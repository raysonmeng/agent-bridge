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
 * STM v2.3 §D6 P4: one-shot control-WS request helper. Opens a short-lived
 * WebSocket to the daemon, sends a request that carries a unique
 * `requestId`, and resolves with the first response whose requestId
 * matches (or the first match by message-type if the request was
 * untagged). Closes the socket and returns.
 *
 * Used by the CLI for `ensure_pair` and `list_pairs` pre-flight calls.
 * Bun has native WebSocket — no extra dependency.
 */
async function controlWsRequest<TReq extends { type: string; requestId: string }, TRes>(
  controlPort: number,
  request: TReq,
  matchResponse: (msg: any) => msg is TRes,
  timeoutMs = 5000,
): Promise<TRes> {
  const url = `ws://127.0.0.1:${controlPort}/ws`;
  return new Promise<TRes>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`control-WS request timed out after ${timeoutMs}ms (type=${request.type})`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify(request)); } catch (err: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error(`control-WS send failed: ${err?.message ?? err}`));
      }
    });
    ws.addEventListener("message", (ev) => {
      if (settled) return;
      try {
        const msg = JSON.parse(ev.data.toString());
        if (matchResponse(msg)) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(msg);
        }
      } catch { /* ignore non-JSON / non-matching */ }
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("control-WS connection error"));
    });
    ws.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("control-WS closed before response"));
    });
  });
}

/**
 * Send `ensure_pair(pairId)` over the control WS. Returns the URLs the
 * CLI should pass to `codex --remote`, or throws a structured error
 * carrying the daemon's `pair_error` code.
 */
async function ensurePairViaControl(
  controlPort: number,
  pairId: string,
  timeoutMs = 5000,
): Promise<{ appServerUrl: string; proxyUrl: string }> {
  const requestId = `cli-ensure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await controlWsRequest<
    { type: "ensure_pair"; requestId: string; pairId: string },
    { type: "pair_ensured" | "pair_error"; requestId: string; [k: string]: any }
  >(
    controlPort,
    { type: "ensure_pair", requestId, pairId },
    (msg): msg is { type: "pair_ensured" | "pair_error"; requestId: string; [k: string]: any } => {
      return msg
        && (msg.type === "pair_ensured" || msg.type === "pair_error")
        && msg.requestId === requestId;
    },
    timeoutMs,
  );
  if (response.type === "pair_error") {
    const err = new Error(response.message ?? "ensure_pair failed") as Error & {
      code?: string;
      details?: any;
    };
    err.code = response.code;
    err.details = response.details;
    throw err;
  }
  return { appServerUrl: response.appServerUrl, proxyUrl: response.proxyUrl };
}

/**
 * Send `list_pairs` over the control WS. Returns the pairs array.
 */
async function listPairsViaControl(
  controlPort: number,
  timeoutMs = 5000,
): Promise<Array<{
  pairId: string;
  isLive: boolean;
  proxyTuiConnected: boolean;
  pairedChatId: string | null;
  [k: string]: any;
}>> {
  const requestId = `cli-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await controlWsRequest<
    { type: "list_pairs"; requestId: string },
    { type: "pair_list"; requestId: string; pairs: any[] }
  >(
    controlPort,
    { type: "list_pairs", requestId },
    (msg): msg is { type: "pair_list"; requestId: string; pairs: any[] } => {
      return msg && msg.type === "pair_list" && msg.requestId === requestId;
    },
    timeoutMs,
  );
  return response.pairs ?? [];
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

function extractCliFlags(args: string[]): {
  mode: CodexConnectionMode;
  pairId: string;
  rest: string[];
} {
  const rest: string[] = [];
  let mode: CodexConnectionMode = "direct";
  let pairId = "default";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--via-proxy") {
      mode = "proxy";
      continue;
    }
    if (a === "--direct") {
      mode = "direct";
      continue;
    }
    // STM v2.3 §8.1 P4: --pair NAME selects which pair this TUI joins.
    // Default is "default" (v2.2-compat). Multiple TUIs on different
    // pairs can coexist; each spawns its own Codex app-server on a
    // separate port via daemon's ensure_pair flow.
    if (a === "--pair" && i + 1 < args.length) {
      pairId = args[i + 1];
      i++;
      continue;
    }
    if (a.startsWith("--pair=")) {
      pairId = a.slice("--pair=".length);
      continue;
    }
    rest.push(a);
  }
  return { mode, pairId, rest };
}

