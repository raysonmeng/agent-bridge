import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "./codex-adapter";

function createAdapter() {
  return new CodexAdapter(4510, 4511) as any;
}

describe("CodexAdapter app-server response handling", () => {
  test("forwards active mapped responses back to the current TUI id", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    adapter.tuiConnId = 2;
    adapter.upstreamToClient.set(100123, { connId: 2, clientId: "client-7" });

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: 100123,
      result: { ok: true },
    }));

    expect(forwarded).not.toBeNull();
    expect(JSON.parse(forwarded)).toEqual({
      id: "client-7",
      result: { ok: true },
    });
    expect(intercepted).toEqual([
      { message: { id: "client-7", result: { ok: true } }, connId: 2 },
    ]);

    adapter.clearResponseTrackingState();
  });

  test("drops stale responses after a TUI connection is retired", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    adapter.upstreamToClient.set(100123, { connId: 1, clientId: 5 });
    adapter.retireConnectionState(1);

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: 100123,
      result: { ok: true },
    }));

    expect(forwarded).toBeNull();
    expect(adapter.staleProxyIds.has(100123)).toBe(false);
    expect(intercepted).toEqual([]);

    adapter.clearResponseTrackingState();
  });

  test("drops mapped responses from an older TUI generation", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    adapter.tuiConnId = 2;
    adapter.upstreamToClient.set(100124, { connId: 1, clientId: 5 });

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: 100124,
      result: { ok: true },
    }));

    expect(forwarded).toBeNull();
    expect(adapter.upstreamToClient.has(100124)).toBe(false);
    expect(intercepted).toEqual([]);

    adapter.clearResponseTrackingState();
  });

  test("swallows bridge-originated responses instead of forwarding them to the TUI", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    adapter.trackBridgeRequestId(-1);

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: -1,
      result: { accepted: true },
    }));

    expect(forwarded).toBeNull();
    expect(adapter.bridgeRequestIds.has(-1)).toBe(false);
    expect(intercepted).toEqual([]);

    adapter.clearResponseTrackingState();
  });

  test("swallows bridge-originated error responses instead of forwarding them to the TUI", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    adapter.trackBridgeRequestId(-2);

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: -2,
      error: { message: "turn/start rejected" },
    }));

    expect(forwarded).toBeNull();
    expect(adapter.bridgeRequestIds.has(-2)).toBe(false);
    expect(intercepted).toEqual([]);

    adapter.clearResponseTrackingState();
  });

  test("drops unmatched responses with an id instead of treating them as notifications", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: 777777,
      result: { ok: true },
    }));

    expect(forwarded).toBeNull();
    expect(intercepted).toEqual([]);

    adapter.clearResponseTrackingState();
  });

  test("treats empty string and non-integer string IDs as unmatched (not coerced to 0)", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    // Map id 0 — if empty string were coerced to 0 via Number(""), it would falsely match
    adapter.tuiConnId = 1;
    adapter.upstreamToClient.set(0, { connId: 1, clientId: "client-zero" });

    // Empty string id: should NOT match id 0
    const empty = adapter.handleAppServerPayload(JSON.stringify({ id: "", result: {} }));
    expect(empty).toBeNull();
    expect(adapter.upstreamToClient.has(0)).toBe(true); // still there, not consumed

    // Float string id: should NOT match
    const float = adapter.handleAppServerPayload(JSON.stringify({ id: "1.5", result: {} }));
    expect(float).toBeNull();

    // Hex string id: should NOT match
    const hex = adapter.handleAppServerPayload(JSON.stringify({ id: "0xff", result: {} }));
    expect(hex).toBeNull();

    expect(intercepted).toEqual([]);
    adapter.clearResponseTrackingState();
  });

  test("still forwards notifications with no response id", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    const raw = JSON.stringify({
      method: "turn/completed",
      params: { turn: { id: "turn-1" } },
    });
    const forwarded = adapter.handleAppServerPayload(raw);

    expect(forwarded).toBe(raw);
    expect(intercepted).toEqual([
      {
        message: {
          method: "turn/completed",
          params: { turn: { id: "turn-1" } },
        },
        connId: undefined,
      },
    ]);

    adapter.clearResponseTrackingState();
  });

  test("drops malformed id-bearing payloads that are neither request nor response", () => {
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({ id: 1 }));

    expect(forwarded).toBeNull();
    expect(intercepted).toEqual([]);

    adapter.clearResponseTrackingState();
  });
});

