/**
 * Room-password self-service join (§11.2): an already-AUTHENTICATED identity that is NOT a member
 * can add itself to a room by presenting the room password, which the broker verifies against the
 * stored hash. Covers the full path store → broker → BrokerClient.joinWithPassword end-to-end.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { RoomService } from "../room-service";
import { hashPassword } from "../backbone/password";
import { joinRoomWithPassword } from "../cli/room";
import { makeEnvelope } from "../unit-test/backbone-fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Broker + store with alice (owner/member of `r` and `np`) and bob (a NON-member). `r` has a password. */
async function startBroker() {
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("bob@x.com", "Bob");
  const tokenA = await svc.issueToken("alice@x.com");
  const tokenB = await svc.issueToken("bob@x.com");
  const rooms = new RoomService(store);
  await rooms.createRoom("r", "Room", "alice@x.com");
  await rooms.join("r", "alice@x.com");
  await store.setRoomPassword("r", hashPassword("secret"));
  await rooms.createRoom("np", "NoPass", "alice@x.com"); // invite-only (no password)
  await rooms.join("np", "alice@x.com");
  const broker = new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: "127.0.0.1",
    port: 0,
    memberCacheTtlMs: 0,
    log: () => {},
  });
  const { port } = broker.start();
  return { store, broker, tokenA, tokenB, url: `ws://127.0.0.1:${port}/ws` };
}

