import { describe, expect, test } from "bun:test";
import { computeBudgetState } from "../budget/budget-state";
import { directiveFingerprint } from "../budget/budget-fingerprint";
import { dynamicWindowVerdict } from "../budget/budget-decision";
import type { AgentUsage, BudgetConfig, BudgetWindow, RunwayEstimate } from "../budget/types";

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
  enabled: true,
  pollSeconds: 60,
  pauseAt: 90,
  resumeBelow: 30,
  syncDriftPct: 10,
  parallel: { minRemainingPct: 60, timeWindowSec: 3600 },
  codexTierControl: false,
  codexTiers: { full: null, balanced: { effort: "medium" }, eco: { effort: "low" } },
  maximize: {
    targetUtil: 98,
    reserveSlopePctPerHour: 0.4,
    reserveMaxPct: 7,
    finishingHorizonMinutes: 30,
    resumeHysteresisPct: 5,
    admissionAt: 85,
    wrapUpQuota: 2,
  },
  allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
};

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  const gateUtil = overrides.gateUtil ?? 20;
  const warnUtil = overrides.warnUtil ?? gateUtil;
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil,
    fiveHour: { util: gateUtil, resetEpoch: NOW + 7200 },
    weekly: { util: warnUtil, resetEpoch: NOW + 500_000 },
    remaining: 100 - gateUtil,
    rateLimitedUntil: 0,
    fetchedAt: NOW,
    parsedVia: "id-match",
    ...overrides,
  };
}

function runway(hours: number, basis: RunwayEstimate["basis"] = "weekly"): RunwayEstimate {
  return { seconds: Math.round(hours * 3600), basis, depletedAtEpoch: null };
}

/** Weekly window with a confident guard burn rate (for will-not-fill verdicts). */
function weeklyBurn(util: number, rate: number, tHours = 138): BudgetWindow {
  return { util, resetEpoch: NOW + Math.round(tHours * 3600), burnRate: rate, burnConfident: true };
}

