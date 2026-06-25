/**
 * v3.2 — time-aware dynamic pause line (07-额度协调与策略v3.md §3.1), the
 * SOLE budget strategy (conserve|maximize selector removed). targetUtil = 98.
 *
 * Covers:
 *   - the §3.1 calibration table (today's live case / won't-fill / will-fill /
 *     far term / hard caps), each row asserting its branch at targetUtil 98;
 *   - the degradation matrix (resetEpoch=0 / stale / non-confident) → the fixed
 *     gateUtil FALLBACK line (pauseAt / resumeBelow);
 *   - symmetric resume + window-reset recovery;
 *   - invariant I1 (the line never pauses below pauseAt) as a property test;
 *   - invariant I2 (phantom-hold: stale data never opens a closed gate) via
 *     classifyPoll;
 *   - Q10 resume-condition directive text.
 */
import { describe, expect, test } from "bun:test";
import {
  agentCanResume,
  agentShouldPause,
  dynamicPauseAt,
  effectiveDynamicLine,
  resumeBlockingEpochFor,
} from "../budget/budget-decision";
import { classifyPoll, INITIAL_FINGERPRINT_STATE } from "../budget/budget-fingerprint";
import { computeBudgetState, renderBudgetInterventionDirective } from "../budget/budget-state";
import type { AgentUsage, BudgetConfig, BudgetWindow } from "../budget/types";

const NOW = 1_000_000;

const MAXIMIZE: BudgetConfig = {
  enabled: true,
  pollSeconds: 300,
  budgetFreshTtlSec: 25,
  idleAdviceActivityWindowSec: 600,
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

/** Build a window resetting `tHours` from NOW, optionally with a guard burn rate. */
function win(util: number, tHours: number, rate?: number, confident = true): BudgetWindow {
  const w: BudgetWindow = { util, resetEpoch: NOW + Math.round(tHours * 3600) };
  if (rate !== undefined) {
    w.burnRate = rate;
    w.burnConfident = confident;
  }
  return w;
}

/** Build a decision-grade AgentUsage from optional 5h/weekly windows. */
function usage(opts: {
  fiveHour?: BudgetWindow | null;
  weekly?: BudgetWindow | null;
  gateUtil?: number;
  rateLimitedUntil?: number;
  fetchedAt?: number;
}): AgentUsage {
  const fiveHour = opts.fiveHour ?? null;
  const weekly = opts.weekly ?? null;
  const gateUtil = opts.gateUtil ?? Math.max(fiveHour?.util ?? 0, weekly?.util ?? 0);
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil: gateUtil,
    fiveHour,
    weekly,
    remaining: Math.max(0, 100 - gateUtil),
    rateLimitedUntil: opts.rateLimitedUntil ?? 0,
    fetchedAt: opts.fetchedAt ?? NOW,
    parsedVia: "id-match",
  };
}

