/**
 * Single source of truth for pause/resume decisions (v3.2).
 *
 * Both the directive-content path (budget-state.ts `pauseTrigger`) and the
 * coordinator's gating state machine (budget-fingerprint.ts) must agree on
 * whether an agent is paused, or the rendered state and the fingerprint state
 * drift apart. This module centralizes that decision so the two callers can
 * never fork.
 *
 * v3.2: the per-window time-aware dynamic pause line (design §3.1) is the SOLE
 * strategy — the old `conserve|maximize` selector is gone. When per-window
 * burn-rate data is unavailable (non-confident / stale / reset-unknown), each
 * window degrades to a fixed gateUtil FALLBACK line (`util ≥ pauseAt` to enter,
 * `util < resumeBelow` to resume) — the same safe gating the former conserve
 * mode used, now an internal fallback rather than a user-selectable mode.
 * Invariant I1: the dynamic line never pauses earlier than the pauseAt floor;
 * invariant I2: missing/stale data never opens a gate.
 *
 * Keep this file dependency-light (only ./types + ./budget-gate); it is bundled
 * into the plugin daemon.
 */
import { matchingGateReset } from "./budget-gate";
import { STALE_MAX_AGE_SEC } from "./types";
import type {
  AgentName,
  AgentUsage,
  BudgetConfig,
  BudgetWindow,
  BudgetWindowKey,
} from "./types";

const AGENT_LABEL: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

const WINDOW_LABEL: Record<BudgetWindowKey, string> = {
  fiveHour: "5h",
  weekly: "周",
};

/** Iteration order is stable so the FIRST tripping window wins the reason. */
const WINDOW_KEYS: readonly BudgetWindowKey[] = ["fiveHour", "weekly"];

/** Clamp `tH` so a clock skew / bogus reset epoch cannot blow up the line. */
const MAX_TIME_TO_RESET_HOURS = 7 * 24;

/** finishing-margin floor/ceiling (design §3.1: clamp burnRate×horizon to [1,10]). */
const FINISHING_MARGIN_MIN_PCT = 1;
const FINISHING_MARGIN_MAX_PCT = 10;

/** Dynamic-line ceiling (design §3.1: clamp(line, pauseAt, 99)). */
const DYNAMIC_LINE_CEILING_PCT = 99;

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamped hours-to-reset for a window. Single source for the `tH` used by both
 * `dynamicPauseAt` and `dynamicWindowVerdict`, so the projected-at-reset figure
 * the underutilization advice shows can never diverge from the gating decision.
 * Callers that need the "past reset" guard must check `resetEpoch <= now`
 * themselves first (this only clamps the upper bound, never the lower).
 */
function clampedTimeToResetHours(window: BudgetWindow, now: number): number {
  return Math.min((window.resetEpoch - now) / 3600, MAX_TIME_TO_RESET_HOURS);
}

/**
 * Decision-grade data check (moved here from budget-state.ts so the decision
 * module is self-contained; budget-state re-exports it for existing importers).
 * A record whose every window has already reset, or that was fetched long ago
 * (stale probe cache during an upstream outage), describes a PAST quota window —
 * its utils must not trigger an intervention now, nor authorize a resume.
 */
export function isDecisionGrade(usage: AgentUsage | null, now: number): boolean {
  if (!usage) return false;
  const freshWindow =
    (usage.fiveHour !== null && usage.fiveHour.resetEpoch > now) ||
    (usage.weekly !== null && usage.weekly.resetEpoch > now);
  if (!freshWindow) return false;
  if (usage.fetchedAt > 0 && now - usage.fetchedAt > STALE_MAX_AGE_SEC) return false;
  return true;
}

