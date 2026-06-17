import { describe, expect, test } from "bun:test";
import { computeBudgetState } from "../budget/budget-state";
import {
  classifyPoll,
  computeResumeCandidate,
  resumeCandidateSides,
  INITIAL_FINGERPRINT_STATE,
  type ResumeCandidate,
  type ResumeSignals,
} from "../budget/budget-fingerprint";
import type { AgentName, AgentUsage, BudgetConfig, BudgetState } from "../budget/types";

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

/** Decision-grade probe with healthy (resumable) defaults — gateUtil 20 < resumeBelow 30. */
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

function state(claude: AgentUsage | null, codex: AgentUsage | null, now = NOW): BudgetState {
  return computeBudgetState(claude, codex, CONFIG, now);
}

/** Per-side signals, all satisfied by default. Override one to drop a predicate. */
function signals(overrides: Partial<ResumeSignals> = {}): ResumeSignals {
  return {
    tuiReady: { codex: true, claude: true },
    pendingExists: { codex: true, claude: true },
    checkpointExists: true,
    ...overrides,
  };
}

const codexPending = {
  status: "paused",
  agent: "codex" as const,
  sessionId: "sess-codex",
  cwd: "/repo/project",
  resetEpoch: NOW + 3600,
  util: 92,
  warnUtil: 92,
  at: NOW - 10,
  sourcePath: "/tmp/budget/pending/codex_scope.json",
  contentHash: "pending-hash",
};

const over = usage({ gateUtil: 95, warnUtil: 95, remaining: 5 });
const healthy = usage();

/**
 * Drive ONE realistic poll through the production reducer and return the sides
 * the coordinator would evaluate this poll plus the resulting candidate. This
 * exercises `classifyPoll` → `resumeCandidateSides` → `computeResumeCandidate`
 * exactly as the coordinator does, with NO hand-forged fpState.
 */
function pollCandidate(
  prev: ReturnType<typeof classifyPoll>["next"] | typeof INITIAL_FINGERPRINT_STATE,
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  sig: ResumeSignals,
): { sides: AgentName[]; candidate: ResumeCandidate; next: ReturnType<typeof classifyPoll>["next"] } {
  const { next, effect } = classifyPoll(prev, state(claude, codex), CONFIG);
  const sides = resumeCandidateSides(effect);
  const candidate = computeResumeCandidate(sides, state(claude, codex), CONFIG, sig);
  return { sides, candidate, next };
}

/** Enter a pause on `side`, returning the post-pause fpState (premise for exit). */
function enterPause(side: "claude" | "codex" | "both"): ReturnType<typeof classifyPoll>["next"] {
  const claude = side === "codex" ? healthy : over;
  const codex = side === "claude" ? healthy : over;
  const { next, effect } = classifyPoll(INITIAL_FINGERPRINT_STATE, state(claude, codex), CONFIG);
  expect(next.side).toBe(side);
  expect(effect.kind).toBe("enter");
  return next;
}

describe("computeResumeCandidate — single side exits a pause (refresh poll)", () => {
  test("codex paused, then window refreshes → exit poll reports codex ready=true", () => {
    const paused = enterPause("codex");
    const { sides, candidate } = pollCandidate(paused, healthy, healthy, signals());
    expect(sides).toEqual(["codex"]);
    expect(candidate.codex).toBe(true);
    // Only the recovered side gets a per-side entry.
    expect(candidate.claude).toBeUndefined();
    expect(candidate.detail?.codex?.ready).toBe(true);
  });

  test("ready detail carries matched pending entry and checkpoint path for PR3 claim", () => {
    const paused = enterPause("codex");
    const { candidate } = pollCandidate(
      paused,
      healthy,
      healthy,
      signals({
        pending: { codex: codexPending },
        checkpointPath: "/repo/project/.agent/checkpoint.md",
      }),
    );

    expect(candidate.codex).toBe(true);
    expect(candidate.detail?.codex?.pending).toEqual(codexPending);
    expect(candidate.detail?.codex?.checkpointPath).toBe("/repo/project/.agent/checkpoint.md");
  });

  test("claude paused (handoff), then refreshes → exit poll reports claude ready=true", () => {
    const paused = enterPause("claude");
    const { sides, candidate } = pollCandidate(paused, healthy, healthy, signals());
    expect(sides).toEqual(["claude"]);
    expect(candidate.claude).toBe(true);
    expect(candidate.codex).toBeUndefined();
  });
});

describe("computeResumeCandidate — partial recovery from joint pause", () => {
  test("both paused, then codex refreshes first → only codex is evaluated as recovered", () => {
    const paused = enterPause("both");
    // Claude remains above pauseAt, Codex has refreshed below resumeBelow. The
    // reducer stays paused on Claude, but Codex is a committed recovered side and
    // must become the sole resume-candidate source for this poll.
    const { sides, candidate, next } = pollCandidate(paused, over, healthy, signals());

    expect(next.side).toBe("claude");
    expect(sides).toEqual(["codex"]);
    expect(candidate.codex).toBe(true);
    expect(candidate.claude).toBeUndefined();
    expect(candidate.detail?.codex?.ready).toBe(true);
  });
});

