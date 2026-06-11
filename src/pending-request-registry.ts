/**
 * PendingRequestRegistry — a shared skeleton for the
 * "send request → register pending → arm a timeout → settle on event → clean up"
 * pattern that AgentBridge implements in several reliability-sensitive places
 * (daemon-client reply waiter, codex-adapter session-replay waiter).
 *
 * DESIGN INTENT (arch-review P2 #546)
 * ----------------------------------
 * This class deliberately does NOT unify the call sites' timeout values,
 * fail-open behavior, or resolve-vs-reject semantics — arch-review noted those
 * are "各自为政" (each site's own policy) and must stay that way. The registry
 * only owns the mechanical bookkeeping:
 *   - keeping an id → { promise settlers, timer } map
 *   - arming / disarming a per-call timeout
 *   - guaranteeing the timer is cleared and the entry deleted on every exit path
 *   - idempotency: a second settle/reject/timeout for the same id is a no-op
 *
 * Each call site keeps full control of:
 *   - its own `timeoutMs` (passed per `register`)
 *   - whether a timeout RESOLVES (fail-open / failure-value) or REJECTS
 *     (via the `onTimeout` callback, which receives the resolve/reject pair)
 *   - what value it settles with (`settle`) or what error it rejects with
 *     (`reject`)
 *
 * Timer injection (`setTimer` / `clearTimer`) keeps the class testable without
 * real wall-clock waits. `unref` is opt-in per call (the existing map+timer
 * sites do NOT unref their timers, so the default is to leave them ref'd).
 */

export interface PendingTimeoutControls<T> {
  /** Resolve the pending promise with a value (fail-open / failure-value path). */
  resolve: (value: T) => void;
  /** Reject the pending promise with an error. */
  reject: (error: Error) => void;
}

export interface RegisterOptions<T> {
  /** Per-call timeout in milliseconds. Each site owns its own value. */
  timeoutMs: number;
  /**
   * Invoked when the timeout fires (and only if the entry is still pending).
   * The registry has already disarmed the timer and removed the entry BEFORE
   * calling this, so the callback just decides resolve-vs-reject. This preserves
   * each site's own fail-open / reject-on-timeout policy.
   */
  onTimeout: (controls: PendingTimeoutControls<T>) => void;
  /**
   * If true, the timeout timer is unref'd so it cannot keep the event loop
   * alive. Defaults to false to match the existing map+timer call sites, whose
   * reply/replay timers are intentionally ref'd.
   */
  unref?: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface PendingEntry<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: TimerHandle;
}

export interface PendingRegistryDeps {
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class PendingRequestRegistry<T> {
  private readonly entries = new Map<string | number, PendingEntry<T>>();
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(deps: PendingRegistryDeps = {}) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /** Number of currently-pending entries (for tests / introspection). */
  get size(): number {
    return this.entries.size;
  }

  /** Whether an id is currently pending. */
  has(id: string | number): boolean {
    return this.entries.has(id);
  }

  /**
   * Register a pending request and return a promise that resolves/rejects when
   * the request is settled, rejected, or times out. The id MUST be sent on the
   * wire by the caller AFTER (or as part of) this call so the response can be
   * matched back via `settle` / `reject`.
   *
   * If an id is registered twice, the previous entry is settled defensively by
   * timing it out is NOT done — instead the new registration overwrites the map
   * slot, mirroring `Map.set`. Call sites use unique ids, so this is not hit in
   * practice; the overwrite keeps the timer of the OLD entry cleared to avoid a
   * leak.
   */
  register(id: string | number, options: RegisterOptions<T>): Promise<T> {
    // Defensive: if the same id is somehow re-registered, clear the stale timer
    // so it can't fire against the new promise. (Call sites use unique ids.)
    const existing = this.entries.get(id);
    if (existing) {
      this.clearTimer(existing.timer);
      this.entries.delete(id);
    }

    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        // Only act if still pending — settle/reject may have raced in.
        if (!this.entries.has(id)) return;
        this.entries.delete(id);
        options.onTimeout({ resolve, reject });
      }, options.timeoutMs);

      if (options.unref) {
        (timer as { unref?: () => void }).unref?.();
      }

      this.entries.set(id, { resolve, reject, timer });
    });
  }

  /**
   * Settle a pending request with a value. Clears its timer and removes the
   * entry. Returns true if an entry existed (and was settled), false otherwise
   * (unknown / already-settled id → no-op).
   */
  settle(id: string | number, value: T): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    this.entries.delete(id);
    entry.resolve(value);
    return true;
  }

  /**
   * Reject a pending request with an error. Clears its timer and removes the
   * entry. Returns true if an entry existed (and was rejected), false otherwise
   * (unknown / already-settled id → no-op).
   */
  reject(id: string | number, error: Error): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    this.entries.delete(id);
    entry.reject(error);
    return true;
  }

  /**
   * Settle EVERY pending request with a value produced per-entry. Used by call
   * sites whose "connection dropped" teardown resolves all in-flight waits with
   * a failure value (resolve-only semantics, e.g. daemon-client reply waiter).
   * The map is fully drained.
   */
  settleAll(value: T | ((id: string | number) => T)): void {
    const make = typeof value === "function" ? (value as (id: string | number) => T) : () => value;
    for (const [id, entry] of this.entries) {
      this.clearTimer(entry.timer);
      this.entries.delete(id);
      entry.resolve(make(id));
    }
  }

  /**
   * Reject EVERY pending request with an error. Provided for symmetry / future
   * teardown paths. The map is fully drained.
   */
  rejectAll(error: Error | ((id: string | number) => Error)): void {
    const make = typeof error === "function" ? (error as (id: string | number) => Error) : () => error;
    for (const [id, entry] of this.entries) {
      this.clearTimer(entry.timer);
      this.entries.delete(id);
      entry.reject(make(id));
    }
  }
}
