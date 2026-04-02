import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigService, DEFAULT_CONFIG, DEFAULT_COLLABORATION_MD } from "../config-service";

describe("ConfigService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("hasConfig returns false when no config exists", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.hasConfig()).toBe(false);
  });

  test("load returns null when no config exists", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.load()).toBeNull();
  });

  test("loadOrDefault returns defaults when no config exists", () => {
    const svc = new ConfigService(tempDir);
    const config = svc.loadOrDefault();
    expect(config.version).toBe("1.0");
    expect(config.daemon.port).toBe(4500);
    expect(config.daemon.proxyPort).toBe(4501);
    expect(config.agents.claude.role).toBe("Reviewer, Planner");
    expect(config.agents.codex.role).toBe("Implementer, Executor");
  });

  test("save and load round-trips correctly", () => {
    const svc = new ConfigService(tempDir);
    const config = { ...DEFAULT_CONFIG, idleShutdownSeconds: 60 };
    svc.save(config);

    expect(svc.hasConfig()).toBe(true);

    const loaded = svc.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.idleShutdownSeconds).toBe(60);
    expect(loaded!.version).toBe("1.0");
  });

  test("saveCollaboration and loadCollaboration round-trips", () => {
    const svc = new ConfigService(tempDir);
    const content = "# Custom rules\nBe nice.";
    svc.saveCollaboration(content);

    const loaded = svc.loadCollaboration();
    expect(loaded).toBe(content);
  });

  test("loadCollaboration returns null when file missing", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.loadCollaboration()).toBeNull();
  });

  test("initDefaults creates both files", () => {
    const svc = new ConfigService(tempDir);
    const created = svc.initDefaults();

    expect(created.length).toBe(2);
    expect(existsSync(svc.configFilePath)).toBe(true);
    expect(existsSync(svc.collaborationFilePath)).toBe(true);

    // Verify content
    const config = svc.load();
    expect(config!.version).toBe("1.0");

    const collab = svc.loadCollaboration();
    expect(collab).toContain("# Collaboration Rules");
  });

  test("initDefaults does not overwrite existing files", () => {
    const svc = new ConfigService(tempDir);

    // Create custom config first
    const custom = { ...DEFAULT_CONFIG, idleShutdownSeconds: 99 };
    svc.save(custom);

    // initDefaults should skip config.json but create collaboration.md
    const created = svc.initDefaults();
    expect(created.length).toBe(1); // only collaboration.md

    const loaded = svc.load();
    expect(loaded!.idleShutdownSeconds).toBe(99); // not overwritten
  });

  test("config file paths are correct", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.configFilePath).toBe(join(tempDir, ".agentbridge", "config.json"));
    expect(svc.collaborationFilePath).toBe(join(tempDir, ".agentbridge", "collaboration.md"));
  });
});
