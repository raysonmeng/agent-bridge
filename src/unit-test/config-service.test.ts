import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigService, DEFAULT_CONFIG } from "../config-service";

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
    expect(config.codex.appPort).toBe(4500);
    expect(config.codex.proxyPort).toBe(4501);
    expect(config.turnCoordination.attentionWindowSeconds).toBe(15);
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

  test("load normalizes legacy daemon config into codex config", () => {
    const svc = new ConfigService(tempDir);
    const configPath = join(tempDir, ".agentbridge", "config.json");
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          daemon: {
            port: 4600,
            proxyPort: 4601,
          },
          turnCoordination: {
            attentionWindowSeconds: 20,
            busyGuard: true,
          },
          idleShutdownSeconds: 45,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const loaded = svc.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.codex.appPort).toBe(4600);
    expect(loaded!.codex.proxyPort).toBe(4601);
    expect(loaded!.turnCoordination.attentionWindowSeconds).toBe(20);
    expect(loaded!.idleShutdownSeconds).toBe(45);
  });

  test("initDefaults creates only config.json", () => {
    const svc = new ConfigService(tempDir);
    const created = svc.initDefaults();

    expect(created.length).toBe(1);
    expect(existsSync(svc.configFilePath)).toBe(true);
    expect(existsSync(join(tempDir, ".agentbridge", "collaboration.md"))).toBe(false);

    // Verify content
    const config = svc.load();
    expect(config!.version).toBe("1.0");
  });

  test("initDefaults does not overwrite existing files", () => {
    const svc = new ConfigService(tempDir);

    // Create custom config first
    const custom = { ...DEFAULT_CONFIG, idleShutdownSeconds: 99 };
    svc.save(custom);

    // initDefaults should skip config.json when it already exists
    const created = svc.initDefaults();
    expect(created.length).toBe(0);

    const loaded = svc.load();
    expect(loaded!.idleShutdownSeconds).toBe(99); // not overwritten
  });

  test("config file paths are correct", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.configFilePath).toBe(join(tempDir, ".agentbridge", "config.json"));
  });
});
