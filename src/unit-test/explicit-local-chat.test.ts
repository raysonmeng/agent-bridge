import { expect, test } from "bun:test";
import { LocalChatHub } from "../local-chat";
const id = "ab9da612-66aa-4195-91ba-881369f93e8b";
const identity = { controlToken: "valid" };
function setup() {
  const sent: any[] = [];
  const agent: any[] = [];
  const socket = { send: (text: string) => { agent.push(JSON.parse(text)); return 1; } };
  const hub = new LocalChatHub({ authorize: i => i?.controlToken === "valid", deliver: async (...args) => { sent.push(args); return { accepted: true }; } });
  hub.handle(socket, { type: "agy_attach", identity, conversationId: id, routingVersion: 2 });
  return { hub, sent, agent, socket };
}
test("ordinary native output and old hook uploads never enter the daemon business inbox", () => {
  const { hub, socket } = setup();
  hub.handle(socket, { type: "native_reply", replyId: "private", text: "personal answer", status: "completed" });
  hub.handle(socket, { type: "local_chat_reply", identity, agentId: `agy:${id}`, replyId: "private", text: "personal answer", status: "completed" });
  expect(hub.inbox).toEqual([]); hub.stop();
});
test("reply requires exact explicit recipient and original message; mismatches never send or store", async () => {
  const { hub, sent, socket, agent } = setup();
  const pending = hub.sendMessage("claude", `agy:${id}`, "question");
  const request = agent.find(m => m.type === "agy_message");
  hub.handle(socket, { type: "agy_ack", deliveryId: request.deliveryId, accepted: true }); await pending;
  for (const [to, inReplyTo] of [["", request.deliveryId], ["codex", request.deliveryId], ["claude", "unknown"]]) {
    expect((await hub.replyMessage(`agy:${id}`, to, inReplyTo, "answer")).accepted).toBe(false);
  }
  expect(sent).toEqual([]); expect(hub.inbox).toEqual([]);
  expect((await hub.replyMessage(`agy:${id}`, "claude", request.deliveryId, "answer")).accepted).toBe(true);
  expect(sent).toHaveLength(1); expect(sent[0][0]).toBe("claude"); expect(sent[0][3].kind).toBe("reply");
  expect((await hub.replyMessage(`agy:${id}`, "claude", request.deliveryId, "duplicate")).accepted).toBe(false);
  hub.stop();
});
test("session invalidation rejects delayed explicit replies rather than routing to replacement", async () => {
  const { hub, socket, agent, sent } = setup();
  const pending = hub.sendMessage("codex", "agy", "q");
  const m = agent.find(x => x.type === "agy_message"); hub.handle(socket, { type: "agy_ack", deliveryId: m.deliveryId, accepted: true }); await pending;
  hub.forgetRecipient("codex");
  expect((await hub.replyMessage(`agy:${id}`, "codex", m.deliveryId, "late")).accepted).toBe(false);
  expect(sent).toEqual([]); hub.stop();
});
