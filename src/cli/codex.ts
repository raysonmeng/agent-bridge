import { spawn, execSync } from "node:child_process";
import {
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { StateDirResolver } from "../state-dir";
import { ConfigService } from "../config-service";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { StderrRingBuffer } from "../stderr-ring-buffer";
import { checkOwnedFlagConflicts } from "./claude";

/**
 * Spec v2.2 §7: fetch live daemon /healthz JSON for pre-flight checks.
 * Returns null if the daemon is unreachable (CLI falls through to its normal
 * "ensure running" flow and surfaces a clearer error elsewhere).
 */
async function fetchLiveDaemonStatus(
  controlPort: number,
): Promise<{ proxyTuiConnected?: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { proxyTuiConnected?: boolean };
  } catch {
    return null;
  }
}

/**
 * Write a timestamped entry to the codex wrapper log.
 *
 * Silent on IO failure — logging must never break the wrapper itself.
 */
function appendWrapperLog(path: string, entry: string): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(path, `[${new Date().toISOString()}] ${entry}\n`, "utf-8");
  } catch {
    /* ignore */
  }
}

/**
 * Build the child env for codex.
 *
 * Enables Rust tracing + full backtrace so that the next "silent exit" shows
 * up in `~/.codex/log/codex-tui.log` and on stderr (which we also tee).
 * User-provided values take precedence — we only set defaults.
 */
function buildChildEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "full",
    RUST_LOG:
      process.env.RUST_LOG ??
      "info,codex_core=debug,codex_tui=debug,codex_app_server=debug",
  };
}

/** Flags that AgentBridge owns for codex command. */
const OWNED_FLAGS = ["--remote", "--remote-auth-token-env"];

/**
 * Connection mode for `agentbridge codex`:
 *   - "direct" (default): connect each TUI straight to the codex app-server
 *     so multiple TUI windows can run in parallel, each with its own thread.
 *     Pre-multi-Claude AgentBridge proxied every TUI through one port, with
 *     a "primary + secondary picker" assumption that breaks for two
 *     long-lived TUI windows.
 *   - "proxy": legacy behavior — route through the daemon's proxy port so
 *     the proxy can intercept agentMessage events. Useful if you depend on
 *     the daemon's TUI broadcast (which the multi-Claude daemon no longer
 *     uses anyway). Opt in with `--via-proxy`.
 */
type CodexConnectionMode = "direct" | "proxy";

function extractConnectionMode(args: string[]): { mode: CodexConnectionMode; rest: string[] } {
  const rest: string[] = [];
  let mode: CodexConnectionMode = "direct";
  for (const a of args) {
    if (a === "--via-proxy") {
      mode = "proxy";
      continue;
    }
    if (a === "--direct") {
      mode = "direct";
      continue;
    }
    rest.push(a);
  }
  return { mode, rest };
}