/**
 * Per-window dynamic pause line (design §3.1). Returns:
 *   - 100               — this window does not trigger a pause this poll (open);
 *   - "admission-closed"— a hard cap fired (util at/over target, or near reset
 *                         inside the finishing band) — P3's finishing gate; P2
 *                         maps it to closed ONLY when util ≥ pauseAt (I1 floor);
 *   - a number in [pauseAt, 99] — pause when util ≥ this line.
 *
 * `burnRatePctPerHour` is the guard's confident EWMA for this window (caller
 * has already verified confidence; a non-confident window degrades to conserve
 * before calling here). PRECONDITION: it must be a finite, non-negative number —
 * every internal caller routes through `confidentRate()` which guarantees this;
 * a direct caller passing NaN/Infinity would propagate it (the clamp does not
 * defend against NaN).
 */
export function dynamicPauseAt(
  window: BudgetWindow,
  burnRatePctPerHour: number,
  cfg: BudgetConfig,
  now: number,
): number | "admission-closed" {
  const m = cfg.maximize;
  const rawTimeToResetHours = (window.resetEpoch - now) / 3600;
  // Past reset point: do not pause on a stale window — wait for fresh data.
  if (rawTimeToResetHours <= 0) return 100;
  const tH = clampedTimeToResetHours(window, now);

  const finishingMarginPct = clamp(
    burnRatePctPerHour * (m.finishingHorizonMinutes / 60),
    FINISHING_MARGIN_MIN_PCT,
    FINISHING_MARGIN_MAX_PCT,
  );

  const projectedAtReset = window.util + burnRatePctPerHour * tH;
  if (projectedAtReset <= m.targetUtil) {
    // (a) Will not fill before reset — but two hard caps first (REAL-4): metering
    //     lag / a burst can still slam into the provider limit, so do not leave a
    //     high-util window wide open.
    if (window.util >= m.targetUtil) return "admission-closed";
    if (
      tH < m.finishingHorizonMinutes / 60 &&
      window.util >= m.targetUtil - finishingMarginPct
    ) {
      return "admission-closed";
    }
    return 100; // truly will not fill: do not pause.
  }

  // (b) Will fill: line = target − finishing margin − time-buffer reserve.
  const reservePct = Math.min(m.reserveMaxPct, m.reserveSlopePctPerHour * tH);
  const line = m.targetUtil - finishingMarginPct - reservePct;
  // Invariant I1: floor at conserve's pauseAt. The ceiling is normally 99, but
  // the FLOOR must always win — a degenerate `pauseAt > 99` (e.g. pauseAt=100,
  // a valid config meaning "effectively never pause") would otherwise let the 99
  // ceiling clamp the line BELOW pauseAt, making maximize pause earlier than
  // conserve (I1 violation). Raising the ceiling to max(pauseAt, 99) keeps the
  // line ≥ pauseAt, so maximize degrades to conserve at such configs.
  return clamp(line, cfg.pauseAt, Math.max(cfg.pauseAt, DYNAMIC_LINE_CEILING_PCT));
}

/**
 * Structured classification of one window's dynamic-line outcome (v3 P4 §3.4).
 *
 * The underutilization advice needs to distinguish "the window WILL NOT fill
 * before reset" (dynamicPauseAt's `return 100` path) from "the window never
 * yields a numeric line for other reasons" (admission-closed / degraded).
 * `effectiveDynamicLine` cannot be the signal source because it deliberately
 * drops `line >= 100` — and will-not-fill IS exactly line 100. This verdict
 * reuses `dynamicPauseAt` for the gating decision (single source of truth) and
 * only exposes the structured outcome plus the projected-at-reset figure the
 * advice text shows.
 */
export type DynamicWindowVerdict =
  | { kind: "will-fill"; line: number }
  | { kind: "will-not-fill"; projectedAtReset: number }
  | { kind: "admission-closed" }
  | { kind: "degraded" };

