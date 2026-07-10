import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigService,
  DEFAULT_CONFIG,
  applyBudgetEnvOverrides,
  normalizeBoundedNumber,
  type AgentBridgeConfig,
} from "../config-service";

/**
 * Helper: unwrap a parsed load() result, failing the test loudly if the config
 * was absent/corrupt. Most existing tests expect a good parse; this keeps them
 * terse while the new discriminated contract is exercised explicitly elsewhere.
 */
function expectParsed(svc: ConfigService): AgentBridgeConfig {
  const result = svc.load();
  expect(result.state).toBe("parsed");
  if (result.state !== "parsed") throw new Error("unreachable");
  return result.config;
}

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

  test("load reports absent when no config exists", () => {
    const svc = new ConfigService(tempDir);
    // Previously `load()` returned null for ENOENT; the discriminated contract
    // distinguishes this normal-absence case from corruption.
    expect(svc.load()).toEqual({ state: "absent" });
  });

  test("loadOrDefault returns defaults when no config exists", () => {
    const svc = new ConfigService(tempDir);
    const config = svc.loadOrDefault();
    expect(config.version).toBe("1.0");
    expect(config.codex.appPort).toBe(4500);
    expect(config.codex.proxyPort).toBe(4501);
    expect(config.turnCoordination.attentionWindowSeconds).toBe(15);
    expect(config.injection.runtime).toBe(true);
  });

  test("save and load round-trips correctly", () => {
    const svc = new ConfigService(tempDir);
    const config = { ...DEFAULT_CONFIG, idleShutdownSeconds: 60 };
    svc.save(config);

    expect(svc.hasConfig()).toBe(true);

    const loaded = expectParsed(svc);
    expect(loaded.idleShutdownSeconds).toBe(60);
    expect(loaded.version).toBe("1.0");
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

    const loaded = expectParsed(svc);
    expect(loaded.codex.appPort).toBe(4600);
    expect(loaded.codex.proxyPort).toBe(4601);
    expect(loaded.turnCoordination.attentionWindowSeconds).toBe(20);
    expect(loaded.idleShutdownSeconds).toBe(45);
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

    const loaded = expectParsed(svc);
    expect(loaded.codex.appPort).toBe(4600);
    expect(loaded.codex.proxyPort).toBe(4601);
    expect(loaded.turnCoordination.attentionWindowSeconds).toBe(20);
    expect(loaded.idleShutdownSeconds).toBe(45);
  });

  test("load reads injection.runtime and defaults invalid or absent values to true", () => {
    const configDir = join(tempDir, ".agentbridge");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });

    writeFileSync(configPath, JSON.stringify({ injection: { runtime: false } }));
    expect(expectParsed(new ConfigService(tempDir)).injection.runtime).toBe(false);
    expect(new ConfigService(tempDir).describeConfig().customValues).toBe(true);

    writeFileSync(configPath, JSON.stringify({ injection: { runtime: "off" } }));
    expect(expectParsed(new ConfigService(tempDir)).injection.runtime).toBe(true);

    writeFileSync(configPath, JSON.stringify({}));
    expect(expectParsed(new ConfigService(tempDir)).injection.runtime).toBe(true);
  });

  test("initDefaults creates only config.json", () => {
    const svc = new ConfigService(tempDir);
    const created = svc.initDefaults();

    expect(created.length).toBe(1);
    expect(existsSync(svc.configFilePath)).toBe(true);
    expect(existsSync(join(tempDir, ".agentbridge", "collaboration.md"))).toBe(false);

    // Verify content
    const config = expectParsed(svc);
    expect(config.version).toBe("1.0");
  });

  test("initDefaults does not overwrite existing files", () => {
    const svc = new ConfigService(tempDir);

    // Create custom config first
    const custom = { ...DEFAULT_CONFIG, idleShutdownSeconds: 99 };
    svc.save(custom);

    // initDefaults should skip config.json when it already exists
    const created = svc.initDefaults();
    expect(created.length).toBe(0);

    const loaded = expectParsed(svc);
    expect(loaded.idleShutdownSeconds).toBe(99); // not overwritten
  });

  test("config file paths are correct", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.configFilePath).toBe(join(tempDir, ".agentbridge", "config.json"));
  });
});

