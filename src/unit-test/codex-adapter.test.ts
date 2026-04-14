import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "../codex-adapter";

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
      raw: JSON.stringify({
        id: 88,
        method: "item/permissions/requestApproval",
        params: { permission: "network" },
      }),
      serverId: 88,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100600, result: { approved: true } }));

    expect(adapter.serverRequestToProxy.has(100600)).toBe(false);
    expect(adapter.pendingServerResponses.has(100600)).toBe(true);

    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.flushPendingServerResponses();

    expect(appSent).toEqual([
      JSON.stringify({ id: 88, result: { approved: true } }),
    ]);
    expect(adapter.pendingServerResponses.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("approval response send failure is buffered for retry", () => {
    const adapter = createAdapter();
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => { throw new Error("broken"); } } as any;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100500, {
      raw: JSON.stringify({
        id: 99,
        method: "item/permissions/requestApproval",
        params: { permission: "network" },
      }),
      serverId: 99,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100500, result: { approved: true } }));

    expect(adapter.serverRequestToProxy.has(100500)).toBe(false);
    expect(adapter.pendingServerResponses.has(100500)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("defers buffered server request replay until thread/resume", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({ id: 50, method: "item/fileChange/requestApproval", params: { threadId: "thread-A", file: "test.ts" } }),
        serverId: 50,
        method: "item/fileChange/requestApproval",
        threadId: "thread-A",
      },
    ];

    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    // Nothing should be replayed until the TUI completes thread/resume
    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(sent.length).toBe(0);

    // Simulate thread/resume request tracking + response
    adapter.trackPendingRequest({ id: 1, method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 1, result: { thread: { id: "thread-A" } } },
      adapter.tuiConnId,
    );

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.method).toBe("item/fileChange/requestApproval");
    expect(parsed.params).toMatchObject({ file: "test.ts" });
    expect(parsed.id).not.toBe(50);
    expect(adapter.serverRequestToProxy.size).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("drops orphan pending request on thread/resume to a different thread", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({ id: 51, method: "item/commandExecution/requestApproval", params: { threadId: "thread-A", command: "ls" } }),
        serverId: 51,
        method: "item/commandExecution/requestApproval",
        threadId: "thread-A",
      },
    ];

    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    // Resume to a DIFFERENT thread (thread-B)
    adapter.trackPendingRequest({ id: 2, method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 2, result: { thread: { id: "thread-B" } } },
      adapter.tuiConnId,
    );

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(0);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("drops pending requests on thread/start (new session)", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({ id: 52, method: "item/commandExecution/requestApproval", params: { threadId: "thread-A", command: "ls" } }),
        serverId: 52,
        method: "item/commandExecution/requestApproval",
        threadId: "thread-A",
      },
    ];

    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    // User starts a new session
    adapter.trackPendingRequest({ id: 3, method: "thread/start" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 3, result: { thread: { id: "thread-NEW" } } },
      adapter.tuiConnId,
    );

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(0);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("fallback: entry without threadId is replayed on any thread/resume", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({ id: 53, method: "item/permissions/requestApproval", params: {} }),
        serverId: 53,
        method: "item/permissions/requestApproval",
        threadId: null,
      },
    ];

    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    adapter.trackPendingRequest({ id: 4, method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 4, result: { thread: { id: "thread-X" } } },
      adapter.tuiConnId,
    );

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("replay send failure: no phantom mapping, request stays buffered", () => {
    const adapter = createAdapter();

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({ id: 60, method: "item/permissions/requestApproval", params: { threadId: "thread-A" } }),
        serverId: 60,
        method: "item/permissions/requestApproval",
        threadId: "thread-A",
      },
    ];

    const ws = { data: { connId: 0 }, send: () => { throw new Error("connection reset"); } } as any;
    adapter.onTuiConnect(ws);

    // Trigger replay via thread/resume to matching thread — send throws,
    // but the entry must stay buffered and no phantom mapping created
    adapter.trackPendingRequest({ id: 5, method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 5, result: { thread: { id: "thread-A" } } },
      adapter.tuiConnId,
    );

    expect(adapter.serverRequestToProxy.size).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("requeues in-flight server requests on TUI disconnect and replays them after thread/resume", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;
    const raw = JSON.stringify({
      id: 70,
      method: "item/permissions/requestApproval",
      params: { threadId: "thread-A", permission: "network" },
    });

    adapter.serverRequestToProxy.set(100400, {
      serverId: 70,
      connId: 1,
      method: "item/permissions/requestApproval",
      raw,
      timestamp: Date.now(),
      threadId: "thread-A",
    });

    adapter.retireConnectionState(1);
    expect(adapter.serverRequestToProxy.has(100400)).toBe(false);
    expect(adapter.pendingServerRequests).toEqual([
      {
        raw,
        serverId: 70,
        method: "item/permissions/requestApproval",
        threadId: "thread-A",
      },
    ]);

    const sent: string[] = [];
    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    // Replay is deferred until thread/resume
    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(sent.length).toBe(0);

    // Simulate TUI completing thread/resume to the matching thread
    adapter.trackPendingRequest({ id: 6, method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 6, result: { thread: { id: "thread-A" } } },
      adapter.tuiConnId,
    );

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(1);
    const replayed = JSON.parse(sent[0]);
    expect(replayed.id).not.toBe(70);
    expect(replayed.method).toBe("item/permissions/requestApproval");
    expect(adapter.serverRequestToProxy.size).toBe(1);

    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: replayed.id, result: { approved: true } }));

    expect(appSent.length).toBe(1);
    expect(JSON.parse(appSent[0]).id).toBe(70);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("new TUI connection defers replay until thread/resume after old primary disconnects", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    // Set up primary conn #1 with a pending server request
    adapter.connIdCounter = 1;
    adapter.tuiConnId = 1;
    adapter.tuiWs = { data: { connId: 1 }, send: () => {} } as any;
    adapter.serverRequestToProxy.set(100700, {
      raw: JSON.stringify({
        id: 91,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-A", file: "draft.txt" },
      }),
      serverId: 91,
      connId: 1,
      method: "item/fileChange/requestApproval",
      timestamp: Date.now(),
      threadId: "thread-A",
    });

    // Primary disconnects — retires state, moves server requests to pending
    adapter.onTuiDisconnect(adapter.tuiWs);
    expect(adapter.tuiWs).toBeNull();
    expect(adapter.pendingServerRequests.length).toBe(1);

    // New TUI opens — becomes primary but does NOT replay yet
    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    expect(sent.length).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(1);

    // TUI completes thread/resume to the same thread — triggers replay
    adapter.trackPendingRequest({ id: 7, method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: 7, result: { thread: { id: "thread-A" } } },
      adapter.tuiConnId,
    );

    expect(sent.length).toBe(1);
    const replayed = JSON.parse(sent[0]);
    expect(replayed.method).toBe("item/fileChange/requestApproval");
    expect(replayed.params).toEqual({ threadId: "thread-A", file: "draft.txt" });
    expect(replayed.id).not.toBe(91);
    expect(adapter.serverRequestToProxy.has(100700)).toBe(false);
    expect(adapter.serverRequestToProxy.size).toBe(1);
    const migrated = [...adapter.serverRequestToProxy.values()][0];
    expect(migrated.connId).toBe(adapter.tuiConnId);
    expect(migrated.serverId).toBe(91);

    adapter.clearResponseTrackingState();
  });

  test("new connection while primary alive becomes secondary (not primary)", () => {
    const adapter = createAdapter();

    // Set up primary conn #1
    adapter.connIdCounter = 1;
    adapter.tuiConnId = 1;
    const primaryWs = { data: { connId: 1 }, send: () => {} } as any;
    adapter.tuiWs = primaryWs;

    // New conn opens while primary is alive — becomes secondary
    const secondaryWs = { data: { connId: 0 }, send: () => {}, close: () => {} } as any;
    adapter.onTuiConnect(secondaryWs);

    // Primary is unchanged
    expect(adapter.tuiWs).toBe(primaryWs);
    expect(adapter.tuiConnId).toBe(1);
    // Secondary is tracked
    expect(adapter.secondaryConnections.size).toBe(1);

    // Clean up — close the secondary's app-server WS mock
    for (const sec of adapter.secondaryConnections.values()) {
      if (sec.appServerWs) sec.appServerWs.close();
    }
    adapter.secondaryConnections.clear();
    adapter.clearResponseTrackingState();
  });

  test("app-server close discards approval state across reconnects", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;
    adapter.tuiConnId = 1;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 71,
      method: "item/permissions/requestApproval",
      params: { permission: "network" },
    }));

    adapter.pendingServerRequests = [
      { raw: JSON.stringify({ id: 72, method: "item/fileChange/requestApproval", params: { file: "draft.txt" } }), serverId: 72, method: "item/fileChange/requestApproval" },
    ];
    adapter.pendingServerResponses.set(100402, {
      raw: JSON.stringify({ id: 73, result: { approved: true } }),
      serverId: 73,
      method: "item/commandExecution/requestApproval",
      timestamp: Date.now(),
    });

    expect(adapter.serverRequestToProxy.size).toBe(1);
    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(adapter.pendingServerResponses.size).toBe(1);

    adapter.handleAppServerClose();

    expect(adapter.serverRequestToProxy.size).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(adapter.pendingServerResponses.size).toBe(0);
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

