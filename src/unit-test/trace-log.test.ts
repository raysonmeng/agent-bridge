import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRACE_RETENTION_DAYS,
  appendTraceEvent,
  pickRelevantEnv,
  redactArgv,
  redactEnv,
} from "../trace-log";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempCwd() {
  const dir = mkdtempSync(join(tmpdir(), "agentbridge-trace-"));
  tempDirs.push(dir);
  return dir;
}

describe("trace log", () => {
  test("redacts env and argv secrets", () => {
    expect(redactEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "sk-secret",
      AGENTBRIDGE_PAIR_ID: "pair",
      SESSION_TOKEN: "session-secret",
    })).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "<redacted>",
      AGENTBRIDGE_PAIR_ID: "pair",
      SESSION_TOKEN: "<redacted>",
    });

    expect(redactArgv(["codex", "--api-key", "sk-secret", "--model=o3", "--token=abc"])).toEqual([
      "codex",
      "--api-key",
      "<redacted>",
      "--model=o3",
      "--token=<redacted>",
    ]);
  });

  test("redacts the no-separator --apikey variant in argv", () => {
    expect(redactArgv(["codex", "--apikey=secret"])).toEqual([
      "codex",
      "--apikey=<redacted>",
    ]);
    expect(redactArgv(["codex", "--apikey", "secret", "--model=o3"])).toEqual([
      "codex",
      "--apikey",
      "<redacted>",
      "--model=o3",
    ]);
  });

  test("pickRelevantEnv keeps only AGENTBRIDGE_/CODEX_ keys", () => {
    expect(pickRelevantEnv({
      PATH: "/bin",
      DATABASE_URL: "postgres://user:pw@host/db",
      HOME: "/home/user",
      AGENTBRIDGE_PAIR_ID: "pair",
      CODEX_WS_PORT: "4500",
      OPENAI_API_KEY: "sk-secret",
    })).toEqual({
      AGENTBRIDGE_PAIR_ID: "pair",
      CODEX_WS_PORT: "4500",
    });
  });

  test("pickRelevantEnv still redacts secret-shaped allowlisted keys", () => {
    expect(pickRelevantEnv({
      AGENTBRIDGE_PAIR_ID: "pair",
      CODEX_API_KEY: "sk-secret",
      AGENTBRIDGE_SESSION_TOKEN: "tok",
    })).toEqual({
      AGENTBRIDGE_PAIR_ID: "pair",
      CODEX_API_KEY: "<redacted>",
      AGENTBRIDGE_SESSION_TOKEN: "<redacted>",
    });
  });

  test("appendTraceEvent's written env contains no non-allowlisted key", () => {
    const cwd = tempCwd();
    const path = appendTraceEvent({
      cwd,
      event: "test.event",
      pid: 123,
      argv: ["abg", "claude"],
      env: {
        PATH: "/bin",
        DATABASE_URL: "postgres://user:pw@host/db",
        AGENTBRIDGE_PAIR_ID: "pair",
        CODEX_WS_PORT: "4500",
      },
      timestamp: "2026-06-02T00:00:00.000Z",
      data: { pairId: "main-abc12345" },
    });

    expect(path).toBe(join(cwd, ".agentbridge", "logs", "trace-2026-06-02.jsonl"));
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]!);
    expect(event).toEqual({
      timestamp: "2026-06-02T00:00:00.000Z",
      event: "test.event",
      cwd,
      pid: 123,
      argv: ["abg", "claude"],
      env: { AGENTBRIDGE_PAIR_ID: "pair", CODEX_WS_PORT: "4500" },
      data: { pairId: "main-abc12345" },
    });
    // Explicitly assert non-allowlisted secrets never reach disk.
    expect(Object.keys(event.env)).not.toContain("PATH");
    expect(Object.keys(event.env)).not.toContain("DATABASE_URL");
  });

  test("a nested env snapshot inside data is allowlisted, never written in full", () => {
    const cwd = tempCwd();
    const path = appendTraceEvent({
      cwd,
      event: "bridge.start",
      pid: 7,
      timestamp: "2026-06-02T00:00:00.000Z",
      data: {
        originalEnv: {
          DATABASE_URL: "postgres://user:SUPERSECRETPW@host/db",
          SENTRY_DSN: "https://abc@sentry.io/1",
          AGENTBRIDGE_PAIR_ID: "pair",
        },
        effectiveEnv: {
          PATH: "/bin",
          CODEX_WS_PORT: "4500",
        },
        pairId: "main-abc12345",
      },
    });

    const event = JSON.parse(readFileSync(path, "utf-8").trim());
    // The nested env snapshots are reduced to allowlisted keys only.
    expect(event.data.originalEnv).toEqual({ AGENTBRIDGE_PAIR_ID: "pair" });
    expect(event.data.effectiveEnv).toEqual({ CODEX_WS_PORT: "4500" });
    // The raw connection strings must never reach disk.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("SUPERSECRETPW");
    expect(serialized).not.toContain("sentry.io");
    expect(serialized).not.toContain("DATABASE_URL");
  });
});

