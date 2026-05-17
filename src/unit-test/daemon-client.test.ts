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

    const rejected = new Promise<void>((resolve) => {
      client.on("rejected", () => resolve());
    });

    for (const ws of serverSockets) {
      ws.close(4001, "another Claude session is already connected");
    }

    await rejected;
    // Give a tick for any stray disconnect to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectEmitted).toBe(false);
  });

  test("emits disconnect (not rejected) for non-4001 close codes", async () => {
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
    void client.attachClaude(1000);  // fire-and-forget; will timeout-to-ok

    const msg = await received;
    expect(msg.type).toBe("claude_connect");
  });

  // ── STM v2.3 §D4 / §D6 P4-cleanup HIGH#2 regression tests ─────────────

  test("P4 attachClaude: sends requestId so daemon responses can correlate", async () => {
    const received = new Promise<any>((resolve) => {
      onServerMessage = (_ws: any, raw: any) => {
        resolve(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      };
    });
    await client.connect();
    void client.attachClaude(1000);
    const msg = await received;
    expect(msg.type).toBe("claude_connect");
    expect(typeof msg.requestId).toBe("string");
    expect(msg.requestId.length).toBeGreaterThan(0);
  });

  test("P4 attachClaude: forwards pairId from constructor", async () => {
    await client.disconnect();
    const pairedClient = new DaemonClient(
      `ws://127.0.0.1:${serverPort}/ws`,
      { chatId: "chat-abc", pairId: "work" },
    );
    const received = new Promise<any>((resolve) => {
      onServerMessage = (_ws: any, raw: any) => {
        resolve(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      };
    });
    await pairedClient.connect();
    void pairedClient.attachClaude(1000);
    const msg = await received;
    expect(msg.pairId).toBe("work");
    expect(msg.chatId).toBe("chat-abc");
    await pairedClient.disconnect();
  });

  test("P4 attachClaude: resolves ok=true when daemon emits matching claude_connect_result", async () => {
    let capturedRequestId: string | undefined;
    onServerMessage = (ws: any, raw: any) => {
      const incoming = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (incoming.type === "claude_connect") {
        capturedRequestId = incoming.requestId;
        // Daemon side replies with typed result.
        ws.send(JSON.stringify({
          type: "claude_connect_result",
          requestId: capturedRequestId,
          ok: true,
          chatId: incoming.chatId ?? "test-chat",
          homePairId: "default",
          paired: false,
        }));
      }
    };
    await client.connect();
    const result = await client.attachClaude(5000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.homePairId).toBe("default");
      expect(result.paired).toBe(false);
    }
  });

  test("P4 attachClaude: resolves ok=false when daemon emits PAIR_NOT_FOUND", async () => {
    await client.disconnect();
    const pairedClient = new DaemonClient(
      `ws://127.0.0.1:${serverPort}/ws`,
      { chatId: "chat-ghost", pairId: "ghost-pair" },
    );
    onServerMessage = (ws: any, raw: any) => {
      const incoming = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (incoming.type === "claude_connect") {
        ws.send(JSON.stringify({
          type: "claude_connect_result",
          requestId: incoming.requestId,
          ok: false,
          error: "PAIR_NOT_FOUND",
          message: `pair "${incoming.pairId}" is not live`,
        }));
      }
    };
    await pairedClient.connect();
    const result = await pairedClient.attachClaude(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("PAIR_NOT_FOUND");
      expect(result.message).toContain("ghost-pair");
    }
    await pairedClient.disconnect();
  });

  test("P4 attachClaude: timeout-to-ok lets v2.2 daemon (no typed response) keep working", async () => {
    // Server doesn't send any response — should fall through to ok=true
    // after the short timeout (backwards-compat).
    onServerMessage = () => { /* swallow */ };
    await client.connect();
    const start = Date.now();
    const result = await client.attachClaude(300);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.homePairId).toBeNull();
      expect(result.paired).toBe(false);
    }
    // Timed out close to the configured budget (give some slack for CI).
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(2000);
  });

  test("P4 attachClaude: ignores claude_connect_result with mismatched requestId", async () => {
    // Daemon sends a response with WRONG requestId (e.g. crossed wires).
    // attachClaude should treat this as no response and timeout-to-ok.
    onServerMessage = (ws: any, raw: any) => {
      const incoming = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (incoming.type === "claude_connect") {
        ws.send(JSON.stringify({
          type: "claude_connect_result",
          requestId: "WRONG-ID",
          ok: false,
          error: "PAIR_NOT_FOUND",
          message: "should be ignored",
        }));
      }
    };
    await client.connect();
    const result = await client.attachClaude(300);
    expect(result.ok).toBe(true); // timeout-to-ok, did NOT pick up the WRONG-ID response
  });
});
