/**
 * Cross-machine onboarding — the honest end-to-end proof (V3 §11.1 / gap-fix T8).
 *
 * The bug this fixes: the broker validates a presented token against ITS OWN Store
 * (StorePskIdentityProvider) and membership against ITS OWN Store (getMembers), but
 * the legacy `abg auth login` self-signed only in the EDGE's local Store — so an edge
 * token never authenticated against a remote broker (4401), and the two Stores were
 * physically isolated with zero bridge.
 *
 * These tests use TWO physically separate SqliteStore files (machine A = the broker
 * host + the operator; machine B = a remote edge) and drive the REAL CLI primitives
 * and the REAL edge entry point (startRoomBridge) — NOT a shared store, NOT a direct
 * BrokerClient shortcut. The only thing that crosses the "machine boundary" is the
 * token STRING (carried out-of-band), exactly as a human would copy it.
 *
 * Positive: A issues+invites bob → bob's token is installed on B's separate store →
 * `abg join` (remote) maps only the cwd → the edge connects with the carried token →
 * a completion published on A is delivered to B. B's store holds NO room and NO
 * membership the whole time — the broker (store A) is the sole authority.
 *
 * Negative (the pre-fix root cause): a token self-signed in a DIFFERENT store (never
 * issued by the broker's store A) is rejected by the broker — proving the broker
 * really validates against its own store, which is exactly why `auth issue` (sign IN
 * the broker store) is the fix and `auth login` self-sign on the edge was broken.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { RoomService } from "../room-service";
import { readAuthToken } from "../collab-store";
import { authLogin, installToken } from "../cli/auth";
import { createRoom, inviteRoomMember, joinRoom } from "../cli/room";
import { startRoomBridge } from "../room-bridge";
import { publishCompletion } from "../cli/publish";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(20);
  }
}

/**
 * Machine A: the broker host + operator. A temp dir with its OWN collab.db. Operator
 * "alice" logs in (self-sign on store A — she IS on the broker machine) and creates
 * the room. The broker is backed by store A with member-authz reading fresh (ttl 0).
 */
async function machineA(): Promise<{
  dirA: string;
  dbPathA: string;
  storeA: SqliteStore;
  broker: Broker;
  url: string;
  ROOM: string;
}> {
  const dirA = mkdtempSync(join(tmpdir(), "abg-xnet-A-"));
  const dbPathA = join(dirA, "collab.db");
  await authLogin({ id: "alice@x.com", name: "Alice", dbPath: dbPathA }); // operator on the broker machine
  const { roomId: ROOM } = await createRoom({ name: "checkout", cwd: dirA, dbPath: dbPathA }); // creator=member, cwd mapped

  const storeA = new SqliteStore(dbPathA); // the broker's long-lived handle on store A
  const broker = new Broker({
    store: storeA,
    identityProvider: new StorePskIdentityProvider(storeA),
    host: "127.0.0.1",
    port: 0,
    memberCacheTtlMs: 0, // re-read membership from store A on every check (no stale cache)
    log: () => {},
  });
  const { port } = broker.start();
  return { dirA, dbPathA, storeA, broker, url: `ws://127.0.0.1:${port}/ws`, ROOM };
}