describe("v3 P4 — runway-difference balance criterion (§3.4)", () => {
  test("① today's case: Codex util high but near reset → runway not short → NOT heavier", () => {
    // warnUtil says Codex is far heavier (92 vs 20) — the OLD criterion would
    // route work away from Codex. But Codex has ~6.5h of runway (near reset),
    // Claude ~9h → ratio 72% ≥ 50 → balanced → no balance directive.
    // Codex weekly util 92 but with a confident burn rate over ~6.5h to reset:
    // dynamic line ≈ 94.4 > 92 → NOT paused (the live design case). 5h window low.
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20 }),
      usage({
        gateUtil: 20,
        warnUtil: 92,
        fiveHour: { util: 20, resetEpoch: NOW + 7200 },
        weekly: { util: 92, resetEpoch: NOW + Math.round(6.5 * 3600), burnRate: 1.2, burnConfident: true },
      }),
      CONFIG,
      NOW,
      { claude: runway(9), codex: runway(6.5) },
    );
    expect(state.phase).toBe("normal");
    expect(state.drift.heavier).toBeNull();
    // driftPct stays the raw warnUtil diff for the display readout (contract).
    expect(state.drift.pct).toBe(-72);
    expect(state.directiveToClaude).toBeNull();
  });

  test("② double gate: both ratio<50 AND gap≥2h → flag shorter side as heavier", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 30, warnUtil: 30 }),
      usage({ gateUtil: 30, warnUtil: 30 }),
      CONFIG,
      NOW,
      { claude: runway(1), codex: runway(10) }, // ratio 10%, gap 9h
    );
    expect(state.phase).toBe("balance");
    expect(state.drift.heavier).toBe("claude"); // shorter runway = heavier
    expect(state.drift.lighter).toBe("codex");
    expect(state.directiveToClaude).toContain("剩余可工作时间");
    expect(state.directiveToClaude).toContain("~1.0h");
    expect(state.directiveToClaude).toContain("~10.0h");
    expect(state.directiveToClaude).toContain("优先派给 Codex");
  });

  test("② double gate: ratio<50 but gap<2h → balanced (not flagged)", () => {
    const state = computeBudgetState(
      usage(),
      usage(),
      CONFIG,
      NOW,
      { claude: runway(0.5), codex: runway(1.4) }, // ratio 36% <50 but gap 0.9h <2
    );
    expect(state.phase).toBe("normal");
    expect(state.drift.heavier).toBeNull();
  });

  test("② double gate: gap≥2h but ratio≥50 → balanced (not flagged)", () => {
    const state = computeBudgetState(
      usage(),
      usage(),
      CONFIG,
      NOW,
      { claude: runway(10), codex: runway(16) }, // ratio 63% (round(62.5)) ≥50, gap 6h
    );
    expect(state.phase).toBe("normal");
    expect(state.drift.heavier).toBeNull();
  });

  test("③ non-confident (runway missing on one side) → fall back to warnUtil driftFor", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 45, warnUtil: 45 }),
      usage({ gateUtil: 20, warnUtil: 20 }),
      CONFIG,
      NOW,
      { claude: null, codex: runway(10) }, // not both confident
    );
    expect(state.phase).toBe("balance");
    expect(state.drift.heavier).toBe("claude"); // warnUtil 45 > 20
    expect(state.drift.lighter).toBe("codex");
    // warnUtil-basis text, not the runway phrasing.
    expect(state.directiveToClaude).toContain("用量比例漂移");
    expect(state.directiveToClaude).not.toContain("剩余可工作时间");
  });

  test("§3.4 invariant 6: a rate-limited side suppresses balance advice", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 30, warnUtil: 30 }),
      usage({ gateUtil: 30, warnUtil: 30, rateLimitedUntil: NOW + 600 }),
      CONFIG,
      NOW,
      { claude: runway(1), codex: runway(10) }, // would flag balance if eligible
    );
    // Contract: no advice is acted on — phase normal, no directive. (drift.heavier
    // still carries the raw routing computation, but it is internal and unused
    // when phase is not balance, exactly like the paused case.)
    expect(state.phase).toBe("normal");
    expect(state.directiveToClaude).toBeNull();
  });

  test("② boundary: gap exactly == minRunwayGapHours (2h) with ratio<50 → flagged", () => {
    const state = computeBudgetState(usage(), usage(), CONFIG, NOW, {
      claude: runway(1),
      codex: runway(3), // ratio 33%, gap exactly 2h (>= gate)
    });
    expect(state.phase).toBe("balance");
    expect(state.drift.heavier).toBe("claude");
  });

  test("② boundary: ratio exactly == minRunwayRatio (50) → NOT flagged (strict <)", () => {
    const state = computeBudgetState(usage(), usage(), CONFIG, NOW, {
      claude: runway(5),
      codex: runway(10), // ratio exactly 50%, gap 5h
    });
    expect(state.phase).toBe("normal");
    expect(state.drift.heavier).toBeNull();
  });

  test("③ no runway at all (legacy caller) → warnUtil driftFor", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 45, warnUtil: 45 }),
      usage({ gateUtil: 20, warnUtil: 20 }),
      CONFIG,
      NOW,
    );
    expect(state.phase).toBe("balance");
    expect(state.drift.heavier).toBe("claude");
  });

  test("⑥ runway jitter does NOT change the balance fingerprint (anti-spam), text stays precise", () => {
    const mk = (codexHours: number) =>
      computeBudgetState(usage({ gateUtil: 30 }), usage({ gateUtil: 30 }), CONFIG, NOW, {
        claude: runway(1),
        codex: runway(codexHours),
      });
    const a = mk(10);
    const b = mk(10.3); // runway drifted by 0.3h between polls
    expect(a.phase).toBe("balance");
    expect(b.phase).toBe("balance");
    // Fingerprint is runway-free → identical → no duplicate banner.
    expect(directiveFingerprint(a)).toBe(directiveFingerprint(b));
    // …but the directive text shows the precise (different) hours.
    expect(a.directiveToClaude).toContain("~10.0h");
    expect(b.directiveToClaude).toContain("~10.3h");
  });
});