export async function runCodex(rawArgs: string[]) {
  const { mode, pairId, rest: args } = extractCliFlags(rawArgs);

  // STM v2.3 §D1 P4: CLI-side validation of --pair NAME. Reject locally
  // with a clear message before any daemon round-trip — the daemon's
  // INVALID_PAIR_NAME would surface a less ergonomic generic message.
  const { isValidPairName } = await import("../pair-registry");
  if (!isValidPairName(pairId)) {
    console.error(`Error: --pair value "${pairId}" is invalid.`);
    console.error("");
    console.error("Allowed: lowercase letters, digits, underscore, hyphen.");
    console.error("First character must be alphanumeric. Length 1-32 chars.");
    console.error("Examples: default, work, side, project-2, my_pair");
    process.exit(1);
  }

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
  // STM v2.3 §8.1 P4: the URL comes from the daemon's `ensure_pair(pairId)`
  // response, not from `status.json` directly. This makes multi-pair
  // possible — each pair has its own (appPort, proxyPort) tuple, and the
  // daemon allocates them under the registry mutex. For backwards-compat
  // when daemon is not yet reachable for ensure_pair (rare; daemon was
  // ensured above), falls back to status.json / config.
  //
  // direct mode → app-server port (each TUI is an independent client of the
  //               same codex backend; gets its own thread; no proxy).
  // proxy mode  → daemon's proxy port. Spec v2.2 §4.6: `--via-proxy`
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

  // Ensure the target pair is live and get its URLs. For "default" this
  // is idempotent against bootCodex's eager ensure; for named pairs it
  // triggers allocation + spawn in the daemon. Short 2s timeout so an
  // older v2.2 daemon (or test fake) that doesn't handle ensure_pair
  // gracefully falls through to status.json URLs.
  let pairUrls: { appServerUrl: string; proxyUrl: string } | null = null;
  try {
    pairUrls = await ensurePairViaControl(controlPort, pairId, 2000);
    console.error(`[agentbridge] Pair "${pairId}" ready (app=${pairUrls.appServerUrl}, proxy=${pairUrls.proxyUrl})`);
  } catch (err: any) {
    if (err.code === "PAIR_PORTS_BUSY") {
      console.error("");
      console.error(`[agentbridge] Error: ports for pair "${pairId}" are held by another process.`);
      console.error(`  ${err.message ?? ""}`);
      const conflictPort = err.details?.conflictPort;
      if (conflictPort) {
        console.error(`  Conflicting port: ${conflictPort}`);
        console.error(`  Stop that process or use \`abg pairs rm ${pairId} --forget\` to release the registry entry and try again.`);
      } else {
        console.error(`  Stop the conflicting process or use \`abg pairs rm ${pairId} --forget\` to release the registry entry.`);
      }
      console.error("");
      process.exit(1);
    }
    if (err.code === "INVALID_PAIR_NAME") {
      console.error(`[agentbridge] Error: pair name "${pairId}" is invalid.`);
      process.exit(1);
    }
    if (err.code === "MAX_PAIRS") {
      console.error(`[agentbridge] Error: daemon is at the max live pairs limit.`);
      console.error(`  ${err.message ?? ""}`);
      console.error(`  Destroy an unused pair with \`abg pairs rm NAME\` and retry.`);
      process.exit(1);
    }
    console.error(`[agentbridge] Failed to ensure pair "${pairId}": ${err.message ?? err}`);
    console.error(`  Falling back to status.json URLs.`);
  }

  if (mode === "direct") {
    if (pairUrls) {
      remoteUrl = pairUrls.appServerUrl;
    } else if (status?.appServerUrl) {
      remoteUrl = status.appServerUrl;
    } else {
      remoteUrl = `ws://127.0.0.1:${config.codex.appPort}`;
      console.error(`[agentbridge] No daemon status found, using config default app-server URL: ${remoteUrl}`);
    }
  } else {
    // Pre-flight check (proxy mode only): is the target pair already
    // connected to a `--via-proxy` TUI? Each pair allows at most one.
    // Short timeout so we don't stall on a daemon that doesn't speak
    // list_pairs (older or stubbed).
    try {
      const pairsList = await listPairsViaControl(controlPort, 2000);
      const target = pairsList.find((p) => p.pairId === pairId);
      if (target?.proxyTuiConnected) {
        console.error("");
        console.error(`[agentbridge] Error: another \`agentbridge codex --pair ${pairId} --via-proxy\` TUI is already connected.`);
        console.error("");
        console.error(`Shared-thread mode supports at most one proxy TUI per pair (pair="${pairId}").`);
        console.error(`Either close the other TUI window for this pair first, or use a different --pair NAME, or use \`agentbridge codex --direct\` to skip pairing.`);
        console.error("");
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`[agentbridge] Warning: list_pairs pre-flight check failed: ${err?.message ?? err}`);
      console.error(`[agentbridge] Proceeding anyway — daemon may reject the second TUI via WS-upgrade token check.`);
    }

    // Spec v2.2 §4.6: generate the token so codex-rs's primary AND secondary
    // picker connections inherit it via the Authorization header.
    const abgToken = (await import("node:crypto")).randomBytes(8).toString("hex");
    if (pairUrls) {
      remoteUrl = pairUrls.proxyUrl;
    } else if (status?.proxyUrl) {
      remoteUrl = status.proxyUrl;
    } else {
      remoteUrl = `ws://127.0.0.1:${config.codex.proxyPort}`;
      console.error(`[agentbridge] No daemon status found, using config default proxy URL: ${remoteUrl}`);
    }
    childEnv.AGENTBRIDGE_PROXY_TOKEN = abgToken;
    remoteAuthArgs.push("--remote-auth-token-env", "AGENTBRIDGE_PROXY_TOKEN");
    console.error(`[agentbridge] Shared-thread mode active. pair="${pairId}" token=${abgToken.slice(0, 8)}…`);
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
