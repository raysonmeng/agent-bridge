import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDirResolver } from "../state-dir";
import {
  findCodexRolloutFile,
  persistCurrentThreadWithRolloutRetry,
  persistCodexContractInjection,
  promoteCurrentThreadIfRolloutExists,
  readCodexContractHash,
  readCodexContractState,
  readRawCurrentThread,
  readUsableCurrentThread,
  writePendingCurrentThread,
} from "../thread-state";

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function identity(root: string, codexHome: string) {
  return {
    stateDir: new StateDirResolver(join(root, "pair-state")),
    pairId: "main-12345678",
    pairName: "main",
    cwd: root,
    env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
  };
}

describe("thread-state", () => {
  test("persists runtime contract idempotency per (threadId, contractHash)", () => {
    const root = tempDir("agentbridge-contract-state-");
    try {
      const stateDir = new StateDirResolver(join(root, "pair-state"));
      persistCodexContractInjection(stateDir, "thread-A", "aaaaaaaaaaaa");
      persistCodexContractInjection(stateDir, "thread-B", "bbbbbbbbbbbb");

      expect(readCodexContractHash(stateDir, "thread-A")).toBe("aaaaaaaaaaaa");
      expect(readCodexContractHash(stateDir, "thread-B")).toBe("bbbbbbbbbbbb");
      expect(readCodexContractHash(stateDir, "thread-missing")).toBeNull();

      persistCodexContractInjection(stateDir, "thread-A", "cccccccccccc");
      const state = readCodexContractState(stateDir);
      expect(state.version).toBe(1);
      expect(state.injections).toHaveLength(2);
      expect(readCodexContractHash(stateDir, "thread-A")).toBe("cccccccccccc");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing or corrupt runtime contract state is treated as empty", () => {
    const root = tempDir("agentbridge-contract-state-");
    try {
      const stateDir = new StateDirResolver(join(root, "pair-state"));
      expect(readCodexContractState(stateDir)).toEqual({ version: 1, injections: [] });

      mkdirSync(stateDir.dir, { recursive: true });
      writeFileSync(stateDir.codexContractStateFile, "{broken", "utf-8");
      expect(readCodexContractState(stateDir)).toEqual({ version: 1, injections: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid contract hashes instead of interpolating untrusted state", () => {
    const root = tempDir("agentbridge-contract-state-");
    try {
      const stateDir = new StateDirResolver(join(root, "pair-state"));
      expect(() => persistCodexContractInjection(
        stateDir,
        "thread-A",
        "not-a-contract-hash",
      )).toThrow("12-character lowercase hex hash");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pending current thread is not usable for resume", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      writePendingCurrentThread(id, "thread-pending", "test");

      expect(readUsableCurrentThread(id, id.env)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("rollout-backed current thread is usable", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      const rolloutPath = join(sessionsDir, "rollout-thread-current.jsonl");
      writeFileSync(rolloutPath, "{}\n", "utf-8");

      const id = identity(root, codexHome);
      const state = promoteCurrentThreadIfRolloutExists(id, "thread-current", "test", id.env);

      expect(state.status).toBe("current");
      expect(state.rolloutPath).toBe(rolloutPath);
      expect(readUsableCurrentThread(id, id.env)?.threadId).toBe("thread-current");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("persistCurrentThreadWithRolloutRetry promotes to current once the rollout appears", async () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "rollout-thread-X.jsonl"), "{}\n", "utf-8");
      const id = identity(root, codexHome);

      const state = await persistCurrentThreadWithRolloutRetry(id, "thread-X", "test", {
        env: id.env,
        attempts: 2,
        delayMs: 1,
      });

      expect(state?.status).toBe("current");
      expect(readUsableCurrentThread(id, id.env)?.threadId).toBe("thread-X");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("a superseded persistence loop abandons and does not clobber the active thread's mapping", async () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      // "thread-B" is the active, newer thread already on disk.
      writePendingCurrentThread(id, "thread-B", "newer");

      // A stale loop for "thread-A" whose guard reports it is already superseded
      // must write nothing and return null — current-thread.json stays thread-B.
      const result = await persistCurrentThreadWithRolloutRetry(id, "thread-A", "stale", {
        env: id.env,
        attempts: 5,
        delayMs: 1,
        shouldContinue: () => false,
      });

      expect(result).toBeNull();
      expect(readRawCurrentThread(id.stateDir)?.threadId).toBe("thread-B");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("pending thread with an existing rollout is promoted to current on read", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      // Daemon gave up within its 5s retry window — state is left pending …
      writePendingCurrentThread(id, "thread-late", "test");

      // … but the rollout file shows up later (Codex kept running).
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      const rolloutPath = join(sessionsDir, "rollout-thread-late.jsonl");
      writeFileSync(rolloutPath, "{}\n", "utf-8");

      const usable = readUsableCurrentThread(id, id.env);
      expect(usable).not.toBeNull();
      expect(usable?.status).toBe("current");
      expect(usable?.threadId).toBe("thread-late");
      expect(usable?.rolloutPath).toBe(rolloutPath);
      expect(usable?.rolloutVerifiedAt).toBeTruthy();

      // The promotion must be persisted (atomically) — re-read from disk.
      const persisted = readRawCurrentThread(id.stateDir);
      expect(persisted?.status).toBe("current");
      expect(persisted?.rolloutPath).toBe(rolloutPath);
      expect(persisted?.rolloutVerifiedAt).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("pending thread without a rollout stays pending on disk and unusable", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      writePendingCurrentThread(id, "thread-no-rollout", "test");

      expect(readUsableCurrentThread(id, id.env)).toBeNull();

      const persisted = readRawCurrentThread(id.stateDir);
      expect(persisted?.status).toBe("pending");
      expect(persisted?.threadId).toBe("thread-no-rollout");
      expect(persisted?.rolloutPath).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("pending thread with mismatched pairId is not promoted even when the rollout exists", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      writePendingCurrentThread(id, "thread-other-pair", "test");

      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "rollout-thread-other-pair.jsonl"), "{}\n", "utf-8");

      const otherPair = { ...id, pairId: "other-87654321" };
      expect(readUsableCurrentThread(otherPair, id.env)).toBeNull();
      // Identity check wins: the record must remain untouched (still pending).
      expect(readRawCurrentThread(id.stateDir)?.status).toBe("pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("pending thread with mismatched cwd is not promoted even when the rollout exists", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      writePendingCurrentThread(id, "thread-other-cwd", "test");

      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "rollout-thread-other-cwd.jsonl"), "{}\n", "utf-8");

      const otherCwd = { ...id, cwd: join(root, "elsewhere") };
      expect(readUsableCurrentThread(otherCwd, id.env)).toBeNull();
      expect(readRawCurrentThread(id.stateDir)?.status).toBe("pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("current thread with a stale rolloutPath is repaired by re-finding the rollout", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      const oldPath = join(sessionsDir, "rollout-thread-moved.jsonl");
      writeFileSync(oldPath, "{}\n", "utf-8");

      const id = identity(root, codexHome);
      const state = promoteCurrentThreadIfRolloutExists(id, "thread-moved", "test", id.env);
      expect(state.status).toBe("current");
      expect(state.rolloutPath).toBe(oldPath);

      // Codex relocated the rollout (e.g. archive layout change).
      const newDir = join(codexHome, "sessions", "2026", "06", "03");
      mkdirSync(newDir, { recursive: true });
      const newPath = join(newDir, "rollout-thread-moved.jsonl");
      writeFileSync(newPath, "{}\n", "utf-8");
      rmSync(oldPath);

      const usable = readUsableCurrentThread(id, id.env);
      expect(usable?.status).toBe("current");
      expect(usable?.rolloutPath).toBe(newPath);
      expect(readRawCurrentThread(id.stateDir)?.rolloutPath).toBe(newPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("findCodexRolloutFile returns null when sessions are absent", () => {
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      expect(findCodexRolloutFile("missing", { CODEX_HOME: codexHome } as NodeJS.ProcessEnv)).toBeNull();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
