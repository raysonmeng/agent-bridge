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
import type { PendingEntry } from "./pending-reader";
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
      /** Agents removed from the active pause set on this committed transition. */
      recoveredSides: AgentName[];
    }
  | {
      /** Leaving an intervention back to idle. */
      kind: "exit";
      previousSide: ActivePauseSide;
      /** Agents removed from the active pause set on this committed transition. */
      recoveredSides: AgentName[];
    }
  | {
      /** Drift/parallel advisory emitted (gate stays open). */
      kind: "advise";
      phase: BudgetState["phase"];
      /** Agents removed from the active pause set on this committed transition. */
      recoveredSides: AgentName[];
    }
  | {
      /** No directive to emit; covers phantom holds, dedup no-ops, and the
       * null-directive fingerprint reset. */
      kind: "none";
      /** Agents removed from the active pause set on this committed transition. */
      recoveredSides: AgentName[];
    };

export interface ClassifyResult {
  next: FingerprintState;
  effect: CoordinatorEffect;
}

/**
 * Daemon-injected readiness signals for the resume-candidate reducer. The
 * reducer stays pure — every probe is gathered by the daemon (TUI state, pending
 * glob, checkpoint stat) and passed in, so this module performs no fs/socket IO.
 *
 * `tuiReady` and `pendingExists` are PER-SIDE: an earlier GLOBAL-OR shape
 * (`codex ready || claude attached`) let one side's readiness leak onto the
 * other, and a pending file from an UNRELATED repo falsely satisfied the
 * pending predicate. Each side now carries its own boolean so the reducer can
 * gate codex/claude independently. `checkpointExists` stays shared — the handoff
 * checkpoint is a single per-pair artifact, not a per-agent one.
 */
export interface ResumeSignals {
  /** tuiReady.codex = tuiConnectionState.canReply(); tuiReady.claude = attachedClaude != null. */
  tuiReady: Record<AgentName, boolean>;
  /** Per-side: a guard-pending record for THIS agent, scoped to the current pair cwd, exists. */
  pendingExists: Record<AgentName, boolean>;
  /** Per-side matched pending entry for claim/injection; present when pendingExists is true. */
  pending?: Partial<Record<AgentName, PendingEntry>>;
  /** fs.existsSync(<pair cwd>/.agent/checkpoint.md) — shared across sides. */
  checkpointExists: boolean;
  /** Absolute checkpoint path when checkpointExists is true. */
  checkpointPath?: string;
}

/**
 * Per-side resume-candidate detail (PR2 detection only). Only the sides passed
 * to `computeResumeCandidate` get an entry; uncovered sides stay `undefined`
 * (idle → both undefined). The richer shape (pending entry + checkpoint path) is
 * carried so PR3's atomic claim need not re-read the guard/checkpoint files.
 */
export interface ResumeCandidateDetail {
  /** All four predicates held: window refreshed AND per-side signals AND checkpoint. */
  ready: boolean;
  /** Matched guard pending entry for the evaluated side, carried for PR3 atomic claim. */
  pending?: PendingEntry;
  /** Shared checkpoint path carried so PR3 does not re-resolve it. */
  checkpointPath?: string;
}

/**
 * Per-side resume-candidate result. `codex`/`claude` are booleans for backward
 * compatibility with the read-only `getResumeCandidate()` contract; the detail
 * map exposes the richer per-side shape for PR3 without re-reading files.
 */
export interface ResumeCandidate {
  codex?: boolean;
  claude?: boolean;
  /** Per-side detail for sides that were evaluated this poll. */
  detail?: Partial<Record<AgentName, ResumeCandidateDetail>>;
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

function removedAgents(prevSide: PauseSide, currentSide: PauseSide): AgentName[] {
  const current = new Set<AgentName>(sideToAgents(currentSide));
  return sideToAgents(prevSide).filter((agent) => !current.has(agent));
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

  // `drift.heavier` is which side carries more usage by drift — relevant only
  // to a balance/parallel advisory. A pause is keyed on the paused side
  // (activeSide), so folding `heavier` into a PAUSED fingerprint lets the
  // NON-paused side's warnUtil re-emit a duplicate pause banner whenever its
  // drift flips `heavier`, even though the pause itself never changed. Drop
  // `heavier` from the fingerprint while paused; keep it when not paused so the
  // balance/parallel dedup behavior is unchanged.
  const heavier = activeSide ? "" : (state.drift.heavier ?? "none");

  return [
    activeSide ? "paused" : state.phase,
    heavier,
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
  const recoveredSides = removedAgents(previousSide, currentSide);

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
        recoveredSides,
      },
    };
  }

  // --- Recovery branch (was paused, now clear) ---
  if (previousSide) {
    return {
      next: { side: null, fingerprint: null, resumeEpoch: null, reason: null },
      effect: { kind: "exit", previousSide, recoveredSides },
    };
  }

  // --- Phantom hold: a non-decision-grade record on either side holds the
  // previous advisory state AND keeps the fingerprint. This sits BEFORE the
  // null-directive branch so a blip cannot reset the fingerprint. ---
  if (
    !isDecisionGrade(state.perAgent.claude, state.now) ||
    !isDecisionGrade(state.perAgent.codex, state.now)
  ) {
    return { next: prev, effect: { kind: "none", recoveredSides: [] } };
  }

  // --- Null-directive reset: decision-grade but nothing to advise. ---
  if (!state.directiveToClaude) {
    return {
      next: { side: null, fingerprint: null, resumeEpoch: null, reason: null },
      effect: { kind: "none", recoveredSides: [] },
    };
  }

  // --- Advise branch: emit only when the fingerprint changed. ---
  const fingerprint = directiveFingerprint(state);
  if (fingerprint !== prev.fingerprint) {
    return {
      next: { side: null, fingerprint, resumeEpoch: null, reason: null },
      effect: { kind: "advise", phase: state.phase, recoveredSides: [] },
    };
  }
  return { next: prev, effect: { kind: "none", recoveredSides: [] } };
}