describe("dynamicPauseAt — §3.1 calibration table (targetUtil=98)", () => {
  test("today's live case (util=92, tH=6.5, rate=1.2) → branch (b), line≈94.4, does not pause", () => {
    // fm=clamp(0.6,1,10)=1; projected=92+7.8=99.8>98 → (b); reserve=min(7,2.6)=2.6;
    // line=98−1−2.6=94.4.
    const line = dynamicPauseAt(win(92, 6.5, 1.2), 1.2, MAXIMIZE, NOW);
    expect(typeof line).toBe("number");
    expect(line as number).toBeCloseTo(94.4, 5);
    expect(92 >= (line as number)).toBe(false); // util below line → no pause
  });

  test("won't-fill (i): util=92, tH=1, rate=1.2 → branch (a) → 100 (no pause)", () => {
    // projected=92+1.2=93.2≤98 → (a); no hard cap → 100.
    expect(dynamicPauseAt(win(92, 1, 1.2), 1.2, MAXIMIZE, NOW)).toBe(100);
  });

  test("will-fill (ii): util=97, tH=1, rate=2 → branch (b), line≈96.6 → pause", () => {
    // fm=clamp(1,1,10)=1; projected=97+2=99>98 → (b); reserve=min(7,0.4)=0.4;
    // line=98−1−0.4=96.6.
    const line = dynamicPauseAt(win(97, 1, 2), 2, MAXIMIZE, NOW);
    expect(line as number).toBeCloseTo(96.6, 5);
    expect(97 >= (line as number)).toBe(true);
  });

  test("far term (tH=120, rate=1.2) → reserve saturates → clamps to pauseAt=90", () => {
    // (b); reserve=min(7,48)=7; line=98−1−7=90 → clamp[90,99]=90.
    expect(dynamicPauseAt(win(50, 120, 1.2), 1.2, MAXIMIZE, NOW)).toBeCloseTo(90, 5);
  });

  test("hard cap 1: util≥targetUtil (util=98) with zero rate → admission-closed", () => {
    // projected=98≤98 → (a); util 98≥targetUtil 98 → admission-closed.
    expect(dynamicPauseAt(win(98, 2, 0), 0, MAXIMIZE, NOW)).toBe("admission-closed");
  });

  test("hard cap 2 (Codex counterexample): near-reset finishing band → admission-closed", () => {
    // finishingHorizon=30min, rate=20 → fm=10; tH=0.25<0.5, util=88≥98−10=88.
    expect(dynamicPauseAt(win(88, 0.25, 20), 20, MAXIMIZE, NOW)).toBe("admission-closed");
  });

  test("past reset (resetEpoch<=now) → 100 (never pause on a stale window)", () => {
    expect(dynamicPauseAt({ util: 99, resetEpoch: NOW - 10 }, 5, MAXIMIZE, NOW)).toBe(100);
  });

  test("tH clamped at 7 days so a bogus far-future reset cannot blow up the line", () => {
    const sane = dynamicPauseAt(win(50, 7 * 24, 1.2), 1.2, MAXIMIZE, NOW);
    const bogus = dynamicPauseAt(win(50, 7 * 24 * 100, 1.2), 1.2, MAXIMIZE, NOW);
    expect(bogus).toBe(sane);
  });

  test("branch (a) won't-fill with rate=0 and util<target → 100 (no hard cap)", () => {
    // projected=96≤98 → (a); cap1 (96≥98) no; cap2 (tH 2 < 0.5) no → 100.
    expect(dynamicPauseAt(win(96, 2, 0), 0, MAXIMIZE, NOW)).toBe(100);
  });

  test("hard cap 2 boundary is strict (tH < horizon): tH=0.5 does NOT fire", () => {
    // finishingHorizon=30min→0.5h; rate=20→fm=10; util=88→projected≤98 → (a).
    expect(dynamicPauseAt(win(88, 0.49, 20), 20, MAXIMIZE, NOW)).toBe("admission-closed");
    expect(dynamicPauseAt(win(88, 0.5, 20), 20, MAXIMIZE, NOW)).toBe(100);
  });
});

