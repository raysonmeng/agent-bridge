import { describe, expect, test } from "bun:test";
import { computeBudgetState } from "../budget/budget-state";
import {
  classifyPoll,
  directiveFingerprint,
  INITIAL_FINGERPRINT_STATE,
  resumeCandidateSides,
  type FingerprintState,
} from "../budget/budget-fingerprint";
import { formatBeijing } from "../budget/format-time";
import type { AgentUsage, BudgetConfig, BudgetState } from "../budget/types";

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
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

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  const gateUtil = overrides.gateUtil ?? 20;
  const warnUtil = overrides.warnUtil ?? gateUtil;
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil,
    fiveHour: { util: gateUtil, resetEpoch: NOW + 3600 },
    weekly: { util: warnUtil, resetEpoch: NOW + 500_000 },
    remaining: 100 - gateUtil,
    rateLimitedUntil: 0,
    fetchedAt: NOW,
    parsedVia: "id-match",
    ...overrides,
  };
}

/** Build a real BudgetState from a per-agent probe pair (drives the reducer
 * through the same shape the coordinator feeds it in production). */
function state(claude: AgentUsage | null, codex: AgentUsage | null, now = NOW): BudgetState {
  return computeBudgetState(claude, codex, CONFIG, now);
}

/** Drive a sequence of polls from an initial state, returning the final state
 * and the ordered list of effects (kind only, with side where present). */
function runPolls(
  states: BudgetState[],
  start: FingerprintState = INITIAL_FINGERPRINT_STATE,
): { final: FingerprintState; effects: Array<ReturnType<typeof classifyPoll>["effect"]> } {
  let current = start;
  const effects: Array<ReturnType<typeof classifyPoll>["effect"]> = [];
  for (const s of states) {
    const { next, effect } = classifyPoll(current, s, CONFIG);
    effects.push(effect);
    current = next;
  }
  return { final: current, effects };
}

describe("classifyPoll reducer — event coverage", () => {
  test("none: both sides healthy, no directive, from idle", () => {
    const { final, effects } = runPolls([state(usage(), usage({ gateUtil: 21, warnUtil: 21 }))]);
    expect(effects[0]).toEqual({ kind: "none", recoveredSides: [] });
    expect(final.side).toBeNull();
    expect(final.fingerprint).toBeNull();
  });

  test("enter: codex trips the gate from idle", () => {
    const { final, effects } = runPolls([
      state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8 })),
    ]);
    expect(effects[0].kind).toBe("enter");
    expect(effects[0]).toMatchObject({ kind: "enter", side: "codex", emit: true, pauseChanged: true });
    expect(final.side).toBe("codex");
    expect(final.fingerprint).not.toBeNull();
  });

  test("enter: claude-only trips as handoff (side=claude)", () => {
    const { effects } = runPolls([
      state(usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), usage()),
    ]);
    expect(effects[0]).toMatchObject({ kind: "enter", side: "claude", emit: true, pauseChanged: true });
  });

  test("enter: both sides trip as joint pause (side=both)", () => {
    const { effects } = runPolls([
      state(
        usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      ),
    ]);
    expect(effects[0]).toMatchObject({ kind: "enter", side: "both", emit: true, pauseChanged: true });
  });

  test("pause hold (none-emit): same side, decision-grade, fingerprint unchanged → no re-emit", () => {
    const paused = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }));
    // Second poll: still over the gate, same reset bucket → fingerprint stable.
    const stillPaused = state(usage(), usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }));
    const { effects, final } = runPolls([paused, stillPaused]);
    expect(effects[0].kind).toBe("enter");
    // Second poll is still an "enter" kind (decision-grade), but must NOT emit
    // and must NOT flip pauseChanged.
    expect(effects[1]).toMatchObject({ kind: "enter", side: "codex", emit: false, pauseChanged: false });
    expect(final.side).toBe("codex");
  });

  test("hold-uncertain: mid-pause degraded record holds fingerprint without re-emit", () => {
    const paused = state(usage(), usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }));
    // Degraded windowless stale record on the active (codex) side — not
    // decision-grade, so canAgentResume is false → side stays codex, and the
    // probe-uncertain path holds the prior fingerprint.
    const degraded = state(
      usage(),
      usage({ gateUtil: 0, warnUtil: 0, stale: true, fiveHour: { util: 0, resetEpoch: 0 }, weekly: null }),
    );
    const { effects, final } = runPolls([paused, degraded]);
    expect(effects[0].kind).toBe("enter");
    expect(effects[1]).toMatchObject({ kind: "hold-uncertain", side: "codex", emit: false });
    // Fingerprint preserved across the blip.
    expect(final.fingerprint).toBe((classifyPoll(INITIAL_FINGERPRINT_STATE, paused, CONFIG)).next.fingerprint);
  });

  test("exit: previously paused side recovers below resumeBelow → exit", () => {
    const paused = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }));
    const recovered = state(usage(), usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }));
    const { effects, final } = runPolls([paused, recovered]);
    expect(effects[0].kind).toBe("enter");
    expect(effects[1]).toEqual({ kind: "exit", previousSide: "codex", recoveredSides: ["codex"] });
    expect(final.side).toBeNull();
    expect(final.fingerprint).toBeNull();
    expect(final.resumeEpoch).toBeNull();
    expect(final.reason).toBeNull();
  });

  test("advise: drift above threshold emits a balance advisory from idle", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    expect(drifted.phase).toBe("balance");
    const { effects, final } = runPolls([drifted]);
    expect(effects[0]).toEqual({ kind: "advise", phase: "balance", recoveredSides: [] });
    expect(final.side).toBeNull();
    expect(final.fingerprint).not.toBeNull();
  });

  test("advise dedup: identical drift on the next poll → none (no re-emit)", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    const { effects } = runPolls([drifted, drifted]);
    expect(effects[0]).toEqual({ kind: "advise", phase: "balance", recoveredSides: [] });
    expect(effects[1]).toEqual({ kind: "none", recoveredSides: [] });
  });

  test("advise: underutilized phase emits with phase=underutilized", () => {
    // v3 P4: parallel is retired; the underutilization advice is the new advise
    // phase. A weekly window with a confident low burn rate projects far below
    // target → will-not-fill → underutilized. (The cooldown gate lives in the
    // coordinator, not this pure reducer.)
    const wkly = { util: 20, resetEpoch: NOW + 500_000, burnRate: 0.1, burnConfident: true };
    const underutilized = state(
      usage({ gateUtil: 20, warnUtil: 20, weekly: wkly }),
      usage({ gateUtil: 20, warnUtil: 20, weekly: wkly }),
    );
    expect(underutilized.phase).toBe("underutilized");
    const { effects } = runPolls([underutilized]);
    expect(effects[0]).toEqual({ kind: "advise", phase: "underutilized", recoveredSides: [] });
  });

  test("reset: advising → directive disappears (decision-grade) clears fingerprint", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    const calm = state(usage({ gateUtil: 20, warnUtil: 20 }), usage({ gateUtil: 20, warnUtil: 20 }));
    expect(calm.directiveToClaude).toBeNull();
    const { effects, final } = runPolls([drifted, calm]);
    expect(effects[0].kind).toBe("advise");
    // null-directive on decision-grade data → effect none, but fingerprint reset.
    expect(effects[1]).toEqual({ kind: "none", recoveredSides: [] });
    expect(final.fingerprint).toBeNull();
    expect(final.side).toBeNull();
  });
});

