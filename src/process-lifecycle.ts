import { execFileSync } from "node:child_process";
import { basename } from "node:path";

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
function invokesCodexBinary(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const exe = tokens[0] ? basename(tokens[0]) : "";
  if (exe === "codex") return true;
  if ((exe === "node" || exe === "bun") && tokens[1]) {
    return basename(tokens[1]) === "codex";
  }
  return false;
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
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" });
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
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" });
    return listManagedCodexTuiProcessesFromList(parsePsProcessList(output))
      .filter((entry) => entry.pid !== process.pid);
  } catch {
    return [];
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function commandForPid(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
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
