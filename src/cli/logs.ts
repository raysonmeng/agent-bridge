/**
 * `abg logs` — tail a pair's daemon log (or the codex wrapper log).
 *
 * Read-only and pair-aware: resolves the pair via resolvePairReadOnly (same path
 * as `abg doctor` / `abg budget`), so it NEVER writes the registry or any state.
 * It turns doctor's dead-end "check the daemon log below" hint into a one-liner:
 * instead of printing an absolute path + byte count and leaving the user to
 * hand-craft a `tail` command (and first figure out which pairId they're in with
 * multiple pairs), `abg logs` resolves the right log for the current pair and
 * prints it.
 *
 *   abg [--pair <name>] logs [--codex] [-f] [-n N]
 *
 *   --codex   read the codex wrapper log (codex-wrapper.log) instead of the
 *             daemon log (agentbridge.log).
 *   -n N      print the last N lines (positive integer; default 100).
 *   -f        follow mode — stream new lines as they are appended.
 *
 * Follow mode shells out to `tail -f -n N <path>` (the project is darwin/linux
 * only, where `tail -f` is universally available). Args are passed as an array —
 * never a shell string — so the resolved path cannot be interpreted by a shell.
 * stdio is inherited, so Ctrl-C (SIGINT) reaches the child `tail` directly and
 * tears it down cleanly; this process exits with the child's status.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parsePairFlag, type ReadOnlyPairResolution, resolvePairReadOnly } from "../pair-resolver";

const DEFAULT_LINES = 100;

interface LogsOptions {
  codex: boolean;
  follow: boolean;
  lines: number;
}

/**
 * Parse `abg logs` flags. `--pair` is stripped upstream (parsePairFlag); this
 * only sees the command-local flags.
 *
 * `-n` requires a strictly positive integer. A missing/garbage value is a user
 * error (thrown), not a silent fallback, so a typo never tails the wrong amount.
 */
export function parseLogsArgs(args: string[]): LogsOptions {
  let codex = false;
  let follow = false;
  let lines = DEFAULT_LINES;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--codex") {
      codex = true;
      continue;
    }
    if (a === "-f" || a === "--follow") {
      follow = true;
      continue;
    }
    if (a === "-n" || a === "--lines") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error(`${a} requires a positive integer (e.g. ${a} 200)`);
      }
      lines = parsePositiveInt(next, a);
      i++;
      continue;
    }
    if (a.startsWith("-n")) {
      // `-n200` (attached value).
      lines = parsePositiveInt(a.slice(2), "-n");
      continue;
    }
    if (a.startsWith("--lines=")) {
      lines = parsePositiveInt(a.slice("--lines=".length), "--lines");
      continue;
    }
    throw new Error(`Unknown logs flag: ${a}`);
  }

  return { codex, follow, lines };
}

function parsePositiveInt(raw: string, flag: string): number {
  // Reject non-integers and non-positives. `Number.parseInt("12abc")` would
  // accept "12", so test the whole token with a strict integer regex first.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/** Return the last `count` lines of `text`, preserving order. */
export function tailLines(text: string, count: number): string[] {
  // Normalise a single trailing newline so it does not produce a spurious
  // empty final line (a log file almost always ends in "\n").
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.length === 0) return [];
  const all = body.split("\n");
  return all.length <= count ? all : all.slice(all.length - count);
}

export async function runLogs(args: string[]) {
  const { pairFlag } = parsePairFlag(args);
  const rest = stripPairTokens(args);

  let options: LogsOptions;
  try {
    options = parseLogsArgs(rest);
  } catch (err) {
    console.error(`[agentbridge] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  let resolution: ReadOnlyPairResolution;
  try {
    resolution = resolvePairReadOnly(pairFlag);
  } catch (err) {
    console.error(`[agentbridge] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
  const { pair } = resolution;

  const logPath = options.codex ? pair.stateDir.codexWrapperLogFile : pair.stateDir.logFile;
  const logLabel = options.codex ? "codex wrapper log" : "daemon log";

  if (!existsSync(logPath)) {
    const which = options.codex ? "codex wrapper log" : "daemon log";
    console.error(
      `no ${which} for pair ${pair.name} yet — start it with \`abg claude\` (${logPath})`,
    );
    process.exit(1);
    return;
  }

  if (options.follow) {
    await followLog(logPath, options.lines);
    return;
  }

  printTail(logPath, options.lines, logLabel, pair.name);
}

function printTail(logPath: string, count: number, label: string, pairName: string) {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (err) {
    console.error(
      `[agentbridge] failed to read ${label} for pair ${pairName}: ` +
        `${err instanceof Error ? err.message : String(err)} (${logPath})`,
    );
    process.exit(1);
    return;
  }
  // A corrupt/huge log is still safe to read fully here: tailLines only keeps
  // the last N entries, so the output is bounded regardless of file size.
  const lines = tailLines(text, count);
  for (const line of lines) console.log(line);
}

/**
 * Stream the log via `tail -f -n N <path>`.
 *
 * Resolves only when the child exits. The path is passed as an argv element (no
 * shell), and stdio is inherited so SIGINT (Ctrl-C) reaches `tail` directly and
 * this process mirrors the child's exit status.
 */
export function followLog(logPath: string, count: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn("tail", ["-f", "-n", String(count), logPath], {
      stdio: "inherit",
    });

    // If `tail` cannot be spawned (missing binary, unlikely on darwin/linux),
    // fail loudly with a non-zero exit instead of hanging.
    child.on("error", (err) => {
      console.error(`[agentbridge] failed to follow log: ${err.message}`);
      process.exit(1);
    });

    child.on("exit", (code, signal) => {
      // Mirror the child's status. SIGINT (Ctrl-C) is the normal way to stop a
      // follow; treat a clean signal-stop as a successful exit so Ctrl-C does
      // not look like an error.
      if (signal === "SIGINT" || signal === "SIGTERM") {
        resolvePromise();
        return;
      }
      if (code != null && code !== 0) {
        process.exit(code);
        return;
      }
      resolvePromise();
    });
  });
}

/**
 * Drop `--pair <name>` / `--pair=<name>` tokens, leaving the logs-local flags.
 * parsePairFlag already extracts the value; this removes the same tokens from
 * the arg list so parseLogsArgs never sees them.
 */
function stripPairTokens(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pair") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++; // skip the value too
      continue;
    }
    if (a.startsWith("--pair=")) continue;
    out.push(a);
  }
  return out;
}
