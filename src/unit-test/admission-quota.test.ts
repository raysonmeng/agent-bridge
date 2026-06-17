/**
 * v3 P3 (§3.2) — per-5h-window admission quota persistence (admission-quota.ts).
 *
 * Covers: fresh-state on absent/malformed file; wrap-up consume under/at limit;
 * persistence across re-read (daemon-restart simulation); window-change reset
 * (Q9: counters never carry across a 5h window); checkpoint-baton once-per-window;
 * limit 0 disables wrap-ups; the pure parser's shape rejection.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeCheckpointBaton,
  consumeWrapUp,
  currentWindowState,
  parseAdmissionQuota,
} from "../budget/admission-quota";

const EPOCH_A = 2_000_000;
const EPOCH_B = 2_018_000; // a later 5h window

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abg-admission-"));
  file = join(dir, "admission-quota.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("currentWindowState", () => {
  test("absent file → fresh zero state for the requested window", () => {
    const s = currentWindowState(file, EPOCH_A);
    expect(s).toEqual({ version: 1, fiveHourResetEpoch: EPOCH_A, wrapUpUsed: 0, checkpointBatonUsed: false });
  });

  test("malformed file → fresh zero state (never throws)", () => {
    writeFileSync(file, "{not json");
    expect(currentWindowState(file, EPOCH_A).wrapUpUsed).toBe(0);
  });

  test("stored record for a DIFFERENT window → fresh zero state (window change resets)", () => {
    writeFileSync(file, JSON.stringify({ version: 1, fiveHourResetEpoch: EPOCH_A, wrapUpUsed: 2, checkpointBatonUsed: true }));
    const s = currentWindowState(file, EPOCH_B);
    expect(s.wrapUpUsed).toBe(0);
    expect(s.checkpointBatonUsed).toBe(false);
    expect(s.fiveHourResetEpoch).toBe(EPOCH_B);
  });
});

describe("consumeWrapUp", () => {
  test("allows up to the limit, then rejects; persists each increment", () => {
    const r1 = consumeWrapUp(file, EPOCH_A, 2);
    expect(r1).toEqual({ allowed: true, used: 1, remaining: 1 });
    const r2 = consumeWrapUp(file, EPOCH_A, 2);
    expect(r2).toEqual({ allowed: true, used: 2, remaining: 0 });
    const r3 = consumeWrapUp(file, EPOCH_A, 2);
    expect(r3.allowed).toBe(false);
    expect(r3.used).toBe(2);
    // persisted: a fresh read sees the consumed count (daemon-restart safe).
    expect(currentWindowState(file, EPOCH_A).wrapUpUsed).toBe(2);
    expect(existsSync(file)).toBe(true);
  });

  test("window change resets the wrap-up count (Q9: no carry-over)", () => {
    consumeWrapUp(file, EPOCH_A, 2);
    consumeWrapUp(file, EPOCH_A, 2);
    expect(consumeWrapUp(file, EPOCH_A, 2).allowed).toBe(false);
    // new window → fresh quota
    expect(consumeWrapUp(file, EPOCH_B, 2).allowed).toBe(true);
  });

  test("limit 0 disables wrap-ups entirely", () => {
    expect(consumeWrapUp(file, EPOCH_A, 0).allowed).toBe(false);
  });
});

describe("consumeCheckpointBaton", () => {
  test("fires once per window, then rejects until the window resets", () => {
    expect(consumeCheckpointBaton(file, EPOCH_A)).toBe(true);
    expect(consumeCheckpointBaton(file, EPOCH_A)).toBe(false);
    // new window → baton available again
    expect(consumeCheckpointBaton(file, EPOCH_B)).toBe(true);
  });

  test("baton and wrap-up counters are independent within a window", () => {
    consumeWrapUp(file, EPOCH_A, 2);
    expect(consumeCheckpointBaton(file, EPOCH_A)).toBe(true);
    // wrap-up count survives the baton write
    expect(currentWindowState(file, EPOCH_A).wrapUpUsed).toBe(1);
    expect(currentWindowState(file, EPOCH_A).checkpointBatonUsed).toBe(true);
  });
});

describe("fail-closed on write failure (never throws, never over-grants)", () => {
  // A path whose PARENT is a regular file makes atomicWriteJson's mkdirSync/openSync
  // throw — simulating a non-writable target without monkey-patching fs.
  function unwritablePath(): string {
    const blocker = join(dir, "blocker-file");
    writeFileSync(blocker, "x");
    return join(blocker, "admission-quota.json");
  }

  test("consumeWrapUp DENIES the grant when the write fails (no over-grant, no throw)", () => {
    const bad = unwritablePath();
    expect(consumeWrapUp(bad, EPOCH_A, 2).allowed).toBe(false);
    // a swallowed write must NOT let the next read re-allow (the over-grant bug)
    expect(consumeWrapUp(bad, EPOCH_A, 2).allowed).toBe(false);
  });

  test("consumeCheckpointBaton WITHHOLDS the baton when the write fails (no re-fire)", () => {
    const bad = unwritablePath();
    expect(consumeCheckpointBaton(bad, EPOCH_A)).toBe(false);
    expect(consumeCheckpointBaton(bad, EPOCH_A)).toBe(false);
  });
});

describe("non-finite epoch guard (I2 self-enforced)", () => {
  test("NaN epoch never grants and never fires", () => {
    expect(consumeWrapUp(file, NaN, 2).allowed).toBe(false);
    expect(consumeCheckpointBaton(file, NaN)).toBe(false);
    expect(existsSync(file)).toBe(false); // never persists a poison record
  });
});

describe("parseAdmissionQuota", () => {
  test("rejects non-v1 / wrong-shape inputs", () => {
    expect(parseAdmissionQuota(null)).toBeNull();
    expect(parseAdmissionQuota([])).toBeNull();
    expect(parseAdmissionQuota({ version: 2, fiveHourResetEpoch: 1, wrapUpUsed: 0 })).toBeNull();
    expect(parseAdmissionQuota({ version: 1, fiveHourResetEpoch: "x", wrapUpUsed: 0 })).toBeNull();
    expect(parseAdmissionQuota({ version: 1, fiveHourResetEpoch: 1, wrapUpUsed: -1 })).toBeNull();
  });

  test("accepts a valid record and coerces a missing baton flag to false", () => {
    const s = parseAdmissionQuota({ version: 1, fiveHourResetEpoch: 5, wrapUpUsed: 1 });
    expect(s).toEqual({ version: 1, fiveHourResetEpoch: 5, wrapUpUsed: 1, checkpointBatonUsed: false });
  });
});
