import { execFileSync } from "node:child_process";
import { basename, win32 as win32Path } from "node:path";

export interface ProcessListEntry {
  pid: number;
  command: string;
}

export interface TerminateProcessOptions {
  gracefulTimeoutMs?: number;
  processGroup?: boolean;
  log?: (message: string) => void;
}

export function parsePsProcessList(output: string): ProcessListEntry[] {
  const entries: ProcessListEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(pid)) continue;
    entries.push({ pid, command: match[2]! });
  }
  return entries;
}

/**
 * True only when the process's EXECUTABLE (argv[0]) is actually the `codex`
 * binary — not merely a process whose arguments happen to contain the text
 * "codex". Without this anchor, a long command line carrying log/prompt text
 * like `... codex ... tui_app_server ... --remote ws://...` (e.g. another
 * agent's argv) is mis-identified as a managed TUI, which `abg doctor` would
 * mis-report and, worse, the kill scanner could mis-target. Accepts both the
 * native `codex` binary and a `node|bun .../codex` script launcher.
 */
export function invokesCodexBinary(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    // win32 command lines quote argv[0] when it has spaces
    // (`"C:\Program Files\...\codex.exe" --remote ...`), use `\`, carry an
    // `.exe`/`.cmd`/`.js` suffix, and are case-insensitive — none of which the
    // POSIX split below handles, so a real Codex TUI was never recognised.
    const [first, second] = splitWin32Argv(command);
    const exe = win32Stem(first);
    if (exe === "codex") return true;
    if ((exe === "node" || exe === "bun") && second) return win32Stem(second) === "codex";
    return false;
  }
  const tokens = command.trim().split(/\s+/);
  const exe = tokens[0] ? basename(tokens[0]) : "";
  if (exe === "codex") return true;
  if ((exe === "node" || exe === "bun") && tokens[1]) {
    return basename(tokens[1]) === "codex";
  }
  return false;
}

/** First two argv tokens of a win32 command line, honouring double quotes. */
function splitWin32Argv(command: string): [string, string] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while (tokens.length < 2 && (m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? "");
  }
  return [tokens[0] ?? "", tokens[1] ?? ""];
}

/** Lower-cased basename with a launcher extension stripped (`codex.exe` → `codex`). */
function win32Stem(token: string): string {
  if (!token) return "";
  return win32Path.basename(token).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/, "");
}

export function commandMatchesManagedCodexTui(command: string, proxyUrl?: string): boolean {
  // Anchor on argv[0] being codex itself before trusting any substring in the
  // rest of the command line (prevents false positives from unrelated processes
  // that merely mention codex/tui_app_server/--remote in their arguments).
  if (!invokesCodexBinary(command)) return false;
  if (!command.includes("tui_app_server")) return false;
  const remoteUrl = extractRemoteUrl(command);
  if (!remoteUrl) return false;
  if (!proxyUrl) return true;
  return remoteTargetsProxy(remoteUrl, proxyUrl);
}

export function findManagedCodexTuiProcessesFromList(
  processes: ProcessListEntry[],
  proxyUrl: string,
): ProcessListEntry[] {
  return processes.filter((entry) => commandMatchesManagedCodexTui(entry.command, proxyUrl));
}

export function findManagedCodexTuiProcesses(proxyUrl: string): ProcessListEntry[] {
  try {
    const output = listProcessesRaw();
    return findManagedCodexTuiProcessesFromList(parsePsProcessList(output), proxyUrl)
      .filter((entry) => entry.pid !== process.pid);
  } catch {
    return [];
  }
}

export interface ManagedCodexTuiProcess extends ProcessListEntry {
  /** The `--remote <url>` target this TUI is attached to (null if unparseable). */
  remoteUrl: string | null;
}

/** Parse the managed-TUI subset of a `ps` listing, annotating each with its `--remote` target. */
export function listManagedCodexTuiProcessesFromList(processes: ProcessListEntry[]): ManagedCodexTuiProcess[] {
  return processes
    .filter((entry) => commandMatchesManagedCodexTui(entry.command))
    .map((entry) => ({ ...entry, remoteUrl: extractRemoteUrl(entry.command) }));
}

/**
 * Every managed Codex TUI on the machine, regardless of which proxy/pair it is
 * attached to. Used by `abg doctor` to detect a Codex TUI that was started from
 * a different cwd (→ a different pair) and therefore will never bridge here.
 */
