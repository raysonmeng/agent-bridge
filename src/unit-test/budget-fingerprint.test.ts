import { describe, expect, test } from "bun:test";
import { computeBudgetState } from "../budget/budget-state";
import {
  classifyPoll,
  directiveFingerprint,
  INITIAL_FINGERPRINT_STATE,
  type FingerprintState,
} from "../budget/budget-fingerprint";
import type { AgentUsage, BudgetConfig, BudgetState } from "../budget/types";

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
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
    expect(effects[0]).toEqual({ kind: "none" });
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
    expect(effects[1]).toEqual({ kind: "exit", previousSide: "codex" });
    expect(final.side).toBeNull();
    expect(final.fingerprint).toBeNull();
    expect(final.resumeEpoch).toBeNull();
    expect(final.reason).toBeNull();
  });

  test("advise: drift above threshold emits a balance advisory from idle", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    expect(drifted.phase).toBe("balance");
    const { effects, final } = runPolls([drifted]);
    expect(effects[0]).toEqual({ kind: "advise", phase: "balance" });
    expect(final.side).toBeNull();
    expect(final.fingerprint).not.toBeNull();
  });

  test("advise dedup: identical drift on the next poll → none (no re-emit)", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    const { effects } = runPolls([drifted, drifted]);
    expect(effects[0]).toEqual({ kind: "advise", phase: "balance" });
    expect(effects[1]).toEqual({ kind: "none" });
  });

  test("advise: parallel phase emits with phase=parallel", () => {
    const parallel = state(
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80, fiveHour: { util: 20, resetEpoch: NOW + 3500 } }),
      usage({ gateUtil: 25, warnUtil: 25, remaining: 75, fiveHour: { util: 25, resetEpoch: NOW + 5000 } }),
    );
    expect(parallel.phase).toBe("parallel");
    const { effects } = runPolls([parallel]);
    expect(effects[0]).toEqual({ kind: "advise", phase: "parallel" });
  });

  test("reset: advising → directive disappears (decision-grade) clears fingerprint", () => {
    const drifted = state(usage({ gateUtil: 35, warnUtil: 45 }), usage({ gateUtil: 20, warnUtil: 20 }));
    const calm = state(usage({ gateUtil: 20, warnUtil: 20 }), usage({ gateUtil: 20, warnUtil: 20 }));
    expect(calm.directiveToClaude).toBeNull();
    const { effects, final } = runPolls([drifted, calm]);
    expect(effects[0].kind).toBe("advise");
    // null-directive on decision-grade data → effect none, but fingerprint reset.
    expect(effects[1]).toEqual({ kind: "none" });
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
    expect(afterPhantom.effect).toEqual({ kind: "none" });
    expect(afterPhantom.next.fingerprint).toBe(afterDrift.next.fingerprint);

    // Recovery to the same real drift must re-emit NOTHING (fingerprint match).
    const afterRecovery = classifyPoll(afterPhantom.next, drifted, CONFIG);
    expect(afterRecovery.effect).toEqual({ kind: "none" });
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
    expect(effects[0]).toEqual({ kind: "none" });
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
});
