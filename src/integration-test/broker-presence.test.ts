import { describe, test, expect, afterEach } from "bun:test";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import type { Envelope } from "../backbone/envelope";

const ROOM = "checkout";

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

async function startBroker() {
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("bob@x.com", "Bob");
  const tokenA = await svc.issueToken("alice@x.com");
  const tokenB = await svc.issueToken("bob@x.com");
  const broker = new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  const { port } = broker.start();
  return { broker, tokenA, tokenB, url: `ws://127.0.0.1:${port}/ws` };
}

/** A subscribed BrokerClient that records every event it receives. */
async function subscriber(url: string, token: string, presence?: Record<string, unknown>) {
  const client = new BrokerClient({ url, token, presence: presence as never });
  const events: Envelope[] = [];
  client.onEvent((_topic, env) => events.push(env));
  await client.connect();
  client.subscribe(ROOM);
  await delay(60); // let the subscribe register at the broker
  return { client, events };
}

describe("Broker presence — member_joined / member_left (§11.1 bullet 9)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  test("an existing subscriber sees member_joined (with reserved meta); the joiner does not see its own", async () => {
    const { broker, tokenA, tokenB, url } = await startBroker();
    cleanup.push(() => broker.stop());

    const bob = await subscriber(url, tokenB);
    const alice = await subscriber(url, tokenA, { agentType: "claude", host: "tailnet-1", capabilities: ["review"] });
    cleanup.push(() => bob.client.close(), () => alice.client.close());

    await waitFor(() => bob.events.some((e) => e.kind === "member_joined" && e.from.agentId === "alice@x.com"));
    const joined = bob.events.find((e) => e.kind === "member_joined" && e.from.agentId === "alice@x.com")!;
    expect(joined.deliveryMode).toBe("online_only");
    expect(joined.from.agentType).toBe("claude");
    expect(joined.payload).toMatchObject({ displayName: "Alice", host: "tailnet-1", capabilities: ["review"] });

    // self-skip: alice never receives her own join
    expect(alice.events.some((e) => e.kind === "member_joined" && e.from.agentId === "alice@x.com")).toBe(false);
  });

  test("member_left fires when a member disconnects", async () => {
    const { broker, tokenA, tokenB, url } = await startBroker();
    cleanup.push(() => broker.stop());
    const bob = await subscriber(url, tokenB);
    const alice = await subscriber(url, tokenA);
    cleanup.push(() => bob.client.close());

    await waitFor(() => bob.events.some((e) => e.kind === "member_joined" && e.from.agentId === "alice@x.com"));
    alice.client.close(); // disconnect

    await waitFor(() => bob.events.some((e) => e.kind === "member_left" && e.from.agentId === "alice@x.com"));
  });

  test("a second connection for the same identity does not re-announce; member_left only on the last leave", async () => {
    const { broker, tokenA, tokenB, url } = await startBroker();
    cleanup.push(() => broker.stop());
    const bob = await subscriber(url, tokenB);
    cleanup.push(() => bob.client.close());

    const a1 = await subscriber(url, tokenA);
    await waitFor(() => bob.events.filter((e) => e.kind === "member_joined" && e.from.agentId === "alice@x.com").length === 1);

    const a2 = await subscriber(url, tokenA); // same identity, second connection
    await delay(120);
    // still exactly one member_joined — alice was already present
    expect(bob.events.filter((e) => e.kind === "member_joined" && e.from.agentId === "alice@x.com").length).toBe(1);

    a1.client.close(); // one of two connections leaves
    await delay(120);
    expect(bob.events.some((e) => e.kind === "member_left" && e.from.agentId === "alice@x.com")).toBe(false);

    a2.client.close(); // last connection leaves
    await waitFor(() => bob.events.some((e) => e.kind === "member_left" && e.from.agentId === "alice@x.com"));
  });
});