describe("CodexAdapter turn state machine", () => {
  test("turnStarted emits only on first turn (idle → busy)", () => {
    const adapter = createAdapter();
    const events: string[] = [];
    adapter.on("turnStarted", () => events.push("started"));

    // First turn: should emit
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    expect(events).toEqual(["started"]);
    expect(adapter.turnInProgress).toBe(true);

    // Nested turn: should NOT emit again
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t2" } } });
    expect(events).toEqual(["started"]);
    expect(adapter.turnInProgress).toBe(true);
  });

  test("turnCompleted emits only when all turns done (busy → idle)", () => {
    const adapter = createAdapter();
    const events: string[] = [];
    adapter.on("turnCompleted", () => events.push("completed"));

    // Start two nested turns
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t2" } } });

    // Complete first: still busy, should NOT emit
    adapter.handleServerNotification({ method: "turn/completed", params: { turn: { id: "t1" } } });
    expect(events).toEqual([]);
    expect(adapter.turnInProgress).toBe(true);

    // Complete second: now idle, should emit
    adapter.handleServerNotification({ method: "turn/completed", params: { turn: { id: "t2" } } });
    expect(events).toEqual(["completed"]);
    expect(adapter.turnInProgress).toBe(false);
  });

  test("injectMessage rejects during active turn", () => {
    const adapter = createAdapter();
    adapter.threadId = "thread-1";
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    expect(adapter.injectMessage("hello")).toBe(false);
  });

  test("injectMessage succeeds when no turn active", () => {
    const adapter = createAdapter();
    adapter.threadId = "thread-1";
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;

    expect(adapter.injectMessage("hello")).toBe(true);
  });

  test("clearResponseTrackingState + turn reset simulates onclose behavior", () => {
    const adapter = createAdapter();
    // Start a turn and track a response
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    expect(adapter.turnInProgress).toBe(true);

    // The onclose handler calls clearResponseTrackingState() then resets turn state.
    // We verify the reset logic directly since we can't trigger a real WebSocket close.
    adapter.clearResponseTrackingState();
    adapter.activeTurnIds.clear();
    adapter.turnInProgress = false;

    expect(adapter.turnInProgress).toBe(false);
    expect(adapter.activeTurnIds.size).toBe(0);
    // After reset, injection should work again
    adapter.threadId = "thread-1";
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;
    expect(adapter.injectMessage("hello after reset")).toBe(true);
  });

  test("thread/start tracked request lifecycle emits ready from response thread id", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    const readyEvents: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;
    adapter.on("ready", (threadId: string) => readyEvents.push(threadId));

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({
      id: "client-thread-start",
      method: "thread/start",
      params: {},
    }));

    const proxyId = JSON.parse(appSent[0]).id;
    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: proxyId,
      result: { thread: { id: "thread-from-response" } },
    }));

    expect(forwarded).not.toBeNull();
    expect(adapter.activeThreadId).toBe("thread-from-response");
    expect(readyEvents).toEqual(["thread-from-response"]);

    adapter.clearResponseTrackingState();
  });

  test("turn/start tracked request lifecycle restores thread id from request params", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    const readyEvents: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;
    adapter.on("ready", (threadId: string) => readyEvents.push(threadId));

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({
      id: "client-turn-start",
      method: "turn/start",
      params: {
        threadId: "thread-from-request",
        input: [{ type: "text", text: "hello" }],
      },
    }));

    const proxyId = JSON.parse(appSent[0]).id;
    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: proxyId,
      result: { accepted: true },
    }));

    expect(forwarded).not.toBeNull();
    expect(adapter.activeThreadId).toBe("thread-from-request");
    expect(readyEvents).toEqual(["thread-from-request"]);

    adapter.clearResponseTrackingState();
  });
});