/**
 * Classify a single window's dynamic-line outcome without re-deriving the gating
 * logic. Returns `degraded` when there is no confident burn rate or the window
 * has already reset (a past window is not a live underutilization signal).
 *
 * `projectedAtReset` reuses dynamicPauseAt's own projection formula
 * (`util + guardRate × clampedTimeToResetHours`) — this is selection/formatting
 * over the guard's verbatim rate, NOT a burn-rate recomputation (§3.3 #2): the
 * decision layer already computes this exact value internally. Classifying
 * will-not-fill by `projectedAtReset <= targetUtil` (rather than `line === 100`)
 * stays correct even at the degenerate `pauseAt = 100` config, where a will-fill
 * line could otherwise clamp to exactly 100.
 */
export function dynamicWindowVerdict(
  window: BudgetWindow,
  cfg: BudgetConfig,
  now: number,
): DynamicWindowVerdict {
  const rate = confidentRate(window);
  if (rate === null) return { kind: "degraded" };
  if (window.resetEpoch <= now) return { kind: "degraded" };

  const line = dynamicPauseAt(window, rate, cfg, now);
  if (line === "admission-closed") return { kind: "admission-closed" };

  const projectedAtReset = window.util + rate * clampedTimeToResetHours(window, now);
  if (projectedAtReset <= cfg.maximize.targetUtil) {
    // dynamicPauseAt returned 100 here (will-not-fill); no hard cap fired since
    // admission-closed was already handled above.
    return { kind: "will-not-fill", projectedAtReset };
  }
  // projected > target → dynamicPauseAt returned a numeric will-fill line.
  return { kind: "will-fill", line };
}

/** A maximize window's contribution to the entry decision. */
interface WindowEntryVerdict {
  /** This window triggers a full pause (after the I1 floor). */
  blocks: boolean;
  /** Effective numeric dynamic line for display/fingerprint; null when degraded/admission. */
  line: number | null;
  /** The hard-cap signal fired (carried for P3; in P2 only `blocks` matters). */
  admission: boolean;
}

/** True when the guard supplied a confident burn rate for this window. */
function confidentRate(window: BudgetWindow): number | null {
  if (window.burnConfident !== true) return null;
  if (typeof window.burnRate !== "number" || !Number.isFinite(window.burnRate) || window.burnRate < 0) {
    return null;
  }
  return window.burnRate;
}

/**
 * Evaluate one fresh window for the ENTRY side. Degraded windows (no confident
 * rate) fall back to the fixed per-window gateUtil line `util ≥ pauseAt`.
 */
function maximizeWindowEntry(window: BudgetWindow, cfg: BudgetConfig, now: number): WindowEntryVerdict {
  const rate = confidentRate(window);
  if (rate === null) {
    // Degraded: fixed fallback line on THIS window (per design §3.1 degrade path).
    return { blocks: window.util >= cfg.pauseAt, line: null, admission: false };
  }
  const line = dynamicPauseAt(window, rate, cfg, now);
  if (line === "admission-closed") {
    // P2 has no three-state gate: map to closed ONLY when not stricter than
    // conserve (I1 floor — see Codex's counterexample, util can be < pauseAt in
    // the near-reset finishing band).
    return { blocks: window.util >= cfg.pauseAt, line: null, admission: true };
  }
  return { blocks: window.util >= line, line, admission: false };
}

/**
 * Evaluate one fresh window for the RESUME side (symmetric to entry): the window
 * still BLOCKS resume until its util recedes below the relaxed threshold.
 * Degraded windows use the fixed fallback `util ≥ resumeBelow` (asymmetric
 * 90-in/30-out, no hysteresis — matches the design "degrade to fallback" path).
 */
