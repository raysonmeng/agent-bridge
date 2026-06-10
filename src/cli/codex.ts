import { spawn, execSync, execFileSync } from "node:child_process";
import {
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { checkAgentsMdContract } from "../agents-contract";
import {
  captureTuiLogTail,
  discoverNativeChildPid,
  readTurnInProgress,
  refineCleanExitClassification,
} from "../wrapper-exit-observability";
import { ConfigService } from "../config-service";
import { BUILD_INFO } from "../build-info";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { guardAgentBridgeEnv, normalizeEnvGuardMode } from "../env-guard";
import { pairScopedCommand } from "../pair-command";
import { appendRotatingLog } from "../rotating-log";
import { applyPairEnv, parsePairFlag, type PairResolution } from "../pair-resolver";
import { StderrRingBuffer } from "../stderr-ring-buffer";
import {
  readUsableCurrentThread,
  type CurrentThreadState,
} from "../thread-state";
import { appendTraceEvent, pickRelevantEnv, redactArgv } from "../trace-log";
import {
  commandForPid,
  commandMatchesManagedCodexTui,
  findManagedCodexTuiProcesses,
  isProcessAlive,
} from "../process-lifecycle";
import { checkOwnedFlagConflicts } from "./claude";
import {
  CODEX_MAX_PERMISSION_SUPPRESSORS,
  CODEX_MAX_PERMISSION_FLAG,
  planMaxPermissions,
} from "./max-permissions";

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
    appendRotatingLog(path, `[${new Date().toISOString()}] ${entry}\n`);
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
function buildChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "full",
    RUST_LOG:
      process.env.RUST_LOG ??
      "info,codex_core=debug,codex_tui=debug,codex_app_server=debug",
  };
}

/** Flags that AgentBridge owns for codex command. */
const OWNED_FLAGS = ["--remote"];

/**
 * Codex subcommands that still launch the TUI and benefit from AgentBridge's
 * remote proxy. Bridge flags for these must be injected *after* the subcommand
 * name, because clap defines `--remote` / `--enable` as per-subcommand options
 * (not `global`). See docs/issues-2026-04-18-codex-stuck-and-resume.md (Issue D).
 */
const TUI_SUBCOMMANDS = new Set(["resume", "fork"]);

/**
 * Codex subcommands that do NOT launch a TUI. Bridge flags are not applicable
 * and must not be injected. Keep in sync with `codex --help` output.
 */
const NON_TUI_SUBCOMMANDS = new Set([
  "exec", "e",
  "review",
  "login", "logout",
  "mcp", "mcp-server",
  "plugin",
  "remote-control",
  "update",
  "app-server", "exec-server",
  "app",
  "completion",
  "sandbox",
  "debug",
  "apply", "a",
  "cloud",
  "features",
  "help",
]);

export interface BuildArgsResult {
  /** Final argv for `codex`. */
  fullArgs: string[];
  /** Whether bridge flags (`--enable tui_app_server --remote <proxy>`) were injected. */
  injectedBridgeFlags: boolean;
}

export interface AgentBridgeCodexArgs {
  rest: string[];
  forceNew: boolean;
  resumeCurrent: boolean;
}

export interface ResolveCodexResumeResult {
  rest: string[];
  mode: "new" | "auto-resume" | "resume-current" | "passthrough";
  thread?: CurrentThreadState;
  error?: string;
}

export function parseAgentBridgeCodexArgs(args: string[]): AgentBridgeCodexArgs {
  const rest: string[] = [];
  let forceNew = false;
  let resumeCurrent = false;

  for (const arg of args) {
    if (arg === "--new") {
      forceNew = true;
      continue;
    }
    if (arg === "resume-current") {
      resumeCurrent = true;
      continue;
    }
    rest.push(arg);
  }

  return { rest, forceNew, resumeCurrent };
}

