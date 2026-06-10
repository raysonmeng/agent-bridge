/**
 * Idempotency state machine for bridge-originated Codex injections
 * (collaboration-protocol v2, PR B).
 *
 * Key = (threadId, idempotencyKey). Lifecycle:
 *
 *   accepted → started(turnId) → terminal(completed | aborted | rejected)
 *
 * `stalled` is NOT terminal — a stalled turn is still a live busy turn, so its
 * key stays in `started` until a real terminal boundary.
 *
 * After a key reaches terminal it is kept as a TOMBSTONE for a TTL (default
 * 20 minutes): without the tombstone, a fast-completing turn would let a late
 * retry re-inject right after terminal, defeating idempotency. Expiry is
 * enforced two ways: a lazy `now()` check on every lookup (authoritative,
 * test-controllable via the injected clock) and an unref'd cleanup timer
 * (memory hygiene; never keeps the process alive).
 *
 * Registration policy (daemon-side contract): a key is registered only once
 * the daemon has actually attempted a wire write for the message (turn/start
 * or turn/steer, or upfront across the interrupt wait window). Pre-wire
 * rejections (busy_reject / budget_paused / not-ready) deliberately do NOT
 * register — the message never entered the pipeline, so retrying with the
 * SAME key later must go through. `release()` exists for attempts that abort
 * before any injection hit the wire (e.g. interrupt failed/timed out).
 *
 * Pure and timer-injectable so it is unit-testable without the daemon wiring.
 */

export type IdempotencyTerminalOutcome = "completed" | "aborted" | "rejected";

export type IdempotencyEntryState =
  | { phase: "accepted" }
  | { phase: "started"; turnId: string }
  | { phase: "terminal"; outcome: IdempotencyTerminalOutcome };

export type IdempotencyDuplicate =
  | { duplicate: false }
  | {
      duplicate: true;
      code: "duplicate_in_flight" | "duplicate_terminal";
      state: IdempotencyEntryState;
    };

interface TrackedEntry {
  threadId: string;
  state: IdempotencyEntryState;
  /** Wall-clock (per injected now()) at which a terminal tombstone expires; null while live. */
  expiresAtMs: number | null;
  /** Unref'd cleanup timer for the tombstone; null while live. */
  timer: ReturnType<typeof setTimeout> | null;
}

export const DEFAULT_TOMBSTONE_TTL_MS = 20 * 60 * 1000;

export interface IdempotencyTrackerOptions {
  /** Tombstone TTL after a key reaches terminal. Default 20 minutes. */
  ttlMs?: number;
  /** Injectable clock for tests (lazy-expiry checks use it). Default Date.now. */
  now?: () => number;
}

export class IdempotencyTracker {
  private readonly entries = new Map<string, TrackedEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: IdempotencyTrackerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Number of live + tombstoned keys currently tracked (diagnostics/tests). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Duplicate lookup WITHOUT mutating state. Expired tombstones are treated
   * as absent (and dropped). accepted/started → duplicate_in_flight;
   * unexpired terminal tombstone → duplicate_terminal.
   */
  check(threadId: string, key: string): IdempotencyDuplicate {
    const entry = this.getLive(threadId, key);
    if (!entry) return { duplicate: false };
    if (entry.state.phase === "terminal") {
      return { duplicate: true, code: "duplicate_terminal", state: entry.state };
    }
    return { duplicate: true, code: "duplicate_in_flight", state: entry.state };
  }

  /** Current state of a key, or null when untracked/expired (diagnostics/tests). */
  peek(threadId: string, key: string): IdempotencyEntryState | null {
    return this.getLive(threadId, key)?.state ?? null;
  }

  /**
   * Register a key as accepted (= an injection attempt is hitting the wire,
   * or — for the interrupt path — the async interrupt window has opened).
   * No-op when the key is already tracked: a live entry must not be reset and
   * a tombstone must not be resurrected (callers run check() first).
   */
  accept(threadId: string, key: string): void {
    if (this.getLive(threadId, key)) return;
    this.entries.set(this.compositeKey(threadId, key), {
      threadId,
      state: { phase: "accepted" },
      expiresAtMs: null,
      timer: null,
    });
  }