describe("classifyPoll reducer — branch-order sensitivity", () => {
  // The decision-grade phantom HOLD must run BEFORE the null-directive reset.
  // A phantom (windowless) record that makes a drift directive disappear must
  // NOT clear the fingerprint, or the directive re-emits when data recovers.
  test("phantom hold preserves the advising fingerprint (drift deflated to nothing)", () => {
    const drifted = state(usage({ gateUtil: 15, warnUtil: 15 }), usage({ gateUtil: 2, warnUtil: 2 }));
    const phantom = state(
      usage({ gateUtil: 0, warnUtil: 0, fiveHour: null, weekly: null }),
      usage({ gateUtil: 2, warnUtil: 2 }),
    );
    const afterDrift = classifyPoll(INITIAL_FINGERPRINT_STATE, drifted, CONFIG);
    expect(afterDrift.effect.kind).toBe("advise");

    const afterPhantom = classifyPoll(afterDrift.next, phantom, CONFIG);
    // Phantom branch runs first → none effect, fingerprint held (NOT reset).
    expect(afterPhantom.effect).toEqual({ kind: "none", recoveredSides: [] });
    expect(afterPhantom.next.fingerprint).toBe(afterDrift.next.fingerprint);

    // Recovery to the same real drift must re-emit NOTHING (fingerprint match).
    const afterRecovery = classifyPoll(afterPhantom.next, drifted, CONFIG);
    expect(afterRecovery.effect).toEqual({ kind: "none", recoveredSides: [] });
  });

  test("phantom that inflates the heavier side still holds (no spurious re-emit)", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    const phantom = state(
      usage({ gateUtil: 0, warnUtil: 0, fiveHour: null, weekly: null }),
      usage({ gateUtil: 20, warnUtil: 20 }),
    );
    const { effects } = runPolls([drifted, phantom, drifted]);
    expect(effects.map((e) => e.kind)).toEqual(["advise", "none", "none"]);
  });

  test("a NEW five-hour window on the lighter side DOES update the fingerprint", () => {
    // Contrast with phantom-hold: a decision-grade change in the reset bucket
    // legitimately re-emits.
    const a = state(
      usage({ gateUtil: 35, warnUtil: 45 }),
      usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3600 } }),
    );
    const b = state(
      usage({ gateUtil: 35, warnUtil: 45 }),
      usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 7200 } }),
    );
    const { effects } = runPolls([a, b]);
    expect(effects.map((e) => e.kind)).toEqual(["advise", "advise"]);
  });

  test("reset-epoch jitter (±1s) does NOT re-emit (bucket rounding)", () => {
    const base = (epoch: number) =>
      state(
        usage({ gateUtil: 35, warnUtil: 45 }),
        usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: epoch } }),
      );
    const { effects } = runPolls([base(NOW + 3600), base(NOW + 3601), base(NOW + 3599)]);
    expect(effects.map((e) => e.kind)).toEqual(["advise", "none", "none"]);
  });

  test("non-decision-grade entry data holds idle (no false enter)", () => {
    // Expired-window stale cache: gateUtil 95 but every window already reset and
    // fetchedAt ancient → not decision-grade → must NOT enter.
    const stale = state(
      usage(),
      usage({
        gateUtil: 95,
        fiveHour: { util: 95, resetEpoch: NOW - 5400 },
        weekly: { util: 95, resetEpoch: NOW - 100 },
        fetchedAt: NOW - 7200,
      }),
    );
    const { effects, final } = runPolls([stale]);
    expect(effects[0]).toEqual({ kind: "none", recoveredSides: [] });
    expect(final.side).toBeNull();
  });

  test("windowless rate-limit record cannot authorize resume mid-pause", () => {
    const paused = state(usage(), usage({ gateUtil: 95 }));
    const rateLimitOnly = state(
      usage(),
      usage({ ok: false, gateUtil: 0, warnUtil: 0, fiveHour: null, weekly: null, rateLimitedUntil: NOW - 1 }),
    );
    const { effects, final } = runPolls([paused, rateLimitOnly]);
    expect(effects[0].kind).toBe("enter");
    // gateUtil=0 is absence of information, not recovery → still paused, held.
    expect(effects[1].kind).toBe("hold-uncertain");
    expect(final.side).toBe("codex");
  });
});

