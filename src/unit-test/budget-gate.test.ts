import { describe, expect, test } from "bun:test";
import { retryAfterMsForResume } from "../budget/budget-gate";

describe("retryAfterMsForResume (B4)", () => {
  const NOW_MS = 1_000_000_000;

  test("returns undefined when there is no resume epoch", () => {
    expect(retryAfterMsForResume(null, NOW_MS)).toBeUndefined();
  });

  test("returns the positive remaining ms for a future resume epoch", () => {
    const epochSec = (NOW_MS + 30_000) / 1000; // 30s in the future
    expect(retryAfterMsForResume(epochSec, NOW_MS)).toBe(30_000);
  });

  test("returns undefined (NOT 0) for a resume epoch already in the past", () => {
    // B4: a window reset that landed mid poll-interval leaves resumeAfterEpoch in
    // the past until the next poll clears the gate. The old Math.max(0, ...) gave
    // retryAfterMs=0 → "retry now" → busy-loop against the still-closed gate.
    const pastEpochSec = (NOW_MS - 5_000) / 1000;
    expect(retryAfterMsForResume(pastEpochSec, NOW_MS)).toBeUndefined();
  });

  test("returns undefined for a resume epoch exactly at now (no 0)", () => {
    expect(retryAfterMsForResume(NOW_MS / 1000, NOW_MS)).toBeUndefined();
  });
});