describe("agentShouldPause — entry", () => {
  test("today's live case: codex weekly 92 / tH 6.5 / rate 1.2 → NOT paused", () => {
    const d = agentShouldPause("codex", usage({ weekly: win(92, 6.5, 1.2), fiveHour: win(22, 0.3, 0.4) }), MAXIMIZE, NOW);
    expect(d.pause).toBe(false);
  });

  test("util=97/tH=1/rate=2 → paused, window=weekly, line≈96.6", () => {
    const d = agentShouldPause("codex", usage({ weekly: win(97, 1, 2) }), MAXIMIZE, NOW);
    expect(d.pause).toBe(true);
    expect(d.window).toBe("weekly");
    expect(d.line as number).toBeCloseTo(96.6, 5);
  });

  test("hard cap 1 (util=98, rate=0) → paused (admission-closed, util≥pauseAt)", () => {
    const d = agentShouldPause("claude", usage({ weekly: win(98, 2, 0) }), MAXIMIZE, NOW);
    expect(d.pause).toBe(true);
  });

  test("I1 floor: admission-closed below pauseAt (util=88) → NOT paused", () => {
    const d = agentShouldPause("codex", usage({ fiveHour: win(88, 0.25, 20) }), MAXIMIZE, NOW);
    expect(d.pause).toBe(false);
  });

  test("degraded (no confident rate): util≥pauseAt pauses, util<pauseAt does not", () => {
    expect(agentShouldPause("codex", usage({ weekly: win(91, 5) }), MAXIMIZE, NOW).pause).toBe(true);
    expect(agentShouldPause("codex", usage({ weekly: win(89, 5) }), MAXIMIZE, NOW).pause).toBe(false);
  });

  test("degraded (burnConfident=false) falls back to the gateUtil line per-window", () => {
    expect(agentShouldPause("codex", usage({ weekly: win(91, 5, 1.2, false) }), MAXIMIZE, NOW).pause).toBe(true);
  });

  test("non-decision-grade (all windows expired) → not paused", () => {
    const u = usage({ weekly: { util: 99, resetEpoch: NOW - 10 } });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(false);
  });

  test("stale fetch → not paused (isDecisionGrade gate)", () => {
    const u = usage({ weekly: win(97, 1, 2), fetchedAt: NOW - 601 });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(false);
  });

  test("expired window is skipped; a fresh tripping window still pauses", () => {
    const u = usage({ fiveHour: { util: 99, resetEpoch: NOW - 5 }, weekly: win(97, 1, 2) });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(true);
  });

  test("both windows trip → reason reports the FIRST (fiveHour) per WINDOW_KEYS order", () => {
    const u = usage({ fiveHour: win(97, 1, 2), weekly: win(97, 1, 2) });
    const d = agentShouldPause("codex", u, MAXIMIZE, NOW);
    expect(d.pause).toBe(true);
    expect(d.window).toBe("fiveHour");
  });
});

describe("invariant I1 — the dynamic line never pauses below pauseAt (property)", () => {
  test("dynamicPauseAt numeric result is always within [pauseAt, 99]", () => {
    for (let i = 0; i < 400; i++) {
      const pauseAt = 80 + (i % 15); // 80..94
      const targetUtil = Math.min(99, pauseAt + 1 + (i % 8)); // > pauseAt
      const cfg: BudgetConfig = {
        ...MAXIMIZE,
        pauseAt,
        maximize: {
          targetUtil,
          reserveSlopePctPerHour: (i % 6) * 0.7,
          reserveMaxPct: i % 20,
          finishingHorizonMinutes: 5 + (i % 170),
          resumeHysteresisPct: 1 + (i % 29),
          admissionAt: 50,
          wrapUpQuota: 2,
        },
      };
      const rate = (i % 25) * 0.5;
      const tH = 0.05 + (i % 200);
      const util = i % 101;
      const line = dynamicPauseAt(win(util, tH, rate), rate, cfg, NOW);
      if (typeof line === "number" && line !== 100) {
        expect(line).toBeGreaterThanOrEqual(pauseAt);
        expect(line).toBeLessThanOrEqual(99);
      }
    }
  });

  test("I1 edge: pauseAt=100 (degenerate) → line floors to 100, never pauses below it", () => {
    // clamp(line, 100, max(100,99)=100) = 100. A 99 ceiling would clamp DOWN to
    // 99 and pause at util≥99 — earlier than a pauseAt=100 floor. The floor wins.
    const cfg: BudgetConfig = { ...MAXIMIZE, pauseAt: 100 };
    expect(dynamicPauseAt(win(99, 6.5, 1.2), 1.2, cfg, NOW)).toBe(100);
    expect(agentShouldPause("codex", usage({ weekly: win(99, 6.5, 1.2) }), cfg, NOW).pause).toBe(false);
  });

  test("agentShouldPause: a tripping window always has util ≥ pauseAt", () => {
    for (let i = 0; i < 400; i++) {
      const pauseAt = 80 + (i % 15);
      const targetUtil = Math.min(99, pauseAt + 1 + (i % 8));
      const cfg: BudgetConfig = {
        ...MAXIMIZE,
        pauseAt,
        maximize: {
          targetUtil,
          reserveSlopePctPerHour: (i % 6) * 0.7,
          reserveMaxPct: i % 20,
          finishingHorizonMinutes: 5 + (i % 170),
          resumeHysteresisPct: 1 + (i % 29),
          admissionAt: 50,
          wrapUpQuota: 2,
        },
      };
      const u = usage({
        fiveHour: win((i * 7) % 101, 0.1 + (i % 50), (i % 10) * 0.8),
        weekly: win((i * 13) % 101, 0.2 + (i % 160), (i % 7) * 1.1),
      });
      const d = agentShouldPause("codex", u, cfg, NOW);
      if (d.pause && d.window) {
        expect(u[d.window]!.util).toBeGreaterThanOrEqual(pauseAt);
      }
    }
  });
});