describe("v3 P4 — underutilization advice (§3.4)", () => {
  test("④ weekly will-not-fill with material waste → underutilized phase + reason", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, weekly: weeklyBurn(20, 0.1) }),
      usage({ gateUtil: 20, warnUtil: 20, weekly: weeklyBurn(20, 0.1) }),
      CONFIG,
      NOW,
    );
    expect(state.phase).toBe("underutilized");
    expect(state.underutilization.recommended).toBe(true);
    expect(state.directiveToClaude).toContain("欠载");
    expect(state.directiveToClaude).toContain("作废");
    expect(state.directiveToClaude).toContain("提高并行");
  });

  test("④ will-fill (high burn) → no underutilization", () => {
    // rate 1.0/h over ~138h → projected ≫ target → will-fill → no advice.
    const state = computeBudgetState(
      usage({ gateUtil: 50, warnUtil: 50, weekly: weeklyBurn(50, 1.0) }),
      usage({ gateUtil: 50, warnUtil: 50, weekly: weeklyBurn(50, 1.0) }),
      CONFIG,
      NOW,
    );
    expect(state.phase).toBe("normal");
    expect(state.underutilization.recommended).toBe(false);
    expect(state.directiveToClaude).toBeNull();
  });

  test("④ will-not-fill but waste < 10% → not worth a nag", () => {
    // projected ~97.5 vs target 98 → waste 0.5 < threshold → no advice.
    const state = computeBudgetState(
      usage({ gateUtil: 90, warnUtil: 90, weekly: weeklyBurn(90, 0.05) }),
      usage({ gateUtil: 90, warnUtil: 90, weekly: weeklyBurn(90, 0.05) }),
      CONFIG,
      NOW,
    );
    expect(state.phase).not.toBe("underutilized");
    expect(state.underutilization.recommended).toBe(false);
  });

  test("④ boundary: waste exactly == threshold (10%) still triggers (strict <)", () => {
    // projected = 20 + 0.5×136 = 88 → waste = 98 − 88 = 10.0 (not < 10 → fires).
    const w = { util: 20, resetEpoch: NOW + Math.round(136 * 3600), burnRate: 0.5, burnConfident: true };
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, weekly: w }),
      usage({ gateUtil: 20, warnUtil: 20, weekly: w }),
      CONFIG,
      NOW,
    );
    expect(state.phase).toBe("underutilized");
  });

  test("④ rate-limited side suppresses underutilization advice (invariant 6)", () => {
    const w = { util: 20, resetEpoch: NOW + 500_000, burnRate: 0.1, burnConfident: true };
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, weekly: w }),
      usage({ gateUtil: 20, warnUtil: 20, weekly: w, rateLimitedUntil: NOW + 600 }),
      CONFIG,
      NOW,
    );
    expect(state.phase).toBe("normal");
    expect(state.underutilization.recommended).toBe(false);
  });

  test("④ paused suppresses underutilization", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 95, warnUtil: 95, fiveHour: { util: 95, resetEpoch: NOW + 1800 } }),
      usage({ gateUtil: 20, warnUtil: 20, weekly: weeklyBurn(20, 0.1) }),
      CONFIG,
      NOW,
    );
    expect(state.phase).toBe("paused");
    expect(state.underutilization.recommended).toBe(false);
  });
});

describe("v3 P4 — dynamicWindowVerdict (signal source, not effectiveDynamicLine)", () => {
  test("will-not-fill is reported (line===100 path effectiveDynamicLine drops)", () => {
    const v = dynamicWindowVerdict(weeklyBurn(20, 0.1), CONFIG, NOW);
    expect(v.kind).toBe("will-not-fill");
    if (v.kind === "will-not-fill") expect(v.projectedAtReset).toBeLessThan(CONFIG.maximize.targetUtil);
  });

  test("will-fill returns a numeric line", () => {
    const v = dynamicWindowVerdict(weeklyBurn(96, 2.0, 5), CONFIG, NOW);
    expect(v.kind).toBe("will-fill");
  });

  test("admission-closed: near-full window in the finishing band (safety guard)", () => {
    // util 97.5, ~0.4h to reset, rate 0.1 → projected 97.54 <= target 98, but the
    // near-reset finishing hard cap fires FIRST → admission-closed, NOT will-not-fill.
    // This is the guard that stops a near-full account being mislabeled "underutilized".
    const v = dynamicWindowVerdict(weeklyBurn(97.5, 0.1, 0.4), CONFIG, NOW);
    expect(v.kind).toBe("admission-closed");
  });

  test("admission-closed near-full weekly does NOT trigger underutilization", () => {
    const w = weeklyBurn(97.5, 0.1, 0.4);
    const state = computeBudgetState(
      usage({ gateUtil: 50, warnUtil: 50, weekly: w }),
      usage({ gateUtil: 50, warnUtil: 50, weekly: w }),
      CONFIG,
      NOW,
    );
    expect(state.phase).not.toBe("underutilized");
    expect(state.underutilization.recommended).toBe(false);
  });

  test("H2 pauseAt=100 degenerate: will-fill clamps line to 100 but is NOT misclassified", () => {
    const cfg100 = { ...CONFIG, pauseAt: 100 };
    // will-fill: projected 100 > target 98 → will-fill, line clamps to 100.
    const fill = dynamicWindowVerdict(weeklyBurn(50, 10, 5), cfg100, NOW);
    expect(fill.kind).toBe("will-fill");
    if (fill.kind === "will-fill") expect(fill.line).toBe(100);
    // will-not-fill: projected 51 <= target 98 → will-not-fill (classified by
    // projectedAtReset, not line===100, so the clamp does not fool it).
    const notFill = dynamicWindowVerdict(weeklyBurn(50, 0.1, 10), cfg100, NOW);
    expect(notFill.kind).toBe("will-not-fill");
    if (notFill.kind === "will-not-fill") expect(notFill.projectedAtReset).toBe(51);
  });

  test("no confident rate → degraded", () => {
    expect(dynamicWindowVerdict({ util: 20, resetEpoch: NOW + 500_000 }, CONFIG, NOW).kind).toBe("degraded");
  });

  test("already-reset window → degraded (not a live signal)", () => {
    expect(dynamicWindowVerdict(weeklyBurn(20, 0.1, -1), CONFIG, NOW).kind).toBe("degraded");
  });
});
