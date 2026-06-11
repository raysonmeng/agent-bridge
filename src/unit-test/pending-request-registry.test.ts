import { describe, test, expect } from "bun:test";
import { PendingRequestRegistry } from "../pending-request-registry";

/**
 * Direct unit tests for PendingRequestRegistry — the shared skeleton extracted
 * for arch-review P2 #546. A fake timer (setTimer/clearTimer injection) lets us
 * fire timeouts deterministically without wall-clock waits.
 */

/** Controllable fake timer: register callbacks, fire them on demand. */
function makeFakeTimers() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  const cleared: number[] = [];
  const unrefed: number[] = [];

  const setTimer = (fn: () => void, _ms: number) => {
    const handle = nextHandle++;
    pending.set(handle, fn);
    // Return an object that mimics a NodeJS.Timeout enough for unref tracking,
    // but is still usable as the opaque handle the registry stores.
    const obj = {
      _handle: handle,
      unref: () => {
        unrefed.push(handle);
        return obj;
      },
    };
    handleToObj.set(handle, obj);
    objToHandle.set(obj, handle);
    return obj as unknown as ReturnType<typeof setTimeout>;
  };

  const handleToObj = new Map<number, unknown>();
  const objToHandle = new Map<unknown, number>();

  const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    const h = objToHandle.get(handle);
    if (h === undefined) return;
    cleared.push(h);
    pending.delete(h);
  };

  const fire = (handle: number) => {
    const fn = pending.get(handle);
    if (!fn) throw new Error(`no pending timer with handle ${handle}`);
    pending.delete(handle);
    fn();
  };

  const fireAll = () => {
    for (const [h, fn] of [...pending.entries()]) {
      pending.delete(h);
      fn();
    }
  };

  return { setTimer, clearTimer, fire, fireAll, cleared, unrefed, pending };
}

