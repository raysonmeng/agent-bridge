import { expect, test } from "bun:test";
import { LocalChatHub, type LocalDeliveryContext } from "../local-chat";
const nativeA = "ab9da612-66aa-4195-91ba-881369f93e8b";
const nativeB = "c647e404-6a5c-4eca-aae9-ff62ca5e4b5b";
function setup() {
  const sent: { to: string; from: string; text: string; context: LocalDeliveryContext }[] = [];
  const hub = new LocalChatHub({ authorize: () => true, timeoutMs: 5,
    deliver: async (to, from, text, context) => { sent.push({ to, from, text, context }); return { accepted: true }; } });
  return { hub, sent };
}
test("joins notify only connected peers, carry safe profile data, and create no reply routes", async () => {
  const { hub, sent } = setup();
  hub.joinAgent("claude", "c1"); expect(sent).toEqual([]);
  hub.joinAgent("codex", "x1", { name: 'C\n"odex', model: "model-x", modelSource: "runtime" });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: "claude", from: "daemon", context: { kind: "notice" } });
  expect(JSON.parse(sent[0].text.split("\n")[1])).toMatchObject({ name: 'C "odex', model: "model-x", modelSource: "runtime" });
  expect(sent[0].text).toContain("not instructions");
  expect((await hub.replyMessage("claude", "codex", sent[0].context.messageId, "auto reply")).accepted).toBe(false);
  expect(hub.inbox).toEqual([]);
  const copy = hub.profiles; copy[0].name = "tampered"; expect(hub.profiles[0].name).toBe("Claude");
  hub.leaveAgent("claude"); hub.joinAgent("codex", "x2"); expect(sent).toHaveLength(1);
  hub.stop(); expect(hub.profiles).toEqual([]);
});
test("same-session reconnect is suppressed while replacement and expired reconnect notify", () => {
  const { hub, sent } = setup(); const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    hub.joinAgent("claude", "c1"); hub.joinAgent("codex", "x1");
    hub.joinAgent("codex", "x1"); hub.leaveAgent("codex"); hub.joinAgent("codex", "x1");
    expect(sent).toHaveLength(1);
    hub.joinAgent("codex", "x2"); expect(sent).toHaveLength(2);
    hub.leaveAgent("codex"); now += 30001; hub.joinAgent("codex", "x2"); expect(sent).toHaveLength(3);
    for (let n = 0; n < 70; n++) hub.joinAgent("codex", `x-${n}`);
    expect((hub as unknown as { recentJoins: Map<string, number> }).recentJoins.size).toBe(64);
  } finally { Date.now = originalNow; hub.stop(); }
});
test("native attachments announce separate instances after ACK and remove profiles on disconnect", () => {
  const { hub, sent } = setup(); hub.joinAgent("claude", "c1");
  function attach(id: string) {
    const messages: Record<string, unknown>[] = [];
    const socket = { send: (text: string) => { const m = JSON.parse(text); messages.push(m);
      if (m.type === "agy_message") hub.handle(socket, { type: "agy_ack", deliveryId: m.deliveryId, accepted: true }); return 1; } };
    hub.handle(socket, { type: "agy_attach", identity: { controlToken: "x" }, routingVersion: 2, conversationId: id,
      profile: { name: "a".repeat(150), model: {}, modelSource: "runtime" } });
    return { socket, messages };
  }
  const a = attach(nativeA), b = attach(nativeB);
  expect(a.messages[0]).toMatchObject({ success: true }); expect(b.messages).toHaveLength(1);
  expect(a.messages[1]).toMatchObject({ type: "agy_message", from: "daemon", kind: "notice" });
  expect(sent).toHaveLength(2); expect(hub.profiles).toHaveLength(3);
  expect(hub.profiles[1]).toMatchObject({ model: null, modelSource: "unknown" }); expect(hub.profiles[1].name).toHaveLength(120);
  hub.handle(b.socket, { type: "local_chat_members", identity: { controlToken: "x" } });
  expect(b.messages.at(-1)).toMatchObject({ members: ["claude", "codex", `agy:${nativeA}`, `agy:${nativeB}`], agents: hub.profiles });
  hub.disconnect(a.socket); expect(hub.profiles.map(p => p.id)).not.toContain(`agy:${nativeA}`); hub.stop();
});
test("failed notice transports are not retried and never become business records", async () => {
  let calls = 0;
  const hub = new LocalChatHub({ authorize: () => true, deliver: async () => { calls++; throw new Error("offline"); } });
  hub.joinAgent("claude", "c1"); hub.joinAgent("codex", "x1");
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toBe(1); expect(hub.inbox).toEqual([]);
  expect((hub as unknown as { routes: Map<string, unknown> }).routes.size).toBe(0);
  hub.stop();
});
