import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QuotaSource, isDegradedUsage, normalizeProbeResult } from "../budget/quota-source";
import { isDecisionGrade } from "../budget/budget-state";

const NOW = 1_700_000_000;

describe("quota-source normalization", () => {
  test("normalizes bash budget-probe shape with hard_util", () => {
    const usage = normalizeProbeResult({
      ok: true,
      util: 42,
      hard_util: 42,
      warn_util: 58,
      stale: false,
      fetched_at: NOW,
      buckets: [
        { id: "primary_window", util: 42, reset_epoch: NOW + 1200, reset_after_seconds: 1200 },
        { id: "secondary_window", util: 31, reset_epoch: NOW + 86_400, reset_after_seconds: 86_400 },
      ],
    });

    expect(usage).not.toBeNull();
    expect(usage!.ok).toBe(true);
    expect(usage!.gateUtil).toBe(42);
    expect(usage!.warnUtil).toBe(58);
    expect(usage!.remaining).toBe(58);
    expect(usage!.fiveHour).toEqual({ util: 42, resetEpoch: NOW + 1200 });
    expect(usage!.weekly).toEqual({ util: 31, resetEpoch: NOW + 86_400 });
    expect(usage!.parsedVia).toBe("id-match");
  });

  test("normalizes node probe.mjs shape without hard_util", () => {
    const usage = normalizeProbeResult({
      ok: true,
      util: 25,
      warn_util: 44,
      now_epoch: NOW,
      buckets: [
        { id: "five_hour", util: 25, reset_epoch: NOW + 3000 },
        { id: "seven_day_sonnet", util: 44, reset_epoch: NOW + 400_000 },
      ],
    });

    expect(usage).not.toBeNull();
    expect(usage!.gateUtil).toBe(25);
    expect(usage!.warnUtil).toBe(44);
    expect(usage!.fetchedAt).toBe(NOW);
    expect(usage!.fiveHour).toEqual({ util: 25, resetEpoch: NOW + 3000 });
    expect(usage!.weekly).toEqual({ util: 44, resetEpoch: NOW + 400_000 });
  });

  test("keeps ok:false rate-limit results as actionable usage", () => {
    const usage = normalizeProbeResult({
      ok: false,
      error: "rate_limited",
      util: 0,
      warn_util: 0,
      fetched_at: NOW,
      buckets: [],
      rate_limited_until: NOW + 900,
    });

    expect(usage).not.toBeNull();
    expect(usage!.ok).toBe(false);
    expect(usage!.gateUtil).toBe(0);
    // util:0 is an actual (finite) reading — it surfaces as a display-only
    // window with unknown reset (resetEpoch 0 is rejected by isDecisionGrade).
    expect(usage!.fiveHour).toEqual({ util: 0, resetEpoch: 0 });
    expect(usage!.weekly).toBeNull();
    expect(usage!.rateLimitedUntil).toBe(NOW + 900);
  });

  test("accepts windowless util readings as display-only degraded data (#103)", () => {
    // Layered consumption: the display layer accepts any finite util reading;
    // the decision layer (isDecisionGrade) independently rejects records
    // without a fresh window, so this cannot flip interventions.
    const usage = normalizeProbeResult({
      ok: true,
      util: 0,
      warn_util: 0,
      fetched_at: NOW,
      buckets: [],
    });
    expect(usage).not.toBeNull();
    expect(usage!.fiveHour).toEqual({ util: 0, resetEpoch: 0 });
    expect(isDecisionGrade(usage, NOW)).toBe(false);
  });

  test("returns null when the record carries no util reading at all (information floor)", () => {
    expect(normalizeProbeResult({
      ok: true,
      fetched_at: NOW,
      buckets: [],
    })).toBeNull();
  });

  test("keeps reset_epoch:null buckets as unknown-reset windows (#103)", () => {
    const usage = normalizeProbeResult({
      ok: true,
      util: 55,
      warn_util: 55,
      fetched_at: NOW,
      buckets: [{ id: "seven_day", util: 55, reset_epoch: null }],
    });
    expect(usage).not.toBeNull();
    expect(usage!.weekly).toEqual({ util: 55, resetEpoch: 0 });
    expect(isDecisionGrade(usage, NOW)).toBe(false);
  });

  test("accepts the live 429-gate stale cache shape from agent-bridge#103", () => {
    const usage = normalizeProbeResult({
      ok: true,
      agent: "claude",
      util: 0,
      warn_util: 0,
      hard_util: 0,
      source: "cache",
      stale: true,
      fetched_at: NOW - 120,
      rate_limited_until: NOW + 300,
    });
    expect(usage).not.toBeNull();
    expect(usage!.stale).toBe(true);
    expect(usage!.rateLimitedUntil).toBe(NOW + 300);
    expect(isDegradedUsage(usage!, NOW)).toBe(true);
  });

  test("keeps cache fallback results when bucket windows are still present", () => {
    const usage = normalizeProbeResult({
      ok: false,
      error: "network",
      stale: true,
      util: 27,
      hard_util: 27,
      warn_util: 27,
      fetched_at: NOW,
      buckets: [
        { id: "primary_window", util: 27, reset_epoch: NOW + 2400 },
        { id: "secondary_window", util: 27, reset_epoch: NOW + 400_000 },
      ],
    });

    expect(usage).not.toBeNull();
    expect(usage!.ok).toBe(false);
    expect(usage!.stale).toBe(true);
    expect(usage!.gateUtil).toBe(27);
    expect(usage!.fiveHour).toEqual({ util: 27, resetEpoch: NOW + 2400 });
    expect(usage!.weekly).toEqual({ util: 27, resetEpoch: NOW + 400_000 });
  });

  test("returns null for failed probe results with no usable data", () => {
    expect(normalizeProbeResult({ ok: false, error: "schema", buckets: [] })).toBeNull();
  });

  test("falls back to reset ordering when bucket ids are provider-specific", () => {
    const usage = normalizeProbeResult({
      ok: true,
      util: 19,
      warn_util: 35,
      fetched_at: NOW,
      buckets: [
        { id: "opaque-long", util: 35, reset_epoch: NOW + 500_000, reset_after_seconds: 500_000 },
        { id: "opaque-short", util: 19, reset_epoch: NOW + 1800, reset_after_seconds: 1800 },
      ],
    });

    expect(usage).not.toBeNull();
    expect(usage!.fiveHour).toEqual({ util: 19, resetEpoch: NOW + 1800 });
    expect(usage!.weekly).toEqual({ util: 35, resetEpoch: NOW + 500_000 });
    expect(usage!.parsedVia).toBe("positional");
  });

  test("uses top-level reset fields when bucket details are absent", () => {
    const usage = normalizeProbeResult({
      ok: true,
      util: 55,
      hard_util: 55,
      warn_util: 55,
      fetched_at: NOW,
      reset_epoch: NOW + 2400,
      reset_after_seconds: 2400,
      buckets: [],
    });

    expect(usage).not.toBeNull();
    expect(usage!.gateUtil).toBe(55);
    expect(usage!.fiveHour).toEqual({ util: 55, resetEpoch: NOW + 2400 });
    expect(usage!.weekly).toBeNull();
    expect(usage!.parsedVia).toBe("top-level");
  });

  test("normalizes schema_version 1 through the versioned parser", () => {
    const usage = normalizeProbeResult({
      schema_version: 1,
      ok: true,
      util: 30,
      warn_util: 30,
      fetched_at: NOW,
      buckets: [
        { id: "five_hour", util: 30, reset_epoch: NOW + 1200 },
        { id: "seven_day", util: 30, reset_epoch: NOW + 400_000 },
      ],
    });

    expect(usage).not.toBeNull();
    expect(usage!.parsedVia).toBe("id-match");
  });
});

