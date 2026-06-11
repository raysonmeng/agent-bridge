import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureTuiLogTail,
  codexSqliteTailCommand,
  discoverNativeChildPid,
  findCodexSqliteLog,
  readTurnInProgress,
  readUnifiedTurnInProgress,
  refineCleanExitClassification,
} from "../wrapper-exit-observability";

const PATHS = { daemonRecordFile: "/rec", pidFile: "/pid", statusFile: "/status" };

/** Build a path-dispatching read fn for the three on-disk states. */
function reader(files: { rec?: string; pid?: string; status?: string }) {
  return (p: string): string => {
    if (p === PATHS.daemonRecordFile && files.rec !== undefined) return files.rec;
    if (p === PATHS.pidFile && files.pid !== undefined) return files.pid;
    if (p === PATHS.statusFile && files.status !== undefined) return files.status;
    throw new Error("ENOENT");
  };
}

describe("discoverNativeChildPid", () => {
  test("parses the first child pid from pgrep output", () => {
    expect(discoverNativeChildPid(100, () => "61880\n61999\n")).toBe(61880);
    expect(discoverNativeChildPid(100, () => "  61880  \n")).toBe(61880);
  });

  test("returns null when pgrep finds nothing or fails", () => {
    // pgrep exits 1 on no match → runner throws
    expect(discoverNativeChildPid(100, () => { throw new Error("exit 1"); })).toBeNull();
    expect(discoverNativeChildPid(100, () => "")).toBeNull();
    expect(discoverNativeChildPid(100, () => "garbage\n")).toBeNull();
  });
});

describe("readTurnInProgress", () => {
  test("reads the boolean field from status.json", () => {
    expect(readTurnInProgress("/x", () => JSON.stringify({ turnInProgress: true }))).toBe(true);
    expect(readTurnInProgress("/x", () => JSON.stringify({ turnInProgress: false }))).toBe(false);
  });

  test("unknown when field missing, file unreadable, or json invalid", () => {
    // Old daemon builds don't write the field — must be unknown, NOT idle.
    expect(readTurnInProgress("/x", () => JSON.stringify({ pid: 1 }))).toBeNull();
    expect(readTurnInProgress("/x", () => { throw new Error("ENOENT"); })).toBeNull();
    expect(readTurnInProgress("/x", () => "not-json")).toBeNull();
    expect(readTurnInProgress("/x", () => JSON.stringify({ turnInProgress: "yes" }))).toBeNull();
  });

  test("stale file from a dead daemon degrades to unknown, not during_turn", () => {
    // A daemon killed MID-TURN leaves turnInProgress:true behind; trusting it
    // would label a later idle TUI quit as the alarming exit_0_during_turn.
    const staleTrue = JSON.stringify({ turnInProgress: true, pid: 4242 });
    expect(readTurnInProgress("/x", () => staleTrue, () => false)).toBeNull();
    expect(readTurnInProgress("/x", () => staleTrue, () => true)).toBe(true);
    // No pid recorded (legacy file) → field taken at face value.
    expect(readTurnInProgress("/x", () => JSON.stringify({ turnInProgress: false }), () => false)).toBe(false);
  });
});