describe("ConfigService — fail-loud on corrupt config (P1)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-config-corrupt-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRaw(raw: string) {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(join(tempDir, ".agentbridge", "config.json"), raw);
  }

  // ---- load() discriminated states ----

  test("ENOENT → absent (not corrupt)", () => {
    const svc = new ConfigService(tempDir);
    expect(svc.load()).toEqual({ state: "absent" });
  });

  test("malformed JSON → corrupt", () => {
    const svc = new ConfigService(tempDir);
    writeRaw("{ not valid json");
    const result = svc.load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") {
      expect(result.reason).toContain("not valid JSON");
    }
  });

  test("valid JSON but not an object → corrupt", () => {
    const svc = new ConfigService(tempDir);
    writeRaw("[1, 2, 3]");
    const result = svc.load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") {
      expect(result.reason).toContain("not a JSON object");
    }
  });

  test("valid JSON, wrong shape (non-numeric budget threshold) → corrupt", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ budget: { pauseAt: "ninety" } }));
    const result = svc.load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") {
      expect(result.reason).toContain("budget.pauseAt");
    }
  });

  test("valid JSON, non-numeric idleShutdownSeconds → corrupt", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ idleShutdownSeconds: "soon" }));
    const result = svc.load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") {
      expect(result.reason).toContain("idleShutdownSeconds");
    }
  });

  test("valid JSON, budget present but not an object → corrupt", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ budget: "tight" }));
    const result = svc.load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") {
      expect(result.reason).toContain("budget is present but not an object");
    }
  });

  test("valid JSON, non-numeric parallel field → corrupt", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ budget: { parallel: { timeWindowSec: "later" } } }));
    const result = svc.load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") {
      expect(result.reason).toContain("budget.parallel.timeWindowSec");
    }
  });

  test("valid good config → parsed", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ budget: { pauseAt: 85, resumeBelow: 20 } }));
    const result = svc.load();
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.config.budget.pauseAt).toBe(85);
    }
  });

  test("absent budget section is NOT corrupt (legacy/partial config normalizes to defaults)", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ version: "1.0" }));
    const result = svc.load();
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.config.budget.pauseAt).toBe(90);
    }
  });

  test("string-number thresholds stay valid (coercible, not corrupt)", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ idleShutdownSeconds: "45", budget: { pauseAt: "85", resumeBelow: "20" } }));
    const result = svc.load();
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.config.idleShutdownSeconds).toBe(45);
      expect(result.config.budget.pauseAt).toBe(85);
    }
  });

  // ---- loadOrDefault() warning behavior ----

  test("loadOrDefault logs a warning ONLY on corrupt; returns defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRaw("{ broken");
    const warnings: string[] = [];
    const config = svc.loadOrDefault((msg) => warnings.push(msg));

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.length).toBe(1); // exactly one clear line, no spam
    expect(warnings[0]).toContain("NOT in effect");
  });

  test("loadOrDefault does NOT log on ENOENT (normal absence)", () => {
    const svc = new ConfigService(tempDir);
    const warnings: string[] = [];
    const config = svc.loadOrDefault((msg) => warnings.push(msg));

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.length).toBe(0);
  });

  test("loadOrDefault does NOT log on a good config", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ budget: { pauseAt: 85, resumeBelow: 20 } }));
    const warnings: string[] = [];
    const config = svc.loadOrDefault((msg) => warnings.push(msg));

    expect(warnings.length).toBe(0);
    expect(config.budget.pauseAt).toBe(85);
  });

  test("loadOrDefault works with the default no-arg logger (no throw)", () => {
    const svc = new ConfigService(tempDir);
    writeRaw("{ broken");
    // The default no-op logger path must keep existing callers working.
    expect(() => svc.loadOrDefault()).not.toThrow();
    expect(svc.loadOrDefault()).toEqual(DEFAULT_CONFIG);
  });

  // ---- describeConfig() for doctor ----

  test("describeConfig reports absent when no config exists", () => {
    const svc = new ConfigService(tempDir);
    const desc = svc.describeConfig();
    expect(desc.state).toBe("absent");
    expect(desc.customValues).toBe(false);
  });

  test("describeConfig reports corrupt with a reason", () => {
    const svc = new ConfigService(tempDir);
    writeRaw("{ broken");
    const desc = svc.describeConfig();
    expect(desc.state).toBe("corrupt");
    expect(desc.reason).toBeDefined();
    expect(desc.customValues).toBe(false);
  });

  test("describeConfig reports parsed with customValues=false when all match defaults", () => {
    const svc = new ConfigService(tempDir);
    svc.save(structuredClone(DEFAULT_CONFIG));
    const desc = svc.describeConfig();
    expect(desc.state).toBe("parsed");
    expect(desc.customValues).toBe(false);
  });

  test("describeConfig reports parsed with customValues=true when a threshold differs", () => {
    const svc = new ConfigService(tempDir);
    writeRaw(JSON.stringify({ budget: { pauseAt: 85, resumeBelow: 20 } }));
    const desc = svc.describeConfig();
    expect(desc.state).toBe("parsed");
    expect(desc.customValues).toBe(true);
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

  function loadBudget(svc: ConfigService) {
    const result = svc.load();
    expect(result.state).toBe("parsed");
    if (result.state !== "parsed") throw new Error("unreachable");
    return result.config.budget;
  }

  test("loadOrDefault includes budget defaults", () => {
    const svc = new ConfigService(tempDir);
    const config = svc.loadOrDefault();
    expect(config.budget).toEqual({
      enabled: true,
      pollSeconds: 300,
      budgetFreshTtlSec: 25,
      idleAdviceActivityWindowSec: 600,
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
      maximize: { targetUtil: 98, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
      allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
    });
  });

  test("load fills budget defaults when section is missing", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ version: "1.0" });
    const budget = loadBudget(svc);
    expect(budget.pauseAt).toBe(90);
    expect(budget.enabled).toBe(true);
  });

  test("v3.2: a legacy config carrying strategy:'conserve' is tolerated (key ignored, not corrupt)", () => {
    const svc = new ConfigService(tempDir);
    // The v3.2 default is the always-on dynamic line; the removed `strategy` key
    // must not break an upgraded user's old config — it parses fine, the key is
    // silently ignored, and the rest of the budget normalizes as usual.
    writeRawConfig({ budget: { strategy: "conserve", pauseAt: 85 } });
    expect(svc.load().state).toBe("parsed");
    const budget = loadBudget(svc);
    expect("strategy" in budget).toBe(false); // field is gone, not carried through
    expect(budget.pauseAt).toBe(85); // the rest still applies
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
    const budget = loadBudget(svc);
    expect(budget).toEqual({
      enabled: false,
      pollSeconds: 120,
      budgetFreshTtlSec: 25,
      idleAdviceActivityWindowSec: 600,
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
      // v3 P1 keys absent in the raw file normalize to defaults.
      maximize: { targetUtil: 98, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
      allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
    });
  });

  test("codexTierControl degrades to false when codexTiers.full is missing", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ budget: { codexTierControl: true } });
    const budget = loadBudget(svc);
    // Sticky turn/start overrides need an explicit restore point.
    expect(budget.codexTierControl).toBe(false);
    expect(budget.codexTiers.full).toBeNull();
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
    const budget = loadBudget(svc);
    expect(budget.codexTiers.full).toEqual({ effort: "high" }); // trimmed, empty model dropped
    expect(budget.codexTiers.balanced).toEqual({ effort: "medium" }); // invalid → default
    expect(budget.codexTierControl).toBe(true);
  });

  test("out-of-range budget values fall back to defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({
      budget: {
        pollSeconds: 1, // below min 5 — coercible number, NOT shape-invalid
        pauseAt: 150, // above 100
        syncDriftPct: 0, // below min 1
        parallel: { minRemainingPct: 200, timeWindowSec: 10 },
      },
    });
    const budget = loadBudget(svc);
    expect(budget.pollSeconds).toBe(300);
    expect(budget.pauseAt).toBe(90);
    expect(budget.syncDriftPct).toBe(10);
    expect(budget.parallel.minRemainingPct).toBe(60);
    expect(budget.parallel.timeWindowSec).toBe(3600);
  });

  test("pauseAt <= resumeBelow resets BOTH thresholds to defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ budget: { pauseAt: 25, resumeBelow: 40 } });
    const budget = loadBudget(svc);
    // An unsatisfiable pause lifecycle must never survive normalization.
    expect(budget.pauseAt).toBe(90);
    expect(budget.resumeBelow).toBe(30);
  });

  test("non-boolean enabled/codexTierControl fall back to defaults (lenient, not corrupt)", () => {
    const svc = new ConfigService(tempDir);
    // P1 shape-validation depth is the NUMERIC decision-grade fields the proposal
    // calls out. Booleans keep the lenient normalize-to-default behavior, so a
    // typo here is not startup-affecting and the config still parses.
    writeRawConfig({ budget: { enabled: "yes", codexTierControl: 1 } });
    const budget = loadBudget(svc);
    expect(budget.enabled).toBe(true);
    expect(budget.codexTierControl).toBe(false);
  });
});