describe("room-password self-service join (§11.2)", () => {
  test("right password → broker grants membership; the joiner can then subscribe + receive", async () => {
    const { store, broker, tokenA, tokenB, url } = await startBroker();
    const alice = new BrokerClient({ url, token: tokenA, log: () => {} });
    const bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      expect(await store.getMembers("r")).not.toContain("bob@x.com"); // closed-by-default before join
      await bob.joinWithPassword("r", "secret"); // resolves on the broker's `joined`
      expect(await store.getMembers("r")).toContain("bob@x.com"); // broker granted PERSISTENT membership

      const got: string[] = [];
      bob.onEvent((_t, env) => got.push(env.messageId));
      bob.subscribe("r");
      await sleep(60);
      await alice.connect();
      alice.publish("r", makeEnvelope({ messageId: "e1", roomId: "r" }));
      await sleep(60);
      expect(got).toEqual(["e1"]); // the freshly self-joined member receives room events
    } finally {
      alice.close();
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("wrong password → rejected, no membership granted", async () => {
    const { store, broker, tokenB, url } = await startBroker();
    const bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      await expect(bob.joinWithPassword("r", "nope")).rejects.toThrow(/invalid room or password/);
      expect(await store.getMembers("r")).not.toContain("bob@x.com");
    } finally {
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("a room with NO password rejects self-join (invite-only stays closed)", async () => {
    const { store, broker, tokenB, url } = await startBroker();
    const bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      // Same generic reason as a wrong password — a prober can't tell "no such / invite-only room"
      // from "wrong password".
      await expect(bob.joinWithPassword("np", "anything")).rejects.toThrow(/invalid room or password/);
      await expect(bob.joinWithPassword("does-not-exist", "anything")).rejects.toThrow(/invalid room or password/);
      expect(await store.getMembers("np")).not.toContain("bob@x.com");
    } finally {
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("throttles after MAX_JOIN_FAILS wrong attempts — even the RIGHT password is then refused", async () => {
    const { store, broker, tokenB, url } = await startBroker();
    const bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      for (let i = 0; i < 5; i++) {
        await expect(bob.joinWithPassword("r", "wrong")).rejects.toThrow(/invalid room or password/);
      }
      // 6th attempt is throttled regardless of correctness — online brute force is rate-capped.
      await expect(bob.joinWithPassword("r", "secret")).rejects.toThrow(/too many attempts/);
      expect(await store.getMembers("r")).not.toContain("bob@x.com");
    } finally {
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("throttle is per-IDENTITY — reconnecting on a fresh socket does NOT reset the lockout (R1)", async () => {
    const { store, broker, tokenB, url } = await startBroker();
    let bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      for (let i = 0; i < 5; i++) {
        await expect(bob.joinWithPassword("r", "wrong")).rejects.toThrow(/invalid room or password/);
      }
      bob.close(); // drop the connection entirely
      // Reconnect as the SAME identity (same token) on a brand-new socket — the lockout must persist,
      // because the counter is keyed to the authenticated identity, not the socket.
      bob = new BrokerClient({ url, token: tokenB, log: () => {} });
      await bob.connect();
      await expect(bob.joinWithPassword("r", "secret")).rejects.toThrow(/too many attempts/);
      expect(await store.getMembers("r")).not.toContain("bob@x.com");
    } finally {
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("lockout EXPIRES — after the window a legitimate user gets a fresh attempt budget", async () => {
    const store = new InMemoryStore();
    const svc = new IdentityService(store);
    await svc.registerIdentity("bob@x.com", "Bob");
    const tokenB = await svc.issueToken("bob@x.com");
    const rooms = new RoomService(store);
    await rooms.createRoom("r", "Room", "alice@x.com");
    await store.setRoomPassword("r", hashPassword("secret"));
    const broker = new Broker({
      store,
      identityProvider: new StorePskIdentityProvider(store),
      host: "127.0.0.1",
      port: 0,
      memberCacheTtlMs: 0,
      joinLockoutMs: 80, // short lockout so the test can wait it out
      log: () => {},
    });
    const { port } = broker.start();
    const bob = new BrokerClient({ url: `ws://127.0.0.1:${port}/ws`, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      for (let i = 0; i < 5; i++) {
        await expect(bob.joinWithPassword("r", "wrong")).rejects.toThrow(/invalid room or password/);
      }
      await expect(bob.joinWithPassword("r", "secret")).rejects.toThrow(/too many attempts/); // locked
      await sleep(130); // wait out the 80ms lockout window
      await bob.joinWithPassword("r", "secret"); // recovered → the right password now succeeds
      expect(await store.getMembers("r")).toContain("bob@x.com");
    } finally {
      bob.close();
      broker.stop();
      await store.close();
    }
  });

  test("an empty password is rejected by the broker", async () => {
    const { broker, tokenB, url } = await startBroker();
    const bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await bob.connect();
      await expect(bob.joinWithPassword("r", "")).rejects.toThrow(/missing password/);
    } finally {
      bob.close();
      broker.stop();
    }
  });

  test("joinWithPassword before connect() rejects (no live socket)", async () => {
    const { broker, tokenB, url } = await startBroker();
    const bob = new BrokerClient({ url, token: tokenB, log: () => {} });
    try {
      await expect(bob.joinWithPassword("r", "secret")).rejects.toThrow(/not connected/);
    } finally {
      bob.close();
      broker.stop();
    }
  });

  test("joinRoomWithPassword (CLI): edge self-joins via the broker — broker store gets membership, edge store only maps cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abg-pwjoin-broker-"));
    const edgeDir = mkdtempSync(join(tmpdir(), "abg-pwjoin-edge-"));
    const brokerDb = join(dir, "collab.db");
    const edgeDb = join(edgeDir, "collab.db");
    const store = new SqliteStore(brokerDb);
    const svc = new IdentityService(store);
    await svc.registerIdentity("alice@x.com", "Alice");
    await svc.registerIdentity("bob@x.com", "Bob");
    const tokenB = await svc.issueToken("bob@x.com");
    const rooms = new RoomService(store);
    await rooms.createRoom("vault", "Vault", "alice@x.com");
    await rooms.join("vault", "alice@x.com");
    await store.setRoomPassword("vault", hashPassword("opensesame"));
    const broker = new Broker({
      store,
      identityProvider: new StorePskIdentityProvider(store),
      host: "127.0.0.1",
      port: 0,
      memberCacheTtlMs: 0,
      log: () => {},
    });
    const { port } = broker.start();
    const url = `ws://127.0.0.1:${port}/ws`;
    writeFileSync(join(edgeDir, "auth-token"), tokenB, { mode: 0o600 }); // bob's broker-issued token, edge-side
    try {
      await joinRoomWithPassword({ roomId: "vault", password: "opensesame", cwd: edgeDir, dbPath: edgeDb, brokerUrl: url });
      // membership granted in the BROKER store …
      expect(await new RoomService(store).getMembers("vault")).toContain("bob@x.com");
      // … while the EDGE store only records the cwd→room hint (no local membership — broker is authoritative)
      const edge = new SqliteStore(edgeDb);
      try {
        expect(await new RoomService(edge).resolveRoomForCwd(edgeDir)).toBe("vault");
        expect(await new RoomService(edge).getMembers("vault")).toEqual([]);
      } finally {
        await edge.close();
      }
      // wrong password → throws the broker's reason (a fresh connection, so not throttled)
      await expect(
        joinRoomWithPassword({ roomId: "vault", password: "WRONG", cwd: edgeDir, dbPath: edgeDb, brokerUrl: url }),
      ).rejects.toThrow(/invalid room or password/);
    } finally {
      broker.stop();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(edgeDir, { recursive: true, force: true });
    }
  });
});
