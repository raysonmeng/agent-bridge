import { test, expect, describe } from "bun:test";
import { StderrRingBuffer } from "../stderr-ring-buffer";

describe("StderrRingBuffer", () => {
  test("rejects non-positive capacity", () => {
    expect(() => new StderrRingBuffer(0)).toThrow(/positive/);
    expect(() => new StderrRingBuffer(-1)).toThrow(/positive/);
  });

  test("ignores empty chunks", () => {
    const buf = new StderrRingBuffer(16);
    buf.append(Buffer.alloc(0));
    expect(buf.byteLength).toBe(0);
    expect(buf.toString()).toBe("");
  });

  test("stores chunks under capacity without eviction", () => {
    const buf = new StderrRingBuffer(1024);
    buf.append(Buffer.from("hello "));
    buf.append(Buffer.from("world"));
    expect(buf.byteLength).toBe(11);
    expect(buf.toString()).toBe("hello world");
  });

  test("evicts oldest bytes when capacity exceeded", () => {
    const buf = new StderrRingBuffer(10);
    buf.append(Buffer.from("0123456789"));
    buf.append(Buffer.from("abc"));
    expect(buf.byteLength).toBe(10);
    expect(buf.toString()).toBe("3456789abc");
  });

  test("truncates a single oversized chunk to its tail", () => {
    const buf = new StderrRingBuffer(5);
    buf.append(Buffer.from("abcdefghij"));
    expect(buf.byteLength).toBe(5);
    expect(buf.toString()).toBe("fghij");
  });

  test("handles partial eviction of head chunk", () => {
    const buf = new StderrRingBuffer(6);
    buf.append(Buffer.from("abcdef"));
    buf.append(Buffer.from("XY"));
    // 'abcdefXY' is 8 bytes, overflow 2, drop 'ab' from head.
    expect(buf.byteLength).toBe(6);
    expect(buf.toString()).toBe("cdefXY");
  });

  test("preserves binary data via snapshot()", () => {
    const buf = new StderrRingBuffer(4);
    buf.append(Buffer.from([0, 1, 2, 3, 4, 5]));
    const snap = buf.snapshot();
    expect(snap.length).toBe(4);
    expect(Array.from(snap)).toEqual([2, 3, 4, 5]);
  });

  test("repeated appends near capacity behave stably", () => {
    const buf = new StderrRingBuffer(4);
    for (let i = 0; i < 100; i++) {
      buf.append(Buffer.from(String.fromCharCode(65 + (i % 26))));
    }
    expect(buf.byteLength).toBe(4);
    // Last 4 chars of the A..Z rotation at i=96..99 → indices 96%26=18,19,20,21 = S T U V
    expect(buf.toString()).toBe("STUV");
  });
});
