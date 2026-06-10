import { describe, expect, test } from "bun:test";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, Socket, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../codex-adapter";

// Hermetic log sink: the constructor's default logFile resolves the REAL pair
// state dir — these tests were appending into (and could rotate!) a live
// daemon's agentbridge.log, corrupting incident forensics.
const TEST_LOG_FILE = join(mkdtempSync(join(tmpdir(), "abg-codex-adapter-test-")), "test.log");

function createAdapter() {
  return new CodexAdapter(4510, 4511, TEST_LOG_FILE) as any;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTurnWatchdogMs<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENTBRIDGE_TURN_WATCHDOG_MS;
  process.env.AGENTBRIDGE_TURN_WATCHDOG_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTBRIDGE_TURN_WATCHDOG_MS;
    } else {
      process.env.AGENTBRIDGE_TURN_WATCHDOG_MS = previous;
    }
  }
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

  test("swallows bridge-originated error responses instead of forwarding them to the TUI, and emits turnAborted", () => {
    // A-1 regression: an injected turn/start rejected by Codex BEFORE any
    // turn/started fires no wasInProgress-gated reset, which would strand the
    // daemon's require_reply tracker. The adapter must emit turnAborted here so
    // the daemon clears it.
    const adapter = createAdapter();
    const intercepted: Array<{ message: any; connId?: number }> = [];
    adapter.interceptServerMessage = (message: any, connId?: number) => intercepted.push({ message, connId });
    const aborts: string[] = [];
    adapter.on("turnAborted", (reason: string) => aborts.push(reason));

    adapter.trackBridgeRequestId(-2);

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: -2,
      error: { message: "turn/start rejected" },
    }));

    expect(forwarded).toBeNull();
    expect(adapter.bridgeRequestIds.has(-2)).toBe(false);
    expect(intercepted).toEqual([]);
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toContain("turn/start rejected");

    adapter.clearResponseTrackingState();
  });

  test("a successful bridge-originated response does not emit turnAborted", () => {
    const adapter = createAdapter();
    const aborts: string[] = [];
    adapter.on("turnAborted", (reason: string) => aborts.push(reason));

    adapter.trackBridgeRequestId(-3);
    adapter.handleAppServerPayload(JSON.stringify({ id: -3, result: {} }));

    expect(aborts).toEqual([]);
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

  test("resetTurnState emits turnAborted (not turnCompleted) when a turn is interrupted", () => {
    // RB-1 regression: an app-server close / reconnect / stop resets turn state
    // with emitCompleted=false. The daemon's require_reply tracker only resets on
    // turnCompleted, so the adapter must emit turnAborted on these paths to keep
    // the tracker from being stranded onto a later, unrelated turn.
    const adapter = createAdapter();
    const events: string[] = [];
    adapter.on("turnCompleted", () => events.push("completed"));
    adapter.on("turnAborted", (reason: string) => events.push(`aborted:${reason}`));

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    expect(adapter.turnInProgress).toBe(true);

    adapter.resetTurnState("app-server connection closed", false);

    expect(adapter.turnInProgress).toBe(false);
    expect(events).toEqual(["aborted:app-server connection closed"]);
  });

  test("resetTurnState with emitCompleted=true emits turnCompleted, not turnAborted", () => {
    const adapter = createAdapter();
    const events: string[] = [];
    adapter.on("turnCompleted", () => events.push("completed"));
    adapter.on("turnAborted", () => events.push("aborted"));

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    adapter.resetTurnState("explicit completion", true);

    expect(events).toEqual(["completed"]);
  });

  test("resetTurnState emits nothing when no turn was in progress", () => {
    const adapter = createAdapter();
    const events: string[] = [];
    adapter.on("turnCompleted", () => events.push("completed"));
    adapter.on("turnAborted", () => events.push("aborted"));

    adapter.resetTurnState("idle reset", false);

    expect(events).toEqual([]);
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

  test("stale turn/start response does not overwrite a newer active thread", () => {
    const adapter = createAdapter();
    adapter.threadId = "thread-new";
    adapter.tuiConnId = 1;

    adapter.trackPendingRequest({
      id: "old-turn",
      method: "turn/start",
      params: {
        threadId: "thread-old",
        input: [{ type: "text", text: "stale" }],
      },
    }, adapter.tuiConnId);

    adapter.handleTrackedResponse(
      { id: "old-turn", result: { turn: { id: "turn-old" } } },
      adapter.tuiConnId,
    );

    expect(adapter.activeThreadId).toBe("thread-new");

    adapter.clearResponseTrackingState();
  });

  test("stale thread switch response does not overwrite latest thread or replay buffered requests", () => {
    const adapter = createAdapter();
    const sent: string[] = [];
    adapter.tuiConnId = 1;
    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;

    adapter.trackPendingRequest({ id: "old-resume", method: "thread/resume" }, adapter.tuiConnId);
    adapter.trackPendingRequest({ id: "new-resume", method: "thread/resume" }, adapter.tuiConnId);

    adapter.handleTrackedResponse(
      { id: "new-resume", result: { thread: { id: "thread-new" } } },
      adapter.tuiConnId,
    );
    expect(adapter.activeThreadId).toBe("thread-new");

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({
          id: 70,
          method: "item/fileChange/requestApproval",
          params: { threadId: "thread-old", file: "stale.ts" },
        }),
        serverId: 70,
        method: "item/fileChange/requestApproval",
        threadId: "thread-old",
      },
    ];

    adapter.handleTrackedResponse(
      { id: "old-resume", result: { thread: { id: "thread-old" } } },
      adapter.tuiConnId,
    );

    expect(adapter.activeThreadId).toBe("thread-new");
    expect(sent).toEqual([]);
    expect(adapter.pendingServerRequests).toHaveLength(1);
    expect(adapter.pendingServerRequests[0].threadId).toBe("thread-old");

    adapter.clearResponseTrackingState();
  });

  test("stale thread/start response does not drop buffered requests for the latest session", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;

    adapter.trackPendingRequest({ id: "old-start", method: "thread/start" }, adapter.tuiConnId);
    adapter.trackPendingRequest({ id: "new-resume", method: "thread/resume" }, adapter.tuiConnId);

    adapter.handleTrackedResponse(
      { id: "new-resume", result: { thread: { id: "thread-new" } } },
      adapter.tuiConnId,
    );

    adapter.pendingServerRequests = [
      {
        raw: JSON.stringify({
          id: 71,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-new", command: "pwd" },
        }),
        serverId: 71,
        method: "item/commandExecution/requestApproval",
        threadId: "thread-new",
      },
    ];

    adapter.handleTrackedResponse(
      { id: "old-start", result: { thread: { id: "thread-old" } } },
      adapter.tuiConnId,
    );

    expect(adapter.activeThreadId).toBe("thread-new");
    expect(adapter.pendingServerRequests).toHaveLength(1);
    expect(adapter.pendingServerRequests[0].threadId).toBe("thread-new");

    adapter.clearResponseTrackingState();
  });

  test("turnPhase walks the v2 lifecycle: idle \u2192 running \u2192 stalled \u2192 running \u2192 idle (PR A)", async () => {
    await withTurnWatchdogMs(40, async () => {
      const adapter = createAdapter();
      const phaseEvents: string[] = [];
      adapter.on("turnPhaseChanged", (e: { phase: string; previous: string }) => phaseEvents.push(`${e.previous}>${e.phase}`));
      expect(adapter.turnPhase).toBe("idle");

      adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "phase-turn" } } });
      expect(adapter.turnPhase).toBe("running");
      expect(adapter.turnInProgress).toBe(true); // compat mapping: running|stalled

      await sleep(90); // watchdog fires \u2192 stalled (current-state, not just the notify dedup)
      expect(adapter.turnPhase).toBe("stalled");
      expect(adapter.turnInProgress).toBe(true);

      // Activity resumes \u2014 phase must honestly return to running even though
      // the at-most-once turnStalled notification dedup set keeps its entry.
      adapter.handleAppServerPayload(
        JSON.stringify({ jsonrpc: "2.0", method: "item/agentReasoning/delta", params: {} }),
        1,
      );
      expect(adapter.turnPhase).toBe("running");

      adapter.handleServerNotification({ method: "turn/completed", params: { turn: { id: "phase-turn" } } });
      expect(adapter.turnPhase).toBe("idle");
      expect(adapter.turnInProgress).toBe(false);

      // The unified event fired on EVERY transition — including the
      // stalled→running resume that has no dedicated event of its own. The
      // daemon's status persistence subscribes to exactly this.
      expect(phaseEvents).toEqual(["idle>running", "running>stalled", "stalled>running", "running>idle"]);

      adapter.clearResponseTrackingState();
    });
  });

  test("turnPhase reports aborted after an abnormal end, until the next turn starts (PR A)", async () => {
    const adapter = createAdapter();
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "abort-turn" } } });
    expect(adapter.turnPhase).toBe("running");

    (adapter as any).resetTurnState("test app-server close");
    expect(adapter.turnPhase).toBe("aborted");
    expect(adapter.turnInProgress).toBe(false); // compat: aborted maps to false

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "next-turn" } } });
    expect(adapter.turnPhase).toBe("running");

    // A NORMAL completion must clear the aborted memory too.
    adapter.handleServerNotification({ method: "turn/completed", params: { turn: { id: "next-turn" } } });
    expect(adapter.turnPhase).toBe("idle");

    adapter.clearResponseTrackingState();
  });

  test("turn watchdog marks stalled but does not fake turnCompleted after inactivity", async () => {
    await withTurnWatchdogMs(40, async () => {
      const adapter = createAdapter();
      const events: string[] = [];
      const stalled: Array<{ turnId: string; inactivityMs: number }> = [];
      adapter.on("turnCompleted", () => events.push("completed"));
      adapter.on("turnStalled", (event: { turnId: string; inactivityMs: number }) => stalled.push(event));

      adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "watchdog-turn" } } });
      expect(adapter.turnInProgress).toBe(true);

      await sleep(90);

      expect(adapter.turnInProgress).toBe(true);
      expect(adapter.activeTurnIds.has("watchdog-turn")).toBe(true);
      expect(events).toEqual([]);
      expect(stalled).toEqual([{ turnId: "watchdog-turn", inactivityMs: 40 }]);

      adapter.clearResponseTrackingState();
    });
  });

  test("turn watchdog is refreshed by ANY inbound app-server message, incl. unforwarded notification types (#69)", async () => {
    // Regression guard for the #69 watchdog-coverage bug: Codex streams many
    // notification types the bridge does NOT forward (item/agentReasoning/delta,
    // item/commandExecution/*, item/fileChange/*, …). A long but actively-
    // streaming turn (e.g. a multi-minute build) emits only these between
    // turn/started and turn/completed. The watchdog must treat them as activity,
    // otherwise a live turn gets force-completed. We drive them through the real
    // handleAppServerPayload funnel (NOT handleServerNotification, which only
    // models the small forwarded subset and would mask the bug).
    //
    // Timing is chosen so the test actually CATCHES the bug, not just passes,
    // with margins wide enough to be CI-safe (this repo has a history of timing
    // flakes — see commit 11941e6):
    // - 400ms watchdog, armed at turn/started (t≈0), original deadline t≈400.
    // - refresh via the unforwarded delta at t≈250 (≈150ms before the original
    //   deadline) pushes the deadline to t≈650.
    // - "still active" is asserted at t≈500 — PAST the original t≈400 deadline
    //   (so WITHOUT the fix the watchdog would already have marked stalled and
    //   this assertion fails) and ≈150ms before the refreshed t≈650 deadline.
    // - "stalled" is asserted at t≈750 (≈100ms past t≈650).
    await withTurnWatchdogMs(400, async () => {
      const adapter = createAdapter();
      const events: string[] = [];
      const stalled: unknown[] = [];
      adapter.on("turnCompleted", () => events.push("completed"));
      adapter.on("turnStalled", (event: unknown) => stalled.push(event));

      adapter.handleAppServerPayload(JSON.stringify({
        method: "turn/started",
        params: { turn: { id: "refresh-turn" } },
      }));
      expect(adapter.turnInProgress).toBe(true);

      await sleep(250);
      // An UNFORWARDED notification type — the exact case that previously did
      // NOT refresh the watchdog (only the 5 isAppServerNotification() methods
      // did), so a live turn streaming only reasoning deltas got force-completed.
      adapter.handleAppServerPayload(JSON.stringify({
        method: "item/agentReasoning/delta",
        params: { itemId: "reasoning-1", delta: "thinking…" },
      }));
      await sleep(250);

      // Past the ORIGINAL deadline but before the refreshed one — still active.
      expect(adapter.turnInProgress).toBe(true);
      expect(events).toEqual([]);
      expect(stalled).toEqual([]);

      await sleep(250);

      expect(adapter.turnInProgress).toBe(true);
      expect(events).toEqual([]);
      expect(stalled).toHaveLength(1);

      adapter.clearResponseTrackingState();
    });
  });

  test("disconnect() synchronously clears turn state and cancels the watchdog (no late turnCompleted)", async () => {
    await withTurnWatchdogMs(40, async () => {
      const adapter = createAdapter();
      const events: string[] = [];
      adapter.on("turnCompleted", () => events.push("completed"));

      adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "disconnect-turn" } } });
      expect(adapter.turnInProgress).toBe(true);
      expect(adapter.activeTurnIds.size).toBe(1);
      expect(adapter.turnWatchdogs.size).toBe(1);

      // Intentional teardown must drop turn state + watchdog timer immediately.
      adapter.disconnect();

      expect(adapter.turnInProgress).toBe(false);
      expect(adapter.activeTurnIds.size).toBe(0);
      expect(adapter.turnWatchdogs.size).toBe(0);
      // A teardown is not a real turn completion — it must not signal "finished".
      expect(events).toEqual([]);

      // And the cancelled watchdog must not fire a late turnCompleted.
      await sleep(90);
      expect(events).toEqual([]);

      adapter.clearResponseTrackingState();
    });
  });

  test("stalled turns keep busy state and never emit completion", () => {
    const adapter = createAdapter();
    const events: string[] = [];
    const stalled: string[] = [];
    adapter.on("turnCompleted", () => events.push("completed"));
    adapter.on("turnStalled", (event: { turnId: string }) => stalled.push(event.turnId));

    // Two concurrent turns (driven via handleServerNotification so only their
    // own watchdogs arm — no global refresh between them).
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t2" } } });
    expect(adapter.activeTurnIds.size).toBe(2);
    expect(adapter.turnInProgress).toBe(true);

    adapter.markTurnStalled("t1");
    expect(adapter.activeTurnIds.has("t1")).toBe(true);
    expect(adapter.turnInProgress).toBe(true);
    expect(events).toEqual([]);
    expect(stalled).toEqual(["t1"]);

    adapter.markTurnStalled("t2");
    expect(adapter.activeTurnIds.has("t2")).toBe(true);
    expect(adapter.turnInProgress).toBe(true);
    expect(events).toEqual([]);
    expect(stalled).toEqual(["t1", "t2"]);

    adapter.clearResponseTrackingState();
  });

  test("turnStalled is emitted at most once per turn but re-arms for a new turn", () => {
    const adapter = createAdapter();
    const events: string[] = [];
    const stalled: string[] = [];
    adapter.on("turnCompleted", () => events.push("completed"));
    adapter.on("turnStalled", (event: { turnId: string }) => stalled.push(event.turnId));

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    expect(adapter.turnInProgress).toBe(true);

    // First stall notifies; the watchdog is intentionally kept armed (turn stays
    // busy), so a later expiry re-invokes markTurnStalled for the SAME turn — but
    // that must NOT emit a duplicate notification.
    adapter.markTurnStalled("t1");
    adapter.markTurnStalled("t1");
    expect(stalled).toEqual(["t1"]);
    // Busy semantics unchanged: still in progress, never force-completed.
    expect(adapter.turnInProgress).toBe(true);
    expect(adapter.activeTurnIds.has("t1")).toBe(true);
    expect(events).toEqual([]);

    // A genuinely new turn must be eligible to notify on its own stall.
    adapter.handleServerNotification({ method: "turn/completed", params: { turn: { id: "t1" } } });
    expect(adapter.turnInProgress).toBe(false);
    expect(events).toEqual(["completed"]);

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t2" } } });
    adapter.markTurnStalled("t2");
    adapter.markTurnStalled("t2");
    expect(stalled).toEqual(["t1", "t2"]);
    expect(adapter.turnInProgress).toBe(true);
    expect(events).toEqual(["completed"]);

    adapter.clearResponseTrackingState();
  });

  test("turnStalled re-arms when the SAME turnId is reused by a fresh turn/started", () => {
    // Real ids can repeat across reconnects: a new turn/started for an id that
    // previously stalled must clear the suppression so the new turn can notify.
    const adapter = createAdapter();
    const stalled: string[] = [];
    adapter.on("turnStalled", (event: { turnId: string }) => stalled.push(event.turnId));

    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "reused" } } });
    adapter.markTurnStalled("reused");
    adapter.markTurnStalled("reused");
    expect(stalled).toEqual(["reused"]);

    // Same id starts a fresh turn — suppression must reset.
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "reused" } } });
    adapter.markTurnStalled("reused");
    expect(stalled).toEqual(["reused", "reused"]);

    adapter.clearResponseTrackingState();
  });

  test("a normal turn/completed cancels the watchdog so it never force-completes later", async () => {
    await withTurnWatchdogMs(40, async () => {
      const adapter = createAdapter();
      const events: string[] = [];
      adapter.on("turnCompleted", () => events.push("completed"));

      adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
      expect(adapter.turnWatchdogs.size).toBe(1);

      adapter.handleServerNotification({ method: "turn/completed", params: { turn: { id: "t1" } } });
      expect(adapter.turnInProgress).toBe(false);
      expect(adapter.turnWatchdogs.size).toBe(0);
      expect(events).toEqual(["completed"]);

      // The watchdog was cleared on normal completion — no SECOND (force) emit.
      await sleep(90);
      expect(events).toEqual(["completed"]);

      adapter.clearResponseTrackingState();
    });
  });

  test("handleAppServerClose cancels turn watchdogs (no late force-completion after close)", async () => {
    await withTurnWatchdogMs(40, async () => {
      const adapter = createAdapter();
      const events: string[] = [];
      adapter.on("turnCompleted", () => events.push("completed"));

      adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
      expect(adapter.turnWatchdogs.size).toBe(1);

      // An app-server close routes through resetTurnState → clears ids + timers.
      // (intentional avoids scheduleReconnect firing during the test.)
      adapter.intentionalDisconnect = true;
      adapter.handleAppServerClose();
      expect(adapter.turnInProgress).toBe(false);
      expect(adapter.activeTurnIds.size).toBe(0);
      expect(adapter.turnWatchdogs.size).toBe(0);

      // The cancelled watchdog must never force-complete after the connection closed.
      await sleep(90);
      expect(events).toEqual([]);

      adapter.clearResponseTrackingState();
    });
  });

  test("an inbound RESPONSE (not only a notification) refreshes the watchdog", async () => {
    // The refresh sits ABOVE the id/notification branching in handleAppServerPayload,
    // so responses count as turn activity too. Same robust margins as the
    // notification-refresh test: 400ms watchdog, refresh at t≈250 (deadline→650),
    // assert-active at t≈500 (past the original 400 deadline, before the refreshed one).
    await withTurnWatchdogMs(400, async () => {
      const adapter = createAdapter();

      adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
      await sleep(250);
      adapter.handleAppServerPayload(JSON.stringify({ id: 987654, result: { ok: true } }));
      await sleep(250);

      expect(adapter.turnInProgress).toBe(true);

      adapter.resetTurnState("test cleanup");
      adapter.clearResponseTrackingState();
    });
  });

  test("turnWatchdogMs() falls back to the 300s default for unset/invalid env values", () => {
    const adapter = createAdapter();
    const prev = process.env.AGENTBRIDGE_TURN_WATCHDOG_MS;
    try {
      // "" / whitespace → 0, "0"/negative → not > 0, non-numeric → NaN,
      // "Infinity" → !isFinite. All must fall back to the 300s default.
      for (const bad of ["", "   ", "0", "-5", "abc", "Infinity", "NaN"]) {
        process.env.AGENTBRIDGE_TURN_WATCHDOG_MS = bad;
        expect(adapter.turnWatchdogMs()).toBe(300_000);
      }
      delete process.env.AGENTBRIDGE_TURN_WATCHDOG_MS;
      expect(adapter.turnWatchdogMs()).toBe(300_000);
      // A valid positive value is honored.
      process.env.AGENTBRIDGE_TURN_WATCHDOG_MS = "1234";
      expect(adapter.turnWatchdogMs()).toBe(1234);
    } finally {
      if (prev === undefined) delete process.env.AGENTBRIDGE_TURN_WATCHDOG_MS;
      else process.env.AGENTBRIDGE_TURN_WATCHDOG_MS = prev;
    }
  });

  test("an error response to the LATEST thread switch leaves activeThreadId unchanged", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;

    // Establish a current thread via a successful resume.
    adapter.trackPendingRequest({ id: "r1", method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse({ id: "r1", result: { thread: { id: "thread-A" } } }, adapter.tuiConnId);
    expect(adapter.activeThreadId).toBe("thread-A");

    // The newest switch fails. The error carries a thread id too (a malformed
    // server could) — handleTrackedResponse must return early on `error` BEFORE
    // the switch, so this thread-B is never adopted and the active thread stays
    // the last one that actually resolved. (Including result.thread.id here is
    // what makes this a genuine guard for the error early-return: drop that
    // early-return and the switch would adopt thread-B, failing this test.)
    adapter.trackPendingRequest({ id: "r2", method: "thread/resume" }, adapter.tuiConnId);
    adapter.handleTrackedResponse(
      { id: "r2", error: { code: -1, message: "boom" }, result: { thread: { id: "thread-B" } } },
      adapter.tuiConnId,
    );
    expect(adapter.activeThreadId).toBe("thread-A");

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

  test("secondary picker connection replays cached initialization before first non-initialize request", async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("test app-server");
      },
      websocket: {
        message(_ws, raw) {
          received.push(typeof raw === "string" ? raw : raw.toString());
        },
      },
    });

    const adapter = new CodexAdapter(server.port, 4511, TEST_LOG_FILE) as any;
    adapter.log = () => {};
    adapter.connIdCounter = 1;
    adapter.tuiConnId = 1;
    adapter.tuiWs = { data: { connId: 1 }, send: () => {} } as any;
    adapter.lastInitializeRaw = JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: { clientInfo: { name: "codex-tui" } },
    });
    adapter.lastInitializedRaw = JSON.stringify({ method: "initialized" });

    const secondaryWs = { data: { connId: 0 }, send: () => {}, close: () => {} } as any;
    try {
      adapter.onTuiConnect(secondaryWs);
      adapter.onTuiMessage(secondaryWs, JSON.stringify({
        id: 2,
        method: "thread/list",
        params: { limit: 25 },
      }));

      for (let i = 0; i < 40 && received.length < 3; i++) {
        await sleep(25);
      }

      expect(received.map((raw) => JSON.parse(raw).method)).toEqual([
        "initialize",
        "initialized",
        "thread/list",
      ]);
    } finally {
      for (const sec of adapter.secondaryConnections.values()) {
        try { sec.appServerWs?.close(); } catch {}
      }
      adapter.secondaryConnections.clear();
      server.stop(true);
      adapter.clearResponseTrackingState();
    }
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

