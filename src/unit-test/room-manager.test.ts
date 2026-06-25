import { describe, test, expect } from "bun:test";
import { RoomManager, type RoomManagerDeps } from "../room-manager";
import type { ConnectionSession } from "../connection-session";
import type { BoundedMessageBuffer } from "../delivery-buffer";
import type { BridgeMessage } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (id: string): BridgeMessage => ({ id, source: "codex", content: id, timestamp: 0 });

/** Fake ConnectionSession: configurable send + backpressure drain. */
class FakeSession {
  isOpen = true;
  sent: BridgeMessage[] = [];
  /** ids for which send() should report failure (dropped). */
  failIds = new Set<string>();
  /** messages to hand back from drainPendingBackpressureInto. */
  backpressured: BridgeMessage[] = [];

  send(m: BridgeMessage): boolean {
    if (this.failIds.has(m.id)) return false;
    this.sent.push(m);
    return true;
  }
  drainPendingBackpressureInto(backlog: BoundedMessageBuffer): number {
    const n = this.backpressured.length;
    backlog.unshiftMany(this.backpressured);
    this.backpressured = [];
    return n;
  }
}

function makeRM(over: Partial<RoomManagerDeps> = {}): {
  rm: RoomManager;
  logs: string[];
  shutdowns: string[];
  state: { claude: ConnectionSession | null; tui: boolean };
} {
  const logs: string[] = [];
  const shutdowns: string[] = [];
  const state = { claude: null as ConnectionSession | null, tui: false };
  const rm = new RoomManager({
    bufferedCap: 100,
    idleShutdownMs: 20,
    claudeDisconnectGraceMs: 20,
    log: (m) => logs.push(m),
    getClaude: () => state.claude,
    isTuiConnected: () => state.tui,
    onIdleShutdown: (r) => shutdowns.push(r),
    ...over,
  });
  return { rm, logs, shutdowns, state };
}

describe("RoomManager.deliverToClaude", () => {
  test("open member + successful send → delivered, no backlog", () => {
    const { rm, state } = makeRM();
    const s = new FakeSession();
    state.claude = s as unknown as ConnectionSession;
    rm.deliverToClaude(msg("a"));
    expect(s.sent.map((m) => m.id)).toEqual(["a"]);
    expect(rm.backlogSize).toBe(0);
  });

  test("no member → buffered", () => {
    const { rm } = makeRM();
    rm.deliverToClaude(msg("a"));
    expect(rm.backlogSize).toBe(1);
  });

  test("member not OPEN → buffered", () => {
    const { rm, state } = makeRM();
    const s = new FakeSession();
    s.isOpen = false;
    state.claude = s as unknown as ConnectionSession;
    rm.deliverToClaude(msg("a"));
    expect(s.sent.length).toBe(0);
    expect(rm.backlogSize).toBe(1);
  });

  test("failed send → buffered + logged", () => {
    const { rm, state, logs } = makeRM();
    const s = new FakeSession();
    s.failIds.add("a");
    state.claude = s as unknown as ConnectionSession;
    rm.deliverToClaude(msg("a"));
    expect(rm.backlogSize).toBe(1);
    expect(logs.some((l) => l.includes("buffering message for retry"))).toBe(true);
  });
});

describe("RoomManager.flushBacklog", () => {
  test("drains in order to the session", () => {
    const { rm } = makeRM();
    rm.deliverToClaude(msg("a"));
    rm.deliverToClaude(msg("b"));
    const s = new FakeSession();
    rm.flushBacklog(s as unknown as ConnectionSession);
    expect(s.sent.map((m) => m.id)).toEqual(["a", "b"]);
    expect(rm.backlogSize).toBe(0);
  });

  test("re-buffers the tail (in order) on a mid-flush send failure", () => {
    const { rm } = makeRM();
    rm.deliverToClaude(msg("a"));
    rm.deliverToClaude(msg("b"));
    rm.deliverToClaude(msg("c"));
    const s = new FakeSession();
    s.failIds.add("b"); // a ok, b fails → b,c re-buffered
    rm.flushBacklog(s as unknown as ConnectionSession);
    expect(s.sent.map((m) => m.id)).toEqual(["a"]);
    expect(rm.backlogSize).toBe(2);
    // a good session then drains the preserved order b,c
    const s2 = new FakeSession();
    rm.flushBacklog(s2 as unknown as ConnectionSession);
    expect(s2.sent.map((m) => m.id)).toEqual(["b", "c"]);
  });
});

