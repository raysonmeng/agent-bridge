import { describe, expect, test } from "bun:test";
import { BudgetCoordinator } from "../budget/budget-coordinator";
import type { ResumeSignals } from "../budget/budget-fingerprint";
import type { AgentUsage, BudgetConfig } from "../budget/types";

/**
 * TDD RED — end-to-end resume-candidate detection driven through the real
 * BudgetCoordinator poll loop (NOT the pure reducer in isolation).
 *
 * Why this exists: the existing resume-candidate.test.ts exercises the pure
 * `computeResumeCandidate` with a HAND-FORGED combination (a paused fpState +
 * an already-refreshed BudgetState) that the production reducer `classifyPoll`
 * can NEVER produce in a single poll — a paused state fed a refreshed reading
 * exits immediately, leaving `next.side = null`. That hand-forge masks the
 * CRITICAL bug.
 *
 * The bug: budget-coordinator.applyState() calls
 *   computeResumeCandidate(next, state, ...)
 * with `next` = the POST-transition fingerprint. On the very poll where the
 * window refreshes, classifyPoll takes the exit branch and returns
 * `next.side = null`, so computeResumeCandidate iterates `sideToAgents(null) = []`
 * and yields `{}`. Result: getResumeCandidate() is empty on EXACTLY the poll
 * that should report the just-recovered side as resumable.
 *
 * Expected contract (what the fix must satisfy): on the refresh poll that exits
 * a codex pause, getResumeCandidate().codex === true (the candidate must hang
 * off the EXITING side — effect.previousSide / prev.side — not the post-exit
 * next.side, which is null).
 *
 * This test is RED today: poll1 (the refresh poll) returns an empty candidate.
 */

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
  enabled: true,
  // Long poll so start() does NOT auto-fire a second poll while we drive each
  // poll explicitly; we advance the loop via pollOnce() to assert per-poll.
  pollSeconds: 300,
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

type FetchResult = { claude: AgentUsage | null; codex: AgentUsage | null } | null;

/** Healthy decision-grade reading: gateUtil 20 < resumeBelow 30, fresh windows. */
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

class FakeSource {
  calls = 0;
  private last: FetchResult;

  constructor(private readonly results: FetchResult[]) {
    this.last = results[results.length - 1] ?? null;
  }

  async fetchBoth(): Promise<FetchResult> {
    const result = this.results[this.calls] ?? this.last;
    this.calls += 1;
    this.last = result;
    return result;
  }
}

describe("BudgetCoordinator.getResumeCandidate — end-to-end via pollOnce (RED)", () => {
  test("codex paused on poll0, window refreshes on poll1 → poll1 candidate reports codex resumable", async () => {
    // poll0: codex gateUtil 95 (>= pauseAt 90) → enters codex pause.
    // poll1: codex window refreshes to gateUtil 20 (< resumeBelow 30) → exits.
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 95, warnUtil: 95, remaining: 5 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }) },
    ]);

    // Codex-side signals all satisfied (tuiReady + pendingExists + checkpointExists).
    const resumeSignals = (): ResumeSignals => ({
      tuiReady: { codex: true, claude: true },
      pendingExists: { codex: true, claude: true },
      checkpointExists: true,
    });

    const coordinator = new BudgetCoordinator({
      source: source as unknown as { fetchBoth: FakeSource["fetchBoth"] },
      config: CONFIG,
      emit: () => {},
      onPauseChange: () => {},
      now: () => NOW,
      resumeSignals,
    });

    // poll0 (start() fires the first pollOnce): enter codex pause.
    await coordinator.start();
    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getSnapshot()?.pauseSide).toBe("codex");
    // While paused (not yet refreshed), codex is NOT a resume candidate.
    expect(coordinator.getResumeCandidate().codex).not.toBe(true);

    // poll1: codex window refreshed → pause exits this poll.
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    coordinator.stop();

    // Pause has cleared (sanity: this IS the refresh/exit poll).
    expect(coordinator.isPaused()).toBe(false);

    // CRITICAL contract: on the refresh poll, the just-recovered codex side must
    // be reported as a resume candidate. Today this is `undefined` because the
    // candidate is computed against the post-exit next.side (null) instead of
    // the exiting previousSide.
    const candidate = coordinator.getResumeCandidate();
    expect(candidate.codex).toBe(true);
    // Richer per-side detail is exposed for PR3's atomic claim.
    expect(candidate.detail?.codex?.ready).toBe(true);
  });

  test("getResumeCandidate returns a defensive copy — mutating it does not change internal state", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 95, warnUtil: 95, remaining: 5 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }) },
    ]);
    const resumeSignals = (): ResumeSignals => ({
      tuiReady: { codex: true, claude: true },
      pendingExists: { codex: true, claude: true },
      checkpointExists: true,
    });
    const coordinator = new BudgetCoordinator({
      source: source as unknown as { fetchBoth: FakeSource["fetchBoth"] },
      config: CONFIG,
      emit: () => {},
      onPauseChange: () => {},
      now: () => NOW,
      resumeSignals,
    });

    await coordinator.start();
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    coordinator.stop();

    const first = coordinator.getResumeCandidate();
    expect(first.codex).toBe(true);
    // Mutate the returned object and its nested detail map.
    first.codex = false;
    if (first.detail) {
      first.detail.codex = { ready: false };
      first.detail.claude = { ready: true };
    }

    // A fresh read is unaffected: the coordinator handed back a copy.
    const second = coordinator.getResumeCandidate();
    expect(second.codex).toBe(true);
    expect(second.detail?.codex?.ready).toBe(true);
    expect(second.detail?.claude).toBeUndefined();
  });

  test("getResumeCandidate deep-copies nested detail — mutating an inner field in place does not leak", async () => {
    // Regression guard for PR3's atomic claim path, which flips `ready` IN PLACE
    // (e.g. `result.detail.codex.ready = false`) rather than replacing the whole
    // detail object. A shallow `{ ...detail }` copies the outer map only, so each
    // inner ResumeCandidateDetail stays shared by reference — an in-place flip
    // would pollute the coordinator's internal resumeCandidate.detail.codex.
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 95, warnUtil: 95, remaining: 5 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }) },
    ]);
    const resumeSignals = (): ResumeSignals => ({
      tuiReady: { codex: true, claude: true },
      pendingExists: { codex: true, claude: true },
      checkpointExists: true,
    });
    const coordinator = new BudgetCoordinator({
      source: source as unknown as { fetchBoth: FakeSource["fetchBoth"] },
      config: CONFIG,
      emit: () => {},
      onPauseChange: () => {},
      now: () => NOW,
      resumeSignals,
    });

    await coordinator.start();
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    coordinator.stop();

    const first = coordinator.getResumeCandidate();
    expect(first.detail?.codex?.ready).toBe(true);
    // Mutate the INNER field in place (do NOT replace the whole detail object).
    if (first.detail?.codex) {
      first.detail.codex.ready = false;
    }

    // A fresh read must still see ready === true: the inner detail was deep-copied.
    const second = coordinator.getResumeCandidate();
    expect(second.detail?.codex?.ready).toBe(true);
  });
});
