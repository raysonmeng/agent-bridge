import { describe, test, expect } from "bun:test";
import { Broker } from "../broker";
import { InMemoryStore } from "../backbone/store/memory-store";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { makeEnvelope } from "../unit-test/backbone-fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Buffering WS client so no inbound message is lost between awaits. */
class WsClient {
  ws!: WebSocket;
  private q: any[] = [];
  private waiters: ((m: any) => void)[] = [];
  static async connect(url: string): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(url);
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      // Ignore presence churn (§11.1 bullet 9): these tests assert on the routing
      // of PUBLISHED envelopes, not member_joined/left (covered by broker-presence).
      if (m?.type === "event" && (m.envelope?.kind === "member_joined" || m.envelope?.kind === "member_left")) return;
      const w = c.waiters.shift();
      if (w) w(m);
      else c.q.push(m);
    };
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error("connect failed"));
    });
    return c;
  }
  next(): Promise<any> {
    const m = this.q.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((r) => this.waiters.push(r));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  /** All currently-buffered messages (no wait). */
  drainNow(): any[] {
    const all = this.q;
    this.q = [];
    return all;
  }
  close() {
    this.ws.close();
  }
}

async function start() {
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  const ids = ["alice@x.com", "bob@x.com", "carol@x.com"] as const;
  const token: Record<string, string> = {};
  for (const id of ids) {
    await svc.registerIdentity(id, id);
    token[id] = await svc.issueToken(id);
  }
  const broker = new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  const { port } = broker.start();
  return { broker, store, token, url: `ws://127.0.0.1:${port}/ws` };
}

async function join(url: string, token: string, topic: string): Promise<WsClient> {
  const c = await WsClient.connect(url);
  c.send({ type: "hello", token });
  await c.next(); // welcome
  c.send({ type: "subscribe", topic });
  await c.next(); // subscribed
  return c;
}