function maximizeWindowBlocksResume(window: BudgetWindow, cfg: BudgetConfig, now: number): boolean {
  const rate = confidentRate(window);
  if (rate === null) {
    return window.util >= cfg.resumeBelow;
  }
  const line = dynamicPauseAt(window, rate, cfg, now);
  const hyst = cfg.maximize.resumeHysteresisPct;
  if (line === "admission-closed") {
    // Symmetric to the I1-floored entry (effective line = pauseAt).
    return window.util >= cfg.pauseAt - hyst;
  }
  // 100 is the "won't-fill" sentinel: this window NEVER triggers entry, so it
  // must NEVER block resume either (symmetry). Without this, a window at e.g.
  // util 95 that returns line 100 would block resume at `util >= 100 − hyst`
  // even though it never caused the pause — delaying recovery up to a full
  // window reset on the OTHER side's behalf.
  if (line === 100) return false;
  return window.util >= line - hyst;
}

/** Fresh, currently-active windows for an agent (resetEpoch in the future). */
function freshWindows(usage: AgentUsage, now: number): Array<{ key: BudgetWindowKey; window: BudgetWindow }> {
  const out: Array<{ key: BudgetWindowKey; window: BudgetWindow }> = [];
  for (const key of WINDOW_KEYS) {
    const window = usage[key];
    if (window && window.resetEpoch > now) out.push({ key, window });
  }
  return out;
}

/** Structured pause-entry decision for one agent (single source of truth). */
export interface AgentPauseDecision {
  /** Should this agent enter a pause this poll. */
  pause: boolean;
  /** Window that tripped (entry), for reason + fingerprint; null when not paused. */
  window: BudgetWindowKey | null;
  /** Effective numeric dynamic line of the trigger window; null in conserve/degraded/admission. */
  line: number | null;
  /** Human-readable Chinese reason; empty string when not paused. */
  reason: string;
}

const NO_PAUSE: AgentPauseDecision = { pause: false, window: null, line: null, reason: "" };

function fallbackPauseReason(agent: AgentName, usage: AgentUsage, cfg: BudgetConfig): string {
  return `${AGENT_LABEL[agent]} gateUtil ${pct(usage.gateUtil)} ≥ pauseAt ${pct(cfg.pauseAt)}（兜底判据）`;
}

/**
 * Decide whether an agent should enter a budget pause. v3.2: always the
 * per-window time-aware evaluation — trips on the FIRST blocking window. A
 * window with no confident burn rate degrades to the gateUtil fallback inside
 * `maximizeWindowEntry`.
 */
export function agentShouldPause(
  agent: AgentName,
  usage: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): AgentPauseDecision {
  if (!usage) return NO_PAUSE;
  if (!isDecisionGrade(usage, now)) return NO_PAUSE;

  const windows = freshWindows(usage, now);
  if (windows.length === 0) {
    // Defensive: isDecisionGrade guarantees ≥1 fresh window, so this is
    // unreachable. Fall back to the gateUtil line if it ever is reached.
    if (usage.gateUtil >= cfg.pauseAt) {
      return { pause: true, window: null, line: null, reason: fallbackPauseReason(agent, usage, cfg) };
    }
    return NO_PAUSE;
  }

  for (const { key, window } of windows) {
    const verdict = maximizeWindowEntry(window, cfg, now);
    if (verdict.blocks) {
      return {
        pause: true,
        window: key,
        line: verdict.line,
        reason: buildMaximizeReason(agent, key, window, verdict, cfg),
      };
    }
  }
  return NO_PAUSE;
}

/** Reason text builder that has cfg in scope (pauseAt needs interpolation). */
function buildMaximizeReason(
  agent: AgentName,
  key: BudgetWindowKey,
  window: BudgetWindow,
  verdict: WindowEntryVerdict,
  cfg: BudgetConfig,
): string {
  const head = `${AGENT_LABEL[agent]} ${WINDOW_LABEL[key]}窗口 util ${pct(window.util)}`;
  if (verdict.line !== null) {
    const rate = window.burnRate;
    const rateText = typeof rate === "number" ? `，燃尽率≈${pct(rate)}/h` : "";
    return `${head} ≥ 动态暂停线 ${pct(verdict.line)}${rateText}`;
  }
  if (verdict.admission) {
    return `${head} 触发收尾保护硬线（≥ pauseAt ${pct(cfg.pauseAt)}）`;
  }
  return `${head} ≥ pauseAt ${pct(cfg.pauseAt)}（燃尽率采样中，退兜底判据）`;
}

