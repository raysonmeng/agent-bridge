import { describe, test, expect } from "bun:test";
import { probeLiveness, type ProbeTarget } from "../liveness-probe";

const OPEN = 1;
const CLOSED = 3;

function makeTarget(initial: Partial<ProbeTarget> = {}): ProbeTarget & { pingCount: number } {
  return {
    readyState: OPEN,
    lastPongAt: 1_000,
    pingCount: 0,
    ping() { this.pingCount++; },
    ...initial,
  } as ProbeTarget & { pingCount: number };
}

describe("probeLiveness", () => {
  test("returns true when pong observed before timeout", async () => {
    const target = makeTarget();

    const promise = probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    // Simulate a pong landing after the first poll tick.
    setTimeout(() => { target.lastPongAt = 2_000; }, 30);

    expect(await promise).toBe(true);
    expect(target.pingCount).toBe(1);
  });

  test("returns false when no pong within timeout", async () => {
    const target = makeTarget();
    const result = await probeLiveness(target, { timeoutMs: 120, pollMs: 20 });
    expect(result).toBe(false);
    expect(target.pingCount).toBe(1);
  });

  test("returns false immediately when socket is not OPEN", async () => {
    const target = makeTarget({ readyState: CLOSED });
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
    expect(target.pingCount).toBe(0);
  });

  test("returns false when ping throws", async () => {
    const target = makeTarget({
      ping() { throw new Error("socket broken"); },
    });
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
  });

  test("returns false if readyState transitions to CLOSED mid-probe", async () => {
    const target = makeTarget();
    setTimeout(() => { target.readyState = CLOSED; }, 30);
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
  });

  test("treats pong received before ping (baseline = same value) as NOT alive", async () => {
    // Critical: a stale pong that landed before the probe started must not
    // be interpreted as proof of liveness. Only pongs arriving AFTER the
    // ping count.
    const target = makeTarget({ lastPongAt: 5_000 });
    const result = await probeLiveness(target, { timeoutMs: 80, pollMs: 20 });
    expect(result).toBe(false);
  });

  test("uses injected clock and sleep for deterministic timeout", async () => {
    let fakeNow = 0;
    const sleeps: number[] = [];
    const target = makeTarget();
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => { sleeps.push(ms); fakeNow += ms; },
    });
    expect(result).toBe(false);
    // With a 100ms budget and 25ms polls, expect 4 sleeps then timeout.
    expect(sleeps.length).toBe(4);
    expect(sleeps.every((s) => s === 25)).toBe(true);
  });
});
