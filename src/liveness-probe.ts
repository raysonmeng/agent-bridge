/**
 * Liveness probe for half-open WebSocket detection.
 *
 * Sends a WebSocket ping and waits up to `timeoutMs` for a pong. Returns true
 * if a pong is observed (via `lastPongAt` monotonically advancing past the
 * baseline snapshot). Used by challenge-on-contest admission in daemon.ts to
 * detect half-open dead peers that still report readyState=OPEN (issue #68).
 *
 * Accepts a minimal probe target interface so the loop can be unit-tested
 * against an in-memory fake without spinning up a real WebSocket.
 */

export interface ProbeTarget {
  /** WebSocket.OPEN = 1. Anything else aborts the probe. */
  readyState: number;
  /**
   * Monotonic timestamp (ms) of the last pong frame observed. Caller updates
   * this from the `pong` handler. The probe only trusts values strictly
   * greater than the baseline taken before ping().
   */
  lastPongAt: number;
  /** Send a ping frame. May throw synchronously on a failed write. */
  ping(): void;
}

export interface ProbeLivenessOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const OPEN = 1;

export async function probeLiveness(
  target: ProbeTarget,
  options: ProbeLivenessOptions,
): Promise<boolean> {
  const {
    timeoutMs,
    pollMs = 50,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (target.readyState !== OPEN) return false;

  const baseline = target.lastPongAt;
  try {
    target.ping();
  } catch {
    return false;
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (target.lastPongAt > baseline) return true;
    if (target.readyState !== OPEN) return false;
    await sleep(pollMs);
  }
  return target.lastPongAt > baseline;
}
