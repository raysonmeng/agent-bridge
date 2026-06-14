import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentName } from "../budget/types";
// Module under test does NOT exist yet — this import is the RED driver.
import {
  parsePendingPayload,
  readGuardPending,
  type PendingEntry,
} from "../budget/pending-reader";

const tmpDirs: string[] = [];

/** Create a throwaway HOME-like dir; NEVER touch the real HOME. */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "abg-pending-reader-"));
  tmpDirs.push(dir);
  return dir;
}

/** Resolve the per-home `.budget-guard/pending` dir and make sure it exists. */
function pendingDir(home: string): string {
  const dir = join(home, ".budget-guard", "pending");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a per-scope pending file: pending/<agent>_<scope>.json */
function writeScopePending(home: string, agent: AgentName, scope: string, payload: unknown): string {
  const dir = pendingDir(home);
  const path = join(dir, `${agent}_${scope}.json`);
  writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload), "utf-8");
  return path;
}

/** Write a legacy flat pending file: <stateDir>/pending_<agent>.json */
function writeLegacyPending(home: string, agent: AgentName, payload: unknown): string {
  const dir = join(home, ".budget-guard");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pending_${agent}.json`);
  writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload), "utf-8");
  return path;
}

/** A complete JS-writer (hook.mjs) pending record. util === warn_util by contract. */
function jsPending(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "paused",
    agent: "claude",
    session_id: "sess-js-1",
    cwd: "/repo/project-a",
    reset_epoch: 1_900_000_000,
    util: 92,
    warn_util: 92,
    at: 1_899_990_000,
    ...overrides,
  };
}

/** A complete Bash-writer (budget_guard.sh) pending record. Note `reset`, no `warn_util`. */
function bashPending(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "paused",
    agent: "codex",
    session_id: "sess-bash-1",
    cwd: "/repo/project-b",
    reset: 1_900_000_500,
    util: 88,
    at: 1_899_990_500,
    ...overrides,
  };
}

// resolveStateDir prefers process.env.BUDGET_STATE_DIR over homeDir. If the host
// (dev machine / CI running a real guard) has BUDGET_STATE_DIR set, the homeDir
// injection these tests rely on for isolation is bypassed — tests would read a
// foreign state dir and either fail or pass spuriously. Save + delete it before
// each test and restore after, so isolation depends ONLY on the injected
// homeDir. The env-override branch is exercised explicitly where it is the
// subject under test.
let savedBudgetStateDir: string | undefined;
beforeEach(() => {
  savedBudgetStateDir = process.env.BUDGET_STATE_DIR;
  delete process.env.BUDGET_STATE_DIR;
});

afterEach(() => {
  if (savedBudgetStateDir === undefined) {
    delete process.env.BUDGET_STATE_DIR;
  } else {
    process.env.BUDGET_STATE_DIR = savedBudgetStateDir;
  }
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("parsePendingPayload — JS schema", () => {
  test("parses reset_epoch and warn_util straight through", () => {
    const entry = parsePendingPayload(jsPending());
    expect(entry).not.toBeNull();
    expect(entry!.agent).toBe("claude");
    expect(entry!.sessionId).toBe("sess-js-1");
    expect(entry!.cwd).toBe("/repo/project-a");
    expect(entry!.resetEpoch).toBe(1_900_000_000);
    expect(entry!.util).toBe(92);
    expect(entry!.warnUtil).toBe(92);
    expect(entry!.at).toBe(1_899_990_000);
  });

  test("util === warn_util is preserved (not treated as independent hard/warn)", () => {
    const entry = parsePendingPayload(jsPending({ util: 95, warn_util: 95 }));
    expect(entry!.util).toBe(95);
    expect(entry!.warnUtil).toBe(95);
  });
});

describe("parsePendingPayload — Bash schema fallback", () => {
  test("reads reset via (.reset_epoch ?? .reset) fallback", () => {
    const entry = parsePendingPayload(bashPending());
    expect(entry).not.toBeNull();
    // Bash writer has no reset_epoch — must fall back to `reset`.
    expect(entry!.resetEpoch).toBe(1_900_000_500);
  });

  test("reads warn via (.warn_util ?? .util) fallback when warn_util absent", () => {
    const entry = parsePendingPayload(bashPending());
    // No warn_util in bash record → falls back to util.
    expect(entry!.warnUtil).toBe(88);
    expect(entry!.util).toBe(88);
  });

  test("reset_epoch wins over reset when both somehow present", () => {
    const entry = parsePendingPayload(bashPending({ reset_epoch: 1_911_111_111, reset: 1_900_000_500 }));
    expect(entry!.resetEpoch).toBe(1_911_111_111);
  });

  test("warn_util wins over util when both present", () => {
    const entry = parsePendingPayload(jsPending({ util: 90, warn_util: 92 }));
    expect(entry!.warnUtil).toBe(92);
    expect(entry!.util).toBe(90);
  });
});

describe("parsePendingPayload — malformed / non-object inputs return null (no throw)", () => {
  test("null returns null", () => {
    expect(parsePendingPayload(null)).toBeNull();
  });

  test("undefined returns null", () => {
    expect(parsePendingPayload(undefined)).toBeNull();
  });

  test("array returns null (asRecord rejects arrays)", () => {
    expect(() => parsePendingPayload([jsPending()])).not.toThrow();
    expect(parsePendingPayload([jsPending()])).toBeNull();
  });

  test("primitive number returns null", () => {
    expect(parsePendingPayload(42)).toBeNull();
  });

  test("primitive string returns null", () => {
    expect(parsePendingPayload("paused")).toBeNull();
  });

  test("object missing session_id returns null", () => {
    const entry = parsePendingPayload(jsPending({ session_id: undefined }));
    expect(entry).toBeNull();
  });

  test("non-finite util coerces to null entry (cannot trust the reading)", () => {
    const entry = parsePendingPayload(jsPending({ util: "not-a-number", warn_util: "x" }));
    expect(entry).toBeNull();
  });
});

describe("readGuardPending — per-scope glob", () => {
  test("reads a single per-scope JS pending file", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "abc123def4567890", jsPending());

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("sess-js-1");
    expect(entries[0].resetEpoch).toBe(1_900_000_000);
  });

  test("carries source path and content hash for atomic resume claims", () => {
    const home = tempHome();
    const payload = jsPending();
    const path = writeScopePending(home, "claude", "abc123def4567890", payload);

    const entries = readGuardPending({ homeDir: home, agent: "claude" });

    expect(entries).toHaveLength(1);
    expect(entries[0].sourcePath).toBe(path);
    expect(entries[0].contentHash).toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  });

  test("globs pending/<agent>_*.json for the requested agent only", () => {
    const home = tempHome();
    // Two scopes for codex (JS sha16 + Bash cksum) → two files, distinct sessions.
    writeScopePending(home, "codex", "deadbeefdeadbeef", bashPending({ session_id: "codex-A" }));
    writeScopePending(home, "codex", "1234567890", bashPending({ session_id: "codex-B" }));
    // A claude file that must NOT leak into codex results.
    writeScopePending(home, "claude", "ffffffffffffffff", jsPending({ session_id: "claude-X" }));

    const entries = readGuardPending({ homeDir: home, agent: "codex" });
    const sessions = entries.map((e) => e.sessionId).sort();
    expect(sessions).toEqual(["codex-A", "codex-B"]);
  });

  test("returns empty array when pending dir does not exist (no throw)", () => {
    const home = tempHome(); // pending dir never created
    expect(() => readGuardPending({ homeDir: home, agent: "claude" })).not.toThrow();
    expect(readGuardPending({ homeDir: home, agent: "claude" })).toEqual([]);
  });
});

describe("readGuardPending — legacy flat fallback", () => {
  test("reads legacy pending_<agent>.json when present", () => {
    const home = tempHome();
    pendingDir(home); // dir exists but empty
    writeLegacyPending(home, "claude", jsPending({ session_id: "legacy-1" }));

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries.map((e) => e.sessionId)).toContain("legacy-1");
  });

  test("merges per-scope and legacy files for the same agent", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "aaaa1111bbbb2222", jsPending({ session_id: "scope-1" }));
    writeLegacyPending(home, "claude", jsPending({ session_id: "legacy-2" }));

    const sessions = readGuardPending({ homeDir: home, agent: "claude" })
      .map((e) => e.sessionId)
      .sort();
    expect(sessions).toEqual(["legacy-2", "scope-1"]);
  });
});

describe("readGuardPending — dedup by session_id", () => {
  test("same (cwd,session) written under two scope names dedups to one entry", () => {
    const home = tempHome();
    // JS sha16 scope and Bash cksum scope for the same session_id.
    writeScopePending(home, "codex", "0123456789abcdef", bashPending({ session_id: "dup-sess" }));
    writeScopePending(home, "codex", "987654321", bashPending({ session_id: "dup-sess" }));

    const entries = readGuardPending({ homeDir: home, agent: "codex" });
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("dup-sess");
  });

  test("legacy and per-scope sharing a session_id dedup to one entry", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "cafebabecafebabe", jsPending({ session_id: "same-sess" }));
    writeLegacyPending(home, "claude", jsPending({ session_id: "same-sess" }));

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("same-sess");
  });
});

describe("readGuardPending — log-and-skip resilience (never throws)", () => {
  test("malformed JSON file is skipped, valid sibling still read", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "1111111111111111", "{ this is not json ]");
    writeScopePending(home, "claude", "2222222222222222", jsPending({ session_id: "good-1" }));

    let entries: PendingEntry[] = [];
    expect(() => {
      entries = readGuardPending({ homeDir: home, agent: "claude" });
    }).not.toThrow();
    expect(entries.map((e) => e.sessionId)).toEqual(["good-1"]);
  });

  test("empty file is skipped (trim yields '')", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "3333333333333333", "");
    writeScopePending(home, "claude", "4444444444444444", "   \n  ");
    writeScopePending(home, "claude", "5555555555555555", jsPending({ session_id: "good-2" }));

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries.map((e) => e.sessionId)).toEqual(["good-2"]);
  });

  test("array-shaped JSON file is skipped (asRecord rejects arrays)", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "6666666666666666", [jsPending()]);
    writeScopePending(home, "claude", "7777777777777777", jsPending({ session_id: "good-3" }));

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries.map((e) => e.sessionId)).toEqual(["good-3"]);
  });

  test("non-object scalar JSON file is skipped", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "8888888888888888", "12345");
    writeScopePending(home, "claude", "9999999999999999", jsPending({ session_id: "good-4" }));

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries.map((e) => e.sessionId)).toEqual(["good-4"]);
  });
});

describe("readGuardPending — TOCTOU (file deleted after listing) is swallowed", () => {
  test("ENOENT from readFileSync between listing and reading does not throw", () => {
    const home = tempHome();
    const dir = pendingDir(home);
    // A real, valid file that survives.
    writeScopePending(home, "claude", "survivor00000000", jsPending({ session_id: "survivor" }));
    // A file that gets deleted AFTER directory listing but BEFORE read.
    const doomed = writeScopePending(home, "claude", "doomed0000000000", jsPending({ session_id: "doomed" }));

    // Monkey-patch readFileSync: first call to the doomed path throws ENOENT
    // (simulating the file being unlinked mid-iteration), other calls pass through.
    const fs = require("node:fs");
    const original = fs.readFileSync;
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    fs.readFileSync = (path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path === doomed) throw enoent;
      return original(path, ...rest);
    };

    let entries: PendingEntry[] = [];
    try {
      expect(() => {
        entries = readGuardPending({ homeDir: home, agent: "claude" });
      }).not.toThrow();
    } finally {
      fs.readFileSync = original;
    }
    void dir;
    expect(entries.map((e) => e.sessionId)).toEqual(["survivor"]);
  });
});

describe("readGuardPending — agent / status / cwd filtering", () => {
  test("entry with a mismatched agent field is dropped", () => {
    const home = tempHome();
    // File NAMED for codex but whose payload claims claude → must be rejected.
    writeScopePending(home, "codex", "agentmismatch0000", jsPending({ session_id: "wrong-agent", agent: "claude" }));
    writeScopePending(home, "codex", "rightagent000000", bashPending({ session_id: "right-agent", agent: "codex" }));

    const entries = readGuardPending({ homeDir: home, agent: "codex" });
    expect(entries.map((e) => e.sessionId)).toEqual(["right-agent"]);
  });

  test("non-paused status records are dropped (only active pauses count)", () => {
    const home = tempHome();
    writeScopePending(home, "codex", "resumedstatus000", bashPending({ session_id: "resumed-1", status: "resumed" }));
    writeScopePending(home, "codex", "clearedstatus000", bashPending({ session_id: "cleared-1", status: "cleared" }));
    writeScopePending(home, "codex", "pausedstatus0000", bashPending({ session_id: "paused-1", status: "paused" }));

    const entries = readGuardPending({ homeDir: home, agent: "codex" });
    expect(entries.map((e) => e.sessionId)).toEqual(["paused-1"]);
  });

  test("cwd filter keeps only entries whose cwd matches (cross-repo isolation)", () => {
    const home = tempHome();
    writeScopePending(home, "codex", "thisrepo00000000", bashPending({ session_id: "this-repo", cwd: "/repo/this" }));
    writeScopePending(home, "codex", "otherrepo0000000", bashPending({ session_id: "other-repo", cwd: "/repo/other" }));

    const entries = readGuardPending({ homeDir: home, agent: "codex", cwd: "/repo/this" });
    expect(entries.map((e) => e.sessionId)).toEqual(["this-repo"]);
  });

  test("no cwd filter → entries from any cwd are kept (backward compatible)", () => {
    const home = tempHome();
    writeScopePending(home, "codex", "repoa00000000000", bashPending({ session_id: "repo-a", cwd: "/repo/a" }));
    writeScopePending(home, "codex", "repob00000000000", bashPending({ session_id: "repo-b", cwd: "/repo/b" }));

    const sessions = readGuardPending({ homeDir: home, agent: "codex" }).map((e) => e.sessionId).sort();
    expect(sessions).toEqual(["repo-a", "repo-b"]);
  });

  test("symlink cwd matches when opts.cwd is the realpath (logical-path tolerant)", () => {
    // The guard writer records `cwd` as whatever process.cwd()/$(pwd) returns —
    // which may be a SYMLINK path (e.g. /tmp → /private/tmp on macOS, or a
    // symlinked checkout). The daemon resolves its own cwd via realpath. A raw
    // string compare misses this and yields a false-negative pendingExists=false.
    const realRoot = mkdtempSync(join(tmpdir(), "abg-pending-realdir-"));
    tmpDirs.push(realRoot);
    // The actual project dir lives under the resolved (realpath) root.
    const realProject = join(realpathSync(realRoot), "project");
    mkdirSync(realProject, { recursive: true });
    // A symlink pointing at the real project; this is what the guard writer saw.
    const linkRoot = mkdtempSync(join(tmpdir(), "abg-pending-link-"));
    tmpDirs.push(linkRoot);
    const symlinkPath = join(linkRoot, "project-link");
    symlinkSync(realProject, symlinkPath, "dir");

    const home = tempHome();
    // entry.cwd = the SYMLINK path (what the guard recorded).
    writeScopePending(home, "codex", "symlinkcwd000000", bashPending({ session_id: "via-symlink", cwd: symlinkPath }));

    // opts.cwd = the REALPATH (what the daemon resolved). Raw `!==` compare fails;
    // a realpath-aware match must keep this entry.
    const entries = readGuardPending({ homeDir: home, agent: "codex", cwd: realProject });
    expect(entries.map((e) => e.sessionId)).toEqual(["via-symlink"]);
  });

  test("cross-repo entry still excluded even with realpath-aware match (distinct realpaths)", () => {
    // Two genuinely different real directories must NOT collide just because the
    // match got smarter — the realpath of one is not the realpath of the other.
    const homeProjects = mkdtempSync(join(tmpdir(), "abg-pending-crossrepo-"));
    tmpDirs.push(homeProjects);
    const root = realpathSync(homeProjects);
    const thisRepo = join(root, "this");
    const otherRepo = join(root, "other");
    mkdirSync(thisRepo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });

    const home = tempHome();
    writeScopePending(home, "codex", "crossthis0000000", bashPending({ session_id: "this-repo", cwd: thisRepo }));
    writeScopePending(home, "codex", "crossother000000", bashPending({ session_id: "other-repo", cwd: otherRepo }));

    const entries = readGuardPending({ homeDir: home, agent: "codex", cwd: thisRepo });
    expect(entries.map((e) => e.sessionId)).toEqual(["this-repo"]);
  });
});

describe("readGuardPending — homeDir injection isolation", () => {
  test("only reads under the injected homeDir, never the real HOME", () => {
    const home = tempHome();
    writeScopePending(home, "claude", "abcdef0123456789", jsPending({ session_id: "isolated" }));

    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    // Every cwd we wrote lives under our fixture; nothing from the real machine.
    expect(entries.every((e) => typeof e.cwd === "string")).toBe(true);
    expect(entries.map((e) => e.sessionId)).toEqual(["isolated"]);
  });
});

describe("readGuardPending — BUDGET_STATE_DIR env override", () => {
  /**
   * Write a per-scope pending file directly under an EXPLICIT state dir
   * (<stateDir>/pending/<agent>_<scope>.json), bypassing the homeDir layout.
   */
  function writeScopePendingAtStateDir(stateDir: string, agent: AgentName, scope: string, payload: unknown): string {
    const dir = join(stateDir, "pending");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${agent}_${scope}.json`);
    writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload), "utf-8");
    return path;
  }

  test("BUDGET_STATE_DIR overrides homeDir for the state dir resolution", () => {
    // homeDir points at an EMPTY fixture (no pending) — if it were used, the read
    // would return []. The override state dir holds the only pending file.
    const home = tempHome();
    pendingDir(home); // exists but empty under the home layout

    const stateDir = mkdtempSync(join(tmpdir(), "abg-pending-statedir-"));
    tmpDirs.push(stateDir);
    writeScopePendingAtStateDir(stateDir, "claude", "envoverride00000", jsPending({ session_id: "from-env" }));

    process.env.BUDGET_STATE_DIR = stateDir;
    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    // Resolution used the env override, not homeDir's empty pending dir.
    expect(entries.map((e) => e.sessionId)).toEqual(["from-env"]);
  });

  test("whitespace-only BUDGET_STATE_DIR is ignored, falling back to homeDir", () => {
    // resolveStateDir treats a blank/whitespace override as absent.
    const home = tempHome();
    writeScopePending(home, "claude", "blankoverride000", jsPending({ session_id: "from-home" }));

    process.env.BUDGET_STATE_DIR = "   ";
    const entries = readGuardPending({ homeDir: home, agent: "claude" });
    expect(entries.map((e) => e.sessionId)).toEqual(["from-home"]);
  });
});
