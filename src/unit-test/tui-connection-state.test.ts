import { describe, expect, test } from "bun:test";
import { TuiConnectionState } from "../tui-connection-state";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createState(disconnectGraceMs = 20) {
  const disconnected: number[] = [];
  const reconnected: number[] = [];
  const logs: string[] = [];

  const state = new TuiConnectionState({
    disconnectGraceMs,
    log: (msg) => logs.push(msg),
    onDisconnectPersisted: (connId) => disconnected.push(connId),
    onReconnectAfterNotice: (connId) => reconnected.push(connId),
  });

  return { state, disconnected, reconnected, logs };
}

describe("TuiConnectionState", () => {
  test("suppresses disconnect notifications before the bridge is ready", async () => {
    const { state, disconnected, reconnected, logs } = createState();

    state.handleTuiDisconnected(1);
    await sleep(30);

    expect(disconnected).toEqual([]);
    expect(reconnected).toEqual([]);
    expect(state.canReply()).toBe(false);
    expect(state.snapshot()).toEqual({
      bridgeReady: false,
      tuiConnected: false,
      disconnectNotificationShown: false,
      hasPendingDisconnectNotification: false,
    });
    expect(logs.some((msg) => msg.includes("Suppressing pre-ready TUI disconnect notification"))).toBe(true);
  });

  test("keeps the bridge ready during a transient disconnect inside the grace window", async () => {
    const { state, disconnected, reconnected } = createState(25);

    state.markBridgeReady();
    state.handleTuiConnected(1);
    state.handleTuiDisconnected(1);

    expect(state.canReply()).toBe(true);
    expect(state.snapshot().hasPendingDisconnectNotification).toBe(true);

    await sleep(10);
    state.handleTuiConnected(2);
    await sleep(30);

    expect(disconnected).toEqual([]);
    expect(reconnected).toEqual([]);
    expect(state.canReply()).toBe(true);
    expect(state.snapshot()).toEqual({
      bridgeReady: true,
      tuiConnected: true,
      disconnectNotificationShown: false,
      hasPendingDisconnectNotification: false,
    });
  });

  test("notifies after a persistent disconnect and reports recovery on reconnect", async () => {
    const { state, disconnected, reconnected } = createState();

    state.markBridgeReady();
    state.handleTuiConnected(1);
    state.handleTuiDisconnected(1);

    await sleep(30);
    expect(disconnected).toEqual([1]);
    expect(reconnected).toEqual([]);
    expect(state.canReply()).toBe(false);

    state.handleTuiConnected(2);

    expect(disconnected).toEqual([1]);
    expect(reconnected).toEqual([2]);
    expect(state.snapshot()).toEqual({
      bridgeReady: true,
      tuiConnected: true,
      disconnectNotificationShown: false,
      hasPendingDisconnectNotification: false,
    });
  });

  test("clears pending disconnect timers when Codex exits", async () => {
    const { state, disconnected, reconnected } = createState();

    state.markBridgeReady();
    state.handleTuiConnected(1);
    state.handleTuiDisconnected(1);
    state.handleCodexExit();

    await sleep(30);

    expect(disconnected).toEqual([]);
    expect(reconnected).toEqual([]);
    expect(state.canReply()).toBe(false);
    expect(state.snapshot()).toEqual({
      bridgeReady: false,
      tuiConnected: false,
      disconnectNotificationShown: false,
      hasPendingDisconnectNotification: false,
    });
  });
});
