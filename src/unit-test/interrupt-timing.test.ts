import { describe, expect, test } from "bun:test";
import {
  CLIENT_REPLY_TIMEOUT_MS,
  DEFAULT_INTERRUPT_TIMEOUT_MS,
  INTERRUPT_CLIENT_MARGIN_MS,
  MAX_INTERRUPT_TIMEOUT_MS,
  clampInterruptTimeoutMs,
} from "../interrupt-timing";

describe("interrupt-timing invariant (PR B REAL #1 — no double-turn)", () => {
  test("MAX_INTERRUPT_TIMEOUT_MS is strictly below the client reply timeout", () => {
    // The whole point: the daemon-side interrupt budget must resolve BEFORE the
    // bridge client's reply timeout fires, or a false client timeout + a Claude
    // retry would double-turn.
    expect(MAX_INTERRUPT_TIMEOUT_MS).toBeLessThan(CLIENT_REPLY_TIMEOUT_MS);
    expect(MAX_INTERRUPT_TIMEOUT_MS).toBe(CLIENT_REPLY_TIMEOUT_MS - INTERRUPT_CLIENT_MARGIN_MS);
  });

  test("a positive margin is reserved for the result to traverse the control WS", () => {
    expect(INTERRUPT_CLIENT_MARGIN_MS).toBeGreaterThan(0);
  });

  test("the default interrupt budget is within the safe ceiling", () => {
    expect(DEFAULT_INTERRUPT_TIMEOUT_MS).toBeLessThanOrEqual(MAX_INTERRUPT_TIMEOUT_MS);
    expect(clampInterruptTimeoutMs(DEFAULT_INTERRUPT_TIMEOUT_MS)).toBe(DEFAULT_INTERRUPT_TIMEOUT_MS);
  });

  test("a value below the ceiling passes through unchanged", () => {
    expect(clampInterruptTimeoutMs(30)).toBe(30);
    expect(clampInterruptTimeoutMs(MAX_INTERRUPT_TIMEOUT_MS - 1)).toBe(MAX_INTERRUPT_TIMEOUT_MS - 1);
  });

  test("a value AT the ceiling is preserved (boundary)", () => {
    expect(clampInterruptTimeoutMs(MAX_INTERRUPT_TIMEOUT_MS)).toBe(MAX_INTERRUPT_TIMEOUT_MS);
  });

  test("an OVER-large value is clamped below the client timeout (the misconfiguration guard)", () => {
    const huge = 600_000; // operator sets a 10-minute interrupt budget
    const clamped = clampInterruptTimeoutMs(huge);
    expect(clamped).toBe(MAX_INTERRUPT_TIMEOUT_MS);
    // The clamped value is strictly below the client reply timeout — so the
    // daemon ALWAYS answers before the client gives up, regardless of the env.
    expect(clamped).toBeLessThan(CLIENT_REPLY_TIMEOUT_MS);
  });

  test("even a value just above the client timeout is clamped strictly below it", () => {
    const clamped = clampInterruptTimeoutMs(CLIENT_REPLY_TIMEOUT_MS + 1);
    expect(clamped).toBe(MAX_INTERRUPT_TIMEOUT_MS);
    expect(clamped).toBeLessThan(CLIENT_REPLY_TIMEOUT_MS);
  });
});