describe("CodexAdapter port precheck — LISTEN-only filter", () => {
  function runLsof(args: string): string[] {
    try {
      return execSync(`lsof ${args}`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  test("buildPortListenLsofCommand restricts to LISTEN sockets", () => {
    expect(CodexAdapter.buildPortListenLsofCommand(4501)).toBe(
      "lsof -ti tcp:4501 -sTCP:LISTEN",
    );
  });

  test("LISTEN filter ignores stale outbound FDs after listener dies", async () => {
    // Use port 0 so the OS picks a guaranteed-free port — random 40000-50000
    // can collide on shared CI runners, causing s.listen() to error.
    const server: Server = await new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;

    const client: Socket = await new Promise((resolve, reject) => {
      const c = new Socket();
      c.once("error", reject);
      c.connect(port, "127.0.0.1", () => resolve(c));
    });

    try {
      // Sanity check: while listener is alive, LISTEN filter finds this process.
      const withListener = runLsof(CodexAdapter.buildPortListenLsofCommand(port).slice(5));
      expect(withListener).toContain(String(process.pid));

      // Stop accepting new connections. We intentionally do NOT await the
      // close callback — that callback only fires when ALL existing
      // connections drain, but the whole point of this test is to keep the
      // client connection open so a stale outbound FD lingers. The listener
      // itself is released synchronously; setImmediate yields once so the
      // close syscall lands before we run lsof. (Previously we awaited the
      // callback, which hung forever on Bun/Linux and passed only by event-
      // loop accident on Bun/macOS.)
      server.close();
      await new Promise((r) => setImmediate(r));

      // OLD impl `lsof -ti :PORT` (no LISTEN filter) would still find this process
      // via the lingering outbound FD — the false positive that broke `abg claude`.
      // NEW impl correctly returns no PIDs because nothing is LISTENING anymore.
      const afterClose = runLsof(CodexAdapter.buildPortListenLsofCommand(port).slice(5));
      expect(afterClose).toEqual([]);
    } finally {
      client.destroy();
      if (server.listening) server.close();
    }
  });
});

describe("CodexAdapter TUI outage recovery", () => {
  type FakeSocket = {
    data: { connId: number };
    closed: Array<{ code: number; reason: string }>;
    sent: string[];
    close: (code: number, reason: string) => void;
    send: (data: string) => void;
  };

  function makeFakeSocket(connId: number): FakeSocket {
    const closed: Array<{ code: number; reason: string }> = [];
    const sent: string[] = [];
    return {
      data: { connId },
      closed,
      sent,
      close(code: number, reason: string) {
        closed.push({ code, reason });
      },
      send(data: string) {
        sent.push(data);
      },
    };
  }

  function setupAdapterWithTui(connId = 1) {
    const adapter = createAdapter();
    const logs: string[] = [];
    adapter.log = (msg: string) => logs.push(msg);
    const ws = makeFakeSocket(connId);
    adapter.tuiConnId = connId;
    adapter.tuiWs = ws;
    adapter.appServerWs = null;
    return { adapter, ws, logs };
  }

  test("buffers TUI message when app-server is not connected (does not close)", () => {
    const { adapter, ws, logs } = setupAdapterWithTui();

    adapter.onTuiMessage(ws, JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "test",
      params: {},
    }));

    expect(ws.closed.length).toBe(0);
    expect(adapter.outageQueue.length).toBe(1);
    expect(adapter.outageTimer).not.toBeNull();
    expect(logs.some((l) => l.startsWith("DIAGNOSTIC: buffered TUI message"))).toBe(true);

    // Cleanup timer to not leak into other tests.
    clearTimeout(adapter.outageTimer);
    adapter.outageTimer = null;
  });

  test("overflows with 1011 when queue fills past OUTAGE_QUEUE_MAX", () => {
    const { adapter, ws, logs } = setupAdapterWithTui();
    const max = (adapter.constructor as any).OUTAGE_QUEUE_MAX;
    expect(typeof max).toBe("number");

    // Fill to capacity.
    for (let i = 0; i < max; i++) {
      adapter.onTuiMessage(ws, JSON.stringify({ jsonrpc: "2.0", id: i, method: "m", params: {} }));
    }
    expect(adapter.outageQueue.length).toBe(max);
    expect(ws.closed.length).toBe(0);

    // One more triggers overflow and close.
    adapter.onTuiMessage(ws, JSON.stringify({ jsonrpc: "2.0", id: max, method: "m", params: {} }));

    expect(ws.closed.length).toBe(1);
    expect(ws.closed[0].code).toBe(1011);
    expect(ws.closed[0].reason).toMatch(/queue overflow/);
    expect(adapter.outageQueue.length).toBe(0);
    expect(adapter.outageTimer).toBeNull();
    expect(logs.some((l) => l.includes("outage queue overflow"))).toBe(true);
  });

  test("drains queued messages in order when app-server reconnects (notifications)", () => {
    const { adapter, ws } = setupAdapterWithTui();
    // Notifications (no id) don't trigger id-rewriting, so we can compare
    // raw bytes exactly. The key property under test is order + count.
    adapter.outageQueue = [
      { raw: '{"jsonrpc":"2.0","method":"a"}', connId: 1 },
      { raw: '{"jsonrpc":"2.0","method":"b"}', connId: 1 },
      { raw: '{"jsonrpc":"2.0","method":"c"}', connId: 1 },
    ];
    adapter.outageTimer = setTimeout(() => {}, 60_000);

    const sent: string[] = [];
    adapter.appServerWs = {
      readyState: 1 /* WebSocket.OPEN */,
      send: (data: string) => sent.push(data),
    };

    adapter.drainOutageQueue();

    expect(sent).toEqual([
      '{"jsonrpc":"2.0","method":"a"}',
      '{"jsonrpc":"2.0","method":"b"}',
      '{"jsonrpc":"2.0","method":"c"}',
    ]);
    expect(adapter.outageQueue.length).toBe(0);
    expect(adapter.outageTimer).toBeNull();
    expect(ws.closed.length).toBe(0);
  });

  test("drain re-assigns fresh proxy ids for requests (no stale mapping race)", () => {
    const { adapter, ws } = setupAdapterWithTui();
    // A TUI → app-server REQUEST (has both id and method). On outage we
    // store RAW, so the replay goes through onTuiMessage's rewriting path
    // against the fresh app-server session. This prevents the race Codex
    // flagged where handleAppServerClose() would wipe upstreamToClient
    // and strand forwarded bytes pointing at a dead mapping.
    adapter.outageQueue = [
      { raw: '{"jsonrpc":"2.0","id":"client-42","method":"thread/start","params":{}}', connId: 1 },
    ];
    adapter.outageTimer = setTimeout(() => {}, 60_000);

    const sent: string[] = [];
    adapter.appServerWs = {
      readyState: 1 /* WebSocket.OPEN */,
      send: (data: string) => sent.push(data),
    };
    // Observe the upstreamToClient map before and after.
    expect(adapter.upstreamToClient.size).toBe(0);

    adapter.drainOutageQueue();

    expect(sent.length).toBe(1);
    const forwarded = JSON.parse(sent[0]);
    expect(forwarded.method).toBe("thread/start");
    expect(typeof forwarded.id).toBe("number"); // proxy id is numeric
    expect(forwarded.id).not.toBe("client-42"); // was rewritten

    // Mapping for the new proxy id was registered on the fresh session.
    expect(adapter.upstreamToClient.size).toBe(1);
    const mapping = adapter.upstreamToClient.get(forwarded.id);
    expect(mapping).toEqual({ connId: 1, clientId: "client-42" });

    expect(ws.closed.length).toBe(0);
  });

  test("closes TUI with 1011 when outage timer fires", async () => {
    const { adapter, ws, logs } = setupAdapterWithTui();
    // Shrink timeout for the test via monkey-patching the static value.
    // Capture the REAL value for restore — a hardcoded restore went stale when
    // the production constant changed, silently poisoning later tests.
    const originalOutageTimeout = (adapter.constructor as any).OUTAGE_TIMEOUT_MS;
    (adapter.constructor as any).OUTAGE_TIMEOUT_MS = 20;

    adapter.onTuiMessage(ws, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: {} }));
    expect(adapter.outageQueue.length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ws.closed.length).toBe(1);
    expect(ws.closed[0].code).toBe(1011);
    expect(ws.closed[0].reason).toMatch(/after \d+ms/);
    expect(adapter.outageQueue.length).toBe(0);
    expect(adapter.outageTimer).toBeNull();
    expect(logs.some((l) => l.includes("did not return within"))).toBe(true);

    // Restore default.
    (adapter.constructor as any).OUTAGE_TIMEOUT_MS = originalOutageTimeout;
  });

  test("drops non-primary outage sends with WARNING log (no close)", () => {
    const { adapter, logs } = setupAdapterWithTui(2);
    const stale = makeFakeSocket(1);

    adapter.onTuiMessage(stale, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params: {} }));

    // Stale connection messages are filtered earlier by the tuiConnId guard,
    // so we don't even reach the forward path. Verify nothing was buffered.
    expect(adapter.outageQueue.length).toBe(0);
    expect(adapter.outageTimer).toBeNull();
    expect(stale.closed.length).toBe(0);
    // The higher-layer "Dropping message from stale TUI conn" log fires instead.
    expect(logs.some((l) => l.includes("stale TUI"))).toBe(true);
  });
});