describe("QuotaSource", () => {
  let tempHome: string | null = null;

  afterEach(() => {
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  test("returns null when no probe source is configured or installed", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "agentbridge-quota-source-test-"));
    const source = new QuotaSource({
      env: {},
      homeDir: tempHome,
      runner: async () => {
        throw new Error("should not run");
      },
    });

    await expect(source.fetchBoth()).resolves.toBeNull();
  });

  test("uses explicit env probe and passes --agent arguments", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      homeDir: "/unused",
      runner: async (command, args) => {
        calls.push({ command, args });
        const agent = args[1];
        return {
          stdout: JSON.stringify({
            ok: true,
            util: agent === "claude" ? 12 : 18,
            warn_util: agent === "claude" ? 12 : 18,
            fetched_at: NOW,
            reset_epoch: NOW + 1200,
            buckets: [],
          }),
        };
      },
    });

    const result = await source.fetchBoth();
    expect(result?.claude?.gateUtil).toBe(12);
    expect(result?.codex?.gateUtil).toBe(18);
    expect(calls).toEqual([
      { command: "/tmp/fake-budget-probe", args: ["--agent", "claude"] },
      { command: "/tmp/fake-budget-probe", args: ["--agent", "codex"] },
    ]);
  });

  test("unusable probe output is logged with a raw snippet for triage (#103)", async () => {
    const logs: string[] = [];
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      homeDir: "/unused",
      log: (m) => logs.push(m),
      runner: async () => ({
        stdout: JSON.stringify({ ok: true, source: "cache", note: "no util fields at all" }),
      }),
    });

    await source.fetchBoth();
    const line = logs.find((l) => l.includes("no usable data"));
    expect(line).toBeDefined();
    expect(line).toContain("raw: ");
    expect(line).toContain("no util fields at all");
  });

  test("unparseable probe output is logged with a raw snippet (#103 MEDIUM)", async () => {
    const logs: string[] = [];
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      homeDir: "/unused",
      log: (m) => logs.push(m),
      runner: async () => ({ stdout: "Error: keychain locked\npartial{json" }),
    });

    await source.fetchBoth();
    const line = logs.find((l) => l.includes("unparseable"));
    expect(line).toBeDefined();
    expect(line).toContain("raw: Error: keychain locked");
  });

  test("expired-window records stay degraded — no premature recovery log", () => {
    const expired = normalizeProbeResult({
      ok: true,
      util: 30,
      warn_util: 30,
      fetched_at: NOW,
      buckets: [{ id: "five_hour", util: 30, reset_epoch: NOW - 100 }],
    });
    expect(expired).not.toBeNull();
    // resetEpoch > 0 but in the past: fresh by the OLD (>0) standard, degraded
    // by the isDecisionGrade-aligned (>now) standard.
    expect(isDegradedUsage(expired!, NOW)).toBe(true);
  });

  test("degraded acceptance is logged on transitions only, with recovery (#103)", async () => {
    const logs: string[] = [];
    let stale = true;
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      homeDir: "/unused",
      log: (m) => logs.push(m),
      now: () => NOW,
      runner: async () => ({
        stdout: JSON.stringify({
          ok: true,
          util: 30,
          warn_util: 30,
          stale,
          fetched_at: NOW,
          buckets: [{ id: "five_hour", util: 30, reset_epoch: NOW + 3600 }],
        }),
      }),
    });

    await source.fetchBoth(); // degraded (stale) — logs once per agent
    await source.fetchBoth(); // still degraded — no new logs
    const degradedLines = logs.filter((l) => l.includes("degraded data accepted"));
    expect(degradedLines.length).toBe(2); // one per agent (claude + codex)

    stale = false;
    await source.fetchBoth(); // recovery — logs once per agent
    const recoveredLines = logs.filter((l) => l.includes("recovered to fresh data"));
    expect(recoveredLines.length).toBe(2);
    expect(logs.filter((l) => l.includes("degraded data accepted")).length).toBe(2);
  });

  test("positional bucket fallback logs a once-per-daemon warning", async () => {
    const logs: string[] = [];
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      homeDir: "/unused",
      log: (m) => logs.push(m),
      runner: async () => ({
        stdout: JSON.stringify({
          ok: true,
          util: 19,
          warn_util: 35,
          fetched_at: NOW,
          buckets: [
            { id: "opaque-long", util: 35, reset_epoch: NOW + 500_000, reset_after_seconds: 500_000 },
            { id: "opaque-short", util: 19, reset_epoch: NOW + 1800, reset_after_seconds: 1800 },
          ],
        }),
      }),
    });

    await source.fetchBoth();
    await source.fetchBoth();

    const positionalLines = logs.filter((l) => l.includes("positional bucket fallback"));
    expect(positionalLines).toHaveLength(1);
    expect(positionalLines[0]).toContain("bucket ids did not identify quota windows");
  });

  test("unknown schema_version logs and falls back to tolerant parsing", async () => {
    const logs: string[] = [];
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      homeDir: "/unused",
      log: (m) => logs.push(m),
      runner: async () => ({
        stdout: JSON.stringify({
          schema_version: 999,
          ok: true,
          util: 30,
          warn_util: 30,
          fetched_at: NOW,
          buckets: [{ id: "five_hour", util: 30, reset_epoch: NOW + 1200 }],
        }),
      }),
    });

    const result = await source.fetchBoth();

    expect(result?.claude?.gateUtil).toBe(30);
    expect(result?.codex?.gateUtil).toBe(30);
    const unknownVersionLines = logs.filter((l) => l.includes("unknown budget probe schema_version"));
    expect(unknownVersionLines).toHaveLength(1);
    expect(unknownVersionLines[0]).toContain("999");
  });

  test("falls back to installed budget-probe when installed probe.mjs is absent", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "agentbridge-quota-source-test-"));
    const installed = join(tempHome, ".budget-guard/bin/budget-probe");
    mkdirSync(join(tempHome, ".budget-guard/bin"), { recursive: true });
    writeFileSync(installed, "#!/bin/sh\n", "utf-8");

    const calls: Array<{ command: string; args: string[] }> = [];
    const source = new QuotaSource({
      env: {},
      homeDir: tempHome,
      runner: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            ok: true,
            util: 9,
            warn_util: 9,
            fetched_at: NOW,
            reset_epoch: NOW + 1200,
            buckets: [],
          }),
        };
      },
    });

    const result = await source.fetchBoth();
    expect(result?.claude?.gateUtil).toBe(9);
    expect(result?.codex?.gateUtil).toBe(9);
    expect(calls).toEqual([
      { command: installed, args: ["--agent", "claude"] },
      { command: installed, args: ["--agent", "codex"] },
    ]);
  });

  test("prefers installed probe.mjs over installed budget-probe so v2 burn fields are preserved", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "agentbridge-quota-source-test-"));
    const binDir = join(tempHome, ".budget-guard/bin");
    const budgetProbe = join(binDir, "budget-probe");
    const probeMjs = join(binDir, "probe.mjs");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(budgetProbe, "#!/bin/sh\n", "utf-8");
    writeFileSync(probeMjs, "#!/usr/bin/env node\n", "utf-8");

    const calls: Array<{ command: string; args: string[] }> = [];
    const source = new QuotaSource({
      env: {},
      homeDir: tempHome,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (command === budgetProbe) {
          return {
            stdout: JSON.stringify({
              ok: true,
              util: 24,
              hard_util: 24,
              warn_util: 24,
              fetched_at: NOW,
              reset_epoch: NOW + 1200,
              buckets: [],
            }),
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            probe_schema: 2,
            util: 22,
            warn_util: 22,
            fetched_at: NOW,
            buckets: [
              {
                id: "five_hour",
                util: 22,
                reset_epoch: NOW + 1200,
                burn_rate_pct_per_hour: 1.25,
                burn_confident: true,
                runway_seconds: 1800,
                depleted_at_epoch: NOW + 1800,
              },
            ],
          }),
        };
      },
    });

    const result = await source.fetchBoth();
    expect(result?.claude?.gateUtil).toBe(22);
    expect(result?.codex?.gateUtil).toBe(22);
    expect(result?.claude?.fiveHour).toMatchObject({
      util: 22,
      resetEpoch: NOW + 1200,
      burnRate: 1.25,
      burnConfident: true,
      runwaySeconds: 1800,
      depletedAtEpoch: NOW + 1800,
    });
    expect(calls).toEqual([
      { command: probeMjs, args: ["claude", "probe"] },
      { command: probeMjs, args: ["codex", "probe"] },
    ]);
  });

  test("falls back per agent from installed probe.mjs to installed budget-probe when probe.mjs fails", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "agentbridge-quota-source-test-"));
    const binDir = join(tempHome, ".budget-guard/bin");
    const budgetProbe = join(binDir, "budget-probe");
    const probeMjs = join(binDir, "probe.mjs");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(budgetProbe, "#!/bin/sh\n", "utf-8");
    writeFileSync(probeMjs, "#!/usr/bin/env node\n", "utf-8");

    const calls: Array<{ command: string; args: string[] }> = [];
    const source = new QuotaSource({
      env: {},
      homeDir: tempHome,
      runner: async (command, args) => {
        calls.push({ command, args });
        if (command === probeMjs && args[0] === "claude") {
          return { stdout: "" };
        }
        if (command === probeMjs && args[0] === "codex") {
          throw new Error("probe.mjs failed");
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            util: 24,
            hard_util: 24,
            warn_util: 24,
            fetched_at: NOW,
            reset_epoch: NOW + 1200,
            buckets: [],
          }),
        };
      },
    });

    const result = await source.fetchBoth();
    expect(result?.claude?.gateUtil).toBe(24);
    expect(result?.codex?.gateUtil).toBe(24);
    expect(calls).toEqual([
      { command: probeMjs, args: ["claude", "probe"] },
      { command: probeMjs, args: ["codex", "probe"] },
      { command: budgetProbe, args: ["--agent", "claude"] },
      { command: budgetProbe, args: ["--agent", "codex"] },
    ]);
  });

  test("uses probe.mjs argument form only when explicitly configured", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const source = new QuotaSource({
      env: { BUDGET_PROBE: "/tmp/probe.mjs" },
      homeDir: "/unused",
      runner: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            ok: true,
            util: 11,
            warn_util: 11,
            fetched_at: NOW,
            reset_epoch: NOW + 1200,
            buckets: [],
          }),
        };
      },
    });

    await source.fetchBoth();
    expect(calls).toEqual([
      { command: "/tmp/probe.mjs", args: ["claude", "probe"] },
      { command: "/tmp/probe.mjs", args: ["codex", "probe"] },
    ]);
  });

  test("does not fall back to installed probes when explicit env probe fails", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "agentbridge-quota-source-test-"));
    const binDir = join(tempHome, ".budget-guard/bin");
    const budgetProbe = join(binDir, "budget-probe");
    const probeMjs = join(binDir, "probe.mjs");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(budgetProbe, "#!/bin/sh\n", "utf-8");
    writeFileSync(probeMjs, "#!/usr/bin/env node\n", "utf-8");

    const calls: Array<{ command: string; args: string[] }> = [];
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/broken-fixture" },
      homeDir: tempHome,
      runner: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            ok: false,
            error: "schema",
            buckets: [],
          }),
        };
      },
    });

    await expect(source.fetchBoth()).resolves.toEqual({ claude: null, codex: null });
    expect(calls).toEqual([
      { command: "/tmp/broken-fixture", args: ["--agent", "claude"] },
      { command: "/tmp/broken-fixture", args: ["--agent", "codex"] },
    ]);
  });

  test("fails open per agent on invalid JSON", async () => {
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/fake-budget-probe" },
      runner: async (_command, args) => {
        if (args.includes("claude")) return { stdout: "not json" };
        return {
          stdout: JSON.stringify({
            ok: true,
            util: 7,
            warn_util: 7,
            fetched_at: NOW,
            reset_epoch: NOW + 1200,
            buckets: [],
          }),
        };
      },
    });

    const result = await source.fetchBoth();
    expect(result).not.toBeNull();
    expect(result!.claude).toBeNull();
    expect(result!.codex?.gateUtil).toBe(7);
  });

  test("fails open when probe execution exceeds timeout", async () => {
    const source = new QuotaSource({
      env: { AGENTBRIDGE_QUOTA_PROBE: "/tmp/slow-budget-probe" },
      timeoutMs: 5,
      runner: () => new Promise(() => {}),
    });

    await expect(source.fetchBoth()).resolves.toEqual({ claude: null, codex: null });
  });
});