export function listManagedCodexTuiProcesses(): ManagedCodexTuiProcess[] {
  try {
    const output = listProcessesRaw();
    return listManagedCodexTuiProcessesFromList(parsePsProcessList(output))
      .filter((entry) => entry.pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Claude Code plugin frontends (bridge-server.js processes). These are the
 * processes that re-launch a pair's daemon as soon as the killed sentinel is
 * cleared, and they keep OLD plugin code loaded until their Claude Code window
 * is reopened — i.e. the two things `abg kill` users most need to know about
 * but cannot see from the daemon list alone. Pure half for tests.
 */
export function listBridgeFrontendProcessesFromList(processes: ProcessListEntry[]): ProcessListEntry[] {
  return processes.filter(
    (entry) =>
      /(?:^|[\s/\\])bridge-server\.js(?:\s|$)/.test(entry.command) &&
      (entry.command.includes("agentbridge") || entry.command.includes("agent_bridge")),
  );
}

export function listBridgeFrontendProcesses(): ProcessListEntry[] {
  try {
    const output = listProcessesRaw();
    return listBridgeFrontendProcessesFromList(parsePsProcessList(output)).filter(
      (entry) => entry.pid !== process.pid,
    );
  } catch {
    return [];
  }
}

export function commandForPid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const { cmd, args } = pidCommandLineCommand(pid);
    const out = execFileSync(cmd, args, { encoding: "utf-8", windowsHide: true }).trim();
    // win32 prints nothing for a gone pid (ps exits non-zero instead); keep the
    // "null = no such process" contract on both.
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Whole-machine process listing as `<pid> <command line>` lines (the shape
 * {@link parsePsProcessList} parses).
 *
 * POSIX: `ps -axo pid=,command=`. win32: there is no `ps` (Git Bash ships an
 * MSYS `ps` that rejects `-axo`, so every caller silently got `[]` — `abg kill`
 * reported "nothing running" while daemons held the ports, and `abg doctor`
 * never saw the Codex TUI). PowerShell CIM is on every supported Windows and
 * yields the full command line; processes without one (system/protected) are
 * skipped.
 */
export function processListCommand(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine -replace '[\r\n]+', ' ')\" }",
      ],
    };
  }
  return { cmd: "ps", args: ["-axo", "pid=,command="] };
}

/** Command that prints one pid's command line (empty / non-zero exit when gone). */
export function pidCommandLineCommand(pid: number, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Math.trunc(pid)}" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine) { $p.CommandLine }`,
      ],
    };
  }
  return { cmd: "ps", args: ["-p", String(pid), "-o", "command="] };
}