export async function runCodex(rawArgs: string[]) {
  const { mode, rest: args } = extractConnectionMode(rawArgs);

  // Check for owned flag conflicts
  checkOwnedFlagConflicts(args, "agentbridge codex", OWNED_FLAGS);

  // Specifically check for --enable tui_app_server (not all --enable values)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--enable" && args[i + 1] === "tui_app_server") {
      console.error(`Error: "--enable tui_app_server" is automatically set by agentbridge codex.`);
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  codex [your flags here]");
      process.exit(1);
    }
    if (args[i] === "--enable=tui_app_server") {
      console.error(`Error: "--enable=tui_app_server" is automatically set by agentbridge codex.`);
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  codex [your flags here]");
      process.exit(1);
    }
  }

  const stateDir = new StateDirResolver();
  const configService = new ConfigService();
  const config = configService.loadOrDefault();
  const controlPort = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  // Ensure daemon is running
  console.error("[agentbridge] Ensuring daemon is running...");
  try {
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.error("[agentbridge] Daemon is ready.");
  } catch (err: any) {
    console.error(`[agentbridge] Failed to start daemon: ${err.message}`);
    console.error("[agentbridge] Try: agentbridge kill && agentbridge claude");
    process.exit(1);
  }

  // Resolve the WebSocket URL to hand to codex --remote.
  //
  // direct mode → app-server port (each TUI is an independent client of the
  //               same codex backend; gets its own thread; no proxy).
  // proxy mode  → daemon's proxy port. Spec v2.2 §4.6: `--via-proxy` now
  //               participates in the shared-thread pairing protocol. A
  //               unique bearer token is passed via Codex's native
  //               --remote-auth-token-env option so the daemon can
  //               distinguish this TUI's secondary picker connection from a
  //               foreign second instance. codex-cli rejects query strings in
  //               --remote (accepted forms are ws://host:port / wss://host:port).
  let remoteUrl: string;
  const childEnv: NodeJS.ProcessEnv = {};
  const remoteAuthArgs: string[] = [];
  const status = lifecycle.readStatus();
  if (mode === "direct") {
    if (status?.appServerUrl) {
      remoteUrl = status.appServerUrl;
    } else {
      remoteUrl = `ws://127.0.0.1:${config.codex.appPort}`;
      console.error(`[agentbridge] No daemon status found, using config default app-server URL: ${remoteUrl}`);
    }
  } else {
    // Spec v2.2 §7: pre-flight check — daemon should only have one proxy TUI
    // at a time. Hit /healthz for the live state (status.json is stale).
    const liveStatus = await fetchLiveDaemonStatus(controlPort);
    if (liveStatus?.proxyTuiConnected) {
      console.error("");
      console.error("[agentbridge] Error: another `agentbridge codex --via-proxy` TUI is already connected to the daemon.");
      console.error("");
      console.error("Shared-thread mode supports at most one proxy TUI at a time.");
      console.error("Either close the other TUI window first, or use `agentbridge codex` (direct mode) to run an independent parallel session.");
      console.error("");
      process.exit(1);
    }

    // Spec v2.2 §4.6: generate the token so codex-rs's primary AND secondary
    // picker connections inherit it via the Authorization header.
    const abgToken = (await import("node:crypto")).randomBytes(8).toString("hex");
    if (status?.proxyUrl) {
      remoteUrl = status.proxyUrl;
    } else {
      remoteUrl = `ws://127.0.0.1:${config.codex.proxyPort}`;
      console.error(`[agentbridge] No daemon status found, using config default proxy URL: ${remoteUrl}`);
    }
    childEnv.AGENTBRIDGE_PROXY_TOKEN = abgToken;
    remoteAuthArgs.push("--remote-auth-token-env", "AGENTBRIDGE_PROXY_TOKEN");
    console.error(`[agentbridge] Shared-thread mode active. Token=${abgToken.slice(0, 8)}…`);
  }

  try {
    await waitForProxyReady(remoteUrl);
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  // Save terminal state and launch Codex with protection
  console.log(`Connecting Codex TUI to AgentBridge at ${remoteUrl} (mode=${mode})...`);

  // Save terminal state
  let savedStty: string | null = null;
  if (process.stdin.isTTY) {
    try {
      savedStty = execSync("stty -g", { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] }).trim();
    } catch {}
  }

  function restoreTerminal() {
    // Restore saved terminal settings
    if (savedStty && process.stdin.isTTY) {
      try {
        execSync(`stty ${savedStty}`, { stdio: ["inherit", "ignore", "ignore"] });
      } catch {
        try {
          execSync("stty sane", { stdio: ["inherit", "ignore", "ignore"] });
        } catch {}
      }
    }

    // Write escape sequences to /dev/tty if available
    let ttyFd: number | null = null;
    try {
      ttyFd = openSync("/dev/tty", "w");
    } catch {
      if (process.stdout.isTTY) {
        ttyFd = 1; // stdout
      }
    }

    if (ttyFd !== null) {
      const sequences = [
        "\x1b[<u",       // Disable keyboard enhancement
        "\x1b[?2004l",   // Disable bracketed paste
        "\x1b[?1004l",   // Disable focus tracking
        "\x1b[?1049l",   // Leave alternate screen
        "\x1b[?25h",     // Show cursor
        "\x1b[0m",       // Reset character attributes
      ];
      for (const seq of sequences) {
        try {
          writeSync(ttyFd, seq);
        } catch {}
      }
      if (ttyFd !== 1) {
        try { closeSync(ttyFd); } catch {}
      }
    }
  }

  const fullArgs = [
    "--enable", "tui_app_server",
    "--remote", remoteUrl,
    ...remoteAuthArgs,
    ...args,
  ];

  // Capture the last 64KB of child stderr so the "ERROR: ..." line from
  // codex-rs on ExitReason::Fatal survives even when stdio is inherited by
  // a terminal that clears on exit. See codex-rs/cli/src/main.rs:553.
  const stderrTail = new StderrRingBuffer();
  const wrapperLogPath = stateDir.codexWrapperLogFile;
  const startedAt = Date.now();

  stateDir.ensure();
  appendWrapperLog(
    wrapperLogPath,
    `spawn: codex ${fullArgs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
  );

  const child = spawn("codex", fullArgs, {
    // inherit stdin + stdout (TUI needs raw TTY), pipe stderr so we can tee.
    stdio: ["inherit", "inherit", "pipe"],
    env: buildChildEnv(childEnv),
  });

  if (typeof child.pid === "number") {
    writeFileSync(stateDir.tuiPidFile, `${child.pid}\n`, "utf-8");
    appendWrapperLog(wrapperLogPath, `child pid=${child.pid}`);
  }

  // Tee stderr: pass through to user's terminal, tail into ring buffer.
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        process.stderr.write(chunk);
      } catch {
        /* stderr may be closed during shutdown */
      }
      stderrTail.append(chunk);
    });
  }

  let cleanedTuiPid = false;
  function cleanupTuiPidFile() {
    if (cleanedTuiPid) return;
    cleanedTuiPid = true;
    try {
      unlinkSync(stateDir.tuiPidFile);
    } catch {}
  }

  process.on("exit", () => { restoreTerminal(); cleanupTuiPidFile(); });
  process.on("SIGINT", () => { restoreTerminal(); cleanupTuiPidFile(); process.exit(130); });
  process.on("SIGTERM", () => { restoreTerminal(); cleanupTuiPidFile(); process.exit(143); });

  child.on("exit", (code, signal) => {
    cleanupTuiPidFile();

    const runtimeMs = Date.now() - startedAt;
    const tail = stderrTail.toString();
    const tailLines = tail.length === 0
      ? "(no stderr captured)"
      : tail;
    // Heuristic classification for quick scanning of the wrapper log.
    //
    // Source-of-truth from codex-rs (verified via Codex's PTY experiment):
    //   - "ERROR: remote app server ... disconnected: ..." → exit code 1
    //     (comes from codex-rs/cli/src/main.rs:553 on ExitReason::Fatal,
    //      triggered by app-server WS close regardless of close code)
    //   - "thread/closed" ServerNotification → exit code 0, EMPTY stderr
    //     (ExitMode::Immediate, invisible in wrapper logs alone —
    //      correlate with agentbridge.log where the adapter sniffs it)
    //   - Plain Ctrl+C → signal:SIGINT
    //   - Other non-zero → likely upstream bug
    let classification = "normal";
    if (/ERROR: remote app server/.test(tail)) classification = "fatal_exit";
    else if (/Error: .* failed: Not initialized/.test(tail)) classification = "not_initialized_after_reconnect";
    else if (/Error: .* failed:/.test(tail)) classification = "rpc_error_exit";
    else if (signal) classification = `signal:${signal}`;
    else if (typeof code === "number" && code !== 0) classification = `nonzero_exit:${code}`;
    else if (code === 0 && tail.trim().length === 0) classification = "exit_0_empty_stderr";

    appendWrapperLog(
      wrapperLogPath,
      [
        `exit: code=${code ?? "null"} signal=${signal ?? "null"} runtime_ms=${runtimeMs} pid=${child.pid ?? "unknown"} classification=${classification}`,
        `--- last stderr (${stderrTail.byteLength} bytes) ---`,
        tailLines,
        `--- end stderr ---`,
      ].join("\n"),
    );

    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    cleanupTuiPidFile();
    appendWrapperLog(wrapperLogPath, `spawn error: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: codex not found in PATH.");
      console.error("Install Codex: https://github.com/openai/codex");
      process.exit(1);
    }
    console.error(`Error starting Codex: ${err.message}`);
    process.exit(1);
  });
}

function proxyHealthUrl(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForProxyReady(proxyUrl: string, maxRetries = 20, delayMs = 100): Promise<void> {
  const healthUrl = proxyHealthUrl(proxyUrl);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Timed out waiting for Codex proxy readiness on ${healthUrl}`);
}