  /**
   * Drop a NON-terminal entry: the attempt aborted before any turn/start hit
   * the wire (e.g. interrupt failed/timed out, sync injection failure), so a
   * retry with the same key is legitimate and must go through. Terminal
   * tombstones are deliberately preserved.
   */
  release(threadId: string, key: string): void {
    const composite = this.compositeKey(threadId, key);
    const entry = this.entries.get(composite);
    if (!entry || entry.state.phase === "terminal") return;
    this.entries.delete(composite);
  }

  /**
   * accepted → started(turnId), driven by the turn_started ACK correlation
   * (or by the known steered turn id on the steer path). No-op for untracked
   * or already-terminal keys (a late ACK must not resurrect a tombstone).
   */
  markStarted(threadId: string, key: string, turnId: string): void {
    const entry = this.getLive(threadId, key);
    if (!entry || entry.state.phase === "terminal") return;
    entry.state = { phase: "started", turnId };
  }

  /**
   * Terminal `rejected`: a bridge-originated JSON-RPC error arrived BEFORE
   * started — the app-server definitively did not start a turn for this key.
   */
  markRejected(threadId: string, key: string): void {
    const entry = this.getLive(threadId, key);
    if (!entry || entry.state.phase === "terminal") return;
    this.terminate(entry, "rejected");
  }

  /**
   * turn/completed boundary: terminal `completed` for every key whose
   * started.turnId matches. A null turnId (turn/completed without an id — the
   * adapter clears ALL active turns there) completes every started key.
   * accepted keys are left alone — their turn/start response is still owed.
   *
   * `threadId` SCOPES the null-turnId case to one thread (consistent with
   * terminateThread, which is always thread-scoped). The adapter's null-id
   * completion clears every active turn on the connection; today there is one
   * thread per pair so unscoped and scoped behave identically, but passing the
   * active thread makes the blast radius explicit and future-proofs the
   * (latent) multi-thread case so a null completion on thread A cannot
   * silently terminate thread B's started keys. When `threadId` is omitted a
   * null turnId completes every started key regardless of thread (legacy
   * behavior). A non-null turnId matches by id only; thread scope is moot
   * because turn ids are globally unique.
   */
  completeTurn(turnId: string | null, threadId?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.state.phase !== "started") continue;
      if (turnId !== null) {
        if (entry.state.turnId !== turnId) continue;
      } else if (threadId !== undefined && entry.threadId !== threadId) {
        continue;
      }
      this.terminate(entry, "completed");
    }
  }

  /**
   * Thread-wide terminal boundary (turnAborted / app-server close / reconnect
   * / stop): terminate ALL pending/running keys for the thread.
   */
  terminateThread(threadId: string, outcome: IdempotencyTerminalOutcome): void {
    for (const entry of this.entries.values()) {
      if (entry.threadId !== threadId || entry.state.phase === "terminal") continue;
      this.terminate(entry, outcome);
    }
  }

  /** Terminate every non-terminal key regardless of thread (connection-level resets). */
  terminateAll(outcome: IdempotencyTerminalOutcome): void {
    for (const entry of this.entries.values()) {
      if (entry.state.phase === "terminal") continue;
      this.terminate(entry, outcome);
    }
  }

  /** Cancel all tombstone timers and forget everything (shutdown/tests). */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  // ── internals ──────────────────────────────────────────────

  private compositeKey(threadId: string, key: string): string {
    // The NUL separator cannot occur in either part (thread ids are UUIDs, keys are
    // validated tool input), so the composite cannot collide across pairs.
    return `${threadId}\u0000${key}`;
  }

  /** Entry lookup with lazy tombstone expiry (injected-clock authoritative). */
  private getLive(threadId: string, key: string): TrackedEntry | null {
    const composite = this.compositeKey(threadId, key);
    const entry = this.entries.get(composite);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && this.now() >= entry.expiresAtMs) {
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(composite);
      return null;
    }
    return entry;
  }

  private terminate(entry: TrackedEntry, outcome: IdempotencyTerminalOutcome): void {
    entry.state = { phase: "terminal", outcome };
    entry.expiresAtMs = this.now() + this.ttlMs;
    const timer = setTimeout(() => {
      // Best-effort memory cleanup; the lazy now() check in getLive is the
      // authoritative expiry (and the one tests drive via the injected clock).
      for (const [composite, candidate] of this.entries.entries()) {
        if (candidate === entry) {
          this.entries.delete(composite);
          break;
        }
      }
    }, this.ttlMs);
    timer.unref?.();
    entry.timer = timer;
  }
}