describe("agentCanResume — symmetric exit", () => {
  test("still above the line (util=97, line≈96.6) → cannot resume", () => {
    expect(agentCanResume(usage({ weekly: win(97, 1, 2) }), MAXIMIZE, NOW)).toBe(false);
  });

  test("util receded into won't-fill band (util=90, tH=1) → resumes", () => {
    expect(agentCanResume(usage({ weekly: win(90, 1, 1.2) }), MAXIMIZE, NOW)).toBe(true);
  });

  test("(b)→(a) transition: util=92/tH=1 drops into won't-fill → resumes", () => {
    // projected=93.2≤98 → (a) → line 100 (won't-fill) → never blocks resume.
    expect(agentCanResume(usage({ weekly: win(92, 1, 1.2) }), MAXIMIZE, NOW)).toBe(true);
  });

  test("won't-fill window at HIGH util (line=100, util=95) does NOT block resume", () => {
    // util=95/tH=1/rate=1 → projected 96≤98 → (a) won't-fill → line 100. This
    // window never triggers entry, so it must never block resume (symmetry).
    expect(agentCanResume(usage({ weekly: win(95, 1, 1) }), MAXIMIZE, NOW)).toBe(true);
  });

  test("a won't-fill window does not keep another recovered side paused", () => {
    const u = usage({ fiveHour: win(80, 1, 0.5), weekly: win(96, 1, 0.5) });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(false);
    expect(agentCanResume(u, MAXIMIZE, NOW)).toBe(true);
  });

  test("window reset (expired) + other window low → resumes", () => {
    const u = usage({ fiveHour: win(10, 0.3, 0.4), weekly: { util: 99, resetEpoch: NOW - 5 } });
    expect(agentCanResume(u, MAXIMIZE, NOW)).toBe(true);
  });

  test("active rate-limit blocks resume regardless of util", () => {
    expect(
      agentCanResume(usage({ weekly: win(10, 1, 0.4), rateLimitedUntil: NOW + 100 }), MAXIMIZE, NOW),
    ).toBe(false);
  });

  test("degraded window resumes only below resumeBelow (fallback exit)", () => {
    expect(agentCanResume(usage({ weekly: win(40, 5) }), MAXIMIZE, NOW)).toBe(false);
    expect(agentCanResume(usage({ weekly: win(29, 5) }), MAXIMIZE, NOW)).toBe(true);
  });
});

describe("resumeBlockingEpochFor — Q10 alignment", () => {
  test("returns the blocking window's reset while still over the line", () => {
    const weekly = win(97, 1, 2);
    expect(resumeBlockingEpochFor(usage({ weekly }), MAXIMIZE, NOW)).toBe(weekly.resetEpoch);
  });

  test("returns 0 once no window blocks resume", () => {
    expect(resumeBlockingEpochFor(usage({ weekly: win(90, 1, 1.2) }), MAXIMIZE, NOW)).toBe(0);
  });

  test("active rate-limit wins", () => {
    expect(
      resumeBlockingEpochFor(usage({ weekly: win(97, 1, 2), rateLimitedUntil: NOW + 500 }), MAXIMIZE, NOW),
    ).toBe(NOW + 500);
  });
});

