/**
 * Explicit state machine for the budget coordinator's directive bookkeeping.
 *
 * This module isolates the pure transition logic that decides, on every poll,
 * which directive (if any) to emit and what fingerprint/resume bookkeeping to
 * carry forward. `BudgetCoordinator` keeps only the IO shell (timer, emit,
 * onPauseChange, snapshot) and delegates every decision to `classifyPoll`.
 *
 * The machine has three states:
 *   - idle                       — no intervention, no pending advisory
 *   - advising(fingerprint)      — drift/parallel advisory active (gate open)
 *   - paused(side, fingerprint, resumeEpoch) — handoff/pause active
 *
 * `side` is the activeSides set rendered as a value: null⇄idle/advising,
 * "claude"/"codex"/"both" map bijectively to the {claude}/{codex}/{claude,codex}
 * active sets. The hysteresis (enter on shouldEnter, exit on canAgentResume) is
 * recomputed inside the reducer from the prior side, so the coordinator no
 * longer mutates a Set.
 *
 * Behavior is a verbatim port of the previous BudgetCoordinator.applyState —
 * every branch order (notably: the non-decision-grade hold sits BEFORE the
 * null-directive reset so a phantom blip cannot clear the fingerprint) is
 * preserved. See budget-coordinator.test.ts for the regression baseline.
 *
 * Keep this file dependency-free beyond ./types, ./budget-gate and
 * ./budget-state; it is bundled into the plugin daemon.
 */
import { resumeBlockingEpoch } from "./budget-gate";
import { isDecisionGrade } from "./budget-state";
import type { AgentName, AgentUsage, BudgetConfig, BudgetState } from "./types";

/** Active side, identical to the old pauseSide() bijection over activeSides. */
export type PauseSide = AgentName | "both" | null;
type ActivePauseSide = Exclude<PauseSide, null>;

/** Directive-fingerprint quantum for reset epochs. Must absorb probe jitter
 * (seconds) while still distinguishing a genuine window reset (hours). */
const RESET_FINGERPRINT_BUCKET_SEC = 600;