describe("CodexAdapter session restore after unintentional reconnect", () => {
  type FakeSocket = {
    data: { connId: number };
    closed: Array<{ code: number; reason: string }>;
    close: (code: number, reason: string) => void;
    send: (data: string) => void;
  };

  function makeFakeSocket(connId: number): FakeSocket {
    const closed: Array<{ code: number; reason: string }> = [];
    return {
      data: { connId },
      closed,
      close(code: number, reason: string) {
        closed.push({ code, reason });
      },
      send() {},
    };
  }

  function makeFakeAppServerWs() {
    const sent: string[] = [];
    return {
      readyState: 1 /* WebSocket.OPEN */,
      sent,
      send: function (data: string) {
        sent.push(data);
      },
    };
  }

  test("sendReplayAndAwait resolves when app-server responds with matching id (no error)", async () => {
    const adapter = createAdapter();
    adapter.log = () => {};

    const server = makeFakeAppServerWs();
    adapter.appServerWs = server;

    const promise = adapter.sendReplayAndAwait(
      JSON.stringify({ jsonrpc: "2.0", id: "replay-1", method: "initialize" }),
      "initialize",
    );

    // Simulate app-server response arriving via handleAppServerPayload.
    setTimeout(() => {
      const consumed = adapter.handleAppServerPayload(JSON.stringify({
        id: "replay-1",
        result: { capabilities: {} },
      }));
      // Response should have been swallowed (not forwarded to TUI).
      expect(consumed).toBeNull();
    }, 5);

    const response = await promise;
    expect(response).toEqual({ id: "replay-1", result: { capabilities: {} } });
  });

  test("sendReplayAndAwait rejects when app-server responds with error field", async () => {
    const adapter = createAdapter();
    adapter.log = () => {};

    adapter.appServerWs = makeFakeAppServerWs();

    const promise = adapter.sendReplayAndAwait(
      JSON.stringify({ jsonrpc: "2.0", id: "replay-err", method: "initialize" }),
      "initialize",
    );

    setTimeout(() => {
      adapter.handleAppServerPayload(JSON.stringify({
        id: "replay-err",
        error: { message: "already initialized" },
      }));
    }, 5);

    await expect(promise).rejects.toThrow(/initialize rejected: already initialized/);
  });

  test("sendReplayAndAwait rejects on timeout", async () => {
    const adapter = createAdapter();
    adapter.log = () => {};
    (adapter.constructor as any).SESSION_REPLAY_TIMEOUT_MS = 30;
    adapter.appServerWs = makeFakeAppServerWs();

    const promise = adapter.sendReplayAndAwait(
      JSON.stringify({ jsonrpc: "2.0", id: "replay-timeout", method: "initialize" }),
      "initialize",
    );

    await expect(promise).rejects.toThrow(/replay timeout/);
    (adapter.constructor as any).SESSION_REPLAY_TIMEOUT_MS = 5000;
  });

  test("handleSessionRestoreAfterReconnect bails when no cached initialize", async () => {
    const adapter = createAdapter();
    const logs: string[] = [];
    adapter.log = (m: string) => logs.push(m);

    adapter.appServerWs = makeFakeAppServerWs();
    adapter.lastInitializeRaw = null;

    await adapter.handleSessionRestoreAfterReconnect();

    expect(logs.some((l) => l.includes("no cached initialize"))).toBe(true);
  });

  test("handleSessionRestoreAfterReconnect closes TUI 1011 on initialize failure", async () => {
    const adapter = createAdapter();
    adapter.log = () => {};

    const ws = makeFakeSocket(1);
    adapter.tuiConnId = 1;
    adapter.tuiWs = ws;

    const server = makeFakeAppServerWs();
    adapter.appServerWs = server;

    adapter.lastInitializeRaw = JSON.stringify({
      jsonrpc: "2.0",
      id: "init-will-fail",
      method: "initialize",
      params: {},
    });

    const restorePromise = adapter.handleSessionRestoreAfterReconnect();

    // Simulate app-server rejecting the replayed initialize.
    setTimeout(() => {
      adapter.handleAppServerPayload(JSON.stringify({
        id: "init-will-fail",
        error: { message: "schema mismatch" },
      }));
    }, 5);

    await restorePromise;

    expect(ws.closed.length).toBe(1);
    expect(ws.closed[0].code).toBe(1011);
    expect(ws.closed[0].reason).toMatch(/initialize rejected: schema mismatch/);
  });

  test("handleSessionRestoreAfterReconnect sends initialize + initialized + thread/resume when happy path", async () => {
    const adapter = createAdapter();
    const logs: string[] = [];
    adapter.log = (m: string) => logs.push(m);

    const ws = makeFakeSocket(1);
    adapter.tuiConnId = 1;
    adapter.tuiWs = ws;

    const server = makeFakeAppServerWs();
    adapter.appServerWs = server;

    adapter.lastInitializeRaw = JSON.stringify({
      jsonrpc: "2.0",
      id: "replay-init",
      method: "initialize",
      params: {},
    });
    adapter.lastInitializedRaw = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
    });
    adapter.threadId = "thread-xyz";

    const restorePromise = adapter.handleSessionRestoreAfterReconnect();

    // Respond to each replayed request in order.
    await new Promise((r) => setTimeout(r, 2));
    adapter.handleAppServerPayload(JSON.stringify({
      id: "replay-init",
      result: { ok: true },
    }));

    // Give the initialize promise a chance to resolve before responding
    // to thread/resume.
    await new Promise((r) => setTimeout(r, 2));
    // The thread/resume id is generated dynamically — inspect what was
    // sent to find it.
    const resumeSent = server.sent.find((s: string) => s.includes("thread/resume"));
    expect(resumeSent).toBeDefined();
    const resumeId = JSON.parse(resumeSent!).id;
    adapter.handleAppServerPayload(JSON.stringify({
      id: resumeId,
      result: { thread: { id: "thread-xyz" } },
    }));

    await restorePromise;

    // Expected 3 sends: initialize, initialized, thread/resume.
    expect(server.sent.length).toBe(3);
    expect(JSON.parse(server.sent[0]).method).toBe("initialize");
    expect(JSON.parse(server.sent[1]).method).toBe("initialized");
    expect(JSON.parse(server.sent[2]).method).toBe("thread/resume");
    expect(JSON.parse(server.sent[2]).params).toEqual({ threadId: "thread-xyz" });

    expect(ws.closed.length).toBe(0);
    expect(logs.some((l) => l.includes("session restored"))).toBe(true);
  });

  test("onTuiMessage buffers during sessionRestoreInProgress (no leak to uninitialized session)", () => {
    const adapter = createAdapter();
    adapter.log = () => {};

    const ws = makeFakeSocket(1);
    adapter.tuiConnId = 1;
    adapter.tuiWs = ws;
    adapter.appServerWs = makeFakeAppServerWs();
    adapter.sessionRestoreInProgress = true;

    adapter.onTuiMessage(ws, JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "turn/steer",
      params: {},
    }));

    // Message should have been pushed onto the outage queue, not sent to
    // app-server, because restore was in progress.
    expect(adapter.outageQueue.length).toBe(1);
    expect(adapter.appServerWs.sent.length).toBe(0);

    // Cleanup timer to avoid leaking into other tests.
    if (adapter.outageTimer) {
      clearTimeout(adapter.outageTimer);
      adapter.outageTimer = null;
    }
  });

  test("onTuiMessage caches initialize and initialized raw payloads", () => {
    const adapter = createAdapter();
    adapter.log = () => {};

    const ws = makeFakeSocket(1);
    adapter.tuiConnId = 1;
    adapter.tuiWs = ws;
    adapter.appServerWs = makeFakeAppServerWs();

    // The `initialize` request triggers reconnectAppServerForNewSession
    // which caches the raw payload.
    const initRaw = JSON.stringify({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: { foo: "bar" },
    });
    // Stub out the reconnect to avoid real network activity.
    adapter.reconnectAppServerForNewSession = async () => {};
    adapter.onTuiMessage(ws, initRaw);
    expect(adapter.lastInitializeRaw).toBe(initRaw);

    // `initialized` notification is captured in the normal forward path.
    const initedRaw = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
    });
    adapter.reconnectingForNewSession = false;
    adapter.onTuiMessage(ws, initedRaw);
    expect(adapter.lastInitializedRaw).toBe(initedRaw);
  });
});

