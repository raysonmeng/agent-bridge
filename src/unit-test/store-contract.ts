import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MAX_PENDING_PER_TARGET } from "../backbone/store";
import type { Store } from "../backbone/store";
import { makeEnvelope } from "./backbone-fixtures";
import { hashToken } from "../backbone/token-hash";

/**
 * Shared Store contract (NOT a *.test.ts — imported by per-impl driver tests).
 * Every Store implementation MUST pass this identical suite (§6.4: "one contract,
 * both implementations pass" — proves the interface isn't polluted by impl detail).
 */
export function runStoreContract(label: string, makeStore: () => Store) {
  describe(`Store contract — ${label}`, () => {
    let store: Store;
    beforeEach(() => {
      store = makeStore();
    });
    afterEach(async () => {
      await store.close();
    });

    test("upsertIdentity is idempotent on id (same email reuses the row)", async () => {
      const a = await store.upsertIdentity("alice@x.com", "Alice");
      expect(a).toEqual({ id: "alice@x.com", displayName: "Alice" });
      // Re-register the same id (a second device) → still one row, id stable, name updated.
      await store.upsertIdentity("alice@x.com", "Alice (laptop)");
      expect(await store.getIdentity("alice@x.com")).toEqual({
        id: "alice@x.com",
        displayName: "Alice (laptop)",
      });
      expect(await store.getIdentity("nobody")).toBeNull();
    });

    test("agents round-trip", async () => {
      await store.upsertAgent("ag-1", "alice@x.com", "claude");
      expect(await store.getAgent("ag-1")).toEqual({
        agentId: "ag-1",
        personId: "alice@x.com",
        type: "claude",
      });
      expect(await store.getAgent("ag-x")).toBeNull();
    });

    test("workspace session accounting (overwrite, distinct per agentType)", async () => {
      expect(await store.getLastSession("/repo", "claude")).toBeNull();
      await store.setLastSession("/repo", "claude", "sess-1");
      expect(await store.getLastSession("/repo", "claude")).toBe("sess-1");
      await store.setLastSession("/repo", "claude", "sess-2");
      expect(await store.getLastSession("/repo", "claude")).toBe("sess-2");
      expect(await store.getLastSession("/repo", "codex")).toBeNull();
    });

    test("rooms create / get / list", async () => {
      await store.createRoom("room-checkout", "checkout", "ag-1");
      expect(await store.getRoom("room-checkout")).toEqual({
        roomId: "room-checkout",
        name: "checkout",
        createdBy: "ag-1",
      });
      await store.createRoom("room-auth", "auth", "ag-2");
      const ids = (await store.listRooms()).map((r) => r.roomId).sort();
      expect(ids).toEqual(["room-auth", "room-checkout"]);
      expect(await store.getRoom("nope")).toBeNull();
    });

    test("membership persists, queryable both directions, idempotent add, remove works", async () => {
      await store.createRoom("r1", "r1", "ag-1");
      await store.addMember("r1", "ag-1");
      await store.addMember("r1", "ag-2");
      await store.addMember("r1", "ag-1"); // idempotent — no duplicate
      expect((await store.getMembers("r1")).sort()).toEqual(["ag-1", "ag-2"]);
      expect(await store.getRoomsForAgent("ag-1")).toEqual(["r1"]);
      await store.removeMember("r1", "ag-2");
      expect(await store.getMembers("r1")).toEqual(["ag-1"]);
    });

    test("cwd → room map (remap overwrites)", async () => {
      expect(await store.getRoomForCwd("/repo/a")).toBeNull();
      await store.mapCwd("/repo/a", "r1");
      expect(await store.getRoomForCwd("/repo/a")).toBe("r1");
      await store.mapCwd("/repo/a", "r2");
      expect(await store.getRoomForCwd("/repo/a")).toBe("r2");
    });

    test("event ledger appends, returns most-recent-first within limit, scoped per room", async () => {
      await store.appendEvent("r1", makeEnvelope({ messageId: "m1", timestamp: 1 }));
      await store.appendEvent("r1", makeEnvelope({ messageId: "m2", timestamp: 2 }));
      await store.appendEvent("r1", makeEnvelope({ messageId: "m3", timestamp: 3 }));
      await store.appendEvent("r2", makeEnvelope({ roomId: "r2", messageId: "x", timestamp: 9 }));
      const recent = await store.getRecentEvents("r1", 2);
      expect(recent.map((e) => e.messageId)).toEqual(["m3", "m2"]);
      expect((await store.getRecentEvents("r1", 10)).length).toBe(3);
      // round-trips the full envelope, not just the id
      expect(recent[0]!.from.agentId).toBe("ag-1");
      // §6.4: a non-positive limit returns empty, IDENTICALLY across impls
      // (guards InMemoryStore's slice(-0)=slice(0) and SQLite's LIMIT -1=unlimited).
      expect(await store.getRecentEvents("r1", 0)).toEqual([]);
      expect(await store.getRecentEvents("r1", -1)).toEqual([]);
    });

    test("whiteboard save / get round-trip (overwrite)", async () => {
      expect(await store.getWhiteboard("r1")).toBeNull();
      const wb = {
        roomId: "r1",
        contractsReady: [{ contract: "auth/v1", by: "ag-7" }],
        inProgress: [],
        blockers: [],
        recentMilestones: [],
        updatedAt: 5,
      };
      await store.saveWhiteboard("r1", wb);
      expect(await store.getWhiteboard("r1")).toEqual(wb);
      const wb2 = { ...wb, updatedAt: 6, blockers: [{ what: "waiting on payment" }] };
      await store.saveWhiteboard("r1", wb2);
      expect(await store.getWhiteboard("r1")).toEqual(wb2);
    });

    test("pending deliveries enqueue/drain, dedup by idempotencyKey, clear on drain, per-target", async () => {
      await store.enqueuePending("ag-2", makeEnvelope({ idempotencyKey: "k1", messageId: "m1" }));
      await store.enqueuePending("ag-2", makeEnvelope({ idempotencyKey: "k2", messageId: "m2" }));
      await store.enqueuePending("ag-2", makeEnvelope({ idempotencyKey: "k1", messageId: "m1-dup" }));
      await store.enqueuePending("ag-3", makeEnvelope({ idempotencyKey: "k9", messageId: "z" }));
      const drained = await store.drainPending("ag-2");
      expect(drained.map((e) => e.idempotencyKey).sort()).toEqual(["k1", "k2"]);
      expect(await store.drainPending("ag-2")).toEqual([]); // cleared
      expect((await store.drainPending("ag-3")).length).toBe(1); // other target intact
    });

    test("pending deliveries are bounded per target (§8.2): oldest dropped beyond MAX_PENDING_PER_TARGET", async () => {
      const total = MAX_PENDING_PER_TARGET + 5;
      for (let i = 0; i < total; i++) {
        await store.enqueuePending("ag-cap", makeEnvelope({ idempotencyKey: `k${i}`, messageId: `m${i}` }));
      }
      const drained = await store.drainPending("ag-cap");
      expect(drained.length).toBe(MAX_PENDING_PER_TARGET); // capped
      const keys = new Set(drained.map((e) => e.idempotencyKey));
      expect(keys.has("k0")).toBe(false); // oldest 5 dropped
      expect(keys.has("k4")).toBe(false);
      expect(keys.has("k5")).toBe(true); // newest kept
      expect(keys.has(`k${total - 1}`)).toBe(true);
    });

    test("auth tokens issue / resolve / list (hashed at rest §11.3), re-issue re-points, revoke deletes", async () => {
      expect(await store.resolveToken("tok-1")).toBeNull();
      await store.issueToken("tok-1", "alice@x.com");
      await store.issueToken("tok-2", "bob@x.com");
      expect(await store.resolveToken("tok-1")).toBe("alice@x.com");
      expect(await store.resolveToken("tok-2")).toBe("bob@x.com");
      // re-issuing the same token re-points it to a new identity
      await store.issueToken("tok-1", "carol@x.com");
      expect(await store.resolveToken("tok-1")).toBe("carol@x.com");
      // §11.3: tokens are stored HASHED at rest — listTokens exposes digests, never the raw tokens
      const all = (await store.listTokens()).map((t) => `${t.token}:${t.identityId}`).sort();
      expect(all).toEqual([`${hashToken("tok-1")}:carol@x.com`, `${hashToken("tok-2")}:bob@x.com`].sort());
      // revokeTokens removes ALL of an identity's tokens, returns the count, and is idempotent
      await store.issueToken("tok-3", "carol@x.com");
      expect(await store.revokeTokens("carol@x.com")).toBe(2); // tok-1 + tok-3
      expect(await store.resolveToken("tok-1")).toBeNull();
      expect(await store.resolveToken("tok-3")).toBeNull();
      expect(await store.resolveToken("tok-2")).toBe("bob@x.com"); // bob untouched
      expect(await store.revokeTokens("carol@x.com")).toBe(0);
    });
  });
}
