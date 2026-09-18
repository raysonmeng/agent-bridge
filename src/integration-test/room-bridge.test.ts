import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { RoomService } from "../room-service";
import { buildTaskCompletedEnvelope } from "../task-completed";
import { startRoomBridge } from "../room-bridge";
import { addTrustedSender } from "../room-trust";
import type { Envelope } from "../backbone/envelope";
import { randomUUID } from "node:crypto";

const ROOM = "checkout";

/** A chat envelope as bob would publish it (the broker re-stamps `from` anyway). */
function bobChat(text: string): Envelope {
  return {
    roomId: ROOM, messageId: randomUUID(), traceId: randomUUID(), idempotencyKey: randomUUID(),
    from: { agentId: "bob@x.com", agentType: "codex" }, kind: "chat", payload: { text },
    timestamp: Date.now(), deliveryMode: "store_if_offline",
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(10);
  }
}

async function setup(opts: { mapCwd?: boolean; writeToken?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentbridge-roombridge-"));
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("bob@x.com", "Bob");
  const tokenA = await svc.issueToken("alice@x.com");
  const tokenB = await svc.issueToken("bob@x.com");
  const rooms = new RoomService(store);
  await rooms.createRoom(ROOM, "Checkout", "alice@x.com");
  await rooms.join(ROOM, "alice@x.com");
  await rooms.join(ROOM, "bob@x.com");
  if (opts.mapCwd !== false) await rooms.mapCwd(dir, ROOM);
  if (opts.writeToken !== false) writeFileSync(join(dir, "auth-token"), tokenA, { mode: 0o600 });
  const broker = new Broker({ store, identityProvider: new StorePskIdentityProvider(store), host: "127.0.0.1", port: 0, log: () => {} });
  const { port } = broker.start();
  return { dir, store, tokenA, tokenB, broker, url: `ws://127.0.0.1:${port}/ws`, dbPath: join(dir, "collab.db") };
}

describe("startRoomBridge — last-mile broker→session injection (§11.1)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  test("inert when not logged in: roomId null, never connects, emit never fires", async () => {
    const { dir, store, broker, url, dbPath } = await setup({ writeToken: false });
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));
    const emitted: string[] = [];
    const handle = await startRoomBridge({ cwd: dir, emit: (t) => emitted.push(t), store, dbPath, brokerUrl: url });
    expect(handle.roomId).toBeNull();
    await delay(80);
    expect(emitted).toEqual([]);
  });

  test("on join, the room whiteboard is rendered and injected (§4.4 new-member injection)", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    // bob publishes a task_completed first so the room has a whiteboard.
    const bob = new BrokerClient({ url, token: tokenB });
    await bob.connect();
    cleanup.push(() => bob.close());
    bob.publish(
      ROOM,
      buildTaskCompletedEnvelope({ roomId: ROOM, from: { agentId: "bob@x.com", agentType: "codex" }, summary: "auth done", contract: "auth/v1" }),
    );
    await delay(120); // let the broker append + distil the whiteboard

    // alice's room bridge starts → subscribes → broker pushes the whiteboard snapshot.
    const emitted: string[] = [];
    const handle = await startRoomBridge({ cwd: dir, emit: (t) => emitted.push(t), store, dbPath, brokerUrl: url });
    cleanup.push(() => handle.stop());
    await waitFor(() => emitted.some((t) => t.includes("📋 房间白板")));
    const wbLine = emitted.find((t) => t.includes("📋 房间白板"))!;
    expect(wbLine).toContain("auth/v1");
  });

  test("offline replay stays in the mapped room and preserves other rooms for their own session", async () => {
    const { dir, store, tokenA, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));
    await store.addMember("other", "alice@x.com");
    const makePending = (roomId: string, summary: string) => buildTaskCompletedEnvelope({
      roomId, from: { agentId: "bob@x.com", agentType: "codex" }, summary,
    });
    await store.enqueuePending("alice@x.com", makePending("other", "PRIVATE_OTHER_ROOM"));
    await store.enqueuePending("alice@x.com", makePending(ROOM, "CURRENT_ROOM"));
    const emitted: string[] = [];
    const received: string[] = [];
    const handle = await startRoomBridge({ cwd: dir, emit: t => emitted.push(t), onEvent: env => received.push(env.roomId), store, dbPath, brokerUrl: url });
    cleanup.push(() => handle.stop());
    await waitFor(() => emitted.some(t => t.includes("CURRENT_ROOM")));
    expect(emitted.some(t => t.includes("PRIVATE_OTHER_ROOM"))).toBe(false);
    expect(received).toEqual([ROOM]);
    const other = new BrokerClient({ url, token: tokenA });
    cleanup.push(() => other.close());
    const otherEvents: string[] = [];
    other.onEvent((topic, env) => { if (env.kind === "task_completed") otherEvents.push(topic); });
    await other.connect();
    other.subscribe("other");
    await waitFor(() => otherEvents.length > 0);
    expect(otherEvents).toEqual(["other"]);
  });

  test("inert when cwd is not mapped to a room", async () => {
    const { dir, store, broker, url, dbPath } = await setup({ mapCwd: false });
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));
    const handle = await startRoomBridge({ cwd: dir, emit: () => {}, store, dbPath, brokerUrl: url });
    expect(handle.roomId).toBeNull();
  });

  test("live (--room-untrusted): a peer's task_completed is rendered as an untrusted notice, injected once (deduped)", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    const emitted: string[] = [];
    const handle = await startRoomBridge({ cwd: dir, emit: (t) => emitted.push(t), store, dbPath, brokerUrl: url, untrustedRoom: true });
    expect(handle.roomId).toBe(ROOM);
    cleanup.push(() => handle.stop());
    await delay(80); // let the bridge connect + subscribe

    // bob publishes a task_completed to the room.
    const bob = new BrokerClient({ url, token: tokenB });
    await bob.connect();
    cleanup.push(() => bob.close());
    const env = buildTaskCompletedEnvelope({
      roomId: ROOM,
      from: { agentId: "bob@x.com", agentType: "codex" },
      summary: "checkout flow shipped",
      repo: "app",
      branch: "main",
    });
    expect(emitted[0]).toContain("外部不可信"); // standing security preamble injected first
    bob.publish(ROOM, env);
    await waitFor(() => emitted.some((t) => t.includes("🏁")));
    const line = emitted.find((t) => t.includes("🏁"))!;
    expect(line).toContain("checkout flow shipped");
    expect(line).toContain("📨[房间消息"); // wrapped as untrusted external input

    // Re-publish the SAME envelope (same idempotencyKey) → deduped, still one injection.
    bob.publish(ROOM, env);
    await delay(150);
    expect(emitted.filter((t) => t.includes("🏁")).length).toBe(1);
  });

  test("live (default): every member's chat is a trusted instruction, completions stay notices; no untrusted preamble", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    const emitted: string[] = [];
    const events: Array<{ text: string; trusted: boolean }> = [];
    const handle = await startRoomBridge({
      cwd: dir, emit: (t) => emitted.push(t), store, dbPath, brokerUrl: url,
      onEvent: (_env, text, trusted) => events.push({ text, trusted }),
    });
    cleanup.push(() => handle.stop());
    await delay(80);
    expect(emitted.some((t) => t.includes("外部不可信"))).toBe(false);
    expect(emitted[0]).toContain("--room-untrusted"); // startup notice says how to opt back in

    const bob = new BrokerClient({ url, token: tokenB });
    await bob.connect();
    cleanup.push(() => bob.close());
    bob.publish(ROOM, bobChat("验收交接 MR web!16"));
    await waitFor(() => events.some((e) => e.text.includes("验收交接")));
    const ev = events.find((e) => e.text.includes("验收交接"))!;
    expect(ev.trusted).toBe(true);
    expect(ev.text.startsWith("✅[房间成员指令] bob@x.com")).toBe(true);

    // A completion (auto-published by the Stop hook) is still only a notice, even in default mode.
    bob.publish(ROOM, buildTaskCompletedEnvelope({ roomId: ROOM, from: { agentId: "bob@x.com", agentType: "codex" }, summary: "shipped" }));
    await waitFor(() => events.some((e) => e.text.includes("shipped")));
    const done = events.find((e) => e.text.includes("shipped"))!;
    expect(done.trusted).toBe(false);
    expect(done.text.startsWith("📨[房间消息")).toBe(true);
  });

  test("untrustedRoom defaults from AGENTBRIDGE_ROOM_UNTRUSTED=1 (set by --room-untrusted)", async () => {
    const { dir, store, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));
    const prev = process.env.AGENTBRIDGE_ROOM_UNTRUSTED;
    process.env.AGENTBRIDGE_ROOM_UNTRUSTED = "1";
    const emitted: string[] = [];
    try {
      const handle = await startRoomBridge({ cwd: dir, emit: (t) => emitted.push(t), store, dbPath, brokerUrl: url });
      cleanup.push(() => handle.stop());
    } finally {
      if (prev === undefined) delete process.env.AGENTBRIDGE_ROOM_UNTRUSTED;
      else process.env.AGENTBRIDGE_ROOM_UNTRUSTED = prev;
    }
    expect(emitted[0]).toContain("外部不可信");
  });

  test("live (--room-untrusted): trust list is read per event — a sender trusted after startup is flagged trusted, no restart", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    const events: Array<{ text: string; trusted: boolean }> = [];
    const handle = await startRoomBridge({
      cwd: dir, emit: () => {}, store, dbPath, brokerUrl: url, untrustedRoom: true,
      onEvent: (_env, text, trusted) => events.push({ text, trusted }),
    });
    cleanup.push(() => handle.stop());
    await delay(80);

    const bob = new BrokerClient({ url, token: tokenB });
    await bob.connect();
    cleanup.push(() => bob.close());
    bob.publish(ROOM, bobChat("before trust"));
    await waitFor(() => events.some((e) => e.text.includes("before trust")));
    expect(events.find((e) => e.text.includes("before trust"))).toMatchObject({ trusted: false });

    addTrustedSender(ROOM, "bob@x.com", dbPath);
    bob.publish(ROOM, bobChat("after trust"));
    await waitFor(() => events.some((e) => e.text.includes("after trust")));
    const after = events.find((e) => e.text.includes("after trust"))!;
    expect(after.trusted).toBe(true);
    expect(after.text.startsWith("✅[房间成员指令] bob@x.com")).toBe(true);
  });
});