/**
 * Resolve the agent set whose resume-candidate must be evaluated this poll from
 * the {@link classifyPoll} effect.
 *
 * CRITICAL: the candidate must hang off the EXITING side, not the post-exit
 * fingerprint. `classifyPoll`'s hysteresis removes a side from `next.side` on
 * the SAME poll its window refreshes (canAgentResume → true), so that poll takes
 * the `exit` branch with `next.side = null`. Computing the candidate against
 * `next.side` would therefore always yield `{}` on exactly the poll a side
 * becomes resumable. Instead:
 *   - exit  → evaluate the recovered `effect.previousSide`.
 *   - enter / hold-uncertain → evaluate the still-paused `effect.side` (so a
 *     side that is paused but not yet refreshed reports ready=false, matching
 *     the "while paused, not a candidate" contract).
 *   - advise / none → no side is paused → no candidate.
 *
 * NB: this uses only the CURRENT exit branch (whole-side recovery: single side
 * or "both" → null). Per-side partial recovery (both → claude) is PR2.5; this
 * function needs no change when that lands because it reads the effect, not the
 * branch internals.
 */
export function resumeCandidateSides(effect: CoordinatorEffect): AgentName[] {
  if (effect.recoveredSides.length > 0) {
    return effect.recoveredSides;
  }
  switch (effect.kind) {
    case "exit":
      return sideToAgents(effect.previousSide);
    case "enter":
    case "hold-uncertain":
      return sideToAgents(effect.side);
    case "advise":
    case "none":
      return [];
  }
}

/**
 * Pure resume-candidate reducer (PR2 — detection only, no emit/inject). For each
 * EXPLICITLY supplied side, decides whether ALL four readiness predicates hold:
 *
 *   1. window refreshed — reuse the existing hysteresis `canAgentResume`
 *      (decision-grade AND gateUtil < resumeBelow AND no live rate_limit). This
 *      is the SINGLE source of truth for "window reset"; we deliberately do NOT
 *      reinvent an epoch-diff detector (a second source would STALE-fork).
 *   2. signals.pendingExists[side]   (per-side)
 *   3. signals.tuiReady[side]        (per-side)
 *   4. signals.checkpointExists      (shared)
 *
 * `sides` is supplied by the caller (see {@link resumeCandidateSides}) — the
 * EXITING side on an exit poll, the still-paused side on an enter/hold poll. An
 * empty `sides` yields `{}`. Each side is evaluated independently against its own
 * usage and its own per-side signals, so "both paused, only codex refreshed"
 * yields `{codex:true, claude:false}`.
 *
 * Fully pure: the signals are externally injected, so this function touches no
 * fs/socket.
 */
export function computeResumeCandidate(
  sides: readonly AgentName[],
  state: BudgetState,
  cfg: BudgetConfig,
  signals: ResumeSignals,
): ResumeCandidate {
  const candidate: ResumeCandidate = {};
  const detail: Partial<Record<AgentName, ResumeCandidateDetail>> = {};
  for (const agent of sides) {
    const windowRefreshed = canAgentResume(state.perAgent[agent], cfg, state.now);
    const ready =
      windowRefreshed &&
      signals.pendingExists[agent] &&
      signals.tuiReady[agent] &&
      signals.checkpointExists;
    candidate[agent] = ready;
    const pending = signals.pending?.[agent];
    detail[agent] = {
      ready,
      ...(pending ? { pending } : {}),
      ...(signals.checkpointPath ? { checkpointPath: signals.checkpointPath } : {}),
    };
  }
  if (sides.length > 0) candidate.detail = detail;
  return candidate;
}
