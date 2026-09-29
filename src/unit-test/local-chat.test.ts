import { describe, expect, test } from "bun:test";
import { LocalChatHub } from "../local-chat";
const id = "ab9da612-66aa-4195-91ba-881369f93e8b";
const identity = { controlToken: "valid" };
function socket() { const messages: any[] = []; return { messages, send: (s: string) => { messages.push(JSON.parse(s)); return 1; } }; }
function setup(timeoutMs = 100) {
  const delivered: unknown[] = [];
  const hub = new LocalChatHub({ authorize: i => i?.controlToken === "valid", deliver: async (to, from, text) => { delivered.push({ to, from, text }); return { accepted: true }; }, timeoutMs });
  return { hub, delivered };
}
function attach(hub: LocalChatHub, s: ReturnType<typeof socket>, conversationId = id) { hub.handle(s, { type: "agy_attach", routingVersion: 2, identity, conversationId }); }
const tick = () => new Promise(r => setTimeout(r, 0));
describe("explicit local routing transport", () => {
  test("auth and required routing fail closed", async () => {
    const { hub, delivered } = setup(), s = socket();
    for (const m of [
      { type: "local_chat_send", from: "claude", to: "codex", text: "hi" },
      { type: "local_chat_send", identity, from: "claude", text: "private" },
      { type: "local_chat_reply", identity, from: "claude", text: "private" },
    ]) hub.handle(s, { ...m, requestId: "r" });
    await tick(); expect(s.messages.every(m => !m.success)).toBe(true); expect(delivered).toEqual([]); expect(hub.inbox).toEqual([]); hub.stop();
  });
  test("old adapter and duplicate registration cannot take over", () => {
    const { hub } = setup(), a = socket(), b = socket();
    hub.handle(a, { type: "agy_attach", identity, conversationId: id }); expect(a.messages[0].success).toBe(false);
    attach(hub, a); expect(a.messages.at(-1)).toMatchObject({ success: true, routingVersion: 2, agentId: `agy:${id}` });
    attach(hub, b); expect(b.messages[0].success).toBe(false);
    hub.disconnect(a); attach(hub, b); expect(b.messages.at(-1).success).toBe(true); hub.stop();
  });
  test("ACK belongs to the exact registered socket", async () => {
    const { hub } = setup(), a = socket(), other = socket(), caller = socket(); attach(hub, a);
    hub.handle(caller, { type: "local_chat_send", requestId: "r", identity, from: "codex", to: "agy", text: "hi" });
    const m = a.messages.at(-1);
    hub.handle(other, { type: "agy_ack", deliveryId: m.deliveryId, accepted: true }); await tick(); expect(caller.messages).toEqual([]);
    hub.handle(a, { type: "agy_ack", deliveryId: m.deliveryId, accepted: true }); await tick();
    expect(caller.messages[0].success).toBe(true); expect(caller.messages[0].info).toContain("not a read receipt"); hub.stop();
  });
  test("multiple instances require exact target and sender; no broadcasting", async () => {
    const { hub } = setup(), a = socket(), b = socket(); attach(hub, a); attach(hub, b, "c647e404-6a5c-4eca-aae9-ff62ca5e4b5b");
    expect((await hub.sendMessage("codex", "agy", "ambiguous")).accepted).toBe(false);
    const pending = hub.sendMessage("codex", `agy:${id}`, "only A");
    const m = a.messages.at(-1); expect(m.text).toBe("only A"); expect(b.messages.some(x => x.type === "agy_message")).toBe(false);
    hub.handle(a, { type: "agy_ack", deliveryId: m.deliveryId, accepted: true }); expect((await pending).accepted).toBe(true); hub.stop();
  });
  test("disconnect and timeout settle unconfirmed without retry", async () => {
    for (const disconnect of [true, false]) {
      const { hub } = setup(5), a = socket(); attach(hub, a);
      const pending = hub.sendMessage("claude", "agy", "hi"); if (disconnect) hub.disconnect(a);
      expect((await pending).accepted).toBe(false); expect(a.messages.filter(x => x.type === "agy_message")).toHaveLength(1); hub.stop();
    }
  });
  test("an agent cannot message or reply to itself", async () => {
    const { hub, delivered } = setup(), a = socket(); attach(hub, a);
    for (const [from, to] of [["claude", "claude"], ["codex", "codex"], ["agy", `agy:${id}`], [`agy:${id}`, "agy"]]) {
      expect((await hub.sendMessage(from, to, "loop")).accepted).toBe(false);
    }
    expect(delivered).toEqual([]); expect(a.messages.some(m => m.type === "agy_message")).toBe(false);
    const pending = hub.sendMessage("claude", "agy", "q"); const d = a.messages.at(-1);
    hub.handle(a, { type: "agy_ack", deliveryId: d.deliveryId, accepted: true }); await pending;
    expect((await hub.replyMessage("claude", "claude", d.deliveryId, "self")).accepted).toBe(false); hub.stop();
  });
});

