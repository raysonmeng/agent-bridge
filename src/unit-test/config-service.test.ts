import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigService, DEFAULT_CONFIG, applyBudgetEnvOverrides } from "../config-service";

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

  test("load normalizes string numbers in legacy config", () => {
    const svc = new ConfigService(tempDir);
    const configPath = join(tempDir, ".agentbridge", "config.json");
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: "1.0",
          daemon: {
            port: "4600",
            proxyPort: "4601",
          },
          turnCoordination: {
            attentionWindowSeconds: "20",
          },
          idleShutdownSeconds: "45",
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

describe("ConfigService — budget section", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-budget-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRawConfig(raw: unknown) {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(join(tempDir, ".agentbridge", "config.json"), JSON.stringify(raw));
  }

  test("loadOrDefault includes budget defaults", () => {
    const svc = new ConfigService(tempDir);
    const config = svc.loadOrDefault();
    expect(config.budget).toEqual({
      enabled: true,
      pollSeconds: 300,
      pauseAt: 90,
      resumeBelow: 30,
      syncDriftPct: 10,
      parallel: { minRemainingPct: 60, timeWindowSec: 3600 },
      codexTierControl: false,
      codexTiers: {
        full: null,
        balanced: { effort: "medium" },
        eco: { effort: "low" },
      },
    });
  });

  test("load fills budget defaults when section is missing", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ version: "1.0" });
    const loaded = svc.load();
    expect(loaded!.budget.pauseAt).toBe(90);
    expect(loaded!.budget.enabled).toBe(true);
  });

  test("load accepts valid custom budget values", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({
      budget: {
        enabled: false,
        pollSeconds: 120,
        pauseAt: 85,
        resumeBelow: 20,
        syncDriftPct: 8,
        parallel: { minRemainingPct: 50, timeWindowSec: 1800 },
        codexTierControl: true,
        codexTiers: { full: { effort: "high" }, eco: { effort: "minimal" } },
      },
    });
    const loaded = svc.load();
    expect(loaded!.budget).toEqual({
      enabled: false,
      pollSeconds: 120,
      pauseAt: 85,
      resumeBelow: 20,
      syncDriftPct: 8,
      parallel: { minRemainingPct: 50, timeWindowSec: 1800 },
      codexTierControl: true,
      codexTiers: {
        full: { effort: "high" },
        balanced: { effort: "medium" }, // unspecified tier keeps the default
        eco: { effort: "minimal" },
      },
    });
  });

  test("codexTierControl degrades to false when codexTiers.full is missing", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ budget: { codexTierControl: true } });
    const loaded = svc.load();
    // Sticky turn/start overrides need an explicit restore point.
    expect(loaded!.budget.codexTierControl).toBe(false);
    expect(loaded!.budget.codexTiers.full).toBeNull();
  });

  test("tier overrides drop empty/non-string fields", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({
      budget: {
        codexTierControl: true,
        codexTiers: {
          full: { effort: "  high  ", model: "" },
          balanced: { effort: 5 },
        },
      },
    });
    const loaded = svc.load();
    expect(loaded!.budget.codexTiers.full).toEqual({ effort: "high" }); // trimmed, empty model dropped
    expect(loaded!.budget.codexTiers.balanced).toEqual({ effort: "medium" }); // invalid → default
    expect(loaded!.budget.codexTierControl).toBe(true);
  });

  test("out-of-range budget values fall back to defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({
      budget: {
        pollSeconds: 1, // below min 5
        pauseAt: 150, // above 100
        syncDriftPct: 0, // below min 1
        parallel: { minRemainingPct: 200, timeWindowSec: 10 },
      },
    });
    const loaded = svc.load();
    expect(loaded!.budget.pollSeconds).toBe(300);
    expect(loaded!.budget.pauseAt).toBe(90);
    expect(loaded!.budget.syncDriftPct).toBe(10);
    expect(loaded!.budget.parallel.minRemainingPct).toBe(60);
    expect(loaded!.budget.parallel.timeWindowSec).toBe(3600);
  });

  test("pauseAt <= resumeBelow resets BOTH thresholds to defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ budget: { pauseAt: 25, resumeBelow: 40 } });
    const loaded = svc.load();
    // An unsatisfiable pause lifecycle must never survive normalization.
    expect(loaded!.budget.pauseAt).toBe(90);
    expect(loaded!.budget.resumeBelow).toBe(30);
  });

  test("non-boolean enabled/codexTierControl fall back to defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ budget: { enabled: "yes", codexTierControl: 1 } });
    const loaded = svc.load();
    expect(loaded!.budget.enabled).toBe(true);
    expect(loaded!.budget.codexTierControl).toBe(false);
  });
});

describe("applyBudgetEnvOverrides", () => {
  const base = {
    enabled: true,
    pollSeconds: 60,
    pauseAt: 90,
    resumeBelow: 30,
    syncDriftPct: 10,
    parallel: { minRemainingPct: 60, timeWindowSec: 3600 },
    codexTierControl: false,
    codexTiers: {
      full: { effort: "high" }, // restore point present so env can flip tier control on
      balanced: { effort: "medium" },
      eco: { effort: "low" },
    },
  };

  test("env values override the base config", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_ENABLED: "false",
      AGENTBRIDGE_BUDGET_POLL_SECONDS: "30",
      AGENTBRIDGE_BUDGET_PAUSE_AT: "88",
      AGENTBRIDGE_BUDGET_CODEX_TIER_CONTROL: "true",
    });
    expect(result.enabled).toBe(false);
    expect(result.pollSeconds).toBe(30);
    expect(result.pauseAt).toBe(88);
    expect(result.codexTierControl).toBe(true);
    // Untouched keys keep base values.
    expect(result.resumeBelow).toBe(30);
    expect(result.parallel.timeWindowSec).toBe(3600);
  });

  test("invalid env values are ignored via boundary rules", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_POLL_SECONDS: "not-a-number",
      AGENTBRIDGE_BUDGET_PAUSE_AT: "9000",
    });
    expect(result.pollSeconds).toBe(60);
    expect(result.pauseAt).toBe(90);
  });

  test("env-induced pauseAt <= resumeBelow resets both to defaults", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_PAUSE_AT: "20",
    });
    expect(result.pauseAt).toBe(90);
    expect(result.resumeBelow).toBe(30);
  });

  test("empty env returns the base config unchanged", () => {
    expect(applyBudgetEnvOverrides(base, {})).toEqual(base);
  });
});

describe("applyBudgetEnvOverrides — boolean spellings", () => {
  const base = {
    enabled: true,
    pollSeconds: 60,
    pauseAt: 90,
    resumeBelow: 30,
    syncDriftPct: 10,
    parallel: { minRemainingPct: 60, timeWindowSec: 3600 },
    codexTierControl: false,
    codexTiers: {
      full: { effort: "high" },
      balanced: { effort: "medium" },
      eco: { effort: "low" },
    },
  };

  test('accepts "0"/"1" alongside "true"/"false"', () => {
    const zeroOne = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_ENABLED: "0",
      AGENTBRIDGE_BUDGET_CODEX_TIER_CONTROL: "1",
    });
    expect(zeroOne.enabled).toBe(false);
    expect(zeroOne.codexTierControl).toBe(true);
  });

  test("unrecognized boolean spellings fall back to base values", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_ENABLED: "yes",
    });
    expect(result.enabled).toBe(true);
  });
});