describe("Broker routing (§3.2): DM / broadcast / hop / offline replay", () => {
  test("DM (`to`) reaches only the named target, not other room members", async () => {
    const { broker, store, token, url } = await start();
    const bob = await join(url, token["bob@x.com"]!, "r");
    const carol = await join(url, token["carol@x.com"]!, "r");
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({ messageId: "dm1", to: ["bob@x.com"], deliveryMode: "online_only" }),
      });
      const got = await bob.next();
      expect(got).toMatchObject({ type: "event", envelope: { messageId: "dm1" } });
      await sleep(40);
      expect(carol.drainNow()).toEqual([]); // carol (a room member) does NOT see the DM
    } finally {
      bob.close();
      carol.close();
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("broadcast reaches all room members EXCEPT the sender (loop prevention)", async () => {
    const { broker, store, token, url } = await start();
    const bob = await join(url, token["bob@x.com"]!, "r");
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({ messageId: "bc1", deliveryMode: "online_only" }),
      });
      expect(await bob.next()).toMatchObject({ type: "event", envelope: { messageId: "bc1" } });
      await sleep(40);
      expect(alice.drainNow()).toEqual([]); // sender never receives its own broadcast
    } finally {
      bob.close();
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("hop<=0 is dropped (multi-hop loop guard)", async () => {
    const { broker, store, token, url } = await start();
    const bob = await join(url, token["bob@x.com"]!, "r");
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({ messageId: "hop0", hop: 0, deliveryMode: "online_only" }),
      });
      await sleep(40);
      expect(bob.drainNow()).toEqual([]); // dropped, nobody receives
    } finally {
      bob.close();
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("store_if_offline DM is queued for an offline target and drained on reconnect", async () => {
    const { broker, store, token, url } = await start();
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      // bob is NOT connected — the DM must be persisted for him.
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({
          roomId: "r",
          messageId: "queued1",
          to: ["bob@x.com"],
          deliveryMode: "store_if_offline",
        }),
      });
      await sleep(40);
      // bob connects → drains the queued DM on welcome
      const bob = await WsClient.connect(url);
      bob.send({ type: "hello", token: token["bob@x.com"]! });
      expect(await bob.next()).toMatchObject({ type: "welcome" });
      expect(await bob.next()).toMatchObject({ type: "event", envelope: { messageId: "queued1" } });
      bob.close();
    } finally {
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("rejects an envelope with a missing/non-object from (anti-spoof guard)", async () => {
    const { broker, store, token, url } = await start();
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      const env = makeEnvelope({ messageId: "noFrom", deliveryMode: "online_only" });
      delete (env as { from?: unknown }).from;
      alice.send({ type: "publish", topic: "r", envelope: env });
      expect(await alice.next()).toMatchObject({ type: "error" }); // rejected, never fanned out
    } finally {
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("rejects a string `to` (would degrade DM to a substring match → leak)", async () => {
    const { broker, store, token, url } = await start();
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      const env = makeEnvelope({ messageId: "strTo", deliveryMode: "online_only" });
      (env as { to?: unknown }).to = "bob@x.com"; // a string, not an array
      alice.send({ type: "publish", topic: "r", envelope: env });
      expect(await alice.next()).toMatchObject({ type: "error" });
    } finally {
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("rejects a second hello on an authenticated socket (no identity rebind)", async () => {
    const { broker, store, token, url } = await start();
    const c = await WsClient.connect(url);
    try {
      c.send({ type: "hello", token: token["alice@x.com"]! });
      expect(await c.next()).toMatchObject({ type: "welcome" });
      c.send({ type: "hello", token: token["bob@x.com"]! });
      expect(await c.next()).toMatchObject({ type: "error" });
    } finally {
      c.close();
      broker.stop();
      await store.close();
    }
  });

  test("a DM sent while connected-but-not-subscribed is drained on subscribe (no gap loss)", async () => {
    const { broker, store, token, url } = await start();
    const alice = await join(url, token["alice@x.com"]!, "r");
    const bob = await WsClient.connect(url);
    bob.send({ type: "hello", token: token["bob@x.com"]! });
    await bob.next(); // welcome (drain empty — bob not subscribed yet)
    try {
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({
          roomId: "r",
          messageId: "gap1",
          to: ["bob@x.com"],
          deliveryMode: "store_if_offline",
        }),
      });
      await sleep(40);
      bob.send({ type: "subscribe", topic: "r" }); // now reachable → drains the gap-window DM
      expect(await bob.next()).toMatchObject({ type: "subscribed" });
      expect(await bob.next()).toMatchObject({ type: "event", envelope: { messageId: "gap1" } });
    } finally {
      alice.close();
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("rejects an envelope missing idempotencyKey (offline-replay load-bearing field)", async () => {
    const { broker, store, token, url } = await start();
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      const env = makeEnvelope({
        roomId: "r",
        messageId: "noKey",
        to: ["bob@x.com"],
        deliveryMode: "store_if_offline",
      });
      delete (env as { idempotencyKey?: unknown }).idempotencyKey;
      alice.send({ type: "publish", topic: "r", envelope: env });
      expect(await alice.next()).toMatchObject({ type: "error" });
    } finally {
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("an empty `to: []` delivers to nobody (never degrades to a broadcast)", async () => {
    const { broker, store, token, url } = await start();
    const bob = await join(url, token["bob@x.com"]!, "r");
    const alice = await join(url, token["alice@x.com"]!, "r");
    try {
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({ roomId: "r", messageId: "emptyTo", to: [], deliveryMode: "online_only" }),
      });
      await sleep(40);
      expect(bob.drainNow()).toEqual([]); // an empty DM target list reaches nobody
    } finally {
      bob.close();
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("offline DM round-trips through the production SqliteStore (closes the InMemoryStore blind spot)", async () => {
    const store = new SqliteStore(":memory:");
    const svc = new IdentityService(store);
    await svc.registerIdentity("alice@x.com", "Alice");
    await svc.registerIdentity("bob@x.com", "Bob");
    const tokA = await svc.issueToken("alice@x.com");
    const tokB = await svc.issueToken("bob@x.com");
    const broker = new Broker({
      store,
      identityProvider: new StorePskIdentityProvider(store),
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    const { port } = broker.start();
    const url = `ws://127.0.0.1:${port}/ws`;
    const alice = await join(url, tokA, "r");
    try {
      alice.send({
        type: "publish",
        topic: "r",
        envelope: makeEnvelope({
          roomId: "r",
          messageId: "sql1",
          idempotencyKey: "sk1",
          to: ["bob@x.com"],
          deliveryMode: "store_if_offline",
        }),
      });
      await sleep(40);
      const bob = await WsClient.connect(url);
      bob.send({ type: "hello", token: tokB });
      expect(await bob.next()).toMatchObject({ type: "welcome" });
      expect(await bob.next()).toMatchObject({ type: "event", envelope: { messageId: "sql1" } });
      bob.close();
    } finally {
      alice.close();
      broker.stop();
      await store.close();
    }
  });

  test("a store error during reconnect-drain does NOT close the already-welcomed connection", async () => {
    const store = new InMemoryStore();
    const svc = new IdentityService(store);
    await svc.registerIdentity("alice@x.com", "Alice");
    const token = await svc.issueToken("alice@x.com");
    (store as { drainPending: unknown }).drainPending = async () => {
      throw new Error("boom");
    };
    const broker = new Broker({
      store,
      identityProvider: new StorePskIdentityProvider(store),
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    const { port } = broker.start();
    const c = await WsClient.connect(`ws://127.0.0.1:${port}/ws`);
    try {
      c.send({ type: "hello", token });
      expect(await c.next()).toMatchObject({ type: "welcome" }); // welcomed despite drain error
      c.send({ type: "subscribe", topic: "r" });
      expect(await c.next()).toMatchObject({ type: "subscribed" }); // still usable, not closed
    } finally {
      c.close();
      broker.stop();
      await store.close();
    }
  });
});
