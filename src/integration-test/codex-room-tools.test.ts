import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import type { Envelope } from "../backbone/envelope";
import { RoomService } from "../room-service";
import { startRoomBridge } from "../room-bridge";
import { callRoomTool } from "../codex-room";

const ROOM = "codex-tools-test";
const ALICE = "alice@test.invalid";
const BOB = "bob@test.invalid";
const CAROL = "carol@test.invalid";

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for local broker event");
    await Bun.sleep(10);
  }
}

describe("Codex room tools through a real local broker", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => { for (const stop of cleanup.reverse()) stop(); cleanup = []; });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "abg-codex-room-tools-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new InMemoryStore();
    const identities = new IdentityService(store);
    const tokens: Record<string, string> = {};
    for (const id of [ALICE, BOB, CAROL]) {
      await identities.registerIdentity(id, id);
      tokens[id] = await identities.issueToken(id);
    }
    const rooms = new RoomService(store);
    await rooms.createRoom(ROOM, "Codex tools test", ALICE);
    for (const id of [ALICE, BOB, CAROL]) await rooms.join(ROOM, id);
    await rooms.mapCwd(dir, ROOM);
    writeFileSync(join(dir, "auth-token"), tokens[ALICE]!, { mode: 0o600 });
    const broker = new Broker({ store, identityProvider: new StorePskIdentityProvider(store), host: "127.0.0.1", port: 0, log: () => {} });
    const { port } = broker.start();
    cleanup.push(() => broker.stop());
    const url = `ws://127.0.0.1:${port}/ws`;
    const events: Array<{ envelope: Envelope; text: string }> = [];
    const bridge = await startRoomBridge({
      cwd: dir, dbPath: join(dir, "collab.db"), store, brokerUrl: url, emit: () => {},
      onEvent: (envelope, text) => events.push({ envelope, text }),
    });
    cleanup.push(() => bridge.stop());
    // Membership requires authentication; retry only the initial connection race.
    let ready = false;
    const deadline = Date.now() + 2500;
    while (!ready) {
      try { ready = !!await bridge.listMembers(); } catch { /* initial connection */ }
      if (Date.now() > deadline) throw new Error("Room bridge did not authenticate");
      if (!ready) await Bun.sleep(10);
    }
    async function peer(id: string) {
      const client = new BrokerClient({ url, token: tokens[id]! });
      cleanup.push(() => client.close());
      const received: Envelope[] = [];
      client.onEvent((_topic, env) => received.push(env));
      await client.connect();
      client.subscribe(ROOM);
      await client.listMembers(ROOM); // ordered round-trip after subscribe
      return { client, received };
    }
    return { bridge, events, bob: await peer(BOB), carol: await peer(CAROL) };
  }

  test("lists authenticated membership; directs Codex messages only to target and broadcasts to all", async () => {
    const { bridge, bob, carol } = await setup();
    const listed = await callRoomTool(bridge, "agentbridge_room_members", {});
    expect(listed.success).toBe(true);
    const roster = JSON.parse(listed.contentItems[0]!.text);
    expect(roster.roomId).toBe(ROOM);
    expect(roster.self).toBe(ALICE);
    expect(roster.ownerId).toBe(ALICE);
    expect(roster.members.sort()).toEqual([ALICE, BOB, CAROL].sort());

    const sent = await callRoomTool(bridge, "agentbridge_room_say", { text: "private for Bob", to: [BOB] });
    expect(sent.success).toBe(true);
    await waitFor(() => bob.received.some(e => (e.payload as any)?.text === "private for Bob"));
    const direct = bob.received.find(e => (e.payload as any)?.text === "private for Bob")!;
    expect(direct.to).toEqual([BOB]);
    expect(direct.from.agentId).toBe(ALICE);
    expect(direct.from.agentType).toBe("codex");

    expect((await callRoomTool(bridge, "agentbridge_room_say", { text: "hello all" })).success).toBe(true);
    await waitFor(() => [bob, carol].every(p => p.received.some(e => (e.payload as any)?.text === "hello all")));
    expect(carol.received.some(e => (e.payload as any)?.text === "private for Bob")).toBe(false);
    const broadcast = carol.received.find(e => (e.payload as any)?.text === "hello all")!;
    expect(broadcast.to).toBeUndefined();
    expect(broadcast.from.agentType).toBe("codex");
  });

  test("rejects unknown recipient without publishing and delivers remote events through onEvent", async () => {
    const { bridge, bob, carol, events } = await setup();
    const invalid = await callRoomTool(bridge, "agentbridge_room_say", { text: "must not be sent", to: ["outsider@test.invalid"] });
    expect(invalid.success).toBe(false);
    expect(invalid.contentItems[0]!.text).toContain("Unknown recipient");
    await callRoomTool(bridge, "agentbridge_room_say", { text: "barrier" });
    await waitFor(() => [bob, carol].every(p => p.received.some(e => (e.payload as any)?.text === "barrier")));
    expect([...bob.received, ...carol.received].some(e => (e.payload as any)?.text === "must not be sent")).toBe(false);

    const message: Envelope = {
      roomId: ROOM, messageId: randomUUID(), traceId: randomUUID(), idempotencyKey: randomUUID(),
      from: { agentId: BOB, agentType: "claude" }, kind: "chat", payload: { text: "remote peer reply" },
      timestamp: Date.now(), deliveryMode: "online_only", to: [ALICE],
    };
    bob.client.publish(ROOM, message);
    await waitFor(() => events.some(e => e.envelope.messageId === message.messageId));
    const delivered = events.find(e => e.envelope.messageId === message.messageId)!;
    expect(delivered.envelope.from.agentId).toBe(BOB);
    expect(delivered.text).toContain("remote peer reply");
    expect(delivered.text).toContain("房间消息");
    bob.client.publish(ROOM, message);
    await bob.client.listMembers(ROOM);
    await Bun.sleep(50);
    expect(events.filter(e => e.envelope.messageId === message.messageId)).toHaveLength(1);
  });
});