/**
 * Decide whether an agent may resume. v3.2: always per-window — resume only when
 * NO fresh window still blocks (symmetric to entry, with hysteresis). A window
 * with no confident burn rate degrades to the gateUtil fallback inside
 * `maximizeWindowBlocksResume` (`util < resumeBelow`).
 */
export function agentCanResume(usage: AgentUsage | null, cfg: BudgetConfig, now: number): boolean {
  if (!isDecisionGrade(usage, now)) return false;
  if (usage!.rateLimitedUntil > now) return false;

  // Resume only when every fresh window has receded. A window that has already
  // reset (resetEpoch <= now) is excluded by freshWindows — that is the
  // "window reset → resume" path (fresh data shows util cliff-dropped, and the
  // expired window no longer blocks).
  const windows = freshWindows(usage!, now);
  for (const { window } of windows) {
    if (maximizeWindowBlocksResume(window, cfg, now)) return false;
  }
  return true;
}

/**
 * Display-only (snapshot/render): the binding dynamic line for an agent — the
 * numeric line of the fresh, confident window with the SMALLEST headroom
 * (util − line), i.e. the window closest to (or past) tripping. Returns null on
 * non-decision-grade data, or when no confident window yields a numeric line
 * (degraded / admission-closed / will-not-fill). NEVER a decision input —
 * `agentShouldPause` owns the gating; this only mirrors it.
 */
export function effectiveDynamicLine(usage: AgentUsage | null, cfg: BudgetConfig, now: number): number | null {
  if (!usage || !isDecisionGrade(usage, now)) return null;
  let bestLine: number | null = null;
  let bestHeadroom = Number.POSITIVE_INFINITY;
  for (const { window } of freshWindows(usage, now)) {
    const rate = confidentRate(window);
    if (rate === null) continue;
    const line = dynamicPauseAt(window, rate, cfg, now);
    if (line === "admission-closed" || line >= 100) continue;
    const headroom = line - window.util;
    if (headroom < bestHeadroom) {
      bestHeadroom = headroom;
      bestLine = line;
    }
  }
  return bestLine;
}

/**
 * "Earliest plausible resume" epoch (Q10 alignment). Returns the active
 * rate-limit if any, else the soonest reset among windows that still block
 * resume (the natural recovery point at a ~94–98 pause line), else 0 when
 * nothing blocks.
 */
export function resumeBlockingEpochFor(usage: AgentUsage | null, cfg: BudgetConfig, now: number): number {
  if (!usage) return 0;
  if (usage.rateLimitedUntil > now) return usage.rateLimitedUntil;
  // Non-decision-grade (stale / all-reset): we cannot evaluate per-window resume,
  // and `agentCanResume` returns false here (phantom-hold keeps the side paused).
  // The honest "earliest plausible resume" is the next window reset — but ONLY if
  // it is still in the FUTURE. When every window has already reset, matchingGateReset
  // returns a PAST epoch; returning that here would clobber the sticky good
  // resumeEpoch with a time in the past (resumeAfterEpoch keeps any epoch > 0),
  // contradicting "still paused". Returning 0 instead lets the fingerprint reducer
  // fall back to the last known-good future resumeEpoch (Codex Q10 edge).
  if (!isDecisionGrade(usage, now)) {
    const reset = matchingGateReset(usage);
    return reset > now ? reset : 0;
  }

  const blockingResets = freshWindows(usage, now)
    .filter(({ window }) => maximizeWindowBlocksResume(window, cfg, now))
    .map(({ window }) => window.resetEpoch)
    .filter((epoch) => epoch > 0);
  if (blockingResets.length === 0) return 0;
  return Math.min(...blockingResets);
}

