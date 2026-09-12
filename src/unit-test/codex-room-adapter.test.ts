import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../codex-adapter";
import { CODEX_ROOM_TOOLS, roomToolResult } from "../codex-room";

function setup() {
  const adapter = new CodexAdapter(4510, 4511, join(mkdtempSync(join(tmpdir(), "abg-room-adapter-")), "test.log")) as any;
  const replies: any[] = [];
  const forwarded: any[] = [];
  adapter.appServerWs = { readyState: WebSocket.OPEN, send: (raw: string) => replies.push(JSON.parse(raw)) };
  adapter.tuiWs = { send: (raw: string) => forwarded.push(JSON.parse(raw)) };
  adapter.threadId = "thread-a";
  adapter.roomToolThreads.add("thread-a");
  return { adapter, replies, forwarded };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function request(tool = "agentbridge_room_members", threadId = "thread-a") {
  return { id: 9, method: "item/tool/call", params: { tool, threadId, arguments: {} } };
}

describe("Codex room dynamic protocol", () => {
  test("temporary TUI helper threads do not steal room calls or end the user turn", async () => {
    const { adapter, replies } = setup();
    adapter.tuiWs.data = { connId: 0 };
    adapter.configureRoomTools(() => true, async () => roomToolResult(true, "members"));
    adapter.onTuiMessage(adapter.tuiWs, JSON.stringify({ id: "temporary-structured-123", method: "thread/start", params: {} }));
    const outgoing = replies.shift();
    expect(outgoing.params.dynamicTools).toBeUndefined();
    adapter.handleAppServerPayload(JSON.stringify({ id: outgoing.id, result: { thread: { id: "helper" } } }));
    expect(adapter.threadId).toBe("thread-a");
    adapter.turnInProgress = true;
    adapter.handleServerNotification({ method: "turn/completed", params: { threadId: "helper", turn: { id: "helper-turn" } } });
    expect(adapter.turnInProgress).toBe(true);
    const req = request(); adapter.handleServerRequest(req, JSON.stringify(req));
    await tick(); expect(replies[0].result.success).toBe(true);
    adapter.clearResponseTrackingState();
  });

  test("refreshes a late room mapping before replaying a new TUI session", async () => {
    const { adapter, replies } = setup();
    let enabled = false;
    let finish!: () => void;
    adapter.tuiWs.data = { connId: 0 };
    adapter.configureRoomTools(() => enabled, async () => roomToolResult(true, "ok"),
      () => new Promise<void>(resolve => { finish = () => { enabled = true; resolve(); }; }));
    let reconnects = 0;
    adapter.reconnectAppServerForNewSession = (ws: any) => {
      reconnects++;
      const pending = adapter.pendingTuiMessages.splice(0);
      adapter.reconnectingForNewSession = false;
      adapter.replayingBufferedMessages = true;
      for (const raw of pending) adapter.onTuiMessage(ws, raw);
      adapter.replayingBufferedMessages = false;
    };
    adapter.onTuiMessage(adapter.tuiWs, JSON.stringify({ id: 1, method: "initialize", params: {} }));
    adapter.onTuiMessage(adapter.tuiWs, JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    expect(replies).toHaveLength(0);
    expect(reconnects).toBe(0);
    finish(); await tick();
    expect(reconnects).toBe(1);
    expect(replies.find((r: any) => r.method === "thread/start").params.dynamicTools.map((t: any) => t.name)).toEqual(CODEX_ROOM_TOOLS.map(t => t.name));
    adapter.clearResponseTrackingState();
  });

  test("registers only a successfully created thread and retains ownership across adapter restart", () => {
    const { adapter, replies } = setup();
    adapter.roomToolThreads.clear();
    adapter.configureRoomTools(() => true, async () => roomToolResult(true, "ok"));
    adapter.tuiWs.data = { connId: 0 };
    adapter.onTuiMessage(adapter.tuiWs, JSON.stringify({ id: 7, method: "thread/start", params: {} }));
    const outgoing = replies[0];
    expect(outgoing.params.dynamicTools.map((t: any) => t.name)).toEqual(CODEX_ROOM_TOOLS.map(t => t.name));
    expect(adapter.roomToolThreads.has("created-thread")).toBe(false);
    adapter.handleAppServerPayload(JSON.stringify({ id: outgoing.id, result: { thread: { id: "created-thread" } } }));
    expect(adapter.roomToolThreads.has("created-thread")).toBe(true);
    const restored = new CodexAdapter(4510, 4511, adapter.logFile) as any;
    expect(restored.roomToolThreads.has("created-thread")).toBe(true);
    adapter.clearResponseTrackingState();
  });

  test("enables experimental handshake before room resolution and preserves existing tools", () => {
    const { adapter } = setup();
    let enabled = false;
    adapter.configureRoomTools(() => enabled, async () => roomToolResult(true, "ok"));
    const init = JSON.parse(adapter.addRoomTools(JSON.stringify({ method: "initialize", params: { capabilities: { optOutNotificationMethods: ["x"] } } })));
    expect(init.params.capabilities).toEqual({ optOutNotificationMethods: ["x"], experimentalApi: true });
    const raw = JSON.stringify({ method: "thread/start", params: { dynamicTools: [{ name: "other" }] } });
    expect(adapter.addRoomTools(raw)).toBe(raw);
    enabled = true;
    expect(JSON.parse(adapter.addRoomTools(raw)).params.dynamicTools.map((t: any) => t.name)).toEqual(["other", ...CODEX_ROOM_TOOLS.map(t => t.name)]);
  });

  test("does not replace or intercept a caller's same-name tool on an unregistered thread", async () => {
    const { adapter, replies, forwarded } = setup();
    let calls = 0;
    adapter.roomToolThreads.clear();
    adapter.configureRoomTools(() => true, async () => { calls++; return roomToolResult(true, "ok"); });
    const raw = JSON.stringify({ method: "thread/start", params: { dynamicTools: [{ name: "agentbridge_room_members", description: "caller tool" }] } });
    expect(adapter.addRoomTools(raw)).toBe(raw);
    const req = request(); adapter.handleServerRequest(req, JSON.stringify(req));
    await tick();
    expect(calls).toBe(0); expect(replies).toHaveLength(0); expect(forwarded).toHaveLength(1);
  });

  test("handles registered room calls with the original server id and forwards unknown tools", async () => {
    const { adapter, replies, forwarded } = setup();
    adapter.configureRoomTools(() => true, async () => roomToolResult(true, "members"));
    const req = request(); adapter.handleServerRequest(req, JSON.stringify(req));
    await tick();
    expect(replies).toEqual([{ id: 9, result: roomToolResult(true, "members") }]);
    expect(forwarded).toHaveLength(0);
    const unknown = request("unrelated_tool"); adapter.handleServerRequest(unknown, JSON.stringify(unknown));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].params.tool).toBe("unrelated_tool");
  });

  test("rejects stale thread calls without invoking the room handler", async () => {
    const { adapter, replies } = setup();
    let calls = 0;
    adapter.configureRoomTools(() => true, async () => { calls++; return roomToolResult(true, "ok"); });
    adapter.threadId = "thread-b";
    const req = request(); adapter.handleServerRequest(req, JSON.stringify(req));
    await tick(); expect(calls).toBe(0); expect(replies[0].result.success).toBe(false);
  });

  test("never replies to a replacement socket after an asynchronous tool completes", async () => {
    const { adapter, replies } = setup();
    let resolve!: (value: any) => void;
    let valid!: () => boolean;
    adapter.configureRoomTools(() => true, (_name: string, _args: unknown, current: () => boolean) => { valid = current; return new Promise(r => { resolve = r; }); });
    const req = request(); adapter.handleServerRequest(req, JSON.stringify(req));
    await tick(); expect(valid()).toBe(true);
    const replacement: any[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (raw: string) => replacement.push(raw) };
    expect(valid()).toBe(false);
    resolve(roomToolResult(true, "done")); await tick();
    expect(replies).toHaveLength(0); expect(replacement).toHaveLength(0);
  });
});