export function resolveCodexResumeArgs(
  parsed: AgentBridgeCodexArgs,
  pair: PairResolution,
  env: NodeJS.ProcessEnv = process.env,
): ResolveCodexResumeResult {
  if (parsed.forceNew && parsed.resumeCurrent) {
    return {
      rest: parsed.rest,
      mode: "new",
      error: "`--new` cannot be combined with `resume-current`.",
    };
  }

  if (parsed.forceNew) {
    return { rest: parsed.rest, mode: "new" };
  }

  const identity = {
    stateDir: pair.stateDir,
    pairId: pair.manual ? null : pair.pairId,
    pairName: pair.name,
    cwd: process.cwd(),
  };

  const current = readUsableCurrentThread(identity, env);
  if (parsed.resumeCurrent) {
    if (!current) {
      return {
        rest: parsed.rest,
        mode: "resume-current",
        error:
          "No verified current Codex thread for this pair. Start a new one with `abg codex --new`, or resume a specific thread with `abg codex resume <threadId>`.",
      };
    }
    return {
      rest: ["resume", current.threadId, ...parsed.rest],
      mode: "resume-current",
      thread: current,
    };
  }

  if (parsed.rest.length === 0 && current) {
    return {
      rest: ["resume", current.threadId],
      mode: "auto-resume",
      thread: current,
    };
  }

  return { rest: parsed.rest, mode: "passthrough" };
}

/**
 * Build the final codex command-line arguments, positioning bridge flags so
 * clap parses them as options of the actually-invoked (sub)command.
 *
 * - Bare `codex` / `codex --<flag>…` / `codex <prompt>` → inject at front (root TUI).
 * - `codex resume|fork …` → inject after the subcommand name.
 * - Any known non-TUI subcommand (`exec`, `review`, `login`, `mcp`, …) → pass
 *   through unchanged; those do not launch a TUI and must not receive `--remote`.
 * - Unknown first token → treat as a bare prompt (TUI mode). Safer than
 *   silently dropping bridge flags for an unrecognized subcommand.
 *
 * `yolo` rides along with the bridge flags (same per-subcommand clap
 * positioning; `--yolo` is accepted on root and resume/fork — verified on
 * codex 0.139). Non-TUI subcommands never get it: silently changing the
 * sandboxing of a manual `abg codex exec …` would be a footgun.
 */
export function buildCodexArgs(
  userArgs: string[],
  proxyUrl: string,
  opts: { yolo?: boolean } = {},
): BuildArgsResult {
  const bridgeFlags = [
    "--enable", "tui_app_server", "--remote", proxyUrl,
    ...(opts.yolo ? [CODEX_MAX_PERMISSION_FLAG] : []),
  ];
  const first = userArgs[0];

  if (!first || first.startsWith("-")) {
    return { fullArgs: [...bridgeFlags, ...userArgs], injectedBridgeFlags: true };
  }

  if (TUI_SUBCOMMANDS.has(first)) {
    return {
      fullArgs: [first, ...bridgeFlags, ...userArgs.slice(1)],
      injectedBridgeFlags: true,
    };
  }

  if (NON_TUI_SUBCOMMANDS.has(first)) {
    return { fullArgs: userArgs, injectedBridgeFlags: false };
  }

  return { fullArgs: [...bridgeFlags, ...userArgs], injectedBridgeFlags: true };
}

