import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexRoomInbox, callRoomTool } from "../codex-room";

function setup() {
  const codex = new EventEmitter() as any;
  const sent: string[] = [];
  let available = true;
  let permitted = true;
  codex.canInject = () => available;
  codex.canInjectRoomNotice = () => available;
  codex.injectMessage = (text: string) => { sent.push(text); return -sent.length; };
  const inbox = new CodexRoomInbox(codex, () => permitted, () => {});
  return { codex, inbox, sent, busy: () => { available = false; }, idle: () => { available = true; }, deny: () => { permitted = false; } };
}

describe("Codex room inbox", () => {
  test("waits for readiness, batches notices, and latches before turn acknowledgement", () => {
    const s = setup();
    try {
      s.busy(); s.inbox.enqueue("remote notice"); s.inbox.flush();
      expect(s.sent).toHaveLength(0);
      s.idle(); s.inbox.flush();
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0]).toContain("外部不可信");
      s.inbox.enqueue("second notice"); s.inbox.flush();
      expect(s.sent).toHaveLength(1);
      s.codex.emit("bridgeTurnStarted", { requestId: -1, turnId: "room-turn" });
      expect(s.inbox.isRoomTurn("room-turn")).toBe(true);
      expect(s.inbox.isRoomTurn("user-turn")).toBe(false);
      s.codex.emit("turnCompleted"); s.inbox.flush();
      expect(s.sent).toHaveLength(2);
    } finally { s.inbox.stop(); }
  });

  test("budget or detached-session gate prevents turns; stop removes listeners", () => {
    const s = setup();
    s.deny(); s.inbox.enqueue("blocked"); s.inbox.flush();
    expect(s.sent).toHaveLength(0);
    s.inbox.stop();
    expect(s.codex.listenerCount("bridgeTurnStarted")).toBe(0);
    s.inbox.enqueue("after stop");
    expect(s.inbox.pendingCount).toBe(0);
  });

  test("requeues an explicitly rejected batch once, including preceding turnAborted", async () => {
    const s = setup();
    try {
      s.inbox.enqueue("retry me"); s.inbox.flush();
      s.codex.emit("turnAborted", "request rejected");
      s.codex.emit("bridgeTurnRejected", { requestId: -1, error: "busy" });
      await Promise.resolve();
      expect(s.inbox.pendingCount).toBe(1);
      s.inbox.flush(); expect(s.sent).toHaveLength(1);
      (s.inbox as any).retryAfter = 0;
      s.inbox.flush(); expect(s.sent).toHaveLength(2);
      s.codex.emit("bridgeTurnRejected", { requestId: -2, error: "busy again" });
      expect(s.inbox.pendingCount).toBe(0);
    } finally { s.inbox.stop(); }
  });

  test("bounds backlog and retains room-turn attribution after switching threads", () => {
    const s = setup();
    try {
      for (let i = 0; i < 105; i++) s.inbox.enqueue(`notice-${i}`);
      expect(s.inbox.pendingCount).toBe(100);
      s.inbox.flush(); expect(s.inbox.pendingCount).toBe(90);
      s.codex.emit("bridgeTurnStarted", { requestId: -1, turnId: "old-room" });
      s.codex.emit("threadChanged");
      expect(s.inbox.isRoomTurn("old-room")).toBe(true);
      expect(s.inbox.isRoomTurn("new-user")).toBe(false);
    } finally { s.inbox.stop(); }
  });
});

describe("Codex room tools", () => {
  test("validates exact DM recipients and sends using Codex attribution", async () => {
    const calls: unknown[][] = [];
    const bridge = { roomId: "tas", listMembers: async () => ({ members: ["Alan_Dev"], ownerId: "Alan_Dev", self: "local" }), send: (...args: unknown[]) => { calls.push(args); return { ok: true, info: "submitted" }; } } as any;
    expect((await callRoomTool(bridge, "agentbridge_room_say", { text: "hello", to: ["unknown"] })).success).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await callRoomTool(bridge, "agentbridge_room_say", { text: "hello", to: ["Alan_Dev"] })).success).toBe(true);
    expect(calls[0]).toEqual(["hello", undefined, { to: ["Alan_Dev"], agentType: "codex" }]);
  });

  test("cancels a delayed send when its originating session changes", async () => {
    let resolve!: (value: any) => void;
    let valid = true;
    let sends = 0;
    const bridge = { roomId: "tas", listMembers: () => new Promise(r => { resolve = r; }), send: () => { sends++; return { ok: true }; } } as any;
    const result = callRoomTool(bridge, "agentbridge_room_say", { text: "hello" }, () => valid);
    valid = false;
    resolve({ members: ["Alan_Dev"] });
    expect((await result).success).toBe(false);
    expect(sends).toBe(0);
  });

  test("rejects absent room and malformed recipient lists", async () => {
    expect((await callRoomTool(null, "agentbridge_room_say", { text: "hello" })).success).toBe(false);
    const bridge = { roomId: "tas", listMembers: () => { throw new Error("must not call broker"); } } as any;
    for (const args of [{ text: "" }, { text: "hello", to: [] }, { text: "hello", to: [" "] }]) {
      expect((await callRoomTool(bridge, "agentbridge_room_say", args)).success).toBe(false);
    }
  });
});