// ---------------------------------------------------------------------------
// v3 P3 (§3.2): admission-gate predicates (three-state finishing protection).
//
// Parallel to agentShouldPause / agentCanResume, but for the WIDER, EARLIER
// `admission-closed` state: it rejects NEW turns at `admissionAt` (default 85),
// while the pause/`closed` gate only trips at the dynamic line (~95). These are
// PURE decision functions; the coordinator's fingerprint applies STATE-level
// hysteresis (phantom-hold included) on top. The per-predicate hysteresis here
// (resumeHysteresisPct on util; the 2×/3× runway enter/exit band) prevents flap
// at the thresholds. `closed` > `admission-closed` precedence is resolved by the
// GATE (coordinator/daemon), never here.
// ---------------------------------------------------------------------------

/**
 * Weekly-runway guard multipliers (RECOMMEND-7). Admission CLOSES when the weekly
 * window will fill before reset AND its depletion runway is under
 * finishingHorizon×ENTER; it RE-OPENS only once the runway recovers above
 * finishingHorizon×EXIT — the one-horizon gap is hysteresis so probe jitter at
 * the floor cannot flap the gate.
 */
const ADMISSION_WEEKLY_RUNWAY_ENTER_MULT = 2;
const ADMISSION_WEEKLY_RUNWAY_EXIT_MULT = 3;

function weeklyRunwayFloorSec(cfg: BudgetConfig, mult: number): number {
  return cfg.maximize.finishingHorizonMinutes * 60 * mult;
}

/**
 * True when the weekly window is genuinely at depletion risk within `floorSec`:
 * it will FILL before reset (a `will-fill` verdict — not merely reset-truncated)
 * and its guard runway is under the floor. Returns false for degraded /
 * will-not-fill / admission-closed verdicts: admission-closed is handled by the
 * hard-cap branch, and will-not-fill / degraded are not depletion signals. Using
 * the verdict (not raw `runwaySeconds`) avoids false-triggering near a weekly
 * RESET, where the guard truncates runway at the reset rather than at depletion.
 */
function weeklyRunwayShort(usage: AgentUsage, cfg: BudgetConfig, now: number, floorSec: number): boolean {
  const weekly = usage.weekly;
  if (!weekly || weekly.resetEpoch <= now) return false;
  if (dynamicWindowVerdict(weekly, cfg, now).kind !== "will-fill") return false;
  const runway = weekly.runwaySeconds;
  if (typeof runway !== "number" || !Number.isFinite(runway)) return false;
  return runway < floorSec;
}

/** First fresh window (stable order) whose §3.1 hard cap fires; null when none. */
function hardCapWindow(usage: AgentUsage, cfg: BudgetConfig, now: number): BudgetWindowKey | null {
  for (const { key, window } of freshWindows(usage, now)) {
    const rate = confidentRate(window);
    if (rate === null) continue;
    if (dynamicPauseAt(window, rate, cfg, now) === "admission-closed") return key;
  }
  return null;
}

/** Structured admission-entry decision for one agent (parallel to AgentPauseDecision). */
export interface AgentAdmissionDecision {
  /** Should this agent's gate enter admission-closed this poll. */
  admitClose: boolean;
  /** Window/condition that tripped (for reason + fingerprint); null when open. */
  window: BudgetWindowKey | null;
  /** Human-readable Chinese reason; empty string when not admission-closed. */
  reason: string;
}

const NO_ADMIT_CLOSE: AgentAdmissionDecision = { admitClose: false, window: null, reason: "" };

/**
 * Decide whether an agent's admission gate should CLOSE (reject new turns, allow
 * wrap-up). Three independent triggers (design §3.2), first match wins the
 * reason: (1) 5h util ≥ admissionAt — the primary, rate-free finishing line;
 * (2) a §3.1 hard cap fires on any fresh window (REAL-4); (3) the weekly window
 * is at depletion risk within finishingHorizon×2 (RECOMMEND-7). Non-decision-grade
 * data never closes here (I2); the asymmetric "stale never OPENS an already-closed
 * window" lives in the fingerprint phantom-hold, not here.
 */