describe("RoomManager.rebufferOnDetach", () => {
  test("moves the session's backpressured messages (prepended) into the backlog", () => {
    const { rm } = makeRM();
    rm.deliverToClaude(msg("tail")); // already in backlog
    const s = new FakeSession();
    s.backpressured = [msg("bp1"), msg("bp2")];
    const n = rm.rebufferOnDetach(s as unknown as ConnectionSession);
    expect(n).toBe(2);
    // backpressured predate the existing backlog entry → prepended
    const drain = new FakeSession();
    rm.flushBacklog(drain as unknown as ConnectionSession);
    expect(drain.sent.map((m) => m.id)).toEqual(["bp1", "bp2", "tail"]);
  });
});

describe("RoomManager idle-shutdown timer — reads LIVE state at fire time", () => {
  test("does not arm idle-shutdown when a client is present", async () => {
    const { rm, shutdowns, logs, state } = makeRM();
    state.claude = new FakeSession() as unknown as ConnectionSession;
    rm.scheduleIdleShutdown();
    await sleep(45);
    // The present-client early-return (room-manager.ts: `if (getClaude()) return`)
    // means no timer is armed, nothing shuts down, and the "will shut down" log
    // is never emitted. Deleting that guard makes this test go red.
    expect(shutdowns).toEqual([]);
    expect(logs.some((l) => l.includes("will shut down"))).toBe(false);
  });

  test("fires shutdown when still idle at fire time", async () => {
    const { rm, shutdowns } = makeRM();
    rm.scheduleIdleShutdown();
    await sleep(45);
    expect(shutdowns).toEqual(["idle — no clients connected"]);
  });

  test("a reconnect BEFORE fire cancels the shutdown (live-state recheck)", async () => {
    const { rm, shutdowns, state, logs } = makeRM();
    rm.scheduleIdleShutdown(); // idle → armed
    state.claude = new FakeSession() as unknown as ConnectionSession; // reconnect before fire
    await sleep(45);
    expect(shutdowns).toEqual([]);
    expect(logs.some((l) => l.includes("Idle shutdown cancelled"))).toBe(true);
  });

  test("cancelIdleShutdown stops a pending fire", async () => {
    const { rm, shutdowns } = makeRM();
    rm.scheduleIdleShutdown();
    rm.cancelIdleShutdown();
    await sleep(45);
    expect(shutdowns).toEqual([]);
  });
});

describe("RoomManager claude-disconnect notification timer", () => {
  test("persists past grace when no reconnect", async () => {
    const { rm, logs } = makeRM();
    rm.scheduleClaudeDisconnectNotification(7);
    await sleep(45);
    expect(logs.some((l) => l.includes("persisted past grace window (client #7)"))).toBe(true);
  });

  test("skips notification when reconnected before fire", async () => {
    const { rm, logs, state } = makeRM();
    rm.scheduleClaudeDisconnectNotification(7);
    state.claude = new FakeSession() as unknown as ConnectionSession;
    await sleep(45);
    expect(logs.some((l) => l.includes("already reconnected"))).toBe(true);
    expect(logs.some((l) => l.includes("persisted past grace window"))).toBe(false);
  });

  test("clearPendingClaudeDisconnect stops the pending notification", async () => {
    const { rm, logs } = makeRM();
    rm.scheduleClaudeDisconnectNotification(7);
    rm.clearPendingClaudeDisconnect("test");
    await sleep(45);
    expect(logs.some((l) => l.includes("persisted past grace window"))).toBe(false);
  });
});
