/**
 * Unit tests for Broker outbox backpressure logic (Fix R3 LOW-3).
 *
 * Exercises the private enqueue / flushOutbox / send via `(broker as any)` — acceptable
 * in unit tests where we own both sides. Real Bun backpressure is hard to trigger
 * deterministically in CI; these cover the pure outbox state machine against the
 * empirically-verified Bun ws.send() contract:
 *   r  > 0  → sent
 *   r === -1 → buffered by Bun (will deliver) — frame consumed, stop
 *   r === 0  → dropped (over backpressure limit) — frame kept, retry on drain
 */
import { describe, test, expect } from "bun:test";
import { Broker } from "../broker";
import { InMemoryStore } from "../backbone/store/memory-store";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";

// Must stay in sync with the constant in broker.ts
const OUTBOX_CAP = 256;

function makeBroker() {
  const store = new InMemoryStore();
  return new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
}

/**
 * Minimal fake ServerWebSocket whose send() returns a caller-scripted result, recording
 * every frame it was asked to send (an "attempt") regardless of the result.
 */
function makeFakeWs(sendResult: (frame: string) => number) {
  const data = {
    connId: 1,
    outbox: [] as string[],
    subs: new Map<string, () => void>(),
    identity: undefined,
    presence: undefined,
  };
  const attempts: string[] = [];
  return {
    data,
    attempts,
    send(frame: string): number {
      attempts.push(frame);
      return sendResult(frame);
    },
  };
}

describe("Broker outbox — backpressure buffering", () => {
  test("enqueue stores frames up to OUTBOX_CAP and drops oldest on overflow", () => {
    const broker = makeBroker();
    const ws = makeFakeWs(() => 0); // result irrelevant: enqueue tested in isolation

    for (let i = 0; i < OUTBOX_CAP + 10; i++) {
      (broker as any).enqueue(ws, `frame-${i}`);
    }

    expect(ws.data.outbox.length).toBe(OUTBOX_CAP);
    // First 10 frames (0–9) dropped; frame-10 is now the oldest
    expect(ws.data.outbox[0]).toBe(`frame-10`);
    expect(ws.data.outbox[ws.data.outbox.length - 1]).toBe(`frame-${OUTBOX_CAP + 9}`);
  });

  test("flushOutbox sends successful frames (r>0) in FIFO order and empties the outbox", () => {
    const broker = makeBroker();
    const ws = makeFakeWs(() => 5); // all succeed

    ws.data.outbox = ["x", "y", "z"];
    (broker as any).flushOutbox(ws);

    expect(ws.attempts).toEqual(["x", "y", "z"]);
    expect(ws.data.outbox).toHaveLength(0);
  });

  test("flushOutbox KEEPS a dropped frame (r===0) at the head and stops", () => {
    const broker = makeBroker();
    let calls = 0;
    // First frame sends, second is dropped (0), rest untried
    const ws = makeFakeWs(() => (++calls === 1 ? 5 : 0));

    ws.data.outbox = ["a", "b", "c", "d"];
    (broker as any).flushOutbox(ws);

    expect(ws.attempts).toEqual(["a", "b"]); // stopped at the dropped frame
    expect(ws.data.outbox).toEqual(["b", "c", "d"]); // dropped frame "b" retained for retry
  });

  test("flushOutbox CONSUMES a buffered frame (r===-1) and stops (no double-send)", () => {
    const broker = makeBroker();
    let calls = 0;
    // First succeeds, second is buffered by Bun (-1) → consumed, then stop
    const ws = makeFakeWs(() => (++calls === 1 ? 5 : -1));

    ws.data.outbox = ["a", "b", "c"];
    (broker as any).flushOutbox(ws);

    expect(ws.attempts).toEqual(["a", "b"]);
    // "b" was buffered by Bun (will deliver) → removed so the next drain won't re-send it
    expect(ws.data.outbox).toEqual(["c"]);
  });

  test("flushOutbox discards head and stops when send() throws (closed socket)", () => {
    const broker = makeBroker();
    const ws = makeFakeWs(() => {
      throw new Error("closed");
    });
    ws.data.outbox = ["a", "b"];
    (broker as any).flushOutbox(ws);

    expect(ws.data.outbox).toEqual(["b"]); // head discarded, stopped
  });

  test("send() enqueues then flushes — a dropped frame stays queued for the next drain", () => {
    const broker = makeBroker();
    const ws = makeFakeWs(() => 0); // every send dropped

    (broker as any).send(ws, { seq: 1 });
    (broker as any).send(ws, { seq: 2 });

    // send#1: seq:1 dropped → stays at head. send#2: enqueues seq:2 BEHIND it, then
    // re-flushes from the head → seq:1 is re-attempted (dropped again, still head);
    // seq:2 is NEVER attempted (head-of-line blocked). So 2 attempts (both seq:1),
    // outbox keeps [seq:1, seq:2] in FIFO order for the next drain.
    expect(ws.attempts).toHaveLength(2);
    expect(ws.attempts.map((a: string) => JSON.parse(a).seq)).toEqual([1, 1]); // both attempts were the head (seq:1), not seq:2
    expect(ws.data.outbox).toHaveLength(2);
    expect(JSON.parse(ws.data.outbox[0]!)).toEqual({ seq: 1 });
    expect(JSON.parse(ws.data.outbox[1]!)).toEqual({ seq: 2 });
  });

  test("send() delivers immediately when the socket is not backpressured", () => {
    const broker = makeBroker();
    const ws = makeFakeWs(() => 5); // always sent

    (broker as any).send(ws, { type: "event" });

    expect(ws.attempts).toHaveLength(1);
    expect(ws.data.outbox).toHaveLength(0); // sent, nothing queued
  });

  test("drain-then-flush re-delivers a previously dropped frame", () => {
    const broker = makeBroker();
    let dropping = true;
    const ws = makeFakeWs(() => (dropping ? 0 : 5));

    (broker as any).send(ws, { seq: 1 }); // dropped → queued
    expect(ws.data.outbox).toHaveLength(1);
    const queuedFrame = ws.data.outbox[0];

    // backpressure relieved → drain calls flushOutbox
    dropping = false;
    (broker as any).flushOutbox(ws);

    expect(ws.data.outbox).toHaveLength(0); // re-delivered
    expect(ws.attempts).toEqual([queuedFrame, queuedFrame]); // same frame attempted twice (drop, then resend)
  });
});
