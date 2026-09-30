import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DaemonClient } from "../daemon-client";

/**
 * Tests for DaemonClient — connection, disconnection, and message routing.
 *
 * Uses a real WebSocket server on a random port so we exercise the full
 * connect / message / close path without mocking WebSocket internals.
 */

let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;
let client: DaemonClient;
let serverSockets: Set<any>;

// Shared message handler — tests can replace this to intercept server-side messages
let onServerMessage: (ws: any, raw: string | Buffer) => void = () => {};

function startServer() {
  serverSockets = new Set();
  const srv = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return undefined;
      return new Response("ok");
    },
    websocket: {
      open(ws: any) {
        serverSockets.add(ws);
      },
      message(ws: any, raw: any) {
        onServerMessage(ws, raw);
      },
      close(ws: any) {
        serverSockets.delete(ws);
      },
    },
  });
  server = srv;
  serverPort = srv.port as number;
}

function stopServer() {
  if (server) {
    server.stop(true);
    server = null;
  }
}

function sendToClient(data: Record<string, unknown>) {
  for (const ws of serverSockets) {
    ws.send(JSON.stringify(data));
  }
}

async function enableExplicitRouting() {
  const status = new Promise<void>(resolve => client.once("status", () => resolve()));
  sendToClient({ type: "status", status: { localChatVersion: 2 } });
  await status;
}

