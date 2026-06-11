/**
 * Shared resume-gate helpers for the budget coordination layer.
 *
 * `matchingGateReset` and `resumeBlockingEpoch` were previously duplicated
 * verbatim in budget-coordinator.ts and budget-state.ts. types.ts already
 * warns that a fork between the entry-side guard and the coordinator's resume
 * gate is an accident waiting to happen (see STALE_MAX_AGE_SEC); these two
 * helpers are the same shape, so they live here as the single source of truth.
 *
 * Keep this file dependency-free beyond ./types; it is bundled into the plugin
 * daemon.
 */
import type { AgentUsage, BudgetConfig } from "./types";

/**
 * Earliest reset epoch among the windows that explain the current gateUtil.
 * Prefer windows whose util matches gateUtil (the resettable hard winner); if
 * none match, fall back to any window with a known reset. Returns 0 when there
 * is no usable window.
 */
export function matchingGateReset(usage: AgentUsage | null): number {
  if (!usage) return 0;

  const windows = [usage.fiveHour, usage.weekly].filter((window): window is NonNullable<typeof window> =>
    !!window && window.resetEpoch > 0
  );
  const matching = windows.filter((window) => Math.abs(window.util - usage.gateUtil) < 0.0001);
  const candidates = matching.length > 0 ? matching : windows;
  if (candidates.length === 0) return 0;
  return Math.min(...candidates.map((window) => window.resetEpoch));
}

/**
 * Epoch at which this side stops blocking resume: the active rate-limit if one
 * is in effect, else the gate-window reset while gateUtil is still at/above
 * resumeBelow, else 0 (this side no longer blocks resume).
 */
export function resumeBlockingEpoch(usage: AgentUsage | null, cfg: BudgetConfig, now: number): number {
  if (!usage) return 0;
  if (usage.rateLimitedUntil > now) return usage.rateLimitedUntil;
  if (usage.gateUtil >= cfg.resumeBelow) return matchingGateReset(usage);
  return 0;
}
