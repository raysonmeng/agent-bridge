import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBudget } from "../cli/budget";
import { listPairs } from "../pair-resolver";

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
let originalFetch: typeof fetch;
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
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  globalThis.fetch = originalFetch;
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

async function captureBudget(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  let fetchCalls = 0;
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
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("unreachable", { status: 503 });
  }) as unknown as typeof fetch;

  try {
    await runBudget(args);
  } catch (err) {
    if (err !== EXIT) throw err;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode, fetchCalls };
}

describe("budget command", () => {
  test("JSON mode reports an unregistered pair without creating registry state", async () => {
    const root = makeTempDir("agentbridge-budget-root-");
    const base = makeTempDir("agentbridge-budget-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureBudget(["--json"]);

    expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: "pair_not_registered" });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
    expect(result.fetchCalls).toBe(0);
    expect(listPairs(base)).toEqual([]);
  });

  test("human mode tells the user to start a pair before reading budget", async () => {
    const root = makeTempDir("agentbridge-budget-root-");
    const base = makeTempDir("agentbridge-budget-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureBudget([]);

    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("该目录尚无 pair，先运行 abg claude");
    expect(result.exitCode).toBe(1);
    expect(result.fetchCalls).toBe(0);
    expect(listPairs(base)).toEqual([]);
  });

  test("JSON mode reports invalid pair names as a structured user error", async () => {
    const root = makeTempDir("agentbridge-budget-root-");
    const base = makeTempDir("agentbridge-budget-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureBudget(["--json", "--pair", "../escape"]);
    const payload = JSON.parse(result.stdout);

    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Invalid --pair name");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
    expect(result.fetchCalls).toBe(0);
    expect(listPairs(base)).toEqual([]);
  });

  test("human mode reports invalid pair names without an unhandled exception", async () => {
    const root = makeTempDir("agentbridge-budget-root-");
    const base = makeTempDir("agentbridge-budget-base-");
    process.chdir(root);
    process.env.AGENTBRIDGE_BASE_DIR = base;

    const result = await captureBudget(["--pair", "../escape"]);

    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid --pair name");
    expect(result.exitCode).toBe(1);
    expect(result.fetchCalls).toBe(0);
    expect(listPairs(base)).toEqual([]);
  });
});