describe("CodexAdapter initialize reconnect", () => {
  test("initialize triggers buffering and reconnect — replayed messages get fresh id mappings", async () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.tuiConnId = 1;
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;

    // Mock connectToAppServer to simulate a successful reconnect
    const newAppSent: string[] = [];
    adapter.connectToAppServer = async () => {
      adapter.appServerWs = {
        readyState: WebSocket.OPEN,
        send: (data: string) => newAppSent.push(data),
      } as any;
    };

    const ws = { data: { connId: 1 } } as any;

    // Send initialize — should be buffered, NOT forwarded to old app-server
    adapter.onTuiMessage(ws, JSON.stringify({
      id: 1,
      method: "initialize",
      params: {},
    }));

    expect(adapter.reconnectingForNewSession).toBe(true);
    expect(appSent).toEqual([]); // NOT sent to old connection

    // Send a follow-up message while reconnecting — should also be buffered
    adapter.onTuiMessage(ws, JSON.stringify({
      id: 2,
      method: "initialized",
    }));

    expect(adapter.pendingTuiMessages.length).toBe(2);

    // Wait for reconnect to complete (async)
    await new Promise((resolve) => setTimeout(resolve, 10));

    // After reconnect, messages should be replayed on the new connection
    expect(adapter.reconnectingForNewSession).toBe(false);
    expect(newAppSent.length).toBe(2);

    // Verify the initialize message was rewritten with a proxy id
    const initMsg = JSON.parse(newAppSent[0]);
    expect(initMsg.method).toBe("initialize");
    expect(initMsg.id).not.toBe(1); // rewritten to proxy id

    // Verify the mapping exists for the new proxy id
    const mapping = adapter.upstreamToClient.get(initMsg.id);
    expect(mapping).toBeDefined();
    expect(mapping.clientId).toBe(1);
    expect(mapping.connId).toBe(1);

    // Simulate app-server responding to initialize
    const tuiForwarded: string[] = [];
    adapter.tuiWs = { send: (data: string) => tuiForwarded.push(data) } as any;

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: initMsg.id,
      result: { userAgent: "codex/1.0", platformFamily: "unix", platformOs: "macos" },
    }));

    expect(forwarded).not.toBeNull();
    const response = JSON.parse(forwarded);
    expect(response.id).toBe(1); // mapped back to client's original id
    expect(response.result.userAgent).toBe("codex/1.0");

    adapter.clearResponseTrackingState();
  });

  test("TUI disconnect during reconnect clears pending buffer", () => {
    const adapter = createAdapter();
    adapter.reconnectingForNewSession = true;
    adapter.pendingTuiMessages = ["msg1", "msg2"];

    const ws = { data: { connId: 1 } } as any;
    adapter.tuiWs = ws;
    adapter.tuiConnId = 1;

    adapter.onTuiDisconnect(ws);

    expect(adapter.reconnectingForNewSession).toBe(false);
    expect(adapter.pendingTuiMessages).toEqual([]);
  });

  test("threadId is reset on TUI connect to prevent premature injection", () => {
    const adapter = createAdapter();
    adapter.threadId = "old-thread";
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;

    const ws = { data: { connId: 0 } } as any;
    adapter.onTuiConnect(ws);

    expect(adapter.threadId).toBeNull();
    expect(adapter.injectMessage("hello")).toBe(false);
  });
});
