import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexRoomInbox, CODEX_LOCAL_TOOLS } from "../codex-room";
import { CodexAdapter } from "../codex-adapter";
import { ClaudeAdapter } from "../claude-adapter";
import type { BridgeMessage } from "../types";

function setupInbox() {
  const codex = new EventEmitter() as EventEmitter & { injectMessage(text: string): number; canInjectRoomNotice(): boolean };
  const injected: string[] = [];
  codex.injectMessage = text => { injected.push(text); return injected.length; };
  codex.canInjectRoomNotice = () => true;
  const inbox = new CodexRoomInbox(codex as unknown as CodexAdapter, () => true, () => {}, "local\n");
  return { codex, injected, inbox };
}

describe("daemon-owned native routing correlation", () => {
  test("local requests never batch different senders; normal completed assistant messages are never captured", () => {
    const s = setupInbox();
    try {
      s.inbox.enqueue("from agy", true, { messageId: "agy-request", kind: "request" });
      s.inbox.enqueue("from claude", true, { messageId: "claude-request", kind: "request" });
      s.inbox.flush();
      expect(s.injected).toEqual(["local\nfrom agy"]);
      s.codex.emit("bridgeTurnStarted", { requestId: 1, turnId: "turn-agy" });
      const base = { id: "item", source: "codex", content: "answer", timestamp: 1, turnId: "turn-agy" };
      s.codex.emit("agentMessage", { ...base, phase: "commentary" });
      s.codex.emit("agentMessage", { ...base, phase: "final_answer", turnId: "other-turn" });
      expect(s.codex.listenerCount("agentMessage")).toBe(0);
      s.codex.emit("agentMessage", { ...base, phase: "final_answer" });
      expect(s.codex.listenerCount("agentMessage")).toBe(0);
      s.codex.emit("turnIdCompleted", "turn-agy");
      s.inbox.flush();
      expect(s.injected[1]).toBe("local\nfrom claude");
    } finally { s.inbox.stop(); }
  });

  for (const kind of ["request", "reply"] as const) test(`rejected explicit local ${kind} is never automatically retried`, async () => {
    const s = setupInbox();
    try {
      s.inbox.enqueue("explicit body", true, { messageId: "12345678-1234-1234-1234-123456789abc", kind });
      s.inbox.flush();
      s.codex.emit("turnAborted", "request rejected");
      s.codex.emit("bridgeTurnRejected", { requestId: 1, error: "turn/start rejected" });
      await Promise.resolve();
      expect(s.inbox.pendingCount).toBe(0);
      expect(s.inbox.active).toBe(false);
      (s.inbox as any).retryAfter = 0;
      s.inbox.flush();
      expect(s.injected).toEqual(["local\nexplicit body"]);
    } finally { s.inbox.stop(); }
  });

  test("explicit user takeover does not install an automatic return route", () => {
    const s = setupInbox();
    try {
      s.inbox.enqueue("request", true, { messageId: "request", kind: "request" });
      s.inbox.flush();
      s.codex.emit("bridgeTurnStarted", { requestId: 1, turnId: "turn" });
      s.codex.emit("tuiTurnStarted", { turnId: "turn" });
      s.codex.emit("agentMessage", { id: "item", source: "codex", content: "private user work", timestamp: 1, phase: "final_answer", turnId: "turn" });
      expect(s.codex.listenerCount("agentMessage")).toBe(0);
    } finally { s.inbox.stop(); }
  });

  test("reply notifications do not manufacture another reply and loops", () => {
    const s = setupInbox();
    try {
      s.inbox.enqueue("answer notification", true, { messageId: "reply", kind: "reply" });
      s.inbox.flush();
      s.codex.emit("bridgeTurnStarted", { requestId: 1, turnId: "notification" });
      s.codex.emit("agentMessage", { id: "item", source: "codex", content: "ack", timestamp: 1, phase: "final_answer", turnId: "notification" });
      expect(s.codex.listenerCount("agentMessage")).toBe(0);
    } finally { s.inbox.stop(); }
  });

  test("Claude sends explicit metadata unchanged; missing or malformed routing fails before sender", async () => {
    const adapter = new ClaudeAdapter() as any;
    const sent: BridgeMessage[] = [];
    adapter.setReplySender(async (message: BridgeMessage) => { sent.push(message); return { success: true }; });
    await adapter.handleReply({ text: "new question", to: "agy" });
    await adapter.handleReply({ text: "answer", to: "agy", in_reply_to: "12345678-1234-1234-1234-123456789abc" });
    expect(sent[0]?.to).toBe("agy");
    expect(sent[1]).toMatchObject({ to: "agy", inReplyTo: "12345678-1234-1234-1234-123456789abc" });
    expect((await adapter.handleReply({ text: "ambiguous", in_reply_to: "id" })).isError).toBe(true);
    expect((await adapter.handleReply({ text: "invalid", to: [] })).isError).toBe(true);
    for (const args of [{ text: "ordinary" }, { text: "bad id", to: "agy", in_reply_to: "not-a-uuid" }, { text: 123, to: "agy" }, { text: " ", to: "agy" }, { text: "x", to: "agy", in_reply_to: 3 }, { text: "x", to: "codex", require_reply: true }, { text: "x", to: "codex", on_busy: "steer" }]) {
      expect((await adapter.handleReply(args)).isError).toBe(true);
    }
    expect(sent).toHaveLength(2);
  });

  test("native item completion preserves assistant phase and never emits tool or thinking logs", () => {
    const adapter = new CodexAdapter(0, 0, "/tmp/abg-unified-routing-test.log") as any;
    const messages: BridgeMessage[] = [];
    adapter.on("agentMessage", (message: BridgeMessage) => messages.push(message));
    for (const type of ["reasoning", "commandExecution", "agentMessage"]) {
      adapter.handleServerNotification({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
        id: type, type, phase: "final_answer", content: [{ type: "text", text: "visible answer" }],
      } } });
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ phase: "final_answer", turnId: "turn", content: "visible answer" });
  });

  test("local dynamic tools register without a remote room, preserving unrelated tools", () => {
    const adapter = new CodexAdapter(0, 0, "/tmp/abg-unified-routing-test.log") as any;
    adapter.configureRoomTools(() => false, async () => ({ success: true, contentItems: [] }), undefined, CODEX_LOCAL_TOOLS);
    const request = JSON.parse(adapter.addRoomTools(JSON.stringify({ id: 1, method: "thread/start", params: { dynamicTools: [{ name: "existing" }] } })));
    expect(request.params.dynamicTools.map((tool: any) => tool.name)).toEqual(["existing", "agentbridge_local_inbox", "agentbridge_local_send"]);
    expect(request.params.dynamicTools.some((tool: any) => tool.name === "agentbridge_room_say")).toBe(false);
  });
});
