import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseLogsArgs, runLogs, tailLines } from "../cli/logs";
import { listPairs } from "../pair-resolver";
import { derivePairId } from "../pair-registry";

const ENV_KEYS = [
  "AGENTBRIDGE_BASE_DIR",
  "AGENTBRIDGE_PAIR_ID",
  "AGENTBRIDGE_PAIR_NAME",
  "AGENTBRIDGE_STATE_DIR",
  "AGENTBRIDGE_CONTROL_PORT",
  "AGENTBRIDGE_MANUAL",
  "CODEX_WS_PORT",
  "CODEX_PROXY_PORT",
] as const;

const EXIT = Symbol("process.exit");

let savedEnv: Record<string, string | undefined>;
let previousCwd: string;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv = {};
  previousCwd = process.cwd();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  process.chdir(previousCwd);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function captureLogs(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  console.log = (...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  };
  process.exit = ((code?: string | number | null | undefined) => {
    exitCode = typeof code === "number" ? code : Number(code ?? 0);
    throw EXIT;
  }) as typeof process.exit;

  try {
    await runLogs(args);
  } catch (err) {
    if (err !== EXIT) throw err;
  }
  return { stdout, stderr: stderr.join("\n"), exitCode };
}

/**
 * Register a pair in the registry by running a real launch path would be heavy;
 * instead, set up the on-disk state dir for the cwd-derived "main" pair and seed
 * its log file. resolvePairReadOnly resolves an unregistered pair to its derived
 * state dir, so a log written there is found WITHOUT any registry write — exactly
 * the read-only contract under test.
 */
function seedDaemonLog(base: string, cwd: string, name: string, contents: string): string {
  const pairId = derivePairId(cwd, name);
  const pairDir = join(base, "pairs", pairId);
  mkdirSync(pairDir, { recursive: true });
  const logPath = join(pairDir, "agentbridge.log");
  writeFileSync(logPath, contents, "utf8");
  return logPath;
}

function seedCodexWrapperLog(base: string, cwd: string, name: string, contents: string): string {
  const pairId = derivePairId(cwd, name);
  const pairDir = join(base, "pairs", pairId);
  mkdirSync(pairDir, { recursive: true });
  const logPath = join(pairDir, "codex-wrapper.log");
  writeFileSync(logPath, contents, "utf8");
  return logPath;
}

describe("parseLogsArgs", () => {
  test("defaults: daemon log, no follow, 100 lines", () => {
    expect(parseLogsArgs([])).toEqual({ codex: false, follow: false, lines: 100 });
  });

  test("--codex selects the wrapper log", () => {
    expect(parseLogsArgs(["--codex"]).codex).toBe(true);
  });

  test("-f / --follow set follow mode", () => {
    expect(parseLogsArgs(["-f"]).follow).toBe(true);
    expect(parseLogsArgs(["--follow"]).follow).toBe(true);
  });

  test("-n N sets the line count", () => {
    expect(parseLogsArgs(["-n", "50"]).lines).toBe(50);
    expect(parseLogsArgs(["-n50"]).lines).toBe(50);
    expect(parseLogsArgs(["--lines", "25"]).lines).toBe(25);
    expect(parseLogsArgs(["--lines=25"]).lines).toBe(25);
  });

  test("flags combine", () => {
    expect(parseLogsArgs(["--codex", "-f", "-n", "5"])).toEqual({
      codex: true,
      follow: true,
      lines: 5,
    });
  });

  test("-n rejects zero, negatives, and non-integers", () => {
    expect(() => parseLogsArgs(["-n", "0"])).toThrow(/positive integer/);
    expect(() => parseLogsArgs(["-n", "-5"])).toThrow(/positive integer/);
    expect(() => parseLogsArgs(["-n", "3.5"])).toThrow(/positive integer/);
    expect(() => parseLogsArgs(["-n", "abc"])).toThrow(/positive integer/);
    expect(() => parseLogsArgs(["-n", "12abc"])).toThrow(/positive integer/);
  });

  test("-n with no value is a user error", () => {
    expect(() => parseLogsArgs(["-n"])).toThrow(/positive integer/);
  });

  test("unknown flags are rejected", () => {
    expect(() => parseLogsArgs(["--bogus"])).toThrow(/Unknown logs flag/);
  });
});

describe("tailLines", () => {
  test("returns the last N lines in order", () => {
    expect(tailLines("a\nb\nc\nd\n", 2)).toEqual(["c", "d"]);
  });

  test("a file shorter than N returns all its lines", () => {
    expect(tailLines("a\nb\n", 10)).toEqual(["a", "b"]);
  });

  test("handles a missing trailing newline", () => {
    expect(tailLines("a\nb\nc", 2)).toEqual(["b", "c"]);
  });

  test("empty file yields no lines", () => {
    expect(tailLines("", 5)).toEqual([]);
    expect(tailLines("\n", 5)).toEqual([]);
  });
});

