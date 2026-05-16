import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "../state-dir";

describe("StateDirResolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("uses env override when provided", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.dir).toBe(tempDir);
  });

  test("returns correct file paths under state dir", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.pidFile).toBe(join(tempDir, "daemon.pid"));
    expect(resolver.tuiPidFile).toBe(join(tempDir, "codex-tui.pid"));
    expect(resolver.lockFile).toBe(join(tempDir, "daemon.lock"));
    expect(resolver.statusFile).toBe(join(tempDir, "status.json"));
    expect(resolver.portsFile).toBe(join(tempDir, "ports.json"));
    expect(resolver.logFile).toBe(join(tempDir, "agentbridge.log"));
  });

  test("ensure() creates directory if it does not exist", () => {
    const nested = join(tempDir, "nested", "state");
    const resolver = new StateDirResolver(nested);
    resolver.ensure();
    expect(Bun.file(nested).size).toBeUndefined; // directory exists
    // Verify by writing a file
    const { writeFileSync, existsSync } = require("node:fs");
    writeFileSync(join(nested, "test.txt"), "ok");
    expect(existsSync(join(nested, "test.txt"))).toBe(true);
  });

  test("ensure() is idempotent", () => {
    const resolver = new StateDirResolver(tempDir);
    resolver.ensure();
    resolver.ensure(); // should not throw
    expect(resolver.dir).toBe(tempDir);
  });

  test("uses platform default when no override", () => {
    // Just verify it doesn't throw and returns a non-empty string
    const resolver = new StateDirResolver();
    expect(resolver.dir.length).toBeGreaterThan(0);
  });

  // ── STM v2.3 §D5 P3d — per-pair file path methods ─────────────────────

  test("pairDir returns <stateDir>/pairs/<pairId>", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.pairDir("default")).toBe(join(tempDir, "pairs", "default"));
    expect(resolver.pairDir("work")).toBe(join(tempDir, "pairs", "work"));
  });

  test("pairCodexPidFile returns <stateDir>/pairs/<pairId>/codex.pid", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.pairCodexPidFile("default")).toBe(join(tempDir, "pairs", "default", "codex.pid"));
    expect(resolver.pairCodexPidFile("work")).toBe(join(tempDir, "pairs", "work", "codex.pid"));
  });

  test("pairCodexWrapperLogFile returns <stateDir>/pairs/<pairId>/codex-wrapper.log", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.pairCodexWrapperLogFile("default")).toBe(
      join(tempDir, "pairs", "default", "codex-wrapper.log"),
    );
  });

  test("ensurePairDir creates the per-pair subdir, idempotent", () => {
    const resolver = new StateDirResolver(tempDir);
    resolver.ensure();
    resolver.ensurePairDir("default");
    resolver.ensurePairDir("default"); // idempotent

    const { writeFileSync, existsSync } = require("node:fs");
    writeFileSync(join(resolver.pairDir("default"), "marker"), "ok");
    expect(existsSync(join(resolver.pairDir("default"), "marker"))).toBe(true);
  });
});