describe("readUnifiedTurnInProgress (#536 — daemon.json + legacy fallback)", () => {
  const alive = () => true;
  const dead = () => false;

  test("reads turnInProgress from daemon.json (preferred source)", () => {
    const read = reader({ rec: JSON.stringify({ pid: 1, phase: "ready", turnInProgress: true }) });
    expect(readUnifiedTurnInProgress(PATHS, read, alive)).toBe(true);
    const read2 = reader({ rec: JSON.stringify({ pid: 1, phase: "ready", turnInProgress: false }) });
    expect(readUnifiedTurnInProgress(PATHS, read2, alive)).toBe(false);
  });

  test("falls back to legacy status.json when daemon.json absent (old daemon)", () => {
    const read = reader({ status: JSON.stringify({ pid: 1, turnInProgress: true }) });
    expect(readUnifiedTurnInProgress(PATHS, read, alive)).toBe(true);
  });

  test("daemon.json wins over a stale legacy status.json", () => {
    const read = reader({
      rec: JSON.stringify({ pid: 1, phase: "ready", turnInProgress: false }),
      status: JSON.stringify({ pid: 1, turnInProgress: true }),
    });
    expect(readUnifiedTurnInProgress(PATHS, read, alive)).toBe(false);
  });

  test("unknown when field missing, nothing on disk, or json invalid", () => {
    expect(readUnifiedTurnInProgress(PATHS, reader({ rec: JSON.stringify({ pid: 1 }) }), alive)).toBeNull();
    expect(readUnifiedTurnInProgress(PATHS, reader({}), alive)).toBeNull();
    expect(readUnifiedTurnInProgress(PATHS, reader({ rec: "not-json" }), alive)).toBeNull();
  });

  test("stale record from a dead daemon degrades to unknown (same trust gate)", () => {
    // daemon.json with turnInProgress:true but its writing pid is dead → unknown.
    const read = reader({ rec: JSON.stringify({ pid: 4242, phase: "ready", turnInProgress: true }) });
    expect(readUnifiedTurnInProgress(PATHS, read, dead)).toBeNull();
    expect(readUnifiedTurnInProgress(PATHS, read, alive)).toBe(true);
  });
});

describe("refineCleanExitClassification", () => {
  test("maps daemon turn state onto the three clean-exit classes", () => {
    expect(refineCleanExitClassification(true)).toBe("exit_0_during_turn");
    expect(refineCleanExitClassification(false)).toBe("exit_0_idle");
    expect(refineCleanExitClassification(null)).toBe("exit_0_turn_unknown");
  });
});

describe("findCodexSqliteLog", () => {
  test("picks the newest logs*.sqlite and ignores other files", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      writeFileSync(join(home, "logs_1.sqlite"), "");
      writeFileSync(join(home, "logs_2.sqlite"), "");
      writeFileSync(join(home, "config.toml"), "");
      const old = new Date(Date.now() - 86_400_000);
      utimesSync(join(home, "logs_1.sqlite"), old, old);

      expect(findCodexSqliteLog(home)).toBe(join(home, "logs_2.sqlite"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("null when the directory or matches are absent", () => {
    expect(findCodexSqliteLog("/nonexistent-dir-xyz")).toBeNull();
    const home = mkdtempSync(join(tmpdir(), "codex-home-empty-"));
    try {
      expect(findCodexSqliteLog(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("codexSqliteTailCommand", () => {
  test("builds a read-only, pid-scoped, bounded query", () => {
    const { cmd, args } = codexSqliteTailCommand("/db.sqlite", 61880, 50);
    expect(cmd).toBe("sqlite3");
    expect(args[0]).toBe("-readonly");
    expect(args[1]).toBe("/db.sqlite");
    expect(args[2]).toContain("like 'pid:61880:%'");
    expect(args[2]).toContain("limit 50");
    expect(args[2]).toContain("substr(feedback_log_body,1,300)");
  });
});

describe("captureTuiLogTail", () => {
  test("degrades gracefully at every failure point — never throws", () => {
    expect(captureTuiLogTail({ codexHome: "/none", nativePid: null, run: () => "x" }))
      .toContain("native child pid unknown");
    expect(captureTuiLogTail({ codexHome: "/nonexistent-dir-xyz", nativePid: 1, run: () => "x" }))
      .toContain("no codex sqlite log database");

    const home = mkdtempSync(join(tmpdir(), "codex-home-tail-"));
    try {
      writeFileSync(join(home, "logs_2.sqlite"), "");
      expect(captureTuiLogTail({ codexHome: home, nativePid: 1, run: () => { throw new Error("sqlite3 missing"); } }))
        .toContain("capture failed: sqlite3 missing");
      expect(captureTuiLogTail({ codexHome: home, nativePid: 1, run: () => "" }))
        .toContain("no log rows for pid 1");
      expect(captureTuiLogTail({ codexHome: home, nativePid: 1, run: () => "row1|INFO|target|body\n" }))
        .toBe("row1|INFO|target|body");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
