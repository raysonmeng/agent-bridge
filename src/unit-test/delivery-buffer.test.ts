import { describe, expect, test } from "bun:test";
import { BoundedMessageBuffer } from "../delivery-buffer";
import type { BridgeMessage } from "../types";

function msg(id: string): BridgeMessage {
  return { id, source: "codex", content: `c-${id}`, timestamp: 0 };
}

function ids(messages: BridgeMessage[]): string[] {
  return messages.map((m) => m.id);
}

/**
 * Build a buffer with a captured log sink so overflow text/counts can be
 * asserted exactly (the daemon depends on these log lines bit-for-bit).
 */
function makeBuffer(
  cap: number,
  overrides: Partial<{ overflowLabel: string; overflowNoun: string }> = {},
) {
  const logs: string[] = [];
  const buffer = new BoundedMessageBuffer({
    cap,
    overflowLabel: overrides.overflowLabel ?? "Message buffer overflow",
    overflowNoun: overrides.overflowNoun,
    log: (line) => logs.push(line),
  });
  return { buffer, logs };
}

describe("BoundedMessageBuffer", () => {
  test("push retains messages in FIFO order up to cap with no overflow log", () => {
    const { buffer, logs } = makeBuffer(3);
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    buffer.push(msg("c"));
    expect(buffer.length).toBe(3);
    expect(logs).toEqual([]);
    expect(ids(buffer.drainAll())).toEqual(["a", "b", "c"]);
  });

  test("push over cap drops the OLDEST and logs one overflow line per excess push", () => {
    const { buffer, logs } = makeBuffer(2);
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    expect(logs).toEqual([]);

    buffer.push(msg("c")); // overflow by 1: drop "a"
    expect(buffer.length).toBe(2);
    expect(logs).toEqual([
      "Message buffer overflow: dropped 1 oldest message(s), 2 remaining",
    ]);
    // Newest survive, oldest evicted.
    expect(ids(buffer.drainAll())).toEqual(["b", "c"]);
  });

  test("overflow drops exactly the excess count and keeps the newest tail", () => {
    const { buffer } = makeBuffer(2);
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    buffer.push(msg("c"));
    buffer.push(msg("d"));
    // cap=2, only the two newest survive in order.
    expect(ids(buffer.drainAll())).toEqual(["c", "d"]);
  });

  test("unshiftMany prepends preserving relative order (predates buffered tail)", () => {
    const { buffer, logs } = makeBuffer(5);
    buffer.push(msg("c"));
    buffer.push(msg("d"));
    buffer.unshiftMany([msg("a"), msg("b")]);
    expect(logs).toEqual([]);
    // a,b are older than c,d and keep their own order.
    expect(ids(buffer.drainAll())).toEqual(["a", "b", "c", "d"]);
  });

  test("unshiftMany over cap drops the oldest (the just-prepended head) + logs", () => {
    const { buffer, logs } = makeBuffer(3);
    buffer.push(msg("x"));
    buffer.push(msg("y"));
    buffer.push(msg("z")); // [x,y,z], at cap
    // Prepend 2 → [a,b,x,y,z] length 5, cap 3 → drop 2 oldest (a,b).
    buffer.unshiftMany([msg("a"), msg("b")]);
    expect(buffer.length).toBe(3);
    expect(logs).toEqual([
      "Message buffer overflow: dropped 2 oldest message(s), 3 remaining",
    ]);
    expect(ids(buffer.drainAll())).toEqual(["x", "y", "z"]);
  });

  test("unshiftMany with empty array is a no-op (no cap check, no log)", () => {
    const { buffer, logs } = makeBuffer(1);
    buffer.push(msg("a"));
    buffer.unshiftMany([]);
    expect(buffer.length).toBe(1);
    expect(logs).toEqual([]);
    expect(ids(buffer.drainAll())).toEqual(["a"]);
  });

  test("drainAll returns everything in order and leaves the buffer empty", () => {
    const { buffer } = makeBuffer(10);
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    const drained = buffer.drainAll();
    expect(ids(drained)).toEqual(["a", "b"]);
    expect(buffer.length).toBe(0);
    // Second drain on an empty buffer yields nothing.
    expect(buffer.drainAll()).toEqual([]);
  });

  test("clear empties without returning (drain-confirmation path)", () => {
    const { buffer } = makeBuffer(10);
    buffer.push(msg("a"));
    buffer.push(msg("b"));
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.drainAll()).toEqual([]);
  });

  test("custom overflow label + noun matches the backpressure log line verbatim", () => {
    const { buffer, logs } = makeBuffer(1, {
      overflowLabel: "Backpressure overflow",
      overflowNoun: "tracked message(s)",
    });
    buffer.push(msg("a"));
    buffer.push(msg("b")); // overflow by 1
    expect(logs).toEqual([
      "Backpressure overflow: dropped 1 oldest tracked message(s), 1 remaining",
    ]);
  });

  test("detach re-buffer sequence: prepend backpressured ahead of existing backlog", () => {
    // Mirrors detachClaude: existing backlog [m3] + re-buffered [m1,m2] (older)
    // → prepend keeps m1,m2 before m3, preserving global timeline.
    const { buffer } = makeBuffer(10);
    buffer.push(msg("m3"));
    const pending = [msg("m1"), msg("m2")];
    buffer.unshiftMany(pending);
    expect(ids(buffer.drainAll())).toEqual(["m1", "m2", "m3"]);
  });
});