const AGENT_LABEL: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function formatEpoch(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/**
 * Explicit coordinator state carried between polls. `side === null` means no
 * intervention; the optional `resumeEpoch`/`fingerprint` describe whichever of
 * the advising/paused states is active.
 */
export interface FingerprintState {
  /** Active pause side (activeSides rendered as a value); null when not paused. */
  side: PauseSide;
  /** Last emitted directive fingerprint; null when there is none to dedup against. */
  fingerprint: string | null;
  /** Sticky resume-after epoch while paused; null otherwise. */
  resumeEpoch: number | null;
  /** Sticky pause reason while paused; null otherwise. */
  reason: string | null;
}

export const INITIAL_FINGERPRINT_STATE: FingerprintState = {
  side: null,
  fingerprint: null,
  resumeEpoch: null,
  reason: null,
};

/** What the coordinator must DO after a poll. The reducer is pure; the shell
 * applies these effects (emit, onPauseChange) in order. */
export type CoordinatorEffect =
  | {
      /** Entering or holding/refreshing an intervention. */
      kind: "enter" | "hold-uncertain";
      side: ActivePauseSide;
      reason: string;
      resumeEpoch: number | null;
      /** True when a directive should be emitted this poll. */
      emit: boolean;
      /** True only on the first poll that enters a pause (drives onPauseChange(true)). */
      pauseChanged: boolean;
    }
  | {
      /** Leaving an intervention back to idle. */
      kind: "exit";
      previousSide: ActivePauseSide;
    }
  | {
      /** Drift/parallel advisory emitted (gate stays open). */
      kind: "advise";
      phase: BudgetState["phase"];
    }
  | {
      /** No directive to emit; covers phantom holds, dedup no-ops, and the
       * null-directive fingerprint reset. */
      kind: "none";
    };

export interface ClassifyResult {
  next: FingerprintState;
  effect: CoordinatorEffect;
}

// ---------------------------------------------------------------------------
// Pure helpers (verbatim ports of the old coordinator private methods, now
// parametrized by an explicit activeSides set instead of reading `this`).
// ---------------------------------------------------------------------------

function sideToAgents(side: PauseSide): AgentName[] {
  if (side === "both") return ["claude", "codex"];
  if (side === "claude") return ["claude"];
  if (side === "codex") return ["codex"];
  return [];
}

function agentsToSide(agents: ReadonlySet<AgentName>): PauseSide {
  const claude = agents.has("claude");
  const codex = agents.has("codex");
  if (claude && codex) return "both";
  if (claude) return "claude";
  if (codex) return "codex";
  return null;
}

function shouldEnter(usage: AgentUsage | null, cfg: BudgetConfig, now: number): boolean {
  if (!isDecisionGrade(usage, now)) return false;
  return usage!.gateUtil >= cfg.pauseAt;
}

function canAgentResume(usage: AgentUsage | null, cfg: BudgetConfig, now: number): boolean {
  if (!isDecisionGrade(usage, now)) return false;
  if (usage!.rateLimitedUntil > now) return false;
  return usage!.gateUtil < cfg.resumeBelow;
}

/**
 * Hysteresis transition over the activeSides set: shouldEnter adds, an already
 * active side that canAgentResume is removed. Verbatim port of the old
 * updateActiveSides, made pure over the prior side.
 */
function nextActiveSide(prevSide: PauseSide, state: BudgetState, cfg: BudgetConfig): PauseSide {
  const active = new Set<AgentName>(sideToAgents(prevSide));
  for (const agent of ["claude", "codex"] as const) {
    const usage = state.perAgent[agent];
    if (shouldEnter(usage, cfg, state.now)) {
      active.add(agent);
    } else if (active.has(agent) && canAgentResume(usage, cfg, state.now)) {
      active.delete(agent);
    }
  }
  return agentsToSide(active);
}

function activeSideReason(agent: AgentName, usage: AgentUsage | null, cfg: BudgetConfig, now: number): string {
  if (!usage) return `${AGENT_LABEL[agent]} 探测暂时不可用，保持上一轮预算干预`;
  if (usage.rateLimitedUntil > now) {
    return `${AGENT_LABEL[agent]} 探针被限流至 ${formatEpoch(usage.rateLimitedUntil)}`;
  }
  if (usage.gateUtil >= cfg.pauseAt) {
    return `${AGENT_LABEL[agent]} gateUtil ${pct(usage.gateUtil)} ≥ pauseAt ${pct(cfg.pauseAt)}`;
  }
  return `${AGENT_LABEL[agent]} gateUtil ${pct(usage.gateUtil)} 尚未低于 resumeBelow ${pct(cfg.resumeBelow)}`;
}

function interventionReason(side: PauseSide, state: BudgetState, cfg: BudgetConfig): string {
  return sideToAgents(side)
    .map((agent) => activeSideReason(agent, state.perAgent[agent], cfg, state.now))
    .join("；");
}

function resumeAfterEpoch(side: PauseSide, state: BudgetState, cfg: BudgetConfig): number | null {
  const epochs = sideToAgents(side)
    .map((agent) => resumeBlockingEpoch(state.perAgent[agent], cfg, state.now))
    .filter((epoch) => epoch > 0);
  if (epochs.length === 0) return null;
  return Math.max(...epochs);
}

function activeSideProbeUncertain(side: PauseSide, state: BudgetState): boolean {
  return sideToAgents(side).some((agent) => {
    const usage = state.perAgent[agent];
    // Non-decision-grade covers every degraded shape (#103 lets stale /
    // unknown-reset records through as display data): mid-pause they must
    // hold the directive fingerprint, not recompute it against a phantom
    // reset bucket — recomputing re-emitted the pause directive on each
    // data-quality flap, the exact regression e7a66fc guarded against.
    return usage === null || usage.rateLimitedUntil > state.now || !isDecisionGrade(usage, state.now);
  });
}

/**
 * Stable dedup fingerprint for a directive. When `activeSide` is set we are
 * paused; otherwise the phase (balance/parallel) drives the side selection.
 */
export function directiveFingerprint(state: BudgetState, activeSide?: ActivePauseSide): string {
  const side = activeSide ?? (state.phase === "balance"
    ? state.drift.lighter ?? "none"
    : state.pause.side ?? "none");
  let reset = 0;
  if (activeSide === "claude") {
    reset = state.pause.resetEpochs.claude;
  } else if (activeSide === "codex") {
    reset = state.pause.resetEpochs.codex;
  } else if (activeSide === "both") {
    reset = Math.max(state.pause.resetEpochs.claude, state.pause.resetEpochs.codex);
  } else if (state.phase === "balance" && state.drift.lighter) {
    reset = state.perAgent[state.drift.lighter]?.fiveHour?.resetEpoch ?? 0;
  }
  // NB: the old code had `side === "claude"/"codex"/"both"` branches here as
  // well. They were dead: when activeSide is set the chain already matched
  // above; when activeSide is undefined the phase is balance (handled above) or
  // parallel (side is always "none"). Proven unreachable — instrumenting them
  // with throws kept all 53 budget tests green — so they are removed.

  return [
    activeSide ? "paused" : state.phase,
    state.drift.heavier ?? "none",
    side,
    // Round-to-nearest bucket, not the raw epoch: the probe's reset_epoch
    // jitters by ±1s between polls (observed live: 09:49:59 ⇄ 09:50:00),
    // and a raw value re-emits the same directive every poll. Rounding —
    // not floor — because real reset times sit ON round boundaries, so a
    // floor bucket edge would keep flapping. A genuine window reset jumps
    // hours and still lands in a different bucket.
    // Domain assumption: jitter tolerance holds because reset epochs sit
    // near bucket-aligned times. An ARBITRARY epoch at a half-bucket point
    // (k*600+300) would still flap under ±1s — not a shape the probe emits.
    Math.round(reset / RESET_FINGERPRINT_BUCKET_SEC),
  ].join("|");
}

/**
 * Pure reducer: given the prior fingerprint state and a freshly computed
 * BudgetState, decide the next state and the effect the coordinator must apply.
 *
 * This is a 1:1 port of the old BudgetCoordinator.applyState. The five
 * transitions (pause enter / pause hold / pause exit / advise / reset) and
 * their branch ORDER are preserved exactly; in particular the non-decision-
 * grade phantom hold runs BEFORE the null-directive reset.
 */
export function classifyPoll(prev: FingerprintState, state: BudgetState, cfg: BudgetConfig): ClassifyResult {
  const previousSide = prev.side;
  const currentSide = nextActiveSide(previousSide, state, cfg);

  // --- Paused branch (intervention active) ---
  if (currentSide) {
    const reason = interventionReason(currentSide, state, cfg);
    const nextResumeRaw = resumeAfterEpoch(currentSide, state, cfg);
    const resumeEpoch = previousSide === currentSide
      ? nextResumeRaw ?? prev.resumeEpoch
      : nextResumeRaw;
    const uncertain = previousSide === currentSide && activeSideProbeUncertain(currentSide, state) && prev.fingerprint;
    const fingerprint = uncertain
      ? prev.fingerprint!
      : directiveFingerprint(state, currentSide);
    const pauseChanged = !previousSide;
    const emit = !previousSide || previousSide !== currentSide || fingerprint !== prev.fingerprint;
    return {
      next: { side: currentSide, fingerprint, resumeEpoch, reason },
      effect: {
        kind: uncertain ? "hold-uncertain" : "enter",
        side: currentSide,
        reason,
        resumeEpoch,
        emit,
        pauseChanged,
      },
    };
  }

  // --- Recovery branch (was paused, now clear) ---
  if (previousSide) {
    return {
      next: { side: null, fingerprint: null, resumeEpoch: null, reason: null },
      effect: { kind: "exit", previousSide },
    };
  }

  // --- Phantom hold: a non-decision-grade record on either side holds the
  // previous advisory state AND keeps the fingerprint. This sits BEFORE the
  // null-directive branch so a blip cannot reset the fingerprint. ---
  if (
    !isDecisionGrade(state.perAgent.claude, state.now) ||
    !isDecisionGrade(state.perAgent.codex, state.now)
  ) {
    return { next: prev, effect: { kind: "none" } };
  }

  // --- Null-directive reset: decision-grade but nothing to advise. ---
  if (!state.directiveToClaude) {
    return {
      next: { side: null, fingerprint: null, resumeEpoch: null, reason: null },
      effect: { kind: "none" },
    };
  }

  // --- Advise branch: emit only when the fingerprint changed. ---
  const fingerprint = directiveFingerprint(state);
  if (fingerprint !== prev.fingerprint) {
    return {
      next: { side: null, fingerprint, resumeEpoch: null, reason: null },
      effect: { kind: "advise", phase: state.phase },
    };
  }
  return { next: prev, effect: { kind: "none" } };
}
