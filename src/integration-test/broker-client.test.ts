import { describe, test, expect } from "bun:test";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { makeEnvelope } from "../unit-test/backbone-fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startBroker() {
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  const token = await svc.issueToken("alice@x.com");
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

describe("BrokerClient ↔ real Broker", () => {
  test("connects, authenticates, and round-trips an event", async () => {
    const { broker, store, token, url } = await startBroker();
    const c = new BrokerClient({ url, token, log: () => {} });
    try {
      expect(await c.connect()).toEqual({ id: "alice@x.com", displayName: "Alice" });
      const got: string[] = [];
      c.onEvent((_topic, env) => got.push(env.messageId));
      c.subscribe("room-1");
      await sleep(60); // let subscribe + ack land
      c.publish("room-1", makeEnvelope({ messageId: "e1" }));
      await sleep(60);
      expect(got).toEqual(["e1"]);
    } finally {
      c.close();
      broker.stop();
      await store.close();
    }
  });

  test("fans out across clients: A publishes, B receives", async () => {
    const { broker, store, token, url } = await startBroker();
    const a = new BrokerClient({ url, token, log: () => {} });
    const b = new BrokerClient({ url, token, log: () => {} });
    try {
      await a.connect();
      await b.connect();
      const got: string[] = [];
      b.onEvent((_topic, env) => got.push(env.messageId));
      b.subscribe("room-x");
      await sleep(60);
      a.publish("room-x", makeEnvelope({ messageId: "x1" }));
      await sleep(60);
      expect(got).toEqual(["x1"]);
    } finally {
      a.close();
      b.close();
      broker.stop();
      await store.close();
    }
  });

  test("rejects a bad token", async () => {
    const { broker, store, url } = await startBroker();
    const c = new BrokerClient({ url, token: "not-a-real-token", log: () => {} });
    try {
      await expect(c.connect()).rejects.toThrow();
    } finally {
      c.close();
      broker.stop();
      await store.close();
    }
  });
});