describe("跨机 onboarding 端到端（多独立 store，绝不共享）", () => {
  let cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  test("store A 签发的 token 装到独立 store B → join → 连 broker → B 收到房间事件；B 本地零房间/零成员", async () => {
    const A = await machineA();
    cleanup.push(() => A.broker.stop(), () => A.storeA.close(), () => rmSync(A.dirA, { recursive: true, force: true }));

    // Operator on A invites bob: issues a token IN store A + adds bob to the room IN store A.
    // This token is the ONLY thing carried out-of-band to machine B.
    const invite = await inviteRoomMember({ roomId: A.ROOM, identityId: "bob@x.com", name: "Bob", dbPath: A.dbPathA });
    const bobToken = invite.token;
    expect(bobToken).toBeTruthy();

    // ---- Machine B: a SEPARATE, initially-empty store. Only the token string crossed. ----
    const dirB = mkdtempSync(join(tmpdir(), "abg-xnet-B-"));
    const dbPathB = join(dirB, "collab.db");
    cleanup.push(() => rmSync(dirB, { recursive: true, force: true }));

    await installToken({ token: bobToken, dbPath: dbPathB }); // = `abg auth login --token <T>`
    const joined = await joinRoom({ roomId: A.ROOM, cwd: dirB, dbPath: dbPathB }); // = `abg join` (remote)
    expect(joined).toEqual({ roomId: A.ROOM, agentId: null, local: false });

    // HONESTY: the two stores are physically separate files; B has NO room and NO
    // membership — only a cwd→room routing hint and the carried token file.
    expect(dbPathB).not.toBe(A.dbPathA);
    const sB = new SqliteStore(dbPathB);
    try {
      expect(await new RoomService(sB).getRoom(A.ROOM)).toBeNull(); // room was NEVER created on B
      expect(await new RoomService(sB).getMembers(A.ROOM)).toEqual([]); // bob is NOT a local member on B
      expect(await new RoomService(sB).resolveRoomForCwd(dirB)).toBe(A.ROOM); // just a routing hint
      expect(await sB.resolveToken(bobToken)).toBeNull(); // B's store can't even resolve the token — only store A holds the binding
    } finally {
      await sB.close();
    }
    expect(readAuthToken(dbPathB)).toBe(bobToken); // B's sole credential = the carried token
    // Membership lives ONLY in the broker's store A.
    expect(await new RoomService(A.storeA).getMembers(A.ROOM)).toContain("bob@x.com");

    // ---- Machine B edge connects via the REAL entry point: it reads its OWN auth-token,
    //      resolves the room from its OWN cwd map, and connects with the carried token. ----
    const emitted: string[] = [];
    const bridge = await startRoomBridge({
      cwd: dirB,
      emit: (t) => emitted.push(t),
      dbPath: dbPathB,
      brokerUrl: A.url,
      log: () => {},
    });
    cleanup.push(() => bridge.stop());
    expect(bridge.roomId).toBe(A.ROOM); // edge went ACTIVE (token present + cwd mapped), not inert
    await delay(250); // let the connection + subscribe land

    // ---- Machine A publishes a completion to the room ----
    const res = await publishCompletion({
      store: A.storeA,
      dbPath: A.dbPathA,
      cwd: A.dirA,
      brokerUrl: A.url,
      argv: ["--summary", "跨机契约 auth/v1", "--repo", "app", "--unblocks", "bob@x.com"],
    });
    expect(res.status).toBe("published");
    expect(res.roomId).toBe(A.ROOM);

    // ---- B receives it — delivered across two physically separate stores ----
    await waitFor(() => emitted.some((t) => t.includes("跨机契约 auth/v1")));
    const hit = emitted.find((t) => t.includes("跨机契约 auth/v1"))!;
    expect(hit).toContain("🏁 完成任务");
    expect(hit).toContain("app");
  });

  test("边机本地自签的 token（不在 broker store A）被 broker 拒——这正是修复前的根因", async () => {
    const A = await machineA();
    cleanup.push(() => A.broker.stop(), () => A.storeA.close(), () => rmSync(A.dirA, { recursive: true, force: true }));

    // Machine C self-signs locally with `abg auth login --id --name`: the (token→identity)
    // binding lands in store C, NEVER in the broker's store A.
    const dirC = mkdtempSync(join(tmpdir(), "abg-xnet-C-"));
    const dbPathC = join(dirC, "collab.db");
    cleanup.push(() => rmSync(dirC, { recursive: true, force: true }));
    const self = await authLogin({ id: "bob@x.com", name: "Bob", dbPath: dbPathC });

    // The self-signed token authenticates against ITS OWN store C …
    const sC = new SqliteStore(dbPathC);
    try {
      expect(await new StorePskIdentityProvider(sC).authenticate(self.token)).toEqual({
        id: "bob@x.com",
        displayName: "Bob",
      });
    } finally {
      await sC.close();
    }
    // … but NOT against the broker's store A (it never issued it).
    await expect(new StorePskIdentityProvider(A.storeA).authenticate(self.token)).rejects.toThrow(/invalid PSK token/);

    // So the edge connect fails at the broker (the old broken path: self-sign on the edge → 4401).
    const c = new BrokerClient({ url: A.url, token: self.token, log: () => {} });
    try {
      await expect(c.connect()).rejects.toThrow();
    } finally {
      c.close();
    }
  });
});