describe("trace log retention", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function logsDirFor(cwd: string): string {
    const dir = join(cwd, ".agentbridge", "logs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Create a trace file with a specific mtime (ageDays in the past relative to `nowMs`). */
  function seedTraceFile(logsDir: string, name: string, nowMs: number, ageDays: number): string {
    const filePath = join(logsDir, name);
    writeFileSync(filePath, '{"seed":true}\n', "utf-8");
    const mtimeSec = (nowMs - ageDays * DAY_MS) / 1000;
    utimesSync(filePath, mtimeSec, mtimeSec);
    return filePath;
  }

  test("creating a new day's file prunes only trace files older than the retention window", () => {
    const cwd = tempCwd();
    const logsDir = logsDirFor(cwd);
    const now = Date.parse("2026-06-11T00:00:00.000Z");

    // Older than the window → must be deleted.
    const stale = seedTraceFile(logsDir, "trace-2026-05-01.jsonl", now, TRACE_RETENTION_DAYS + 1);
    // Inside the window → must be kept.
    const recent = seedTraceFile(logsDir, "trace-2026-06-08.jsonl", now, TRACE_RETENTION_DAYS - 1);
    // Just inside the boundary (younger than the cutoff) → kept. We back off a
    // fraction of a day so second-precision mtime rounding cannot flip it.
    const boundary = seedTraceFile(logsDir, "trace-2026-06-04.jsonl", now, TRACE_RETENTION_DAYS - 0.5);
    // A non-trace file must never be touched, even if ancient.
    const unrelated = join(logsDir, "agentbridge.log");
    writeFileSync(unrelated, "keep me\n", "utf-8");
    utimesSync(unrelated, (now - 999 * DAY_MS) / 1000, (now - 999 * DAY_MS) / 1000);

    // Trigger: write the FIRST event of a brand-new day.
    const todayPath = appendTraceEvent({
      cwd,
      event: "bridge.start",
      timestamp: "2026-06-11T09:00:00.000Z",
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(boundary)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(todayPath)).toBe(true);
  });

  test("does not prune the just-created day's file even if its own mtime looks old", () => {
    const cwd = tempCwd();
    const logsDir = logsDirFor(cwd);
    const now = Date.parse("2026-06-11T00:00:00.000Z");

    // Pre-create today's file with an ancient mtime, then append (existing file
    // → not a new-day write → no prune runs, and the file is preserved).
    const todayPath = join(logsDir, "trace-2026-06-11.jsonl");
    writeFileSync(todayPath, '{"pre":true}\n', "utf-8");
    utimesSync(todayPath, (now - 999 * DAY_MS) / 1000, (now - 999 * DAY_MS) / 1000);

    const returned = appendTraceEvent({
      cwd,
      event: "bridge.start",
      timestamp: "2026-06-11T09:00:00.000Z",
    });

    expect(returned).toBe(todayPath);
    expect(existsSync(todayPath)).toBe(true);
    // Append preserved prior content (no truncation) and added the new event.
    const lines = readFileSync(todayPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("appending to an existing day file does not trigger pruning", () => {
    const cwd = tempCwd();
    const logsDir = logsDirFor(cwd);
    const now = Date.parse("2026-06-11T00:00:00.000Z");
    const stale = seedTraceFile(logsDir, "trace-2026-05-01.jsonl", now, TRACE_RETENTION_DAYS + 5);

    // First write of the day → creates file → prunes stale.
    appendTraceEvent({ cwd, event: "first", timestamp: "2026-06-11T08:00:00.000Z" });
    expect(existsSync(stale)).toBe(false);

    // Re-seed a stale file, then append again to the SAME (now existing) day
    // file — this must NOT prune (trigger is new-day-file creation only).
    const stale2 = seedTraceFile(logsDir, "trace-2026-05-02.jsonl", now, TRACE_RETENTION_DAYS + 5);
    appendTraceEvent({ cwd, event: "second", timestamp: "2026-06-11T08:05:00.000Z" });
    expect(existsSync(stale2)).toBe(true);
  });
});
