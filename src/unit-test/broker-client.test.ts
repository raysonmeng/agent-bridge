import { describe, test, expect } from "bun:test";
import { BrokerClient } from "../broker-client";
import { makeEnvelope } from "./backbone-fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drivable fake WebSocket so reconnect/queue logic is testable deterministically. */
class FakeWs {
  readyState = 0; // CONNECTING
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: any[] = [];
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  simOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  simMessage(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  simDrop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function mkClient(factories: FakeWs[]) {
  return new BrokerClient({
    url: "ws://x/ws",
    token: "tok",
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    wsFactory: () => {
      const w = new FakeWs();
      factories.push(w);
      return w as unknown as WebSocket;
    },
  });
}

const welcome = { type: "welcome", identity: { id: "a@x", displayName: "A" } };

describe("BrokerClient — auth + reconnect + offline queue", () => {
  test("connects, authenticates, and subscribes", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p = c.connect();
    fs[0]!.simOpen();
    expect(fs[0]!.sent).toContainEqual({ type: "hello", token: "tok" });
    fs[0]!.simMessage(welcome);
    expect(await p).toEqual({ id: "a@x", displayName: "A" });
    expect(c.connected).toBe(true);
    c.subscribe("room1");
    expect(fs[0]!.sent).toContainEqual({ type: "subscribe", topic: "room1" });
    c.close();
  });

  test("publish while offline is queued, then re-subscribed + flushed on reconnect", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p = c.connect();
    fs[0]!.simOpen();
    fs[0]!.simMessage(welcome);
    await p;
    c.subscribe("room1");
    fs[0]!.simDrop(); // server dropped the connection
    expect(c.connected).toBe(false);
    c.publish("room1", makeEnvelope({ messageId: "off1" })); // queued
    expect(c.queuedCount).toBe(1);

    await sleep(30); // reconnect timer (5ms) fires → new ws
    expect(fs.length).toBe(2);
    fs[1]!.simOpen();
    fs[1]!.simMessage(welcome);
    await sleep(5);
    expect(fs[1]!.sent).toContainEqual({ type: "subscribe", topic: "room1" }); // re-subscribed
    expect(
      fs[1]!.sent.some((m: any) => m.type === "publish" && m.envelope.messageId === "off1"),
    ).toBe(true); // flushed
    expect(c.queuedCount).toBe(0);
    c.close();
  });

  test("a bad token rejects and does NOT trigger a reconnect loop", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p = c.connect();
    fs[0]!.simOpen();
    fs[0]!.simMessage({ type: "auth_error", reason: "invalid token" });
    fs[0]!.simDrop();
    await expect(p).rejects.toThrow();
    await sleep(30);
    expect(fs.length).toBe(1); // no reconnect attempt on auth failure
    c.close();
  });

  test("connect() is idempotent — repeated calls share ONE socket + promise", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p1 = c.connect();
    const p2 = c.connect();
    expect(p2).toBe(p1); // same promise
    expect(fs.length).toBe(1); // exactly one socket
    fs[0]!.simOpen();
    fs[0]!.simMessage(welcome);
    expect(await p1).toEqual({ id: "a@x", displayName: "A" });
    c.close();
  });

  test("a transient pre-welcome drop does NOT reject; retry stays idempotent (no overlapping sockets)", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p1 = c.connect();
    fs[0]!.simOpen(); // hello sent, no welcome yet
    fs[0]!.simDrop(); // transient drop BEFORE welcome → reconnect scheduled, p1 still pending
    const p2 = c.connect(); // a defensive caller "retries"
    expect(p2).toBe(p1); // idempotent — does not spawn another socket
    await sleep(30); // reconnect fires → exactly ONE new socket
    expect(fs.length).toBe(2); // initial + one reconnect, never 3+
    fs[1]!.simOpen();
    fs[1]!.simMessage(welcome);
    expect(await p1).toEqual({ id: "a@x", displayName: "A" }); // same promise resolves
    expect(c.connected).toBe(true);
    c.close();
  });

  test("outbox is bounded (drop-oldest) under a long disconnect", async () => {
    const fs: FakeWs[] = [];
    const c = new BrokerClient({
      url: "ws://x/ws",
      token: "tok",
      reconnectBaseMs: 100000, // don't reconnect during the test
      maxOutbox: 3,
      wsFactory: () => {
        const w = new FakeWs();
        fs.push(w);
        return w as unknown as WebSocket;
      },
    });
    c.connect();
    fs[0]!.simOpen();
    fs[0]!.simMessage(welcome);
    fs[0]!.simDrop(); // offline
    for (let i = 0; i < 5; i++) c.publish("r", makeEnvelope({ messageId: `m${i}` }));
    expect(c.queuedCount).toBe(3); // capped at maxOutbox
    c.close();
  });

  test("incoming events reach onEvent handlers", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p = c.connect();
    fs[0]!.simOpen();
    fs[0]!.simMessage(welcome);
    await p;
    const got: string[] = [];
    c.onEvent((topic, env) => got.push(`${topic}:${env.messageId}`));
    fs[0]!.simMessage({ type: "event", topic: "room1", envelope: makeEnvelope({ messageId: "e9" }) });
    expect(got).toEqual(["room1:e9"]);
    c.close();
  });

  test("a malformed inbound frame (null / number) does not throw out of onmessage", async () => {
    const fs: FakeWs[] = [];
    const c = mkClient(fs);
    const p = c.connect();
    fs[0]!.simOpen();
    fs[0]!.simMessage(welcome);
    await p;
    expect(() => fs[0]!.simMessage(null)).not.toThrow();
    expect(() => fs[0]!.simMessage(42)).not.toThrow();
    // still functional after the bad frames
    const got: string[] = [];
    c.onEvent((_t, e) => got.push(e.messageId));
    fs[0]!.simMessage({ type: "event", topic: "r", envelope: makeEnvelope({ messageId: "ok" }) });
    expect(got).toEqual(["ok"]);
    c.close();
  });
});
