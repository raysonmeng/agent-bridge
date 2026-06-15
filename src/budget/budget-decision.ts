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
  const tH = Math.min(rawTimeToResetHours, MAX_TIME_TO_RESET_HOURS);

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