describe("computeResumeCandidate — still paused (no refresh) → not a candidate", () => {
  test("codex paused and still over threshold → enter/hold poll, codex ready=false", () => {
    const paused = enterPause("codex");
    // Codex still over pauseAt → hysteresis keeps it paused (no exit this poll).
    const { sides, candidate } = pollCandidate(paused, healthy, over, signals());
    expect(sides).toEqual(["codex"]);
    expect(candidate.codex).toBe(false);
  });
});

describe("computeResumeCandidate — missing any one predicate → false (direct, exit side)", () => {
  test("pendingExists[codex]=false → false", () => {
    const candidate = computeResumeCandidate(
      ["codex"],
      state(healthy, healthy),
      CONFIG,
      signals({ pendingExists: { codex: false, claude: true } }),
    );
    expect(candidate.codex).toBe(false);
  });

  test("usage still >= resumeBelow (window NOT refreshed) → false", () => {
    // Codex at gateUtil 40 >= resumeBelow 30 → canAgentResume false.
    const notRefreshed = state(healthy, usage({ gateUtil: 40, warnUtil: 40, remaining: 60 }));
    const candidate = computeResumeCandidate(["codex"], notRefreshed, CONFIG, signals());
    expect(candidate.codex).toBe(false);
  });

  test("tuiReady[codex]=false → false", () => {
    const candidate = computeResumeCandidate(
      ["codex"],
      state(healthy, healthy),
      CONFIG,
      signals({ tuiReady: { codex: false, claude: true } }),
    );
    expect(candidate.codex).toBe(false);
  });

  test("checkpointExists=false → false", () => {
    const candidate = computeResumeCandidate(
      ["codex"],
      state(healthy, healthy),
      CONFIG,
      signals({ checkpointExists: false }),
    );
    expect(candidate.codex).toBe(false);
  });

  test("non-decision-grade usage (stale, every window already reset) → false", () => {
    const degraded = state(
      healthy,
      usage({
        gateUtil: 20,
        warnUtil: 20,
        fiveHour: { util: 20, resetEpoch: NOW - 5400 },
        weekly: { util: 20, resetEpoch: NOW - 100 },
        fetchedAt: NOW - 7200,
      }),
    );
    const candidate = computeResumeCandidate(["codex"], degraded, CONFIG, signals());
    expect(candidate.codex).toBe(false);
  });
});

describe("computeResumeCandidate — per-side independence (both sides evaluated)", () => {
  test("both refreshed + all signals → both ready=true", () => {
    // exit from `both` recovers both sides; pass both explicitly.
    const candidate = computeResumeCandidate(
      ["claude", "codex"],
      state(healthy, healthy),
      CONFIG,
      signals(),
    );
    expect(candidate.codex).toBe(true);
    expect(candidate.claude).toBe(true);
  });

  test("only codex refreshed (claude over threshold) → codex true, claude false", () => {
    const mixed = state(usage({ gateUtil: 40, warnUtil: 40, remaining: 60 }), healthy);
    const candidate = computeResumeCandidate(["claude", "codex"], mixed, CONFIG, signals());
    expect(candidate.codex).toBe(true);
    expect(candidate.claude).toBe(false);
  });

  test("per-side signal isolation: codex pending false → only codex blocked", () => {
    const candidate = computeResumeCandidate(
      ["claude", "codex"],
      state(healthy, healthy),
      CONFIG,
      signals({ pendingExists: { codex: false, claude: true } }),
    );
    expect(candidate.codex).toBe(false);
    expect(candidate.claude).toBe(true);
  });

  test("shared checkpoint missing → both false", () => {
    const candidate = computeResumeCandidate(
      ["claude", "codex"],
      state(healthy, healthy),
      CONFIG,
      signals({ checkpointExists: false }),
    );
    expect(candidate.codex).toBe(false);
    expect(candidate.claude).toBe(false);
  });
});

describe("resumeCandidateSides — effect-driven side selection", () => {
  test("exit effect → previousSide", () => {
    const paused = enterPause("codex");
    const { effect } = classifyPoll(paused, state(healthy, healthy), CONFIG);
    expect(effect.kind).toBe("exit");
    expect(resumeCandidateSides(effect)).toEqual(["codex"]);
  });

  test("enter effect → still-paused side", () => {
    const { effect } = classifyPoll(INITIAL_FINGERPRINT_STATE, state(healthy, over), CONFIG);
    expect(effect.kind).toBe("enter");
    expect(resumeCandidateSides(effect)).toEqual(["codex"]);
  });

  test("none effect (idle, nothing to advise) → []", () => {
    const { effect } = classifyPoll(INITIAL_FINGERPRINT_STATE, state(healthy, healthy), CONFIG);
    expect(effect.kind).toBe("none");
    expect(resumeCandidateSides(effect)).toEqual([]);
  });
});

describe("computeResumeCandidate — empty sides & purity", () => {
  test("empty sides → empty candidate (no detail)", () => {
    const candidate = computeResumeCandidate([], state(healthy, healthy), CONFIG, signals());
    expect(candidate.codex).toBeUndefined();
    expect(candidate.claude).toBeUndefined();
    expect(candidate.detail).toBeUndefined();
  });

  test("identical inputs yield identical output (referential determinism)", () => {
    const s = state(healthy, healthy);
    const sig = signals();
    const a = computeResumeCandidate(["codex"], s, CONFIG, sig);
    const b = computeResumeCandidate(["codex"], s, CONFIG, sig);
    expect(a).toEqual(b);
  });
});