export async function runCodex(args: string[]) {
  const originalEnv = { ...process.env };
  const envGuardResult = guardAgentBridgeEnv({
    cwd: process.cwd(),
    env: process.env,
    mode: normalizeEnvGuardMode(process.env.AGENTBRIDGE_ENV_GUARD),
    allowStrict: true,
    log: (msg) => console.error(msg),
  });

  // Strip `--pair <name>` first; the rest flows through to codex.
  const { pairFlag, rest } = parsePairFlag(args);

  // Max-permission default (user request): TUI launches get --yolo unless
  // --safe / AGENTBRIDGE_SAFE=1 / an explicit alias is already present.
  // `--safe` is wrapper-owned and stripped here, before codex arg parsing.
  const permissionPlan = planMaxPermissions(rest, CODEX_MAX_PERMISSION_SUPPRESSORS);
  const wrapperArgs = parseAgentBridgeCodexArgs(permissionPlan.args);

  // AGENTS.md is managed exclusively by `abg init`. Startup never writes or
  // blocks on it — only nudge once on stderr if the contract is missing/stale.
  const agentsContract = checkAgentsMdContract(process.cwd());
  if (!agentsContract.fresh) {
    console.error(`[agentbridge] ${agentsContract.message}`);
  }

  // Check for owned flag conflicts (on the real codex args, not the pair flag or wrapper flags).
  checkOwnedFlagConflicts(wrapperArgs.rest, "agentbridge codex", OWNED_FLAGS);

  // Specifically check for --enable tui_app_server (not all --enable values)
  for (let i = 0; i < wrapperArgs.rest.length; i++) {
    if (wrapperArgs.rest[i] === "--enable" && wrapperArgs.rest[i + 1] === "tui_app_server") {
      console.error(`Error: "--enable tui_app_server" is automatically set by agentbridge codex.`);
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  codex [your flags here]");
      process.exit(1);
    }
    if (wrapperArgs.rest[i] === "--enable=tui_app_server") {
      console.error(`Error: "--enable=tui_app_server" is automatically set by agentbridge codex.`);
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  codex [your flags here]");
      process.exit(1);
    }
  }

  // Resolve the pair and inject its env BEFORE ensureRunning, so the daemon this
  // launches binds this pair's Codex app-server / proxy / control ports.
  let pair: PairResolution;
  try {
    pair = await applyPairEnv({ pairFlag });
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  if (pair.warning) console.error(`[agentbridge] ⚠️  ${pair.warning}`);
  if (process.env.AGENTBRIDGE_TRACE === "1") {
    traceCliStart("cli.codex.start", args, originalEnv, envGuardResult.action, pair);
  }

  const stateDir = pair.stateDir;
  const controlPort = pair.ports.controlPort;
  const pairProxyUrl = `ws://127.0.0.1:${pair.ports.proxyPort}`;
  guardNoLiveManagedTui(stateDir, pairProxyUrl);

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  if (!pair.manual) {
    console.error(
      `[agentbridge] pair "${pair.pairId}" (slot ${pair.slot}) — control :${controlPort}, ` +
        `codex :${pair.ports.appPort}/:${pair.ports.proxyPort}`,
    );
  }

  // Ensure daemon is running
  console.error("[agentbridge] Ensuring daemon is running...");
  try {
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.error("[agentbridge] Daemon is ready.");
  } catch (err: any) {
    console.error(`[agentbridge] Failed to start daemon: ${err.message}`);
    console.error(`[agentbridge] Try: ${pairScopedCommand("kill")} && ${pairScopedCommand("claude")}`);
    process.exit(1);
  }

  // Read proxyUrl from daemon status or fall back to config
  let proxyUrl: string;
  const status = lifecycle.readStatus();
  if (status?.proxyUrl) {
    proxyUrl = status.proxyUrl;
  } else {
    // Mirror exactly how the daemon resolves its proxy port (daemon.ts:39):
    // CODEX_PROXY_PORT (set by applyPairEnv in pair mode; user-set in manual mode)
    // else the project config. This is correct for BOTH multi-pair (env carries
    // the slot's port) and manual/legacy mode (config may be a custom port).
    // Thread a stderr logger so a corrupt config.json warns the user here too,
    // matching this command's existing `console.error("[agentbridge] …")` style,
    // instead of silently using the default proxy port.
    const fallbackProxyPort =
      process.env.CODEX_PROXY_PORT ??
      String(
        new ConfigService().loadOrDefault((msg) => console.error(`[agentbridge] ${msg}`)).codex
          .proxyPort,
      );
    proxyUrl = `ws://127.0.0.1:${fallbackProxyPort}`;
    console.error(`[agentbridge] No daemon status found, using fallback proxy port: ${proxyUrl}`);
  }

  try {
    await waitForProxyReady(proxyUrl);
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  // Save terminal state and launch Codex with protection
  console.log(`Connecting Codex TUI to AgentBridge at ${proxyUrl}...`);

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

  const resumeArgs = resolveCodexResumeArgs(wrapperArgs, pair);
  if (resumeArgs.error) {
    console.error(`[agentbridge] ${resumeArgs.error}`);
    process.exit(1);
  }
  if (resumeArgs.mode === "auto-resume" || resumeArgs.mode === "resume-current") {
    console.error(`[agentbridge] Resuming current Codex thread ${resumeArgs.thread!.threadId}`);
  }

  const { fullArgs, injectedBridgeFlags } = buildCodexArgs(resumeArgs.rest, proxyUrl, {
    yolo: permissionPlan.inject,
  });
  if (permissionPlan.inject && injectedBridgeFlags) {
    console.error(`[agentbridge] running with ${CODEX_MAX_PERMISSION_FLAG} (default; opt out with --safe or AGENTBRIDGE_SAFE=1)`);
  }

  // Capture the last 64KB of child stderr so the "ERROR: ..." line from
  // codex-rs on ExitReason::Fatal survives even when stdio is inherited by
  // a terminal that clears on exit. See codex-rs/cli/src/main.rs:553.
  const stderrTail = new StderrRingBuffer();
  const wrapperLogPath = stateDir.codexWrapperLogFile;
  const startedAt = Date.now();

  stateDir.ensure();
  appendWrapperLog(
    wrapperLogPath,
    `spawn: codex ${redactArgv(fullArgs).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
  );

  const child = spawn("codex", fullArgs, {
    // inherit stdin + stdout (TUI needs raw TTY), pipe stderr so we can tee.
    stdio: ["inherit", "inherit", "pipe"],
    env: buildChildEnv(),
  });

  if (typeof child.pid === "number") {
    writeFileSync(stateDir.tuiPidFile, `${child.pid}\n`, "utf-8");
    appendWrapperLog(wrapperLogPath, `child pid=${child.pid}`);
  }

  // The spawned `codex` is an npm launcher; the real TUI is ITS child, and
  // the structured logs in ~/.codex/logs_*.sqlite are keyed by that native
  // pid. Discover it shortly after spawn (retry: the launcher needs a moment
  // to fork) so the exit block can freeze the right log tail (issue #102).
  let nativeChildPid: number | null = null;
  if (typeof child.pid === "number") {
    const launcherPid = child.pid;
    let attempts = 0;
    const discover = () => {
      attempts += 1;
      nativeChildPid = discoverNativeChildPid(launcherPid, (cmd, args) =>
        execFileSync(cmd, args, { encoding: "utf-8", timeout: 2000 }),
      );
      if (nativeChildPid !== null) {
        appendWrapperLog(wrapperLogPath, `native child pid=${nativeChildPid} (launcher pid=${launcherPid})`);
        return;
      }
      if (attempts < 5 && !childExited) {
        const retry = setTimeout(discover, 500);
        retry.unref();
      }
    };
    const first = setTimeout(discover, 300);
    first.unref();
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
  let childExited = false;
  let wrapperShuttingDown = false;
  let signalExitCode: number | null = null;
  function cleanupTuiPidFile() {
    if (cleanedTuiPid) return;
    cleanedTuiPid = true;
    try {
      unlinkSync(stateDir.tuiPidFile);
    } catch {}
  }

  /**
   * Ask the child to stop, escalating to SIGKILL, WITHOUT blocking the event
   * loop. A synchronous wait here would prevent Node from reaping the child, so
   * the killed pid would linger as an unreaped zombie that still answers
   * `kill(pid, 0)` — and the wrapper would wait out every timeout for nothing.
   * We signal asynchronously and let `child.on("exit")` (which fires only once
   * the child is reaped) drive the actual shutdown.
   */
  function requestChildTermination(reason: string) {
    if (childExited) return;
    const pid = child.pid;
    if (typeof pid !== "number") return;
    appendWrapperLog(wrapperLogPath, `terminating child pid=${pid} reason=${reason}`);
    try {
      child.kill("SIGTERM");
    } catch {}
    const killTimer = setTimeout(() => {
      if (childExited) return;
      appendWrapperLog(wrapperLogPath, `child pid=${pid} still alive after SIGTERM; sending SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 1500);
    killTimer.unref();
  }

  function shutdownWrapper(reason: string, exitCode: number) {
    if (wrapperShuttingDown) return;
    wrapperShuttingDown = true;
    signalExitCode = exitCode;
    restoreTerminal();
    requestChildTermination(reason);

    if (childExited) {
      cleanupTuiPidFile();
      process.exit(exitCode);
      return;
    }

    // `child.on("exit")` exits the wrapper once the child is reaped. Hard
    // fallback in case the signal can never be delivered to the child.
    const forceTimer = setTimeout(() => {
      cleanupTuiPidFile();
      process.exit(exitCode);
    }, 3000);
    forceTimer.unref();
  }

  process.on("exit", () => {
    // Last-resort SYNCHRONOUS cleanup only — never block. A best-effort SIGKILL
    // is enough: once the wrapper exits the child is reparented to init/launchd
    // and reaped there. Blocking to wait would defeat that reaping.
    restoreTerminal();
    if (!childExited && typeof child.pid === "number") {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    cleanupTuiPidFile();
  });
  process.on("SIGHUP", () => shutdownWrapper("SIGHUP", 129));
  process.on("SIGINT", () => shutdownWrapper("SIGINT", 130));
  process.on("SIGTERM", () => shutdownWrapper("SIGTERM", 143));

  child.on("exit", (code, signal) => {
    childExited = true;
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
    else if (code === 0 && tail.trim().length === 0) {
      // Refine the historically-opaque exit_0_empty_stderr via the daemon's
      // turn state (status.json, refreshed on every turn transition). A clean
      // exit DURING a turn is the alarming one — the user sees "Codex died"
      // while the agent loop usually finishes app-server-side (issue #102).
      classification = refineCleanExitClassification(readTurnInProgress(stateDir.statusFile));
    }

    // Freeze the native TUI's structured-log tail into the exit block — the
    // sqlite db outlives the process, but correlating it manually cost a
    // two-agent triage last time. Best-effort and bounded by design: worst
    // case adds 2s (execFileSync timeout) to every exit path including
    // Ctrl-C — accepted diagnostics cost, cannot hang.
    const tuiLogTail = captureTuiLogTail({
      codexHome: join(homedir(), ".codex"),
      nativePid: nativeChildPid,
      run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8", timeout: 2000 }),
    });

    appendWrapperLog(
      wrapperLogPath,
      [
        `exit: code=${code ?? "null"} signal=${signal ?? "null"} runtime_ms=${runtimeMs} pid=${child.pid ?? "unknown"} native_pid=${nativeChildPid ?? "unknown"} classification=${classification}`,
        `--- last stderr (${stderrTail.byteLength} bytes) ---`,
        tailLines,
        `--- end stderr ---`,
        `--- last tui log (native pid ${nativeChildPid ?? "unknown"}) ---`,
        tuiLogTail,
        `--- end tui log ---`,
      ].join("\n"),
    );

    // When a signal initiated the shutdown, exit with the conventional
    // 128+signal code (the child was reaped with signal=SIG*, code=null).
    process.exit(signalExitCode ?? code ?? 0);
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

function traceCliStart(
  event: string,
  args: string[],
  originalEnv: NodeJS.ProcessEnv,
  envGuardAction: string,
  pair: PairResolution,
) {
  try {
    appendTraceEvent({
      cwd: process.cwd(),
      event,
      pid: process.pid,
      argv: ["agentbridge", "codex", ...args],
      env: process.env,
      data: {
        originalEnv: pickRelevantEnv(originalEnv),
        effectiveEnv: pickRelevantEnv(process.env),
        envGuardAction,
        pairId: pair.pairId,
        pairName: pair.name,
        manual: pair.manual,
        slot: pair.slot,
        stateDir: pair.stateDir.dir,
        ports: pair.ports,
        build: BUILD_INFO,
      },
    });
  } catch {
    // Trace logging is diagnostic only.
  }
}

function guardNoLiveManagedTui(stateDir: PairResolution["stateDir"], proxyUrl: string) {
  const pid = readTuiPid(stateDir);
  if (pid) {
    if (!isProcessAlive(pid)) {
      try { unlinkSync(stateDir.tuiPidFile); } catch {}
    } else if (!isManagedCodexTuiProcess(pid, proxyUrl)) {
      appendWrapperLog(stateDir.codexWrapperLogFile, `stale tui pid file pointed at unmanaged live pid=${pid}; removing`);
      try { unlinkSync(stateDir.tuiPidFile); } catch {}
    } else {
      console.error(`[agentbridge] This pair already has a managed Codex TUI running (pid ${pid}).`);
      console.error(`[agentbridge] Use that terminal, or stop it with: ${pairScopedCommand("kill")}`);
      process.exit(1);
    }
  }

  const orphan = findManagedCodexTuiProcesses(proxyUrl)[0];
  if (!orphan) return;

  console.error(`[agentbridge] This pair already has a managed Codex TUI running (pid ${orphan.pid}).`);
  console.error(`[agentbridge] Use that terminal, or stop it with: ${pairScopedCommand("kill")}`);
  process.exit(1);
}

function readTuiPid(stateDir: PairResolution["stateDir"]): number | null {
  try {
    const raw = readFileSync(stateDir.tuiPidFile, "utf-8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isManagedCodexTuiProcess(pid: number, proxyUrl: string): boolean {
  const cmd = commandForPid(pid);
  return cmd !== null && commandMatchesManagedCodexTui(cmd, proxyUrl);
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