describe("DaemonClient", () => {
  beforeEach(() => {
    onServerMessage = () => {};
    startServer();
    client = new DaemonClient(`ws://127.0.0.1:${serverPort}/ws`);
  });

  afterEach(async () => {
    await client.disconnect();
    stopServer();
  });

  test("connect() succeeds against a live server", async () => {
    await client.connect();
    // No error thrown = success
  });

  test("connect() rejects when server is not reachable", async () => {
    stopServer();
    const badClient = new DaemonClient("ws://127.0.0.1:19999/ws");
    await expect(badClient.connect()).rejects.toThrow();
  });

  test("emits disconnect when server closes the socket", async () => {
    await client.connect();

    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    for (const ws of serverSockets) {
      ws.close();
    }

    await disconnected;
  });

  test("emits rejected (not disconnect) when server closes with code 4001", async () => {
    await client.connect();

    let disconnectEmitted = false;
    client.on("disconnect", () => { disconnectEmitted = true; });

    const rejected = new Promise<number>((resolve) => {
      client.on("rejected", (code) => resolve(code));
    });

    for (const ws of serverSockets) {
      ws.close(4001, "another Claude session is already connected");
    }

    const code = await rejected;
    expect(code).toBe(4001);
    // Give a tick for any stray disconnect to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectEmitted).toBe(false);
  });

  test("emits rejected (not disconnect) when server closes with code 4002 (evicted stale)", async () => {
    await client.connect();

    let disconnectEmitted = false;
    client.on("disconnect", () => { disconnectEmitted = true; });

    const rejected = new Promise<number>((resolve) => {
      client.on("rejected", (code) => resolve(code));
    });

    for (const ws of serverSockets) {
      ws.close(4002, "stale frontend evicted by newer session");
    }

    const code = await rejected;
    expect(code).toBe(4002);
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectEmitted).toBe(false);
  });

  test("emits rejected (not disconnect) when server closes with code 4003 (probe in progress)", async () => {
    await client.connect();

    let disconnectEmitted = false;
    client.on("disconnect", () => { disconnectEmitted = true; });

    const rejected = new Promise<number>((resolve) => {
      client.on("rejected", (code) => resolve(code));
    });

    for (const ws of serverSockets) {
      ws.close(4003, "liveness probe in progress, retry shortly");
    }

    const code = await rejected;
    expect(code).toBe(4003);
    await new Promise((r) => setTimeout(r, 50));
    // Critical: must NOT trigger the disconnect path, which would cause the
    // contestant to reconnect-loop during the probe window.
    expect(disconnectEmitted).toBe(false);
  });

  test("emits rejected (not disconnect) when server closes with code 4006 (contract mismatch)", async () => {
    await client.connect();

    let disconnectEmitted = false;
    client.on("disconnect", () => { disconnectEmitted = true; });

    const rejected = new Promise<number>((resolve) => {
      client.on("rejected", (code) => resolve(code));
    });

    for (const ws of serverSockets) {
      ws.close(4006, "contract version mismatch: daemon v1, client v2");
    }

    const code = await rejected;
    expect(code).toBe(4006);
    await new Promise((r) => setTimeout(r, 50));
    // A contract mismatch is terminal-until-reinstall, like pair/token mismatch:
    // it must NOT fall into the disconnect (auto-reconnect) path.
    expect(disconnectEmitted).toBe(false);
  });

  test("attachClaudeAndWaitForStatus resolves daemon status when the daemon confirms attachment", async () => {
    onServerMessage = (ws, raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "claude_connect") {
        ws.send(JSON.stringify({
          type: "status",
          status: {
            bridgeReady: true,
            tuiConnected: false,
            threadId: null,
            queuedMessageCount: 0,
            proxyUrl: "ws://127.0.0.1:4501",
            appServerUrl: "ws://127.0.0.1:4500",
            pid: 12345,
          },
        }));
      }
    };

    await client.connect();
    const status = await client.attachClaudeAndWaitForStatus(250);
    expect(status?.pid).toBe(12345);
    expect(status?.bridgeReady).toBe(true);
  });

  test("attachClaudeAndWaitForStatus resolves null when the daemon rejects the attach", async () => {
    onServerMessage = (ws, raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "claude_connect") {
        ws.close(4003, "liveness probe in progress, retry shortly");
      }
    };

    await client.connect();
    await expect(client.attachClaudeAndWaitForStatus(250)).resolves.toBeNull();
  });

  test("attachClaudeAndWaitForStatus resolves null on timeout when daemon never responds", async () => {
    // Server intentionally swallows claude_connect — no status, no close, no anything.
    // Critical path for the recovery poller: a hung daemon must let the caller proceed.
    onServerMessage = () => {};

    await client.connect();
    const start = Date.now();
    const result = await client.attachClaudeAndWaitForStatus(150);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Must actually wait for the timeout, not resolve instantly.
    expect(elapsed).toBeGreaterThanOrEqual(140);
    // Sanity check on upper bound to catch event-listener leaks that delay GC.
    expect(elapsed).toBeLessThan(2_000);
  });

  test("emits disconnect (not rejected) for non-rejection close codes", async () => {
    await client.connect();

    let rejectedEmitted = false;
    client.on("rejected", () => { rejectedEmitted = true; });

    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    for (const ws of serverSockets) {
      ws.close(1000, "normal closure");
    }

    await disconnected;
    await new Promise((r) => setTimeout(r, 50));
    expect(rejectedEmitted).toBe(false);
  });

  test("pending replies rejected on rejected close (code 4001)", async () => {
    await client.connect();
    await enableExplicitRouting();

    // Send a message that expects a reply — it will never be answered
    const replyPromise = client.sendReply(
      { id: "test-pending", source: "claude", to: "codex", content: "hello", timestamp: Date.now() },
    );

    // Close with 4001 before any response
    for (const ws of serverSockets) {
      ws.close(4001, "another Claude session is already connected");
    }

    const result = await replyPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("emits codexMessage on codex_to_claude", async () => {
    await client.connect();

    const msgPromise = new Promise<any>((resolve) => {
      client.on("codexMessage", (msg) => resolve(msg));
    });

    sendToClient({
      type: "codex_to_claude",
      message: { id: "test1", source: "codex", content: "hello", timestamp: 1 },
    });

    const msg = await msgPromise;
    expect(msg.content).toBe("hello");
    expect(msg.source).toBe("codex");
  });

  test("emits status on status message", async () => {
    await client.connect();

    const statusPromise = new Promise<any>((resolve) => {
      client.on("status", (s) => resolve(s));
    });

    sendToClient({
      type: "status",
      status: {
        bridgeReady: true,
        tuiConnected: false,
        threadId: null,
        queuedMessageCount: 0,
        proxyUrl: "http://localhost:4501",
        appServerUrl: "http://localhost:4502",
        pid: 123,
      },
    });

    const status = await statusPromise;
    expect(status.bridgeReady).toBe(true);
  });

  test("sendReply returns error when not connected", async () => {
    const result = await client.sendReply({
      id: "r1",
      source: "claude",
      content: "hi",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  test("sendReply resolves on successful result", async () => {
    // Set up echo handler before connecting
    onServerMessage = (ws: any, raw: any) => {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "claude_to_codex") {
        ws.send(JSON.stringify({
          type: "claude_to_codex_result",
          requestId: msg.requestId,
          success: true,
        }));
      }
    };

    await client.connect();
    await enableExplicitRouting();

    const result = await client.sendReply({
      id: "r2",
      source: "claude", to: "codex",
      content: "reply text",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("sendReply passes the PR B structured result fields through", async () => {
    onServerMessage = (ws: any, raw: any) => {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "claude_to_codex") {
        ws.send(JSON.stringify({
          type: "claude_to_codex_result",
          requestId: msg.requestId,
          success: false,
          error: "Codex is busy executing a turn.",
          ok: false,
          code: "busy_reject",
          phase: "running",
          retryAfterMs: 15000,
        }));
      }
    };

    await client.connect();
    await enableExplicitRouting();

    const result = await client.sendReply({
      id: "r-structured",
      source: "claude", to: "codex",
      content: "structured fields",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("busy_reject");
    expect(result.phase).toBe("running");
    expect(result.retryAfterMs).toBe(15000);
    expect(result.error).toContain("busy");
  });

  test("sendReply rejects legacy controls before any network call", async () => {
    const seen: any[] = [];
    onServerMessage = (ws: any, raw: any) => {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "claude_to_codex") {
        seen.push(msg);
        ws.send(JSON.stringify({ type: "claude_to_codex_result", requestId: msg.requestId, success: true }));
      }
    };

    await client.connect();
    await enableExplicitRouting();

    const result = await client.sendReply(
      { id: "r-int", source: "claude", to: "codex", content: "interrupt me", timestamp: Date.now() },
      false,
      "interrupt",
      "key-77",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Legacy turn controls");
    expect(seen).toHaveLength(0);
  });

  test("emits turnStarted on a turn_started control event", async () => {
    await client.connect();

    const ackPromise = new Promise<any>((resolve) => {
      client.on("turnStarted", (ack) => resolve(ack));
    });

    sendToClient({
      type: "turn_started",
      requestId: "reply_1_1",
      idempotencyKey: "key-9",
      threadId: "thread-1",
      turnId: "turn-abc",
    });

    const ack = await ackPromise;
    expect(ack).toEqual({
      requestId: "reply_1_1",
      idempotencyKey: "key-9",
      threadId: "thread-1",
      turnId: "turn-abc",
    });
  });

  test("pending replies rejected on disconnect", async () => {
    await client.connect();
    await enableExplicitRouting();

    const replyPromise = client.sendReply({
      id: "r3",
      source: "claude", to: "codex",
      content: "will be rejected",
      timestamp: Date.now(),
    });

    // Close server socket to trigger disconnect
    for (const ws of serverSockets) {
      ws.close();
    }

    const result = await replyPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("disconnected");
  });

  test("can reconnect after disconnect", async () => {
    await client.connect();

    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    for (const ws of serverSockets) {
      ws.close();
    }
    await disconnected;

    // Reconnect — should succeed
    await client.connect();

    // Verify it works by sending a message
    const msgPromise = new Promise<any>((resolve) => {
      client.on("codexMessage", (msg) => resolve(msg));
    });

    sendToClient({
      type: "codex_to_claude",
      message: { id: "test2", source: "codex", content: "after reconnect", timestamp: 2 },
    });

    const msg = await msgPromise;
    expect(msg.content).toBe("after reconnect");
  });

  test("attachClaude sends claude_connect message", async () => {
    const received = new Promise<any>((resolve) => {
      onServerMessage = (_ws: any, raw: any) => {
        resolve(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      };
    });

    await client.connect();
    client.attachClaude();

    const msg = await received;
    expect(msg.type).toBe("claude_connect");
  });

  test("attachClaude includes client identity when configured", async () => {
    const identity = {
      pairId: "main-12345678",
      pairName: "main",
      cwd: "/tmp/project",
      baseDir: "/tmp/agentbridge-base",
      stateDir: "/tmp/agentbridge-base/pairs/main-12345678",
      clientPid: 1234,
      contractVersion: 1,
    };
    client = new DaemonClient(`ws://127.0.0.1:${serverPort}/ws`, { identity });
    const received = new Promise<any>((resolve) => {
      onServerMessage = (_ws: any, raw: any) => {
        resolve(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      };
    });

    await client.connect();
    client.attachClaude();

    const msg = await received;
    expect(msg).toEqual({ type: "claude_connect", identity });
  });

  // Regression: room_say / room_members are the first MODEL-invokable round-trips and
  // Claude can dispatch several in ONE turn (concurrent tools/call). They MUST correlate by
  // the unique requestId — an earlier type-keyed implementation let a second call orphan the
  // first (hang forever) and cross-settle the reply onto the wrong waiter.
  test("concurrent room_say calls settle independently by requestId, even on out-of-order replies", async () => {
    await client.connect();
    const seen: Array<{ requestId: string; text: string }> = [];
    onServerMessage = (_ws: any, raw: any) => {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "claude_to_room") seen.push({ requestId: msg.requestId, text: msg.text });
    };
    const pA = client.sendRoomMessage("A");
    const pB = client.sendRoomMessage("B");
    while (seen.length < 2) await new Promise((r) => setTimeout(r, 5));
    const reqA = seen.find((s) => s.text === "A")!;
    const reqB = seen.find((s) => s.text === "B")!;
    expect(reqA.requestId).not.toBe(reqB.requestId); // distinct ids despite same message type
    // Reply OUT OF ORDER (B then A) with distinguishable outcomes.
    sendToClient({ type: "claude_to_room_result", requestId: reqB.requestId, success: false, error: "B-failed" });
    sendToClient({ type: "claude_to_room_result", requestId: reqA.requestId, success: true });
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA).toEqual({ success: true }); // A got A's result (not orphaned, not B's)
    expect(rB).toEqual({ success: false, error: "B-failed" }); // B got B's result
  });

  test("concurrent room_members calls settle independently by requestId", async () => {
    await client.connect();
    const ids: string[] = [];
    onServerMessage = (_ws: any, raw: any) => {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "request_room_members") ids.push(msg.requestId);
    };
    const p1 = client.requestRoomMembers();
    const p2 = client.requestRoomMembers();
    while (ids.length < 2) await new Promise((r) => setTimeout(r, 5));
    // Reply to the SECOND request first, with distinguishable rosters.
    sendToClient({ type: "room_members_result", requestId: ids[1], members: ["two@x"], ownerId: "two@x", self: "two@x" });
    sendToClient({ type: "room_members_result", requestId: ids[0], members: ["one@x"], ownerId: "one@x", self: "one@x" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.members).toEqual(["one@x"]); // request 1 got roster 1
    expect(r2?.members).toEqual(["two@x"]); // request 2 got roster 2
  });
});
