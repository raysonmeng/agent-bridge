import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DaemonClient } from "./daemon-client";

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
