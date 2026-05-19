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

  test("attachClaudeAndWaitForStatus resolves true when the daemon confirms attachment", async () => {
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
    await expect(client.attachClaudeAndWaitForStatus(250)).resolves.toBe(true);
  });

  test("attachClaudeAndWaitForStatus resolves false when the daemon rejects the attach", async () => {
    onServerMessage = (ws, raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "claude_connect") {
        ws.close(4003, "liveness probe in progress, retry shortly");
      }
    };

    await client.connect();
    await expect(client.attachClaudeAndWaitForStatus(250)).resolves.toBe(false);
  });

  test("attachClaudeAndWaitForStatus resolves false on timeout when daemon never responds", async () => {
    // Server intentionally swallows claude_connect — no status, no close, no anything.
    // Critical path for the recovery poller: a hung daemon must let the caller proceed.
    onServerMessage = () => {};

    await client.connect();
    const start = Date.now();
    const result = await client.attachClaudeAndWaitForStatus(150);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
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

    // Send a message that expects a reply — it will never be answered
    const replyPromise = client.sendReply(
      { id: "test-pending", source: "claude", content: "hello", timestamp: Date.now() },
      false,
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

    const result = await client.sendReply({
      id: "r2",
      source: "claude",
      content: "reply text",
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("pending replies rejected on disconnect", async () => {
    await client.connect();

    const replyPromise = client.sendReply({
      id: "r3",
      source: "claude",
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
});
