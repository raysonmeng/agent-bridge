/**
 * v3 P3 (§3.2) — admission-gate decision predicates (budget-decision.ts).
 *
 * Covers agentShouldAdmitClose / agentCanAdmitOpen:
 *   - the three independent CLOSE triggers (5h util ≥ admissionAt; §3.1 hard cap;
 *     weekly runway < finishingHorizon×2), each in isolation + first-match order;
 *   - the OPEN side with hysteresis (util admissionAt−resumeHysteresisPct; the
 *     2×/3× weekly-runway enter/exit hold band);
 *   - I2: non-decision-grade (null / stale / all-reset) never closes AND never
 *     opens (the predicates return false for canAdmitOpen on stale — phantom-hold
 *     in the fingerprint keeps a closed gate closed).
 */
import { describe, expect, test } from "bun:test";
import { agentCanAdmitOpen, agentShouldAdmitClose } from "../budget/budget-decision";
import type { AgentUsage, BudgetConfig, BudgetWindow } from "../budget/types";

const NOW = 1_000_000;

const CFG: BudgetConfig = {
  enabled: true,
  pollSeconds: 300,
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
    finishingHorizonMinutes: 30, // floor: enter < 2×30m=3600s, exit ≥ 3×30m=5400s
    resumeHysteresisPct: 5, // admission util exit line: admissionAt − 5 = 80
    admissionAt: 85,
    wrapUpQuota: 2,
  },
  allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
};

interface WinOpts {
  rate?: number;
  confident?: boolean;
  runwaySeconds?: number;
}

/** Build a window resetting `tHours` from NOW with optional burn rate + runway. */
function win(util: number, tHours: number, opts: WinOpts = {}): BudgetWindow {
  const w: BudgetWindow = { util, resetEpoch: NOW + Math.round(tHours * 3600) };
  if (opts.rate !== undefined) {
    w.burnRate = opts.rate;
    w.burnConfident = opts.confident ?? true;
  }
  if (opts.runwaySeconds !== undefined) w.runwaySeconds = opts.runwaySeconds;
  return w;
}

function usage(opts: {
  fiveHour?: BudgetWindow | null;
  weekly?: BudgetWindow | null;
  fetchedAt?: number;
}): AgentUsage {
  const fiveHour = opts.fiveHour ?? null;
  const weekly = opts.weekly ?? null;
  const gateUtil = Math.max(fiveHour?.util ?? 0, weekly?.util ?? 0);
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil: gateUtil,
    fiveHour,
    weekly,
    remaining: Math.max(0, 100 - gateUtil),
    rateLimitedUntil: 0,
    fetchedAt: opts.fetchedAt ?? NOW,
    parsedVia: "id-match",
  };
}