describe("effectiveDynamicLine — display only", () => {
  test("today's case → ≈94.4", () => {
    expect(effectiveDynamicLine(usage({ weekly: win(92, 6.5, 1.2) }), MAXIMIZE, NOW)).toBeCloseTo(94.4, 5);
  });

  test("non-decision-grade → null", () => {
    const u = usage({ weekly: { util: 99, resetEpoch: NOW - 10 } });
    expect(effectiveDynamicLine(u, MAXIMIZE, NOW)).toBeNull();
  });

  test("picks the binding (smallest-headroom) window", () => {
    // weekly util=92 → (b) line 94.4. fiveHour util=50 → (a) won't-fill → line 100,
    // skipped (>=100). So weekly is the only numeric line and is chosen as binding.
    const u = usage({ fiveHour: win(50, 6.5, 1.2), weekly: win(92, 6.5, 1.2) });
    expect(effectiveDynamicLine(u, MAXIMIZE, NOW)).toBeCloseTo(94.4, 5);
  });

  test("two confident numeric lines → smallest headroom wins", () => {
    // Both will-fill (b), same line 94.4 (tH 6.5, rate 1.2). fiveHour util=93
    // (headroom 1.4) vs weekly util=91 (headroom 3.4) → fiveHour is binding.
    const u = usage({ fiveHour: win(93, 6.5, 1.2), weekly: win(91, 6.5, 1.2) });
    expect(effectiveDynamicLine(u, MAXIMIZE, NOW)).toBeCloseTo(94.4, 5);
  });
});

describe("invariant I2 — phantom-hold (classifyPoll)", () => {
  test("a paused side holds when its data goes non-decision-grade", () => {
    // Poll 1: codex weekly trips the line (util=97, tH=1, rate=2 → line 96.6).
    const s1 = computeBudgetState(null, usage({ weekly: win(97, 1, 2) }), MAXIMIZE, NOW);
    const r1 = classifyPoll(INITIAL_FINGERPRINT_STATE, s1, MAXIMIZE);
    expect(r1.next.side).toBe("codex");

    // Poll 2: codex probe goes stale (non-decision-grade) — must HOLD, not open.
    const staleCodex = usage({ weekly: win(97, 1, 2), fetchedAt: NOW - 601 });
    const s2 = computeBudgetState(null, staleCodex, MAXIMIZE, NOW + 60);
    const r2 = classifyPoll(r1.next, s2, MAXIMIZE);
    expect(r2.next.side).toBe("codex");
    expect(r2.effect.kind).toBe("hold-uncertain");
  });

  test("stale/expired hold keeps the sticky FUTURE resumeEpoch (no past-time clobber)", () => {
    // Poll 1: codex weekly trips (util=97, tH=1, rate=2 → line 96.6); the blocking
    // window's reset (NOW+3600) becomes the resumeEpoch.
    const s1 = computeBudgetState(null, usage({ weekly: win(97, 1, 2) }), MAXIMIZE, NOW);
    const r1 = classifyPoll(INITIAL_FINGERPRINT_STATE, s1, MAXIMIZE);
    expect(r1.next.side).toBe("codex");
    expect(r1.next.resumeEpoch).toBe(NOW + 3600);

    // Poll 2: codex probe is stale AND its only window has already reset
    // (resetEpoch in the past). The gate must HOLD and the resumeEpoch must NOT
    // be overwritten with the past reset — it stays the last known-good future.
    const expiredStale = usage({
      fiveHour: { util: 99, resetEpoch: NOW - 10 },
      weekly: null,
      fetchedAt: NOW - 700,
    });
    const s2 = computeBudgetState(null, expiredStale, MAXIMIZE, NOW + 60);
    const r2 = classifyPoll(r1.next, s2, MAXIMIZE);
    expect(r2.next.side).toBe("codex");
    expect(r2.next.resumeEpoch).toBe(NOW + 3600); // sticky future, not NOW-10
  });
});

describe("renderBudgetInterventionDirective — Q10 resume-condition text", () => {
  const claudeU = usage({ weekly: win(97, 1, 2) });
  const codexU = usage({ weekly: win(40, 6.5, 0.4) });

  test("codex side: resume text describes the dynamic line, not 30%", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "codex", "r", NOW + 3600, MAXIMIZE);
    expect(text).toContain("动态暂停线");
    expect(text).toContain("− 5%");
    expect(text).not.toContain("gateUtil 低于 30%");
  });

  test("claude side: handoff resume text describes the dynamic line", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "claude", "r", NOW + 3600, MAXIMIZE);
    expect(text).toContain("动态暂停线");
    expect(text).not.toContain("低于 30%");
  });

  test("both sides: joint resume text describes the dynamic line", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "both", "r", NOW + 3600, MAXIMIZE);
    expect(text).toContain("动态暂停线");
    expect(text).not.toContain("都低于 30%");
  });
});