describe("classifyPoll reducer — hysteresis side transitions", () => {
  test("claude handoff → joint pause → codex pause", () => {
    const s1 = state(usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), usage());
    const s2 = state(
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
    );
    const s3 = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }));
    const { effects, final } = runPolls([s1, s2, s3]);
    expect(effects.map((e) => (e.kind === "enter" ? e.side : e.kind))).toEqual(["claude", "both", "codex"]);
    // Each side change emits.
    for (const e of effects) {
      if (e.kind === "enter") expect(e.emit).toBe(true);
    }
    expect(final.side).toBe("codex");
  });

  test("joint pause downgrades to claude handoff when codex recovers", () => {
    const s1 = state(
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
    );
    const s2 = state(usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), usage());
    const { effects, final } = runPolls([s1, s2]);
    expect(effects.map((e) => (e.kind === "enter" ? e.side : e.kind))).toEqual(["both", "claude"]);
    expect(final.side).toBe("claude");
  });

  test("joint pause downgrades to claude handoff and marks codex recovered", () => {
    const s1 = state(
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
    );
    const s2 = state(usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), usage());
    const { effects } = runPolls([s1, s2]);

    expect(effects[1]).toMatchObject({
      kind: "enter",
      side: "claude",
      recoveredSides: ["codex"],
    });
    expect(resumeCandidateSides(effects[1])).toEqual(["codex"]);
  });

  test("joint pause downgrades to codex pause and marks claude recovered", () => {
    const s1 = state(
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
    );
    const s2 = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }));
    const { effects } = runPolls([s1, s2]);

    expect(effects[1]).toMatchObject({
      kind: "enter",
      side: "codex",
      recoveredSides: ["claude"],
    });
    expect(resumeCandidateSides(effects[1])).toEqual(["claude"]);
  });

  test("joint pause full exit marks both sides recovered", () => {
    const s1 = state(
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
    );
    const s2 = state(usage(), usage());
    const { effects, final } = runPolls([s1, s2]);

    expect(effects[1]).toEqual({
      kind: "exit",
      previousSide: "both",
      recoveredSides: ["claude", "codex"],
    });
    expect(resumeCandidateSides(effects[1])).toEqual(["claude", "codex"]);
    expect(final.side).toBeNull();
  });

  test("resumeEpoch is sticky on same side, reset on side change", () => {
    // Codex paused with a rate-limit resume epoch.
    const s1 = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8, rateLimitedUntil: NOW + 900 }));
    const r1 = classifyPoll(INITIAL_FINGERPRINT_STATE, s1, CONFIG);
    expect(r1.next.resumeEpoch).toBe(NOW + 900);

    // Next poll: still codex over gate but now no blocking epoch readable
    // (gateUtil high, no rate-limit, reset bucket present) — resumeEpoch comes
    // from the gate reset; assert it stays defined on the same side.
    const s2 = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }));
    const r2 = classifyPoll(r1.next, s2, CONFIG);
    expect(r2.next.side).toBe("codex");
    expect(r2.next.resumeEpoch).toBe(NOW + 3600);
  });

  test("rate-limit pause reason renders the limit time in Beijing time, not UTC", () => {
    const s = state(usage(), usage({ gateUtil: 92, warnUtil: 92, remaining: 8, rateLimitedUntil: NOW + 900 }));
    const { effect } = classifyPoll(INITIAL_FINGERPRINT_STATE, s, CONFIG);
    const reason = "reason" in effect ? (effect.reason ?? "") : "";
    expect(reason).toContain("探针被限流至");
    expect(reason).toContain(formatBeijing(NOW + 900));
    expect(reason).toContain("（北京时间）");
    expect(reason).not.toContain("Z");
  });
});