describe("logs command (non-follow)", () => {
  test("prints the last N lines of the resolved daemon log", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const body = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
    seedDaemonLog(base, process.cwd(), "main", body);

    const result = await captureLogs(["-n", "3"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toEqual(["line-8", "line-9", "line-10"]);
    expect(result.stderr).toBe("");
    // Read-only: no registry entry was written.
    expect(listPairs(base)).toEqual([]);
  });

  test("a file shorter than N tails the whole file", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    seedDaemonLog(base, process.cwd(), "main", "only-one\n");

    const result = await captureLogs(["-n", "100"]);

    expect(result.stdout).toEqual(["only-one"]);
    expect(result.exitCode).toBeUndefined();
  });

  test("--codex reads the codex wrapper log", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    // Seed BOTH logs with distinct content; --codex must pick the wrapper one.
    seedDaemonLog(base, process.cwd(), "main", "DAEMON\n");
    seedCodexWrapperLog(base, process.cwd(), "main", "WRAPPER\n");

    const result = await captureLogs(["--codex"]);

    expect(result.stdout).toEqual(["WRAPPER"]);
    expect(result.exitCode).toBeUndefined();
  });

  test("missing daemon log → clear message + non-zero exit", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureLogs([]);

    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain("no daemon log for pair main yet");
    expect(result.stderr).toContain("abg claude");
    expect(result.exitCode).toBe(1);
    expect(listPairs(base)).toEqual([]);
  });

  test("missing codex wrapper log → wrapper-specific message + non-zero exit", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    // Daemon log exists but the wrapper log does not.
    seedDaemonLog(base, process.cwd(), "main", "DAEMON\n");

    const result = await captureLogs(["--codex"]);

    expect(result.stderr).toContain("no codex wrapper log for pair main yet");
    expect(result.exitCode).toBe(1);
  });

  test("invalid -n surfaces a user error and exits non-zero", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureLogs(["-n", "0"]);

    expect(result.stderr).toContain("positive integer");
    expect(result.exitCode).toBe(1);
  });

  test("invalid --pair name is reported without an unhandled exception", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureLogs(["--pair", "../escape"]);

    expect(result.stderr).toContain("Invalid --pair name");
    expect(result.exitCode).toBe(1);
    expect(listPairs(base)).toEqual([]);
  });

  test("--pair selects a different pair's log (read-only)", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    seedDaemonLog(base, process.cwd(), "main", "MAIN-PAIR\n");
    seedDaemonLog(base, process.cwd(), "work", "WORK-PAIR\n");

    const result = await captureLogs(["--pair", "work"]);

    expect(result.stdout).toEqual(["WORK-PAIR"]);
    expect(result.exitCode).toBeUndefined();
    expect(listPairs(base)).toEqual([]);
  });
});

describe("logs command (follow)", () => {
  test("smoke: follow streams appended lines then exits on SIGINT", async () => {
    const root = makeTempDir("agentbridge-logs-root-");
    const base = makeTempDir("agentbridge-logs-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const logPath = seedDaemonLog(base, process.cwd(), "main", "initial-line\n");

    // Drive followLog directly so we can assert it streams and then bound it by
    // killing the spawned `tail` (mirrors a user pressing Ctrl-C). This proves
    // the child is spawned with the right path and that the promise resolves on
    // a signal-stop instead of hanging the test.
    const { followLog } = await import("../cli/logs");

    // Capture what `tail` writes by temporarily redirecting is not trivial with
    // stdio:"inherit"; instead we assert the call completes (no hang) within a
    // bounded window after appending a new line.
    const followPromise = followLog(logPath, 5);

    // Give tail a moment to attach, append a line, then send SIGINT to the
    // process group's tail child. We cannot reach the child handle from here, so
    // we rely on the bounded timeout + resolve-on-signal contract: spawn a guard
    // that kills any lingering `tail -f` for this log path.
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(logPath, "initial-line\nappended-line\n", "utf8");
    await new Promise((r) => setTimeout(r, 150));

    // Terminate the follow by killing the tail child via pkill scoped to the log
    // path. Bound the whole test so a stuck follow fails fast rather than hanging.
    const { spawnSync } = await import("node:child_process");
    spawnSync("pkill", ["-INT", "-f", `tail -f -n 5 ${logPath}`]);

    const settled = await Promise.race([
      followPromise.then(() => "resolved" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
    ]);

    expect(settled).toBe("resolved");
  });
});