describe("PendingRequestRegistry", () => {
  test("register + settle resolves the promise with the settled value", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<{ ok: boolean }>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register("req-1", {
      timeoutMs: 1000,
      onTimeout: ({ resolve }) => resolve({ ok: false }),
    });

    expect(reg.size).toBe(1);
    expect(reg.has("req-1")).toBe(true);

    const settled = reg.settle("req-1", { ok: true });
    expect(settled).toBe(true);

    await expect(p).resolves.toEqual({ ok: true });
    // Entry removed and timer cleared.
    expect(reg.size).toBe(0);
    expect(reg.has("req-1")).toBe(false);
    expect(timers.cleared.length).toBe(1);
  });

  test("register + reject rejects the promise with the given error", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<string>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register(42, {
      timeoutMs: 500,
      onTimeout: ({ reject }) => reject(new Error("timed out")),
    });

    const rejected = reg.reject(42, new Error("boom"));
    expect(rejected).toBe(true);

    await expect(p).rejects.toThrow("boom");
    expect(reg.size).toBe(0);
    expect(timers.cleared.length).toBe(1);
  });

  test("timeout that resolves (fail-open) settles with the failure value", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<{ success: boolean; error?: string }>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register("reply-1", {
      timeoutMs: 1000,
      onTimeout: ({ resolve }) => resolve({ success: false, error: "Timed out" }),
    });

    // Fire the timer (handle 1).
    timers.fire(1);

    await expect(p).resolves.toEqual({ success: false, error: "Timed out" });
    // Entry removed by the timeout path.
    expect(reg.size).toBe(0);
    expect(reg.has("reply-1")).toBe(false);
  });

  test("timeout that rejects produces a rejected promise", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<unknown>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register("replay-1", {
      timeoutMs: 5000,
      onTimeout: ({ reject }) => reject(new Error("replay timeout for initialize")),
    });

    timers.fire(1);

    await expect(p).rejects.toThrow(/replay timeout for initialize/);
    expect(reg.size).toBe(0);
  });

  test("settle after timeout is a no-op (timeout already won)", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<{ v: number }>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register("race-1", {
      timeoutMs: 100,
      onTimeout: ({ resolve }) => resolve({ v: -1 }),
    });

    timers.fire(1); // timeout wins, entry deleted

    // Late settle must be a no-op and must NOT change the resolved value.
    const settled = reg.settle("race-1", { v: 99 });
    expect(settled).toBe(false);

    await expect(p).resolves.toEqual({ v: -1 });
  });

  test("timeout after settle is a no-op (settle already won)", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<{ v: number }>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register("race-2", {
      timeoutMs: 100,
      onTimeout: ({ resolve }) => resolve({ v: -1 }),
    });

    reg.settle("race-2", { v: 7 }); // settle wins, timer cleared + entry deleted

    // The timer should have been cleared, so firing it would find no entry.
    // Defensive: even if it were fired, the registry guards on entries.has(id).
    // (The handle is no longer in `pending` because clearTimer removed it.)
    expect(timers.pending.size).toBe(0);

    await expect(p).resolves.toEqual({ v: 7 });
  });

  test("duplicate settle is idempotent (second settle is a no-op)", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<number>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = reg.register("dup", {
      timeoutMs: 100,
      onTimeout: ({ resolve }) => resolve(-1),
    });

    expect(reg.settle("dup", 1)).toBe(true);
    expect(reg.settle("dup", 2)).toBe(false); // no-op
    expect(reg.reject("dup", new Error("late"))).toBe(false); // no-op

    await expect(p).resolves.toBe(1);
  });

  test("settle on an unknown id is a no-op (returns false)", () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<number>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    expect(reg.settle("never-registered", 1)).toBe(false);
    expect(reg.reject("never-registered", new Error("x"))).toBe(false);
    expect(reg.size).toBe(0);
  });

  test("settleAll drains every pending entry with a constant value", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<{ success: boolean; error?: string }>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p1 = reg.register("a", { timeoutMs: 1000, onTimeout: ({ resolve }) => resolve({ success: false }) });
    const p2 = reg.register("b", { timeoutMs: 1000, onTimeout: ({ resolve }) => resolve({ success: false }) });
    expect(reg.size).toBe(2);

    reg.settleAll({ success: false, error: "Daemon connection closed" });

    await expect(p1).resolves.toEqual({ success: false, error: "Daemon connection closed" });
    await expect(p2).resolves.toEqual({ success: false, error: "Daemon connection closed" });
    expect(reg.size).toBe(0);
    // Both timers cleared.
    expect(timers.cleared.length).toBe(2);
  });

  test("settleAll accepts a per-id factory", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<string>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p1 = reg.register("x", { timeoutMs: 1000, onTimeout: ({ resolve }) => resolve("") });
    const p2 = reg.register("y", { timeoutMs: 1000, onTimeout: ({ resolve }) => resolve("") });

    reg.settleAll((id) => `closed:${String(id)}`);

    await expect(p1).resolves.toBe("closed:x");
    await expect(p2).resolves.toBe("closed:y");
  });

  test("rejectAll drains every pending entry with an error", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<unknown>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p1 = reg.register("a", { timeoutMs: 1000, onTimeout: ({ reject }) => reject(new Error("t")) });
    const p2 = reg.register("b", { timeoutMs: 1000, onTimeout: ({ reject }) => reject(new Error("t")) });

    reg.rejectAll(new Error("connection lost"));

    await expect(p1).rejects.toThrow("connection lost");
    await expect(p2).rejects.toThrow("connection lost");
    expect(reg.size).toBe(0);
  });

  test("settleAll on an empty registry is a harmless no-op", () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<number>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(() => reg.settleAll(0)).not.toThrow();
    expect(reg.size).toBe(0);
  });

  test("unref:true unrefs the timer; default leaves it ref'd", () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<number>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    reg.register("ref-default", { timeoutMs: 100, onTimeout: ({ resolve }) => resolve(0) });
    expect(timers.unrefed).toEqual([]); // default: NOT unref'd

    reg.register("unref-on", { timeoutMs: 100, unref: true, onTimeout: ({ resolve }) => resolve(0) });
    expect(timers.unrefed).toEqual([2]); // second timer handle, unref'd
  });

  test("re-registering the same id clears the old timer (no leak)", async () => {
    const timers = makeFakeTimers();
    const reg = new PendingRequestRegistry<number>({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p1 = reg.register("same", { timeoutMs: 100, onTimeout: ({ resolve }) => resolve(-1) });
    // Re-register: old timer (handle 1) must be cleared.
    const p2 = reg.register("same", { timeoutMs: 100, onTimeout: ({ resolve }) => resolve(-2) });

    expect(timers.cleared).toContain(1);
    expect(reg.size).toBe(1);

    // Settling resolves the SECOND promise; the first is orphaned (never settles)
    // — acceptable because real call sites use unique ids and never hit this.
    reg.settle("same", 5);
    await expect(p2).resolves.toBe(5);
    void p1; // intentionally not awaited
  });
});