describe("CodexAdapter thread/closed diagnostic sniffer", () => {
  test("logs DIAGNOSTIC line when app-server emits thread/closed", () => {
    const adapter = createAdapter();
    const logs: string[] = [];
    adapter.log = (msg: string) => logs.push(msg);
    adapter.interceptServerMessage = () => {};

    adapter.handleAppServerPayload(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/closed",
      params: { threadId: "abc-123" },
    }));

    const diag = logs.filter((l) => l.startsWith("DIAGNOSTIC: app-server emitted thread/closed"));
    expect(diag.length).toBe(1);
    expect(diag[0]).toContain("threadId=abc-123");
  });

  test("handles thread/closed with missing params gracefully", () => {
    const adapter = createAdapter();
    const logs: string[] = [];
    adapter.log = (msg: string) => logs.push(msg);
    adapter.interceptServerMessage = () => {};

    adapter.handleAppServerPayload(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/closed",
    }));

    const diag = logs.filter((l) => l.startsWith("DIAGNOSTIC: app-server emitted thread/closed"));
    expect(diag.length).toBe(1);
    expect(diag[0]).toContain("threadId=unknown");
  });

  test("does not log DIAGNOSTIC for other notifications", () => {
    const adapter = createAdapter();
    const logs: string[] = [];
    adapter.log = (msg: string) => logs.push(msg);
    adapter.interceptServerMessage = () => {};

    adapter.handleAppServerPayload(JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { threadId: "abc-123" },
    }));

    const diag = logs.filter((l) => l.startsWith("DIAGNOSTIC:"));
    expect(diag.length).toBe(0);
  });
});

