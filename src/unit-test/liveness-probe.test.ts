import { describe, test, expect } from "bun:test";
import { probeLiveness, type ProbeTarget } from "../liveness-probe";

const OPEN = 1;
const CLOSED = 3;

function makeTarget(initial: Partial<ProbeTarget> = {}): ProbeTarget & { pingCount: number } {
  // Seed lastPongAt at "now - 1s" so the defensive baseline (max(lastPongAt, now()))
  // resolves to now() rather than a synthetic-stale value — preserves the assertion
  // semantics for tests that simulate a real-time pong arriving during the probe.
  return {
    readyState: OPEN,
    lastPongAt: Date.now() - 1_000,
    pingCount: 0,
    ping() { this.pingCount++; },
    ...initial,
  } as ProbeTarget & { pingCount: number };
}

describe("probeLiveness", () => {
  test("returns true when pong observed before timeout", async () => {
    const target = makeTarget();

    const promise = probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    // Simulate a pong landing after the first poll tick. The timestamp must
    // exceed Date.now() at the moment the probe takes its baseline; using
    // `Date.now() + 60_000` is safely far enough in the future for the assertion.
    setTimeout(() => { target.lastPongAt = Date.now() + 60_000; }, 30);

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
    // ping count. The defensive baseline takes max(lastPongAt, now()) so a
    // recent-but-pre-probe pong is also filtered out — see the dedicated
    // defensive-baseline tests below for that case.
    const target = makeTarget({ lastPongAt: Date.now() - 500 });
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

  test("defensive baseline: pongs older than probe start are ignored even if newer than lastPongAt seed", async () => {
    // Regression for Bun's sendPings: true. Without max(lastPongAt, now()),
    // a recent-but-pre-probe pong (e.g. from Bun's background heartbeat that
    // landed during the same JS tick before our ping() ran) would falsely
    // satisfy `lastPongAt > baseline`. Use an injected clock so we can stage
    // the timestamp ordering deterministically.
    let fakeNow = 10_000;
    const target = makeTarget({ lastPongAt: 9_500 });
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => { fakeNow += ms; },
    });
    expect(result).toBe(false);
  });

  test("defensive baseline: pong arriving DURING probe (after now()) is accepted", async () => {
    let fakeNow = 10_000;
    // lastPongAt seeded BELOW now() — proves we anchor baseline to now(), not lastPongAt.
    const target = makeTarget({ lastPongAt: 9_500 });
    let pingCalls = 0;
    target.ping = () => {
      pingCalls++;
      // Simulate peer responding with a pong AFTER the probe started.
      target.lastPongAt = fakeNow + 1; // strictly greater than baseline (=fakeNow)
    };
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => { fakeNow += ms; },
    });
    expect(result).toBe(true);
    expect(pingCalls).toBe(1);
  });
});
