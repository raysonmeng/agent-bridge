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
});