describe("CodexAdapter.forceKillAppServerSync", () => {
  test("synchronously SIGKILLs the retained app-server pid", async () => {
    const adapter = createAdapter();
    // Stand-in for the spawned `codex app-server` child: a real, harmless,
    // long-lived process. We assert via the `exit` event (which fires once the
    // OS delivers the signal AND the child is reaped) rather than polling
    // kill(pid,0) — the latter would see a not-yet-reaped zombie as "alive".
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore",
    });
    const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (_code, signal) => resolve({ signal }));
    });
    // Let the child come up so it has a live pid to kill.
    await sleep(100);
    expect(typeof child.pid).toBe("number");

    adapter.appServerPid = child.pid;
    adapter.forceKillAppServerSync();

    const result = await Promise.race([
      exited,
      sleep(3000).then(() => ({ signal: "TIMEOUT" as unknown as NodeJS.Signals })),
    ]);
    expect(result.signal).toBe("SIGKILL");
  });

  test("is a no-op (no throw) when no app-server pid is retained", () => {
    const adapter = createAdapter();
    adapter.appServerPid = null;
    expect(() => adapter.forceKillAppServerSync()).not.toThrow();
  });

  test("swallows ESRCH when the retained pid is already gone", () => {
    const adapter = createAdapter();
    // A pid that is overwhelmingly unlikely to exist; process.kill would throw
    // ESRCH, which forceKillAppServerSync must swallow.
    adapter.appServerPid = 2147483646;
    expect(() => adapter.forceKillAppServerSync()).not.toThrow();
  });
});