describe("directiveFingerprint — pure fingerprint", () => {
  test("paused fingerprint differs by side", () => {
    const s = state(
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
    );
    expect(directiveFingerprint(s, "claude")).not.toBe(directiveFingerprint(s, "codex"));
    expect(directiveFingerprint(s, "both")).not.toBe(directiveFingerprint(s, "claude"));
  });

  test("balance fingerprint uses lighter side, ignores ±1s jitter via bucket", () => {
    const a = state(
      usage({ gateUtil: 35, warnUtil: 45 }),
      usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3600 } }),
    );
    const b = state(
      usage({ gateUtil: 35, warnUtil: 45 }),
      usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3601 } }),
    );
    expect(directiveFingerprint(a)).toBe(directiveFingerprint(b));
  });

  // Regression (MEDIUM-4): the PAUSED fingerprint must NOT depend on
  // `drift.heavier`. A pause is keyed on the paused side; `heavier` reflects the
  // NON-paused side's relative drift, which is irrelevant to a pause decision.
  // Folding it in let the non-paused side's warnUtil re-emit a DUPLICATE pause
  // banner whenever its drift flipped `heavier`, even though the pause never
  // changed.
  test("paused fingerprint ignores drift.heavier flipped by the non-paused side", () => {
    // Codex is the paused side (gateUtil 92). Only claude (the NON-paused side)
    // changes its warnUtil, flipping drift.heavier claude⇄codex while codex's
    // pause-relevant state stays identical.
    const heavierClaude = state(
      usage({ gateUtil: 20, warnUtil: 70 }),
      usage({ gateUtil: 92, warnUtil: 50, remaining: 8 }),
    );
    const heavierCodex = state(
      usage({ gateUtil: 20, warnUtil: 30 }),
      usage({ gateUtil: 92, warnUtil: 50, remaining: 8 }),
    );
    // Sanity: drift.heavier genuinely flipped between the two states.
    expect(heavierClaude.drift.heavier).toBe("claude");
    expect(heavierCodex.drift.heavier).toBe("codex");
    // The PAUSED fingerprint (activeSide = "codex") must be EQUAL → no dup banner.
    expect(directiveFingerprint(heavierClaude, "codex")).toBe(
      directiveFingerprint(heavierCodex, "codex"),
    );
  });

  test("not-paused fingerprint still folds in drift.heavier (behavior preserved)", () => {
    // Two balance states identical except for drift.heavier (lighter held the
    // same) — the NON-paused path must still distinguish them, or a real
    // balance-direction change would be silently deduped.
    const base: BudgetState = {
      phase: "balance",
      now: NOW,
      perAgent: { claude: usage({ gateUtil: 35, warnUtil: 45 }), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
      drift: { pct: 25, heavier: "claude", lighter: "codex" },
      pause: {
        active: false,
        side: null,
        reason: null,
        resumeBelow: CONFIG.resumeBelow,
        resumeAfterEpoch: null,
        resetEpochs: { claude: 0, codex: 0 },
      },
      parallel: { recommended: false, reason: null },
      underutilization: { recommended: false, reason: null },
      effort: { claudeAdvice: null, codexTier: "full" },
      directiveToClaude: "balance",
    };
    const heavierClaude: BudgetState = { ...base, drift: { ...base.drift, heavier: "claude" } };
    const heavierCodex: BudgetState = { ...base, drift: { ...base.drift, heavier: "codex" } };
    // lighter is identical → balance `side` is identical → the ONLY difference is
    // heavier. The fingerprints must still differ.
    expect(directiveFingerprint(heavierClaude)).not.toBe(directiveFingerprint(heavierCodex));
  });
});
