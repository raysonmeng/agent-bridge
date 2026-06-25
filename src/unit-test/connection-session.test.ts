import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { ConnectionSession, type ControlSocketData } from "../connection-session";
import { BoundedMessageBuffer } from "../delivery-buffer";
import type { BridgeMessage } from "../types";

const OPEN = 1;

function msg(id: string): BridgeMessage {
  return { id, source: "codex", content: id, timestamp: 0 };
}

/** Minimal fake of the ServerWebSocket surface ConnectionSession touches. */
class FakeWs {
  data: ControlSocketData;
  readyState = OPEN;
  sendResult: number = 42; // default: a normal byte count (success)
  sendThrows = false;
  bufferedAmount = 0;
  sent: string[] = [];
  pings = 0;
  closed: { code: number; reason: string } | null = null;

  constructor() {
    this.data = {
      clientId: 7,
      attached: false,
      lastPongAt: 0,
      pongCount: 0,
      pendingBackpressure: new BoundedMessageBuffer({ cap: 100, overflowLabel: "x", log: () => {} }),
    };
  }
  send(payload: string): number {
    if (this.sendThrows) throw new Error("boom");
    this.sent.push(payload);
    return this.sendResult;
  }
  ping(): void {
    this.pings++;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  getBufferedAmount(): number {
    return this.bufferedAmount;
  }
}

function makeSession(): { ws: FakeWs; session: ConnectionSession; logs: string[] } {
  const ws = new FakeWs();
  const logs: string[] = [];
  const session = new ConnectionSession(ws as unknown as ServerWebSocket<ControlSocketData>, {
    log: (m) => logs.push(m),
    livenessPollMs: 1,
  });
  ws.data.session = session;
  return { ws, session, logs };
}

describe("ConnectionSession.send — Bun -1/0/throw semantics", () => {
  let ctx: ReturnType<typeof makeSession>;
  beforeEach(() => {
    ctx = makeSession();
  });

  test("normal send (>0) returns true and tracks no backpressure", () => {
    ctx.ws.sendResult = 42;
    expect(ctx.session.send(msg("a"))).toBe(true);
    expect(ctx.session.pendingBackpressureSize).toBe(0);
    expect(ctx.ws.sent.length).toBe(1);
  });

  test("backpressure (-1) returns TRUE and tracks the message for redelivery", () => {
    ctx.ws.sendResult = -1;
    expect(ctx.session.send(msg("a"))).toBe(true);
    expect(ctx.session.pendingBackpressureSize).toBe(1);
  });

  test("dropped (0) returns false and tracks nothing", () => {
    ctx.ws.sendResult = 0;
    expect(ctx.session.send(msg("a"))).toBe(false);
    expect(ctx.session.pendingBackpressureSize).toBe(0);
    expect(ctx.logs.some((l) => l.includes("returned 0 (dropped)"))).toBe(true);
  });

  test("throw returns false and logs", () => {
    ctx.ws.sendThrows = true;
    expect(ctx.session.send(msg("a"))).toBe(false);
    expect(ctx.logs.some((l) => l.includes("Failed to send bridge message"))).toBe(true);
  });

  test("send serialises as a codex_to_claude envelope", () => {
    ctx.session.send(msg("hello"));
    expect(JSON.parse(ctx.ws.sent[0]!)).toMatchObject({ type: "codex_to_claude", message: { id: "hello" } });
  });
});

describe("ConnectionSession backpressure rebuffer + drain confirm", () => {
  test("drainPendingBackpressureInto moves messages (prepended) and returns count", () => {
    const { ws, session } = makeSession();
    ws.sendResult = -1;
    session.send(msg("p1"));
    session.send(msg("p2"));
    const backlog = new BoundedMessageBuffer({ cap: 100, overflowLabel: "backlog", log: () => {} });
    backlog.push(msg("existing"));
    const n = session.drainPendingBackpressureInto(backlog);
    expect(n).toBe(2);
    expect(session.pendingBackpressureSize).toBe(0);
    // prepended: p1,p2 precede the pre-existing backlog entry
    expect(backlog.drainAll().map((m) => m.id)).toEqual(["p1", "p2", "existing"]);
  });

  test("confirmDrainIfFlushed clears only when socket buffer is empty", () => {
    const { ws, session } = makeSession();
    ws.sendResult = -1;
    session.send(msg("p1"));
    ws.bufferedAmount = 5; // not yet flushed
    session.confirmDrainIfFlushed();
    expect(session.pendingBackpressureSize).toBe(1);
    ws.bufferedAmount = 0; // fully drained
    session.confirmDrainIfFlushed();
    expect(session.pendingBackpressureSize).toBe(0);
  });
});

describe("ConnectionSession misc mechanics", () => {
  test("recordPong advances counter and timestamp", () => {
    const { session } = makeSession();
    expect(session.pongCount).toBe(0);
    session.recordPong();
    expect(session.pongCount).toBe(1);
  });

  test("markAttached + getters reflect ws.data", () => {
    const { ws, session } = makeSession();
    expect(session.clientId).toBe(7);
    expect(session.attached).toBe(false);
    session.markAttached(true);
    expect(session.attached).toBe(true);
    expect(ws.data.attached).toBe(true);
  });

  test("probeLiveness resolves true when a pong is observed", async () => {
    const { ws, session } = makeSession();
    // ping() simulates an immediate pong on this fake.
    const origPing = ws.ping.bind(ws);
    ws.ping = () => {
      origPing();
      ws.data.pongCount++;
    };
    expect(await session.probeLiveness(50)).toBe(true);
  });

  test("probeLiveness resolves false when socket is not OPEN", async () => {
    const { ws, session } = makeSession();
    ws.readyState = 3; // CLOSED
    expect(await session.probeLiveness(50)).toBe(false);
  });

  test("close delegates code+reason", () => {
    const { ws, session } = makeSession();
    session.close(4002, "evicted");
    expect(ws.closed).toEqual({ code: 4002, reason: "evicted" });
  });
});
