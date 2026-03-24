import { describe, expect, test } from "bun:test";
import {
  BRIDGE_CONTRACT_REMINDER,
  StatusBuffer,
  classifyMessage,
  parseMarker,
} from "./message-filter";
import type { BridgeMessage } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeMsg(content: string, ts?: number): BridgeMessage {
  return { id: `test_${Date.now()}`, source: "codex", content, timestamp: ts ?? Date.now() };
}

describe("parseMarker", () => {
  test("extracts [IMPORTANT] marker", () => {
    const r = parseMarker("[IMPORTANT] task done");
    expect(r.marker).toBe("important");
    expect(r.body).toBe("task done");
  });

  test("extracts [STATUS] marker case-insensitive", () => {
    const r = parseMarker("[status] progress update");
    expect(r.marker).toBe("status");
    expect(r.body).toBe("progress update");
  });

  test("extracts [FYI] marker", () => {
    const r = parseMarker("[FYI] background info");
    expect(r.marker).toBe("fyi");
    expect(r.body).toBe("background info");
  });

  test("returns untagged for no marker", () => {
    const r = parseMarker("plain message");
    expect(r.marker).toBe("untagged");
    expect(r.body).toBe("plain message");
  });

  test("handles leading whitespace before marker", () => {
    const r = parseMarker("  [STATUS] progress");
    expect(r.marker).toBe("status");
    expect(r.body).toBe("progress");
  });

  test("handles leading newline before marker", () => {
    const r = parseMarker("\n[IMPORTANT] urgent");
    expect(r.marker).toBe("important");
    expect(r.body).toBe("urgent");
  });
});

describe("classifyMessage", () => {
  test("forwards IMPORTANT in filtered mode", () => {
    expect(classifyMessage("[IMPORTANT] x", "filtered")).toEqual({ action: "forward", marker: "important" });
  });

  test("buffers STATUS in filtered mode", () => {
    expect(classifyMessage("[STATUS] x", "filtered")).toEqual({ action: "buffer", marker: "status" });
  });

  test("drops FYI in filtered mode", () => {
    expect(classifyMessage("[FYI] x", "filtered")).toEqual({ action: "drop", marker: "fyi" });
  });

  test("forwards untagged in filtered mode", () => {
    expect(classifyMessage("hello", "filtered")).toEqual({ action: "forward", marker: "untagged" });
  });

  test("forwards everything in full mode", () => {
    expect(classifyMessage("[FYI] x", "full")).toEqual({ action: "forward", marker: "untagged" });
    expect(classifyMessage("[STATUS] x", "full")).toEqual({ action: "forward", marker: "untagged" });
  });
});

describe("StatusBuffer", () => {
  test("flushes when threshold reached", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 2, flushTimeoutMs: 60000 });
    buf.add(makeMsg("[STATUS] a"));
    expect(flushed).toHaveLength(0);
    buf.add(makeMsg("[STATUS] b"));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("2 update(s)");
    buf.dispose();
  });

  test("flushes on timeout", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.add(makeMsg("[STATUS] a"));
    await sleep(40);
    expect(flushed).toHaveLength(1);
    buf.dispose();
  });

  test("manual flush clears buffer", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 60000 });
    buf.add(makeMsg("[STATUS] a"));
    buf.add(makeMsg("[STATUS] b"));
    buf.flush("turn completed");
    expect(flushed).toHaveLength(1);
    expect(flushed[0].content).toContain("flushed: turn completed");
    expect(buf.size).toBe(0);
    buf.dispose();
  });

  test("flush on empty buffer is no-op", () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m));
    buf.flush("test");
    expect(flushed).toHaveLength(0);
    buf.dispose();
  });

  test("dispose clears timer and buffer", async () => {
    const flushed: BridgeMessage[] = [];
    const buf = new StatusBuffer((m) => flushed.push(m), { flushThreshold: 10, flushTimeoutMs: 20 });
    buf.add(makeMsg("[STATUS] a"));
    buf.dispose();
    await sleep(40);
    expect(flushed).toHaveLength(0);
  });
});

describe("BRIDGE_CONTRACT_REMINDER", () => {
  test("contains marker instructions", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[IMPORTANT]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[STATUS]");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("[FYI]");
  });
});