describe("agentShouldAdmitClose — close triggers", () => {
  test("(1) 5h util ≥ admissionAt closes, attributes fiveHour", () => {
    const d = agentShouldAdmitClose("codex", usage({ fiveHour: win(85, 3) }), CFG, NOW);
    expect(d.admitClose).toBe(true);
    expect(d.window).toBe("fiveHour");
    expect(d.reason).toContain("admissionAt");
  });

  test("(1) 5h util just below admissionAt does NOT close (no other trigger)", () => {
    const d = agentShouldAdmitClose("codex", usage({ fiveHour: win(84, 3) }), CFG, NOW);
    expect(d.admitClose).toBe(false);
  });

  test("(2) §3.1 hard cap (5h util ≥ targetUtil) closes via the hard-cap branch", () => {
    // util 98 ≥ admissionAt too, but the reason should mention the util line first
    // (condition 1 wins). Use a weekly hard cap with 5h below admissionAt to hit (2).
    // rate 0 keeps projected (= util) at target, so the `util ≥ targetUtil`
    // hard cap fires (a positive rate would project past target → will-fill →
    // a numeric line, not admission-closed).
    const d = agentShouldAdmitClose(
      "codex",
      usage({ fiveHour: win(50, 3, { rate: 1, confident: true }), weekly: win(98, 5, { rate: 0, confident: true }) }),
      CFG,
      NOW,
    );
    expect(d.admitClose).toBe(true);
    expect(d.window).toBe("weekly");
    expect(d.reason).toContain("收尾保护硬线");
  });

  test("(3) weekly will-fill + runway < 2×finishingHorizon closes, attributes weekly", () => {
    // weekly: util 70, rate 20/h, 2h to reset → projected 110 > target 98 (will-fill);
    // runwaySeconds 3000 < 3600 floor. 5h clean (util 50 < admissionAt, no hard cap).
    const d = agentShouldAdmitClose(
      "codex",
      usage({
        fiveHour: win(50, 4, { rate: 1, confident: true }),
        weekly: win(70, 2, { rate: 20, confident: true, runwaySeconds: 3000 }),
      }),
      CFG,
      NOW,
    );
    expect(d.admitClose).toBe(true);
    expect(d.window).toBe("weekly");
    expect(d.reason).toContain("runway");
  });

  test("(3) weekly runway above the enter floor does NOT close", () => {
    const d = agentShouldAdmitClose(
      "codex",
      usage({
        fiveHour: win(50, 4, { rate: 1, confident: true }),
        weekly: win(70, 2, { rate: 20, confident: true, runwaySeconds: 4000 }), // > 3600
      }),
      CFG,
      NOW,
    );
    expect(d.admitClose).toBe(false);
  });

  test("will-not-fill weekly with short runway does NOT close (reset-truncation guard)", () => {
    // Low burn → won't fill before reset; a short runwaySeconds here is reset-bound,
    // not depletion-bound, so it must not trigger the weekly guard.
    const d = agentShouldAdmitClose(
      "codex",
      usage({ weekly: win(50, 0.5, { rate: 0.1, confident: true, runwaySeconds: 1000 }) }),
      CFG,
      NOW,
    );
    expect(d.admitClose).toBe(false);
  });

  test("non-confident weekly (no burn rate) does not trigger the runway guard", () => {
    // burnConfident:false → confidentRate null → dynamicWindowVerdict degraded →
    // weeklyRunwayShort returns false even with a short runwaySeconds.
    const w = win(70, 2, { rate: 20, confident: false, runwaySeconds: 1000 });
    expect(agentShouldAdmitClose("codex", usage({ weekly: w }), CFG, NOW).admitClose).toBe(false);
  });

  test("weekly absent → no runway trigger, only 5h drives close", () => {
    expect(agentShouldAdmitClose("codex", usage({ fiveHour: win(70, 3) }), CFG, NOW).admitClose).toBe(false);
    expect(agentShouldAdmitClose("codex", usage({ fiveHour: win(86, 3) }), CFG, NOW).admitClose).toBe(true);
  });

  test("null / non-decision-grade usage never closes (I2)", () => {
    expect(agentShouldAdmitClose("codex", null, CFG, NOW).admitClose).toBe(false);
    // stale: fetchedAt far in the past
    const stale = usage({ fiveHour: win(95, 3), fetchedAt: NOW - 10_000 });
    expect(agentShouldAdmitClose("codex", stale, CFG, NOW).admitClose).toBe(false);
    // all windows already reset
    const past = usage({ fiveHour: win(95, -1) });
    expect(agentShouldAdmitClose("codex", past, CFG, NOW).admitClose).toBe(false);
  });
});

describe("agentCanAdmitOpen — open with hysteresis", () => {
  test("all clear → can open", () => {
    expect(agentCanAdmitOpen(usage({ fiveHour: win(70, 3) }), CFG, NOW)).toBe(true);
  });

  test("5h util in hysteresis band [admissionAt−5, admissionAt) blocks open", () => {
    // 82 ≥ 80 (= 85 − 5) → still blocks open even though < admissionAt (no new entry).
    expect(agentCanAdmitOpen(usage({ fiveHour: win(82, 3) }), CFG, NOW)).toBe(false);
  });

  test("5h util below the relaxed line opens", () => {
    expect(agentCanAdmitOpen(usage({ fiveHour: win(79, 3) }), CFG, NOW)).toBe(true);
  });

  test("hard cap still firing blocks open", () => {
    expect(
      agentCanAdmitOpen(usage({ fiveHour: win(50, 3), weekly: win(98, 5, { rate: 0, confident: true }) }), CFG, NOW),
    ).toBe(false);
  });

  test("weekly runway in the hold band [2×, 3×) blocks open (hysteresis)", () => {
    // runway 4000s: ≥ 3600 (won't newly enter) but < 5400 (exit floor) → holds closed.
    const u = usage({
      fiveHour: win(50, 4, { rate: 1, confident: true }),
      weekly: win(70, 2, { rate: 20, confident: true, runwaySeconds: 4000 }),
    });
    expect(agentCanAdmitOpen(u, CFG, NOW)).toBe(false);
  });

  test("weekly runway above the exit floor opens", () => {
    const u = usage({
      fiveHour: win(50, 4, { rate: 1, confident: true }),
      weekly: win(70, 2, { rate: 20, confident: true, runwaySeconds: 6000 }), // > 5400
    });
    expect(agentCanAdmitOpen(u, CFG, NOW)).toBe(true);
  });

  test("non-decision-grade never opens (I2: stale must not release a closed gate)", () => {
    expect(agentCanAdmitOpen(null, CFG, NOW)).toBe(false);
    const stale = usage({ fiveHour: win(70, 3), fetchedAt: NOW - 10_000 });
    expect(agentCanAdmitOpen(stale, CFG, NOW)).toBe(false);
  });

  test("a live rate-limit blocks open even when util has receded (parity with agentCanResume)", () => {
    const u = usage({ fiveHour: win(70, 3) });
    u.rateLimitedUntil = NOW + 600;
    expect(agentCanAdmitOpen(u, CFG, NOW)).toBe(false);
  });
});