describe("ConfigService — top-level numeric bounds (no negative/zero passthrough)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-numeric-bounds-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRawConfig(raw: unknown) {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(join(tempDir, ".agentbridge", "config.json"), JSON.stringify(raw));
  }

  test("negative idleShutdownSeconds falls back to default (prevents daemon self-shutdown)", () => {
    const svc = new ConfigService(tempDir);
    // A coercible negative passes shape-check; daemon.ts computes *1000 → -N ms,
    // setTimeout clamps to 0 → daemon self-shuts ~immediately after boot. Must
    // fall back to the default (30) instead of passing through.
    writeRawConfig({ idleShutdownSeconds: -1 });
    const config = expectParsed(svc);
    expect(config.idleShutdownSeconds).toBe(DEFAULT_CONFIG.idleShutdownSeconds);
  });

  test("zero idleShutdownSeconds falls back to default (min 1)", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ idleShutdownSeconds: 0 });
    const config = expectParsed(svc);
    expect(config.idleShutdownSeconds).toBe(DEFAULT_CONFIG.idleShutdownSeconds);
  });

  test("positive idleShutdownSeconds is honored", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ idleShutdownSeconds: 120 });
    const config = expectParsed(svc);
    expect(config.idleShutdownSeconds).toBe(120);
  });

  test("negative attentionWindowSeconds falls back to default; zero is allowed (min 0)", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ turnCoordination: { attentionWindowSeconds: -5 } });
    let config = expectParsed(svc);
    expect(config.turnCoordination.attentionWindowSeconds).toBe(
      DEFAULT_CONFIG.turnCoordination.attentionWindowSeconds,
    );

    // 0 is a legitimate "no attention window" value and must pass through.
    writeRawConfig({ turnCoordination: { attentionWindowSeconds: 0 } });
    config = expectParsed(svc);
    expect(config.turnCoordination.attentionWindowSeconds).toBe(0);
  });

  test("out-of-range codex ports fall back to defaults (1..65535)", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ codex: { appPort: -1, proxyPort: 70000 } });
    const config = expectParsed(svc);
    expect(config.codex.appPort).toBe(DEFAULT_CONFIG.codex.appPort);
    expect(config.codex.proxyPort).toBe(DEFAULT_CONFIG.codex.proxyPort);
  });

  test("zero codex ports fall back to defaults", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ codex: { appPort: 0, proxyPort: 0 } });
    const config = expectParsed(svc);
    expect(config.codex.appPort).toBe(DEFAULT_CONFIG.codex.appPort);
    expect(config.codex.proxyPort).toBe(DEFAULT_CONFIG.codex.proxyPort);
  });

  test("in-range codex ports are honored", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ codex: { appPort: 4600, proxyPort: 4601 } });
    const config = expectParsed(svc);
    expect(config.codex.appPort).toBe(4600);
    expect(config.codex.proxyPort).toBe(4601);
  });
});

