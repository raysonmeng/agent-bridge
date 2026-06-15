/**
 * Shared resume-gate helpers for the budget coordination layer.
 *
 * `matchingGateReset` is the single source of truth for "the reset epoch that
 * explains the current gateUtil". (v3.2 removed the conserve-era
 * `resumeBlockingEpoch` from here — the strategy-aware `resumeBlockingEpochFor`
 * in budget-decision.ts is the sole resume-epoch helper now.)
 *
 * Keep this file dependency-free beyond ./types; it is bundled into the plugin
 * daemon.
 */
import type { AgentUsage } from "./types";

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
 * Advisory retry delay (ms) for a budget-paused injection rejection. Returns the
 * time until `resumeAfterEpoch`, or undefined when there is no trustworthy
 * FUTURE time — NEVER 0 or negative (B4). A resumeAfterEpoch already in the past
 * (a window reset landed mid poll-interval before the coordinator re-polled to
 * clear the gate) must not advertise retryAfterMs=0: the client would retry
 * immediately, be re-rejected by the still-closed gate, and busy-loop until the
 * next poll. Omitting it lets the client wait for the RESUME push instead.
 */
export function retryAfterMsForResume(resumeAfterEpoch: number | null, nowMs: number): number | undefined {
  if (resumeAfterEpoch === null) return undefined;
  const remainingMs = resumeAfterEpoch * 1000 - nowMs;
  return remainingMs > 0 ? remainingMs : undefined;
}