export function agentShouldAdmitClose(
  agent: AgentName,
  usage: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): AgentAdmissionDecision {
  if (!usage) return NO_ADMIT_CLOSE;
  if (!isDecisionGrade(usage, now)) return NO_ADMIT_CLOSE;

  // (1) 5h util ≥ admissionAt — primary, rate-free.
  const fiveHour = usage.fiveHour;
  if (fiveHour && fiveHour.resetEpoch > now && fiveHour.util >= cfg.maximize.admissionAt) {
    return {
      admitClose: true,
      window: "fiveHour",
      reason: `${AGENT_LABEL[agent]} 5h窗口 util ${pct(fiveHour.util)} ≥ admissionAt ${pct(cfg.maximize.admissionAt)}（收尾保护：拒新任务、放收尾）`,
    };
  }

  // (2) §3.1 hard cap on any fresh window (REAL-4).
  const hard = hardCapWindow(usage, cfg, now);
  if (hard !== null) {
    return {
      admitClose: true,
      window: hard,
      reason: `${AGENT_LABEL[agent]} ${WINDOW_LABEL[hard]}窗口触发收尾保护硬线（util 已达 targetUtil 或临近重置收尾带）`,
    };
  }

  // (3) weekly window at depletion risk within finishingHorizon×2 (RECOMMEND-7).
  if (weeklyRunwayShort(usage, cfg, now, weeklyRunwayFloorSec(cfg, ADMISSION_WEEKLY_RUNWAY_ENTER_MULT))) {
    return {
      admitClose: true,
      window: "weekly",
      reason: `${AGENT_LABEL[agent]} 周窗口 runway 低于 ${ADMISSION_WEEKLY_RUNWAY_ENTER_MULT}×收尾视野（防新长任务撞穿周额度）`,
    };
  }

  return NO_ADMIT_CLOSE;
}

/**
 * Decide whether an agent's admission gate may RE-OPEN — symmetric to
 * agentShouldAdmitClose with hysteresis: every trigger must have receded — 5h
 * util < admissionAt − resumeHysteresisPct, no hard cap firing on any fresh
 * window, and the weekly runway recovered above finishingHorizon×EXIT (> the
 * ENTER floor → a one-horizon hold band). A window that has already RESET drops
 * out of freshWindows (the "window reset → open" path). Non-decision-grade data
 * never opens (I2: missing/stale data must not release a closed gate).
 */
export function agentCanAdmitOpen(usage: AgentUsage | null, cfg: BudgetConfig, now: number): boolean {
  if (!isDecisionGrade(usage, now)) return false;
  // A live rate-limit means the provider is throttling probes — do not RELEASE a
  // protective gate on it (parity with agentCanResume; the stale-flag hold beyond
  // this is the fingerprint phantom-hold's job in the coordinator layer).
  if (usage!.rateLimitedUntil > now) return false;

  // (1) 5h util must recede below the hysteresis-relaxed admission line.
  const fiveHour = usage!.fiveHour;
  if (fiveHour && fiveHour.resetEpoch > now) {
    if (fiveHour.util >= cfg.maximize.admissionAt - cfg.maximize.resumeHysteresisPct) return false;
  }
  // (2) no §3.1 hard cap may still be firing on any fresh window.
  if (hardCapWindow(usage!, cfg, now) !== null) return false;
  // (3) weekly runway must have recovered above the EXIT floor (> ENTER → hysteresis).
  if (weeklyRunwayShort(usage!, cfg, now, weeklyRunwayFloorSec(cfg, ADMISSION_WEEKLY_RUNWAY_EXIT_MULT))) return false;

  return true;
}
