import { describe, test, expect, afterEach } from "bun:test";
import { Broker } from "../broker";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { buildTaskCompletedEnvelope } from "../task-completed";
import type { Store } from "../backbone/store";

const ROOM = "checkout";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw buffering WS client so we can observe non-event frames (e.g. `whiteboard`). */
class WsClient {
  ws!: WebSocket;
  frames: any[] = [];
  static async connect(url: string): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(url);
    c.ws.onmessage = (ev) => c.frames.push(JSON.parse(ev.data as string));
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error("ws connect failed"));
    });
    return c;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
  async helloAndSubscribe(token: string) {
    this.send({ type: "hello", token });
    await sleep(30);
    this.send({ type: "subscribe", topic: ROOM });
    await sleep(40);
  }
}

async function startBroker(store: Store = new InMemoryStore()) {
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("bob@x.com", "Bob");
  const tokenA = await svc.issueToken("alice@x.com");
  const tokenB = await svc.issueToken("bob@x.com");
  await store.addMember(ROOM, "alice@x.com"); // room authz (§11.2)
  await store.addMember(ROOM, "bob@x.com");
  const broker = new Broker({ store, identityProvider: new StorePskIdentityProvider(store), host: "127.0.0.1", port: 0, log: () => {} });
  const { port } = broker.start();
  return { broker, store, tokenA, tokenB, url: `ws://127.0.0.1:${port}/ws` };
}

function taskEnv(summary: string, contract?: string) {
  return buildTaskCompletedEnvelope({ roomId: ROOM, from: { agentId: "bob@x.com", agentType: "codex" }, summary, contract });
}

describe("Broker room memory — ledger + whiteboard (§4)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  test("a published task_completed is appended to the ledger; broker-synthesized presence is NOT", async () => {
    const { broker, store, tokenA, tokenB, url } = await startBroker();
    cleanup.push(() => broker.stop());
    const alice = await WsClient.connect(url); // subscribing alice triggers a member_joined (presence)
    cleanup.push(() => alice.close());
    await alice.helloAndSubscribe(tokenA);

    const bob = await WsClient.connect(url);
    cleanup.push(() => bob.close());
    bob.send({ type: "hello", token: tokenB });
    await sleep(30);
    bob.send({ type: "publish", topic: ROOM, envelope: taskEnv("auth done", "auth/v1") });
    await sleep(60);

    const events = await store.getRecentEvents(ROOM, 10);
    expect(events).toHaveLength(1); // ONLY the task_completed — presence never hits the ledger
    expect(events[0]!.kind).toBe("task_completed");
    const wb = await store.getWhiteboard(ROOM);
    expect(wb!.recentMilestones).toHaveLength(1);
    expect(wb!.contractsReady[0]).toMatchObject({ contract: "auth/v1" });
  });

  test("a new member is handed the whiteboard on join (only on the 0→1 transition)", async () => {
    const { broker, store, tokenA, tokenB, url } = await startBroker();
    cleanup.push(() => broker.stop());
    // bob publishes first so the whiteboard has content.
    const bob = await WsClient.connect(url);
    cleanup.push(() => bob.close());
    bob.send({ type: "hello", token: tokenB });
    await sleep(30);
    bob.send({ type: "publish", topic: ROOM, envelope: taskEnv("checkout shipped", "checkout/v1") });
    await sleep(50);
    expect((await store.getWhiteboard(ROOM))!.contractsReady).toHaveLength(1);

    // alice joins → receives a whiteboard frame.
    const alice = await WsClient.connect(url);
    cleanup.push(() => alice.close());
    await alice.helloAndSubscribe(tokenA);
    const wbFrame = alice.frames.find((f) => f.type === "whiteboard");
    expect(wbFrame).toBeDefined();
    expect(wbFrame.roomId).toBe(ROOM);
    expect(wbFrame.whiteboard.contractsReady[0]).toMatchObject({ contract: "checkout/v1" });

    // a second subscribe on the SAME connection must not re-inject (no 0→1).
    const before = alice.frames.filter((f) => f.type === "whiteboard").length;
    alice.send({ type: "subscribe", topic: ROOM });
    await sleep(40);
    expect(alice.frames.filter((f) => f.type === "whiteboard").length).toBe(before);
  });

  test("private completions never reach an unrelated member through the whiteboard", async () => {
    const { broker, store, tokenA, tokenB, url } = await startBroker();
    cleanup.push(() => broker.stop());
    const svc = new IdentityService(store);
    await svc.registerIdentity("carol@x.com", "Carol");
    await store.addMember(ROOM, "carol@x.com");
    const tokenC = await svc.issueToken("carol@x.com");
    const alice = await WsClient.connect(url);
    const bob = await WsClient.connect(url);
    cleanup.push(() => alice.close(), () => bob.close());
    await alice.helloAndSubscribe(tokenA);
    await bob.helloAndSubscribe(tokenB);
    bob.send({ type: "publish", topic: ROOM, envelope: { ...taskEnv("PRIVATE_COMPLETION", "private/v1"), to: ["alice@x.com"] } });
    await sleep(60);
    expect(alice.frames.some(f => f.envelope?.payload?.summary === "PRIVATE_COMPLETION")).toBe(true);
    expect(await store.getWhiteboard(ROOM)).toBeNull();
    const carol = await WsClient.connect(url);
    cleanup.push(() => carol.close());
    await carol.helloAndSubscribe(tokenC);
    expect(JSON.stringify(carol.frames)).not.toContain("PRIVATE_COMPLETION");
    expect(JSON.stringify(carol.frames)).not.toContain("private/v1");
  });

  test("a ledger-write failure does NOT block live delivery (best-effort)", async () => {
    const store = new InMemoryStore();
    (store as unknown as { appendEvent: () => Promise<void> }).appendEvent = () => Promise.reject(new Error("ledger down"));
    const { broker, tokenA, tokenB, url } = await startBroker(store);
    cleanup.push(() => broker.stop());
    const alice = await WsClient.connect(url);
    cleanup.push(() => alice.close());
    await alice.helloAndSubscribe(tokenA);

    const bob = await WsClient.connect(url);
    cleanup.push(() => bob.close());
    bob.send({ type: "hello", token: tokenB });
    await sleep(30);
    bob.send({ type: "publish", topic: ROOM, envelope: taskEnv("still delivered") });
    await sleep(60);

    // alice still received the event despite appendEvent throwing.
    const evt = alice.frames.find((f) => f.type === "event" && f.envelope?.kind === "task_completed");
    expect(evt).toBeDefined();
    expect(evt.envelope.payload.summary).toBe("still delivered");
  });
});