function listProcessesRaw(): string {
  const { cmd, args } = processListCommand();
  return execFileSync(cmd, args, { encoding: "utf-8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Process identity & liveness — the SINGLE source of truth
//
// These three helpers used to be re-implemented (with drifted semantics) in
// daemon-lifecycle.ts and pair-registry.ts. They are consolidated here, next to
// the `ps` parsing and the argv[0]-anchored `commandMatchesManagedCodexTui`
// matcher, which is the project's most rigorous matcher template. All call sites
// import from this module; do NOT re-add local copies.
// ---------------------------------------------------------------------------

/** A `ps` command-line lookup for a pid — injectable so the identity matchers are pure/testable. */
export type CommandLookup = (pid: number) => string | null;

/**
 * `process.kill(pid, 0)` liveness with two deliberate hardenings, applied
 * uniformly so every call site agrees:
 *
 *  - pid <= 0 (and non-integer) is NEVER a real holder. `process.kill(0, 0)`
 *    targets the current process GROUP and "succeeds", which would wrongly mark
 *    a corrupt `{pid:0}` pid file / lock as live and wedge acquisition forever.
 *    Negatives carry signal-broadcast semantics, not a pid. Treat all as dead so
 *    the slot/lock/pid file is reclaimable.
 *  - EPERM (the process exists but we may not signal it) is treated as ALIVE.
 *    On a single-user machine EPERM is near-unreachable, but if it does occur,
 *    declaring an existing-but-unsignalable process dead and then stomping its
 *    state is strictly worse than conservatively keeping it. This adopts
 *    pair-registry's historical "EPERM = alive" choice; the previous
 *    daemon-lifecycle/process-lifecycle copies wrongly treated EPERM as dead.
 */
export function pidLooksAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Backward-compatible alias for {@link pidLooksAlive}. Kept because many call
 * sites and tests import `isProcessAlive`. Identical semantics — there is now a
 * single liveness implementation (incl. the pid<=0 guard and EPERM = alive).
 */
export const isProcessAlive = pidLooksAlive;

/**
 * The SINGLE strict AgentBridge-daemon matcher, shared by daemon-lifecycle
 * (kill / reuse identity guard) and pair-registry (legacy-root detection).
 *
 * Verifies via the process command line that `pid` is actually our daemon, not
 * an OS-reused pid belonging to an unrelated process. It anchors on the
 * executable basename being a daemon-role script (`daemon.{ts,js}` in
 * production, `*-daemon.{ts,js}` for the e2e harness's fake) — NOT on the loose
 * substring "daemon", which also matches e.g. a test file named
 * `daemon-self-heal.test.ts` invoked by an IDE runner. It additionally requires
 * an agentbridge marker so an unrelated `*-daemon.js` from another project is
 * not matched.
 *
 * This is a behaviour TIGHTENING relative to pair-registry's former loose
 * `cmd.includes("daemon")`. The legacy single-pair-root daemon is still spawned
 * as `<bun> run <…>/daemon.{ts,js}` (dev) or `<…>/server/daemon.js` (bundled),
 * whose path carries an `agentbridge`/`agent_bridge` marker, so the anchored
 * pattern still catches it — see process-lifecycle.test.ts ("isAgentBridgeDaemon" block) for the proof cases.
 *
 * `lookup` defaults to a real `ps` call; tests inject a pure function.
 */
export function isAgentBridgeDaemon(pid: number, lookup: CommandLookup = commandForPid): boolean {
  const cmd = lookup(pid);
  if (cmd === null) return false;
  // Match .../<anything>-daemon.js or .../<anything>-daemon.ts as a runnable
  // argument (preceded by whitespace/path-sep, followed by whitespace or EOL).
  const hasDaemonEntry = /(?:^|[\s/\\])[\w.-]*-?daemon\.(?:ts|js)(?:\s|$)/.test(cmd);
  const hasAgentbridge = cmd.includes("agentbridge") || cmd.includes("agent_bridge");
  return hasDaemonEntry && hasAgentbridge;
}

/**
 * The general AgentBridge-process matcher (loose by design): launchers (CLI /
 * plugin frontend) and daemons all carry an agentbridge marker. Used only to
 * detect OS pid recycling of a STALE lock holder — NOT for kill decisions
 * (kill paths use the stricter {@link isAgentBridgeDaemon}).
 *
 * `lookup` defaults to a real `ps` call; tests inject a pure function.
 */
export function isAgentBridgeProcess(pid: number, lookup: CommandLookup = commandForPid): boolean {
  const cmd = lookup(pid);
  if (cmd === null) return false;
  return cmd.includes("agentbridge") || cmd.includes("agent_bridge");
}

export function terminateProcessSync(pid: number, options: TerminateProcessOptions = {}): boolean {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2000;
  const target = options.processGroup && process.platform !== "win32" ? -pid : pid;
  const label = options.processGroup && process.platform !== "win32" ? `process group ${pid}` : `pid ${pid}`;

  try {
    process.kill(target, "SIGTERM");
    options.log?.(`Sent SIGTERM to ${label}`);
  } catch {
    return !isProcessAlive(pid);
  }

  if (waitForExitSync(pid, gracefulTimeoutMs)) return true;

  try {
    process.kill(target, "SIGKILL");
    options.log?.(`Sent SIGKILL to ${label}`);
  } catch {}

  return waitForExitSync(pid, 500);
}

function waitForExitSync(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleepSync(50);
  }
  return !isProcessAlive(pid);
}

function sleepSync(ms: number) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function extractRemoteUrl(command: string): string | null {
  const equals = command.match(/(?:^|\s)--remote=([^\s]+)/);
  if (equals) return equals[1]!;
  const separate = command.match(/(?:^|\s)--remote\s+([^\s]+)/);
  return separate?.[1] ?? null;
}

function remoteTargetsProxy(remoteUrl: string, proxyUrl: string): boolean {
  try {
    const remote = new URL(remoteUrl);
    const proxy = new URL(proxyUrl);
    return (
      remote.protocol === proxy.protocol &&
      remote.hostname === proxy.hostname &&
      remote.port === proxy.port &&
      normalizePath(remote.pathname) === normalizePath(proxy.pathname)
    );
  } catch {
    return remoteUrl === proxyUrl;
  }
}

function normalizePath(pathname: string): string {
  return pathname === "" ? "/" : pathname;
}