describe("CodexAdapter server-to-client request passthrough", () => {
  test("forwards unknown future server request method to TUI (broad classification)", () => {
    const adapter = createAdapter();
    const sent: string[] = [];
    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;
    adapter.tuiConnId = 1;

    // A hypothetical future server-to-client request method not in the known allowlist
    const result = adapter.handleAppServerPayload(JSON.stringify({
      id: 99,
      method: "item/futureFeature/requestSomething",
      params: { detail: "test" },
    }));

    expect(result).toBeNull();
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.method).toBe("item/futureFeature/requestSomething");
    expect(parsed.id).not.toBe(99); // remapped to proxy id
    expect(adapter.serverRequestToProxy.size).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("forwards server request (id + method) to TUI instead of dropping", () => {
    const adapter = createAdapter();
    const sent: string[] = [];
    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;
    adapter.tuiConnId = 1;

    const serverRequest = JSON.stringify({
      id: 42,
      method: "item/permissions/requestApproval",
      params: { permission: "network" },
    });

    const result = adapter.handleAppServerPayload(serverRequest);

    expect(result).toBeNull();
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.method).toBe("item/permissions/requestApproval");
    expect(parsed.params).toEqual({ permission: "network" });
    expect(parsed.id).not.toBe(42);
    expect(adapter.serverRequestToProxy.size).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("existing response handling is not affected by server request passthrough", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;
    adapter.upstreamToClient.set(100200, { connId: 1, clientId: "c1" });

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: 100200,
      result: { ok: true },
    }));

    expect(forwarded).not.toBeNull();
    expect(JSON.parse(forwarded!).id).toBe("c1");
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("notifications without id still forwarded as before", () => {
    const adapter = createAdapter();
    const raw = JSON.stringify({ method: "item/started", params: { item: { id: "i1", type: "text" } } });
    const forwarded = adapter.handleAppServerPayload(raw);
    expect(forwarded).toBe(raw);
    adapter.clearResponseTrackingState();
  });

  test("buffers server request when no TUI connected", () => {
    const adapter = createAdapter();
    adapter.tuiWs = null;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 50,
      method: "item/fileChange/requestApproval",
      params: { file: "test.ts" },
    }));

    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(adapter.pendingServerRequests[0].serverId).toBe(50);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("falls back to buffer when TUI send fails", () => {
    const adapter = createAdapter();
    adapter.tuiWs = { send: () => { throw new Error("broken pipe"); } } as any;
    adapter.tuiConnId = 1;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 90,
      method: "item/commandExecution/requestApproval",
      params: {},
    }));

    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(adapter.pendingServerRequests[0].serverId).toBe(90);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("routes TUI approval response back to app-server with original server id", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100300, {
      serverId: 42,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100300, result: { approved: true } }));

    expect(appSent.length).toBe(1);
    expect(JSON.parse(appSent[0]).id).toBe(42);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("rejects stale response from old TUI without deleting mapping", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 2;

    adapter.serverRequestToProxy.set(100301, {
      serverId: 43,
      connId: 1,
      method: "item/fileChange/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 2 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100301, result: { approved: true } }));

    expect(appSent.length).toBe(0);
    expect(adapter.serverRequestToProxy.has(100301)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("normalizes string ID to number when matching server request response", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100302, {
      serverId: 44,
      connId: 1,
      method: "item/commandExecution/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: "100302", result: { approved: false } }));

    expect(appSent.length).toBe(1);
    expect(JSON.parse(appSent[0]).id).toBe(44);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("unknown TUI response id falls through to normal client forwarding", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 999, result: { ok: true } }));

    expect(appSent.length).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("approval response when app-server disconnected is dropped gracefully", () => {
    const adapter = createAdapter();
    adapter.appServerWs = null;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100600, {
      serverId: 88,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100600, result: { approved: true } }));

    // mapping preserved (not deleted, not forwarded)
    expect(adapter.serverRequestToProxy.has(100600)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("approval response send failure retains mapping", () => {
    const adapter = createAdapter();
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => { throw new Error("broken"); } } as any;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100500, {
      serverId: 99,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100500, result: { approved: true } }));

    // mapping should still exist after send failure
    expect(adapter.serverRequestToProxy.has(100500)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("replays buffered server requests on TUI reconnect", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.pendingServerRequests = [
      { raw: JSON.stringify({ id: 50, method: "item/fileChange/requestApproval", params: { file: "test.ts" } }), serverId: 50, method: "item/fileChange/requestApproval" },
    ];

    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.method).toBe("item/fileChange/requestApproval");
    expect(parsed.id).not.toBe(50);
    expect(adapter.serverRequestToProxy.size).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("replay send failure: no phantom mapping, request stays buffered", () => {
    const adapter = createAdapter();

    adapter.pendingServerRequests = [
      { raw: JSON.stringify({ id: 60, method: "item/permissions/requestApproval", params: {} }), serverId: 60, method: "item/permissions/requestApproval" },
    ];

    const ws = { data: { connId: 0 }, send: () => { throw new Error("connection reset"); } } as any;
    adapter.onTuiConnect(ws);

    expect(adapter.serverRequestToProxy.size).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("server request mappings survive TUI disconnect (TTL cleanup)", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100400, {
      serverId: 70,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    adapter.retireConnectionState(1);
    expect(adapter.serverRequestToProxy.has(100400)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("app-server close clears all server request state", () => {
    const adapter = createAdapter();

    adapter.serverRequestToProxy.set(100401, {
      serverId: 71,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });
    adapter.pendingServerRequests = [
      { raw: "{}", serverId: 72, method: "item/fileChange/requestApproval" },
    ];

    adapter.clearResponseTrackingState();
    adapter.activeTurnIds.clear();
    adapter.turnInProgress = false;

    expect(adapter.serverRequestToProxy.size).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(0);
  });

  test("server request and client request share nextProxyId without collision", () => {
    const adapter = createAdapter();
    const sent: string[] = [];
    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;
    adapter.tuiConnId = 1;
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 80,
      method: "item/permissions/requestApproval",
      params: {},
    }));

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({
      id: "client-1",
      method: "thread/start",
      params: {},
    }));

    const serverProxyId = JSON.parse(sent[0]).id;
    const clientMapping = [...adapter.upstreamToClient.entries()];
    expect(clientMapping.length).toBe(1);
    expect(clientMapping[0][0]).not.toBe(serverProxyId);

    adapter.clearResponseTrackingState();
  });
});
