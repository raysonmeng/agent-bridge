/**
 * v3 P2 — time-aware maximize pause line (design budget-strategy-v3.md §3.1).
 *
 * Covers the acceptance set called out in §6 P2:
 *   - the §3.1 calibration table (today's live case / last-1h (a)+(b) / far term
 *     / hard caps), each row asserting its branch;
 *   - the full degradation matrix (resetEpoch=0 / stale / non-confident /
 *     both-unknown) → conserve fallback;
 *   - symmetric resume + window-reset recovery;
 *   - invariant I1 (maximize never pauses below pauseAt) as a property test;
 *   - invariant I2 (phantom-hold: stale data never opens a closed gate) via
 *     classifyPoll;
 *   - conserve mode untouched (sanity guards alongside the existing suites).
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
  pauseAt: 90,
  resumeBelow: 30,
  syncDriftPct: 10,
  parallel: { minRemainingPct: 60, timeWindowSec: 3600 },
  codexTierControl: false,
  codexTiers: { full: null, balanced: { effort: "medium" }, eco: { effort: "low" } },
  strategy: "maximize",
  maximize: {
    targetUtil: 97,
    reserveSlopePctPerHour: 0.4,
    reserveMaxPct: 7,
    finishingHorizonMinutes: 30,
    resumeHysteresisPct: 5,
  },
};

const CONSERVE: BudgetConfig = { ...MAXIMIZE, strategy: "conserve" };

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

describe("dynamicPauseAt — §3.1 calibration table", () => {
  test("today's live case (util=92, tH=6.5, rate=1.2) → branch (b), line≈93.4, does not pause", () => {
    const line = dynamicPauseAt(win(92, 6.5, 1.2), 1.2, MAXIMIZE, NOW);
    expect(typeof line).toBe("number");
    expect(line as number).toBeCloseTo(93.4, 5);
    expect(92 >= (line as number)).toBe(false); // util below line → no pause
  });

  test("last 1h (i): util=92, tH=1, rate=1.2 → branch (a) won't-fill → 100 (no pause)", () => {
    expect(dynamicPauseAt(win(92, 1, 1.2), 1.2, MAXIMIZE, NOW)).toBe(100);
  });

  test("last 1h (ii): util=96, tH=1, rate=1.2 → branch (b), line≈95.6 → pause", () => {
    const line = dynamicPauseAt(win(96, 1, 1.2), 1.2, MAXIMIZE, NOW);
    expect(line as number).toBeCloseTo(95.6, 5);
    expect(96 >= (line as number)).toBe(true);
  });

  test("far term (tH=120, rate=1.2) → reserve saturates → clamps to pauseAt=90 (≈conserve)", () => {
    expect(dynamicPauseAt(win(50, 120, 1.2), 1.2, MAXIMIZE, NOW)).toBeCloseTo(90, 5);
  });

  test("hard cap 1: util≥targetUtil with zero rate → admission-closed", () => {
    expect(dynamicPauseAt(win(97, 2, 0), 0, MAXIMIZE, NOW)).toBe("admission-closed");
  });

  test("hard cap 2 (Codex counterexample): near-reset finishing band → admission-closed", () => {
    // finishingHorizon=30min, rate=20 → finishingMargin=10; tH=0.25<0.5, util=88≥87.
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
    // projected=96≤97 → (a); cap1 (96≥97) no; cap2 (tH 2 < 0.5) no → 100.
    expect(dynamicPauseAt(win(96, 2, 0), 0, MAXIMIZE, NOW)).toBe(100);
  });

  test("hard cap 2 boundary is strict (tH < horizon): tH=0.5 does NOT fire", () => {
    // finishingHorizon=30min→0.5h; rate=20→margin=10; util=87→projected=97≤97 (a).
    expect(dynamicPauseAt(win(87, 0.49, 20), 20, MAXIMIZE, NOW)).toBe("admission-closed");
    expect(dynamicPauseAt(win(87, 0.5, 20), 20, MAXIMIZE, NOW)).toBe(100);
  });
});

describe("agentShouldPause — maximize entry", () => {
  test("today's live case: codex weekly 92 / tH 6.5 / rate 1.2 → NOT paused", () => {
    const d = agentShouldPause("codex", usage({ weekly: win(92, 6.5, 1.2), fiveHour: win(22, 0.3, 0.4) }), MAXIMIZE, NOW);
    expect(d.pause).toBe(false);
  });

  test("util=96 last 1h → paused, window=weekly, line≈95.6", () => {
    const d = agentShouldPause("codex", usage({ weekly: win(96, 1, 1.2) }), MAXIMIZE, NOW);
    expect(d.pause).toBe(true);
    expect(d.window).toBe("weekly");
    expect(d.line as number).toBeCloseTo(95.6, 5);
  });

  test("hard cap 1 (util=97, rate=0) → paused (admission-closed, util≥pauseAt)", () => {
    const d = agentShouldPause("claude", usage({ weekly: win(97, 2, 0) }), MAXIMIZE, NOW);
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

  test("degraded (burnConfident=false) falls back to conserve per-window", () => {
    expect(agentShouldPause("codex", usage({ weekly: win(91, 5, 1.2, false) }), MAXIMIZE, NOW).pause).toBe(true);
  });

  test("non-decision-grade (all windows expired) → not paused", () => {
    const u = usage({ weekly: { util: 99, resetEpoch: NOW - 10 } });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(false);
  });

  test("stale fetch → not paused (isDecisionGrade gate)", () => {
    const u = usage({ weekly: win(96, 1, 1.2), fetchedAt: NOW - 601 });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(false);
  });

  test("expired window is skipped; a fresh tripping window still pauses", () => {
    const u = usage({ fiveHour: { util: 99, resetEpoch: NOW - 5 }, weekly: win(96, 1, 1.2) });
    expect(agentShouldPause("codex", u, MAXIMIZE, NOW).pause).toBe(true);
  });

  test("both windows trip → reason reports the FIRST (fiveHour) per WINDOW_KEYS order", () => {
    const u = usage({ fiveHour: win(96, 1, 1.2), weekly: win(96, 1, 1.2) });
    const d = agentShouldPause("codex", u, MAXIMIZE, NOW);
    expect(d.pause).toBe(true);
    expect(d.window).toBe("fiveHour");
  });
});

describe("invariant I1 — maximize never pauses below pauseAt (property)", () => {
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

  test("I1 edge: pauseAt=100 (degenerate) → line floors to 100, never pauses below conserve", () => {
    // clamp(line, 100, max(100,99)=100) = 100. A 99 ceiling would clamp DOWN to
    // 99 and pause at util≥99 — earlier than conserve (which never pauses at
    // pauseAt=100). The floor must win.
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

describe("agentCanResume — maximize symmetric exit", () => {
  test("still above the line (util=96, line≈95.6) → cannot resume", () => {
    expect(agentCanResume(usage({ weekly: win(96, 1, 1.2) }), MAXIMIZE, NOW)).toBe(false);
  });

  test("util receded into won't-fill band (util=90, tH=1) → resumes", () => {
    expect(agentCanResume(usage({ weekly: win(90, 1, 1.2) }), MAXIMIZE, NOW)).toBe(true);
  });

  test("(b)→(a) transition: util=92/tH=1 drops into won't-fill → resumes", () => {
    // projected=93.2≤97 → (a) → line 100 (won't-fill) → never blocks resume.
    expect(agentCanResume(usage({ weekly: win(92, 1, 1.2) }), MAXIMIZE, NOW)).toBe(true);
  });

  test("won't-fill window at HIGH util (line=100, util=95) does NOT block resume", () => {
    // util=95/tH=1/rate=1 → projected 96≤97 → (a) won't-fill → line 100. This
    // window never triggers entry, so it must never block resume (symmetry) —
    // even though util 95 ≥ 100−hyst(5). Regression guard for the line=100 fix.
    expect(agentCanResume(usage({ weekly: win(95, 1, 1) }), MAXIMIZE, NOW)).toBe(true);
  });

  test("a won't-fill window does not keep another recovered side paused", () => {
    // weekly recovered into won't-fill (line 100) at util 96; fiveHour also
    // won't-fill. Neither gates entry → resume must be allowed.
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

  test("degraded window resumes only below resumeBelow (conserve exit)", () => {
    expect(agentCanResume(usage({ weekly: win(40, 5) }), MAXIMIZE, NOW)).toBe(false);
    expect(agentCanResume(usage({ weekly: win(29, 5) }), MAXIMIZE, NOW)).toBe(true);
  });
});

describe("resumeBlockingEpochFor — maximize Q10 alignment", () => {
  test("returns the blocking window's reset while still over the line", () => {
    const weekly = win(96, 1, 1.2);
    expect(resumeBlockingEpochFor(usage({ weekly }), MAXIMIZE, NOW)).toBe(weekly.resetEpoch);
  });

  test("returns 0 once no window blocks resume", () => {
    expect(resumeBlockingEpochFor(usage({ weekly: win(90, 1, 1.2) }), MAXIMIZE, NOW)).toBe(0);
  });

  test("active rate-limit wins", () => {
    expect(
      resumeBlockingEpochFor(usage({ weekly: win(96, 1, 1.2), rateLimitedUntil: NOW + 500 }), MAXIMIZE, NOW),
    ).toBe(NOW + 500);
  });
});

describe("effectiveDynamicLine — display only", () => {
  test("maximize today's case → ≈93.4", () => {
    expect(effectiveDynamicLine(usage({ weekly: win(92, 6.5, 1.2) }), MAXIMIZE, NOW)).toBeCloseTo(93.4, 5);
  });

  test("conserve mode → null", () => {
    expect(effectiveDynamicLine(usage({ weekly: win(92, 6.5, 1.2) }), CONSERVE, NOW)).toBeNull();
  });

  test("picks the binding (smallest-headroom) window", () => {
    // Both windows: tH 6.5, rate 1.2. weekly util=92 → projected 99.8 > 97 → (b)
    // line 93.4. fiveHour util=50 → projected 57.8 ≤ 97 → (a) won't-fill → line
    // 100, which effectiveDynamicLine skips (>=100). So weekly is the only
    // numeric line and is correctly chosen as binding.
    const u = usage({ fiveHour: win(50, 6.5, 1.2), weekly: win(92, 6.5, 1.2) });
    expect(effectiveDynamicLine(u, MAXIMIZE, NOW)).toBeCloseTo(93.4, 5);
  });

  test("two confident numeric lines → smallest headroom wins", () => {
    // Both will-fill (b), same line 93.4 (tH 6.5, rate 1.2). fiveHour util=93
    // (headroom 0.4) vs weekly util=91 (headroom 2.4) → fiveHour is binding.
    const u = usage({ fiveHour: win(93, 6.5, 1.2), weekly: win(91, 6.5, 1.2) });
    expect(effectiveDynamicLine(u, MAXIMIZE, NOW)).toBeCloseTo(93.4, 5);
  });
});

describe("invariant I2 — phantom-hold under maximize (classifyPoll)", () => {
  test("a paused maximize side holds when its data goes non-decision-grade", () => {
    // Poll 1: codex weekly trips the line (util=96, tH=1, rate=1.2 → line 95.6).
    const s1 = computeBudgetState(null, usage({ weekly: win(96, 1, 1.2) }), MAXIMIZE, NOW);
    const r1 = classifyPoll(INITIAL_FINGERPRINT_STATE, s1, MAXIMIZE);
    expect(r1.next.side).toBe("codex");

    // Poll 2: codex probe goes stale (non-decision-grade) — must HOLD, not open.
    const staleCodex = usage({ weekly: win(96, 1, 1.2), fetchedAt: NOW - 601 });
    const s2 = computeBudgetState(null, staleCodex, MAXIMIZE, NOW + 60);
    const r2 = classifyPoll(r1.next, s2, MAXIMIZE);
    expect(r2.next.side).toBe("codex");
    expect(r2.effect.kind).toBe("hold-uncertain");
  });

  test("stale/expired hold keeps the sticky FUTURE resumeEpoch (no past-time clobber)", () => {
    // Poll 1: codex weekly trips (util=96, tH=1, rate=1.2 → line 95.6); the
    // blocking window's reset (NOW+3600) becomes the resumeEpoch.
    const s1 = computeBudgetState(null, usage({ weekly: win(96, 1, 1.2) }), MAXIMIZE, NOW);
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
  const claudeU = usage({ weekly: win(96, 1, 1.2) });
  const codexU = usage({ weekly: win(40, 6.5, 0.4) });

  test("conserve: resume text keeps the historical gateUtil<resumeBelow wording", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "codex", "r", NOW + 3600, CONSERVE);
    expect(text).toContain("gateUtil 低于 30%");
    expect(text).not.toContain("动态暂停线");
  });

  test("maximize (codex side): resume text describes the dynamic line, not 30%", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "codex", "r", NOW + 3600, MAXIMIZE);
    expect(text).toContain("动态暂停线");
    expect(text).toContain("− 5%");
    expect(text).not.toContain("gateUtil 低于 30%");
  });

  test("maximize (claude side): handoff resume text is strategy-aware", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "claude", "r", NOW + 3600, MAXIMIZE);
    expect(text).toContain("动态暂停线");
    expect(text).not.toContain("低于 30%");
  });

  test("maximize (both sides): joint resume text is strategy-aware", () => {
    const text = renderBudgetInterventionDirective(claudeU, codexU, "both", "r", NOW + 3600, MAXIMIZE);
    expect(text).toContain("动态暂停线");
    expect(text).not.toContain("都低于 30%");
  });
});

describe("conserve mode is unchanged by the maximize path", () => {
  test("conserve still gates on gateUtil ≥ pauseAt, ignoring the dynamic line", () => {
    // util=92 with tH 6.5 would NOT pause under maximize (line 93.4) but DOES
    // under conserve (92 ≥ pauseAt 90).
    expect(agentShouldPause("codex", usage({ weekly: win(92, 6.5, 1.2) }), CONSERVE, NOW).pause).toBe(true);
  });

  test("conserve resume still requires gateUtil < resumeBelow", () => {
    expect(agentCanResume(usage({ weekly: win(40, 6.5, 1.2) }), CONSERVE, NOW)).toBe(false);
    expect(agentCanResume(usage({ weekly: win(20, 6.5, 1.2) }), CONSERVE, NOW)).toBe(true);
  });
});
