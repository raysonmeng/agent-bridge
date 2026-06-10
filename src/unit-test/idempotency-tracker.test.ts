import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_TOMBSTONE_TTL_MS,
  IdempotencyTracker,
} from "../idempotency-tracker";

const THREAD = "thread-1";
const OTHER_THREAD = "thread-2";
const KEY = "key-a";

describe("IdempotencyTracker state machine", () => {
  const trackers: IdempotencyTracker[] = [];
  afterEach(() => {
    while (trackers.length > 0) trackers.pop()!.dispose();
  });
  function createTracker(opts: ConstructorParameters<typeof IdempotencyTracker>[0] = {}) {
    const tracker = new IdempotencyTracker(opts);
    trackers.push(tracker);
    return tracker;
  }

  test("unknown keys are not duplicates", () => {
    const tracker = createTracker();
    expect(tracker.check(THREAD, KEY)).toEqual({ duplicate: false });
    expect(tracker.peek(THREAD, KEY)).toBeNull();
    expect(tracker.size).toBe(0);
  });

  test("accept registers the key; check reports duplicate_in_flight", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    const dup = tracker.check(THREAD, KEY);
    expect(dup).toEqual({
      duplicate: true,
      code: "duplicate_in_flight",
      state: { phase: "accepted" },
    });
  });

  test("check is read-only — repeated checks do not mutate state", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.check(THREAD, KEY);
    tracker.check(THREAD, KEY);
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "accepted" });
    expect(tracker.size).toBe(1);
  });

  test("accepted → started carries the turn id and stays duplicate_in_flight", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "turn-7");
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "started", turnId: "turn-7" });
    const dup = tracker.check(THREAD, KEY);
    expect(dup.duplicate).toBe(true);
    expect(dup.duplicate && dup.code).toBe("duplicate_in_flight");
  });

  test("completeTurn terminates ONLY the key whose started.turnId matches", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, "key-1");
    tracker.markStarted(THREAD, "key-1", "turn-1");
    tracker.accept(THREAD, "key-2");
    tracker.markStarted(THREAD, "key-2", "turn-2");

    tracker.completeTurn("turn-1");

    expect(tracker.peek(THREAD, "key-1")).toEqual({ phase: "terminal", outcome: "completed" });
    expect(tracker.peek(THREAD, "key-2")).toEqual({ phase: "started", turnId: "turn-2" });
  });

  test("completeTurn(null) terminates every started key, leaving accepted keys alone", () => {
    // null = turn/completed carried no id; the adapter cleared ALL active
    // turns. accepted keys still owe a turn/start response, so they stay.
    const tracker = createTracker();
    tracker.accept(THREAD, "key-started");
    tracker.markStarted(THREAD, "key-started", "turn-1");
    tracker.accept(THREAD, "key-accepted");

    tracker.completeTurn(null);

    expect(tracker.peek(THREAD, "key-started")).toEqual({ phase: "terminal", outcome: "completed" });
    expect(tracker.peek(THREAD, "key-accepted")).toEqual({ phase: "accepted" });
  });

  test("terminal tombstone answers duplicate_terminal", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "turn-1");
    tracker.completeTurn("turn-1");
    const dup = tracker.check(THREAD, KEY);
    expect(dup).toEqual({
      duplicate: true,
      code: "duplicate_terminal",
      state: { phase: "terminal", outcome: "completed" },
    });
  });

  test("markRejected is terminal `rejected` from accepted (pre-started JSON-RPC error)", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markRejected(THREAD, KEY);
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "terminal", outcome: "rejected" });
    const dup = tracker.check(THREAD, KEY);
    expect(dup.duplicate && dup.code).toBe("duplicate_terminal");
  });

  test("markStarted / markRejected are no-ops for untracked keys", () => {
    const tracker = createTracker();
    tracker.markStarted(THREAD, KEY, "turn-1");
    tracker.markRejected(THREAD, KEY);
    expect(tracker.size).toBe(0);
    expect(tracker.check(THREAD, KEY)).toEqual({ duplicate: false });
  });

  test("a late markStarted cannot resurrect a terminal tombstone", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "turn-1");
    tracker.completeTurn("turn-1");
    tracker.markStarted(THREAD, KEY, "turn-2");
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "terminal", outcome: "completed" });
  });

  test("accept is a no-op when the key already exists (live or tombstone)", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "turn-1");
    tracker.accept(THREAD, KEY); // must not reset started → accepted
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "started", turnId: "turn-1" });

    tracker.completeTurn("turn-1");
    tracker.accept(THREAD, KEY); // must not resurrect the tombstone
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "terminal", outcome: "completed" });
  });

  test("release drops non-terminal entries so the key becomes retryable", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.release(THREAD, KEY);
    expect(tracker.check(THREAD, KEY)).toEqual({ duplicate: false });
  });

  test("release preserves terminal tombstones", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markRejected(THREAD, KEY);
    tracker.release(THREAD, KEY);
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "terminal", outcome: "rejected" });
  });

  test("release frees a STARTED key so a same-key retry is allowed (REAL #2 steer-fail release)", () => {
    // A keyed steer is accept()+markStarted(originalTurnId) at dispatch (bound to
    // the still-running original turn). When the app-server later REJECTS the
    // steer, the daemon must release the key — it never reached Codex, so the
    // same key must be retryable instead of stranded in `started` until the
    // original turn terminates.
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "original-turn");
    expect(tracker.check(THREAD, KEY).duplicate).toBe(true); // would block a retry

    tracker.release(THREAD, KEY); // steerFailed path

    expect(tracker.check(THREAD, KEY)).toEqual({ duplicate: false });
    // And the same key can be re-accepted cleanly (a genuine retry).
    tracker.accept(THREAD, KEY);
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "accepted" });
  });

  test("releasing a steer-failed key does NOT disturb the original turn's OWN key", () => {
    // The original turn may itself carry a different idempotency key in started;
    // releasing the failed steer's key must leave that one untouched.
    const tracker = createTracker();
    tracker.accept(THREAD, "original-key");
    tracker.markStarted(THREAD, "original-key", "original-turn");
    tracker.accept(THREAD, "steer-key");
    tracker.markStarted(THREAD, "steer-key", "original-turn");

    tracker.release(THREAD, "steer-key");

    expect(tracker.check(THREAD, "steer-key")).toEqual({ duplicate: false });
    expect(tracker.peek(THREAD, "original-key")).toEqual({ phase: "started", turnId: "original-turn" });
  });

  test("completeTurn(null, threadId) scopes the all-started completion to ONE thread (recommend #2)", () => {
    // null-turnId completion is thread-scoped when a threadId is supplied:
    // a null completion on THREAD must not terminate OTHER_THREAD's started keys.
    const tracker = createTracker();
    tracker.accept(THREAD, "key-a");
    tracker.markStarted(THREAD, "key-a", "turn-a");
    tracker.accept(OTHER_THREAD, "key-b");
    tracker.markStarted(OTHER_THREAD, "key-b", "turn-b");

    tracker.completeTurn(null, THREAD);

    expect(tracker.peek(THREAD, "key-a")).toEqual({ phase: "terminal", outcome: "completed" });
    // OTHER_THREAD's started key is untouched.
    expect(tracker.peek(OTHER_THREAD, "key-b")).toEqual({ phase: "started", turnId: "turn-b" });
  });

  test("completeTurn(null) without a threadId still terminates every started key (legacy behavior)", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, "key-a");
    tracker.markStarted(THREAD, "key-a", "turn-a");
    tracker.accept(OTHER_THREAD, "key-b");
    tracker.markStarted(OTHER_THREAD, "key-b", "turn-b");

    tracker.completeTurn(null);

    expect(tracker.peek(THREAD, "key-a")).toEqual({ phase: "terminal", outcome: "completed" });
    expect(tracker.peek(OTHER_THREAD, "key-b")).toEqual({ phase: "terminal", outcome: "completed" });
  });

  test("completeTurn(turnId, threadId) still matches by id regardless of thread scope", () => {
    // A non-null turnId matches by id only — thread scope is moot (turn ids are
    // globally unique). Passing a threadId must not change id-matching.
    const tracker = createTracker();
    tracker.accept(OTHER_THREAD, "key-x");
    tracker.markStarted(OTHER_THREAD, "key-x", "turn-x");

    tracker.completeTurn("turn-x", THREAD); // threadId differs from the key's thread

    expect(tracker.peek(OTHER_THREAD, "key-x")).toEqual({ phase: "terminal", outcome: "completed" });
  });

  test("terminateThread terminates all pending/running keys for that thread only", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, "key-accepted");
    tracker.accept(THREAD, "key-started");
    tracker.markStarted(THREAD, "key-started", "turn-1");
    tracker.accept(OTHER_THREAD, "key-other");

    tracker.terminateThread(THREAD, "aborted");

    expect(tracker.peek(THREAD, "key-accepted")).toEqual({ phase: "terminal", outcome: "aborted" });
    expect(tracker.peek(THREAD, "key-started")).toEqual({ phase: "terminal", outcome: "aborted" });
    expect(tracker.peek(OTHER_THREAD, "key-other")).toEqual({ phase: "accepted" });
  });

  test("terminateThread does not overwrite an existing terminal outcome", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "turn-1");
    tracker.completeTurn("turn-1");
    tracker.terminateThread(THREAD, "aborted");
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "terminal", outcome: "completed" });
  });

  test("terminateAll terminates every non-terminal key regardless of thread", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, "key-1");
    tracker.accept(OTHER_THREAD, "key-2");
    tracker.terminateAll("aborted");
    expect(tracker.peek(THREAD, "key-1")).toEqual({ phase: "terminal", outcome: "aborted" });
    expect(tracker.peek(OTHER_THREAD, "key-2")).toEqual({ phase: "terminal", outcome: "aborted" });
  });

  test("the same key on a DIFFERENT thread is independent", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, KEY);
    expect(tracker.check(OTHER_THREAD, KEY)).toEqual({ duplicate: false });
  });

  test("composite key cannot collide across (threadId, key) boundaries", () => {
    // "a" + "b-key" vs "a-b" + "key" style splits must stay distinct.
    const tracker = createTracker();
    tracker.accept("t", "x-y");
    expect(tracker.check("t-x", "y")).toEqual({ duplicate: false });
  });

  test("tombstone expires after the TTL via the injected clock", () => {
    let nowMs = 1_000_000;
    const tracker = createTracker({ ttlMs: 60_000, now: () => nowMs });
    tracker.accept(THREAD, KEY);
    tracker.markStarted(THREAD, KEY, "turn-1");
    tracker.completeTurn("turn-1");

    nowMs += 59_999;
    expect(tracker.check(THREAD, KEY).duplicate).toBe(true);

    nowMs += 1; // exactly at the TTL boundary → expired
    expect(tracker.check(THREAD, KEY)).toEqual({ duplicate: false });
    expect(tracker.size).toBe(0); // lazy expiry dropped the entry
  });

  test("after tombstone expiry the key is reusable from scratch", () => {
    let nowMs = 0;
    const tracker = createTracker({ ttlMs: 10, now: () => nowMs });
    tracker.accept(THREAD, KEY);
    tracker.markRejected(THREAD, KEY);
    nowMs = 11;
    expect(tracker.check(THREAD, KEY)).toEqual({ duplicate: false });
    tracker.accept(THREAD, KEY);
    expect(tracker.peek(THREAD, KEY)).toEqual({ phase: "accepted" });
  });

  test("live (non-terminal) entries never expire — only tombstones have a TTL", () => {
    let nowMs = 0;
    const tracker = createTracker({ ttlMs: 10, now: () => nowMs });
    tracker.accept(THREAD, KEY);
    nowMs = 1_000_000; // way past any TTL
    expect(tracker.check(THREAD, KEY).duplicate).toBe(true);
  });

  test("the unref'd cleanup timer also removes the tombstone (real clock)", async () => {
    const tracker = createTracker({ ttlMs: 20 });
    tracker.accept(THREAD, KEY);
    tracker.markRejected(THREAD, KEY);
    expect(tracker.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(tracker.size).toBe(0);
  });

  test("default TTL is 20 minutes", () => {
    expect(DEFAULT_TOMBSTONE_TTL_MS).toBe(20 * 60 * 1000);
  });

  test("dispose clears everything", () => {
    const tracker = createTracker();
    tracker.accept(THREAD, "k1");
    tracker.accept(THREAD, "k2");
    tracker.markRejected(THREAD, "k2");
    tracker.dispose();
    expect(tracker.size).toBe(0);
    expect(tracker.check(THREAD, "k1")).toEqual({ duplicate: false });
    expect(tracker.check(THREAD, "k2")).toEqual({ duplicate: false });
  });
});