describe("quota-source — guard burn fields (v3 layered amendment)", () => {
  const NOW2 = 1_700_000_000;

  function bucketWith(extra: Record<string, unknown>) {
    return {
      ok: true,
      util: 42,
      warn_util: 42,
      fetched_at: NOW2,
      buckets: [
        { id: "five_hour", util: 42, reset_epoch: NOW2 + 3600, ...extra },
      ],
    };
  }

  test("passes a complete field group through verbatim", () => {
    const usage = normalizeProbeResult(
      bucketWith({
        burn_rate_pct_per_hour: 1.25,
        burn_confident: true,
        runway_seconds: 1800,
        depleted_at_epoch: NOW2 + 1800,
        five_hour_windows_left: 2.4,
      }),
    );
    expect(usage!.fiveHour).toEqual({
      util: 42,
      resetEpoch: NOW2 + 3600,
      burnRate: 1.25,
      burnConfident: true,
      runwaySeconds: 1800,
      depletedAtEpoch: NOW2 + 1800,
      fiveHourWindowsLeft: 2.4,
    });
  });

  test("a negative burn rate poisons the WHOLE group (window itself survives)", () => {
    const usage = normalizeProbeResult(
      bucketWith({
        burn_rate_pct_per_hour: -1,
        burn_confident: true,
        runway_seconds: 1800,
      }),
    );
    expect(usage!.fiveHour).toEqual({ util: 42, resetEpoch: NOW2 + 3600 });
  });

  test("non-numeric runway_seconds poisons the group (strings are NOT tolerated here)", () => {
    const usage = normalizeProbeResult(
      bucketWith({ burn_rate_pct_per_hour: 1.25, runway_seconds: "1800" }),
    );
    expect(usage!.fiveHour).toEqual({ util: 42, resetEpoch: NOW2 + 3600 });
  });

  test("non-numeric five_hour_windows_left poisons the group (strings are NOT tolerated here)", () => {
    const usage = normalizeProbeResult(
      bucketWith({
        burn_rate_pct_per_hour: 1.25,
        burn_confident: true,
        runway_seconds: 1800,
        five_hour_windows_left: "2.4",
      }),
    );
    expect(usage!.fiveHour).toEqual({ util: 42, resetEpoch: NOW2 + 3600 });
  });

  test("NaN burn rate and non-boolean burn_confident each poison the group", () => {
    expect(
      normalizeProbeResult(bucketWith({ burn_rate_pct_per_hour: Number.NaN }))!.fiveHour,
    ).toEqual({ util: 42, resetEpoch: NOW2 + 3600 });
    expect(
      normalizeProbeResult(bucketWith({ burn_rate_pct_per_hour: 1, burn_confident: "yes" }))!.fiveHour,
    ).toEqual({ util: 42, resetEpoch: NOW2 + 3600 });
  });

  test("partial group keeps the valid present fields (guard omits what it cannot estimate)", () => {
    const usage = normalizeProbeResult(
      bucketWith({ burn_rate_pct_per_hour: 0.8, burn_confident: false }),
    );
    expect(usage!.fiveHour).toEqual({
      util: 42,
      resetEpoch: NOW2 + 3600,
      burnRate: 0.8,
      burnConfident: false,
    });
  });

  test("legacy probe output without burn fields parses exactly as before", () => {
    const usage = normalizeProbeResult(bucketWith({}));
    expect(usage!.fiveHour).toEqual({ util: 42, resetEpoch: NOW2 + 3600 });
  });

  test("top-level probe_schema 2 is tolerated and burn fields ride the top-level fallback", () => {
    const usage = normalizeProbeResult({
      ok: true,
      probe_schema: 2,
      util: 42,
      fetched_at: NOW2,
      reset_epoch: NOW2 + 3600,
      burn_rate_pct_per_hour: 1.1,
      burn_confident: true,
      runway_seconds: 900,
      depleted_at_epoch: NOW2 + 900,
    });
    expect(usage!.parsedVia).toBe("top-level");
    expect(usage!.fiveHour).toEqual({
      util: 42,
      resetEpoch: NOW2 + 3600,
      burnRate: 1.1,
      burnConfident: true,
      runwaySeconds: 900,
      depletedAtEpoch: NOW2 + 900,
    });
  });
});