describe("applyBudgetEnvOverrides", () => {
  const base = {
    enabled: true,
    pollSeconds: 60,
    budgetFreshTtlSec: 25,
    idleAdviceActivityWindowSec: 600,
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
    maximize: { targetUtil: 97, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
    allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
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

  test("env overrides budgetFreshTtlSec and idleAdviceActivityWindowSec", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_FRESH_TTL_SEC: "10",
      AGENTBRIDGE_BUDGET_IDLE_ADVICE_ACTIVITY_WINDOW_SEC: "0",
    });
    expect(result.budgetFreshTtlSec).toBe(10);
    expect(result.idleAdviceActivityWindowSec).toBe(0); // 0 = gate disabled, a valid value
  });

  test("out-of-range fresh-TTL / idle-window env values fall back to base (boundary rules)", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_FRESH_TTL_SEC: "9000", // > 300 max
      AGENTBRIDGE_BUDGET_IDLE_ADVICE_ACTIVITY_WINDOW_SEC: "-5", // < 0 min
    });
    expect(result.budgetFreshTtlSec).toBe(25);
    expect(result.idleAdviceActivityWindowSec).toBe(600);
  });
});

describe("applyBudgetEnvOverrides — boolean spellings", () => {
  const base = {
    enabled: true,
    pollSeconds: 60,
    budgetFreshTtlSec: 25,
    idleAdviceActivityWindowSec: 600,
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
    maximize: { targetUtil: 97, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
    allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
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

describe("ConfigService — budget v3 P1 keys (legacy key handling)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-budget-v3-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRawConfig(raw: unknown) {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(join(tempDir, ".agentbridge", "config.json"), JSON.stringify(raw));
  }

  function loadBudget(svc: ConfigService) {
    const result = svc.load();
    expect(result.state).toBe("parsed");
    if (result.state !== "parsed") throw new Error("unreachable");
    return result.config.budget;
  }

  test("legacy burnRate keys in the raw file are ignored (layered amendment: collection moved to the guard)", () => {
    const svc = new ConfigService(tempDir);
    writeRawConfig({ budget: { burnRate: { enabled: false, sampleCap: 100 } } });
    const budget = loadBudget(svc);
    expect("burnRate" in budget).toBe(false);
  });
});

describe("normalizeBoundedNumber (Q6 — fractional config params)", () => {
  test("accepts fractional values in range", () => {
    expect(normalizeBoundedNumber(0.4, 1, 0, 5)).toBe(0.4);
    expect(normalizeBoundedNumber(5, 1, 0, 5)).toBe(5);
    expect(normalizeBoundedNumber(0, 1, 0, 5)).toBe(0);
  });

  test("accepts numeric strings (env-style)", () => {
    expect(normalizeBoundedNumber("0.7", 1, 0, 5)).toBe(0.7);
  });

  test("NaN / non-numeric values fall back to the default", () => {
    expect(normalizeBoundedNumber(Number.NaN, 1.5, 0, 5)).toBe(1.5);
    expect(normalizeBoundedNumber("ninety", 1.5, 0, 5)).toBe(1.5);
    expect(normalizeBoundedNumber(undefined, 1.5, 0, 5)).toBe(1.5);
    expect(normalizeBoundedNumber(null, 1.5, 0, 5)).toBe(1.5);
    expect(normalizeBoundedNumber({}, 1.5, 0, 5)).toBe(1.5);
  });

  test("out-of-range values fall back to the default", () => {
    expect(normalizeBoundedNumber(5.1, 1.5, 0, 5)).toBe(1.5);
    expect(normalizeBoundedNumber(-0.1, 1.5, 0, 5)).toBe(1.5);
  });

  test("empty string falls back to the default (does not coerce to 0)", () => {
    expect(normalizeBoundedNumber("", 1.5, 0, 5)).toBe(1.5);
    expect(normalizeBoundedNumber("   ", 1.5, 0, 5)).toBe(1.5);
  });
});

describe("applyBudgetEnvOverrides — v3 P1 keys", () => {
  const base = {
    enabled: true,
    pollSeconds: 60,
    budgetFreshTtlSec: 25,
    idleAdviceActivityWindowSec: 600,
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
    maximize: { targetUtil: 97, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
    allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
  };

  test("v3 env keys leave the rest of the config untouched", () => {
    const result = applyBudgetEnvOverrides(base, {
      AGENTBRIDGE_BUDGET_TARGET_UTIL: "95",
    });
    expect(result.pauseAt).toBe(90);
    expect(result.resumeBelow).toBe(30);
  });
});

describe("normalizeBudgetConfig — v3 P2 maximize block", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abg-max-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
  function writeRawConfig(raw: unknown) {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeFileSync(join(tempDir, ".agentbridge", "config.json"), JSON.stringify(raw));
  }
  function loadBudget() {
    const result = new ConfigService(tempDir).load();
    expect(result.state).toBe("parsed");
    if (result.state !== "parsed") throw new Error("unreachable");
    return result.config.budget;
  }

  test("absent maximize block fills package defaults", () => {
    writeRawConfig({ version: "1.0" });
    expect(loadBudget().maximize).toEqual(DEFAULT_CONFIG.budget.maximize);
  });

  test("valid custom maximize values pass through (incl. fractional slope)", () => {
    writeRawConfig({
      budget: {
        maximize: {
          targetUtil: 95,
          reserveSlopePctPerHour: 1.25,
          reserveMaxPct: 10,
          finishingHorizonMinutes: 45,
          resumeHysteresisPct: 8,
        },
      },
    });
    expect(loadBudget().maximize).toEqual({
      targetUtil: 95,
      reserveSlopePctPerHour: 1.25,
      reserveMaxPct: 10,
      finishingHorizonMinutes: 45,
      resumeHysteresisPct: 8,
      admissionAt: 85,
      wrapUpQuota: 2,
    });
  });

  test("valid custom admissionAt / wrapUpQuota pass through", () => {
    writeRawConfig({
      budget: { maximize: { admissionAt: 80, wrapUpQuota: 3 } },
    });
    const m = loadBudget().maximize;
    expect(m.admissionAt).toBe(80);
    expect(m.wrapUpQuota).toBe(3);
  });

  test("out-of-range admissionAt / wrapUpQuota fall back per field", () => {
    writeRawConfig({
      budget: { maximize: { admissionAt: 30, wrapUpQuota: 99 } }, // 30 < 50, 99 > 10
    });
    const m = loadBudget().maximize;
    expect(m.admissionAt).toBe(85);
    expect(m.wrapUpQuota).toBe(2);
  });

  test("admissionAt >= targetUtil resets the WHOLE maximize block to defaults", () => {
    writeRawConfig({
      budget: { maximize: { targetUtil: 96, admissionAt: 96 } }, // 96 >= 96 → unsatisfiable
    });
    expect(loadBudget().maximize).toEqual(DEFAULT_CONFIG.budget.maximize);
  });

  test("garbage admissionAt fails loud as corrupt (not silent default)", () => {
    writeRawConfig({ budget: { maximize: { admissionAt: "eighty-five" } } });
    const result = new ConfigService(tempDir).load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") expect(result.reason).toContain("budget.maximize.admissionAt");
  });

  test("out-of-range fields fall back per field (others preserved)", () => {
    writeRawConfig({
      budget: {
        maximize: {
          targetUtil: 200, // > 99 → fallback 98
          reserveSlopePctPerHour: -1, // < 0 → fallback 0.4
          finishingHorizonMinutes: 999, // > 180 → fallback 30
        },
      },
    });
    const m = loadBudget().maximize;
    expect(m.targetUtil).toBe(98);
    expect(m.reserveSlopePctPerHour).toBe(0.4);
    expect(m.finishingHorizonMinutes).toBe(30);
  });

  test("targetUtil <= pauseAt resets the WHOLE maximize block to defaults", () => {
    writeRawConfig({
      budget: {
        pauseAt: 95,
        maximize: { targetUtil: 94, reserveMaxPct: 20 }, // 94 <= 95 → unsatisfiable
      },
    });
    expect(loadBudget().maximize).toEqual(DEFAULT_CONFIG.budget.maximize);
  });

  test("env overrides land on the maximize block", () => {
    const overridden = applyBudgetEnvOverrides(DEFAULT_CONFIG.budget, {
      AGENTBRIDGE_BUDGET_TARGET_UTIL: "96",
      AGENTBRIDGE_BUDGET_RESERVE_SLOPE_PCT_PER_HOUR: "0.9",
      AGENTBRIDGE_BUDGET_FINISHING_HORIZON_MINUTES: "60",
    });
    expect(overridden.maximize.targetUtil).toBe(96);
    expect(overridden.maximize.reserveSlopePctPerHour).toBe(0.9);
    expect(overridden.maximize.finishingHorizonMinutes).toBe(60);
  });

  test("env overrides land on the P3 admission keys", () => {
    const overridden = applyBudgetEnvOverrides(DEFAULT_CONFIG.budget, {
      AGENTBRIDGE_BUDGET_ADMISSION_AT: "80",
      AGENTBRIDGE_BUDGET_WRAP_UP_QUOTA: "4",
    });
    expect(overridden.maximize.admissionAt).toBe(80);
    expect(overridden.maximize.wrapUpQuota).toBe(4);
  });

  test("out-of-range admission env values are ignored (normalize bounds apply)", () => {
    const overridden = applyBudgetEnvOverrides(DEFAULT_CONFIG.budget, {
      AGENTBRIDGE_BUDGET_ADMISSION_AT: "30", // < 50 → fallback 85
      AGENTBRIDGE_BUDGET_WRAP_UP_QUOTA: "99", // > 10 → fallback 2
    });
    expect(overridden.maximize.admissionAt).toBe(85);
    expect(overridden.maximize.wrapUpQuota).toBe(2);
  });

  test("fractional wrapUpQuota is floored to an integer", () => {
    writeRawConfig({ budget: { maximize: { wrapUpQuota: 1.9 } } });
    expect(loadBudget().maximize.wrapUpQuota).toBe(1);
  });

  test("describeConfig reports custom values when maximize is tuned", () => {
    writeRawConfig({ budget: { maximize: { targetUtil: 95 } } });
    expect(new ConfigService(tempDir).describeConfig().customValues).toBe(true);
  });

  test("garbage maximize numeric fails loud as corrupt (not silent default)", () => {
    writeRawConfig({ budget: { maximize: { targetUtil: "ninety" } } });
    const result = new ConfigService(tempDir).load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") expect(result.reason).toContain("budget.maximize.targetUtil");
  });

  test("non-object maximize block fails loud as corrupt", () => {
    writeRawConfig({ budget: { maximize: 42 } });
    expect(new ConfigService(tempDir).load().state).toBe("corrupt");
  });
});

describe("ConfigService — v3 P4 allocation block", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abg-config-alloc-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });
  function writeRawConfig(raw: unknown): void {
    writeFileSync(join(tempDir, ".agentbridge", "config.json"), JSON.stringify(raw), "utf-8");
    return;
  }

  test("defaults present when absent", () => {
    expect(DEFAULT_CONFIG.budget.allocation).toEqual({ minRunwayRatio: 50, minRunwayGapHours: 2 });
  });

  test("custom in-range values are honored", () => {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeRawConfig({ budget: { allocation: { minRunwayRatio: 40, minRunwayGapHours: 5 } } });
    const result = new ConfigService(tempDir).load();
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.config.budget.allocation).toEqual({ minRunwayRatio: 40, minRunwayGapHours: 5 });
    }
  });

  test("one valid + one out-of-range key → ONLY the bad key resets (independent, no whole-block reset)", () => {
    // A valid minRunwayRatio:40 must be KEPT while the out-of-range
    // minRunwayGapHours:999 falls back to its default 2. If allocation were reset
    // as a whole block, minRunwayRatio would wrongly become 50 — so keeping 40
    // is what proves the per-key independence the name claims.
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeRawConfig({ budget: { allocation: { minRunwayRatio: 40, minRunwayGapHours: 999 } } });
    const result = new ConfigService(tempDir).load();
    expect(result.state).toBe("parsed");
    if (result.state === "parsed") {
      expect(result.config.budget.allocation).toEqual({ minRunwayRatio: 40, minRunwayGapHours: 2 });
    }
  });

  test("present-but-garbage numeric fails loud as corrupt", () => {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeRawConfig({ budget: { allocation: { minRunwayRatio: "ninety" } } });
    const result = new ConfigService(tempDir).load();
    expect(result.state).toBe("corrupt");
    if (result.state === "corrupt") expect(result.reason).toContain("budget.allocation.minRunwayRatio");
  });

  test("non-object allocation block fails loud as corrupt", () => {
    mkdirSync(join(tempDir, ".agentbridge"), { recursive: true });
    writeRawConfig({ budget: { allocation: 42 } });
    expect(new ConfigService(tempDir).load().state).toBe("corrupt");
  });

  test("env overrides allocation thresholds", () => {
    const result = applyBudgetEnvOverrides(DEFAULT_CONFIG.budget, {
      AGENTBRIDGE_BUDGET_MIN_RUNWAY_RATIO: "70",
      AGENTBRIDGE_BUDGET_MIN_RUNWAY_GAP_HOURS: "4",
    });
    expect(result.allocation).toEqual({ minRunwayRatio: 70, minRunwayGapHours: 4 });
  });
});