describe("CodexAdapter turn/steer (protocol v2 B0)", () => {
  function createSteerableAdapter() {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.threadId = "thread-steer";
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    return { adapter, appSent };
  }

  test("steerMessage rejects when no thread is active", () => {
    const adapter = createAdapter();
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    expect(adapter.steerMessage("hello")).toBe(false);
  });

  test("steerMessage rejects when the app-server WebSocket is not connected", () => {
    const adapter = createAdapter();
    adapter.threadId = "thread-steer";
    adapter.handleServerNotification({ method: "turn/started", params: { turn: { id: "t1" } } });
    adapter.appServerWs = null;
    expect(adapter.steerMessage("hello")).toBe(false);
  });

  test("steerMessage rejects when NO turn is in progress (injectMessage territory)", () => {
    const adapter = createAdapter();
    adapter.threadId = "thread-steer";
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;
    expect(adapter.turnInProgress).toBe(false);
    expect(adapter.steerMessage("hello")).toBe(false);
  });

  test("steerMessage sends turn/steer with a tracked negative id and text input", () => {
    const { adapter, appSent } = createSteerableAdapter();

    expect(adapter.steerMessage("mid-turn correction")).toBe(true);
    expect(appSent).toHaveLength(1);

    const sent = JSON.parse(appSent[0]);
    expect(sent.method).toBe("turn/steer");
    expect(typeof sent.id).toBe("number");
    expect(sent.id).toBeLessThan(0);
    expect(sent.params).toEqual({
      threadId: "thread-steer",
      input: [{ type: "text", text: "mid-turn correction" }],
    });
    expect(adapter.bridgeRequestIds.has(sent.id)).toBe(true);
    expect(adapter.bridgeRequestKinds.get(sent.id)).toBe("steer");

    adapter.clearResponseTrackingState();
  });

  test("a rejected steer emits steerFailed, NOT turnAborted, and leaves the turn running", () => {
    // Core B0 invariant: ActiveTurnNotSteerable / NoActiveTurn-race rejections
    // must not be confused with a turn abort — the ORIGINAL turn is untouched.
    const { adapter, appSent } = createSteerableAdapter();
    const failures: string[] = [];
    const aborts: string[] = [];
    adapter.on("steerFailed", (reason: string) => failures.push(reason));
    adapter.on("turnAborted", (reason: string) => aborts.push(reason));

    adapter.steerMessage("mid-turn correction");
    const steerId = JSON.parse(appSent[0]).id;

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: steerId,
      error: { message: "ActiveTurnNotSteerable" },
    }));

    expect(forwarded).toBeNull(); // swallowed, never forwarded to the TUI
    expect(failures).toEqual(["ActiveTurnNotSteerable"]);
    expect(aborts).toEqual([]);
    expect(adapter.turnInProgress).toBe(true);
    expect(adapter.turnPhase).toBe("running");
    expect(adapter.bridgeRequestIds.has(steerId)).toBe(false); // consumed

    adapter.clearResponseTrackingState();
  });

  test("an accepted steer emits steerAccepted and nothing else", () => {
    const { adapter, appSent } = createSteerableAdapter();
    const events: string[] = [];
    adapter.on("steerAccepted", () => events.push("accepted"));
    adapter.on("steerFailed", () => events.push("failed"));
    adapter.on("turnAborted", () => events.push("aborted"));

    adapter.steerMessage("mid-turn correction");
    const steerId = JSON.parse(appSent[0]).id;

    adapter.handleAppServerPayload(JSON.stringify({ id: steerId, result: {} }));

    expect(events).toEqual(["accepted"]);
    expect(adapter.turnInProgress).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("a rejected injected turn/start still emits turnAborted (kind default unchanged)", () => {
    // Regression guard for the kind-aware tracking refactor: the pre-existing
    // turn-start error path must keep its abort semantics.
    const { adapter } = createSteerableAdapter();
    const aborts: string[] = [];
    const failures: string[] = [];
    adapter.on("turnAborted", (reason: string) => aborts.push(reason));
    adapter.on("steerFailed", (reason: string) => failures.push(reason));

    adapter.trackBridgeRequestId(-77); // default kind: "turn-start"
    adapter.handleAppServerPayload(JSON.stringify({
      id: -77,
      error: { message: "turn/start rejected" },
    }));

    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toContain("turn/start rejected");
    expect(failures).toEqual([]);

    adapter.clearResponseTrackingState();
  });

  test("clearResponseTrackingState clears in-flight steer kinds (no leak across reconnects)", () => {
    // Regression: clearTransientResponseTrackingState cancelled the TTL timers
    // (the only other deletion path for bridgeRequestKinds) but cleared only
    // bridgeRequestIds — every in-flight request at an app-server disconnect
    // leaked its kind entry forever.
    const { adapter } = createSteerableAdapter();

    adapter.steerMessage("in flight at disconnect");
    adapter.trackBridgeRequestId(-88); // an in-flight turn-start, same lifecycle
    expect(adapter.bridgeRequestIds.size).toBe(2);
    expect(adapter.bridgeRequestKinds.size).toBe(2);

    adapter.clearResponseTrackingState();

    expect(adapter.bridgeRequestIds.size).toBe(0);
    expect(adapter.bridgeRequestKinds.size).toBe(0);
  });

  test("a failed send untracks the steer id so a late response is unmatched", () => {
    const { adapter } = createSteerableAdapter();
    adapter.appServerWs = {
      readyState: WebSocket.OPEN,
      send: () => { throw new Error("socket write failed"); },
    } as any;
    const failures: string[] = [];
    adapter.on("steerFailed", (reason: string) => failures.push(reason));

    expect(adapter.steerMessage("doomed")).toBe(false);
    expect(adapter.bridgeRequestIds.size).toBe(0);
    expect(adapter.bridgeRequestKinds.size).toBe(0);
    expect(failures).toEqual([]); // send failure is the return value's job, not the event's

    adapter.clearResponseTrackingState();
  });
});
