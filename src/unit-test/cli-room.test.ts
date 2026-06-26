import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoom, joinRoom, listRooms } from "../cli/room";
import { IdentityService } from "../backbone/identity-service";
import { RoomService } from "../room-service";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { atomicWriteText } from "../atomic-json";

/** Mimic `abg auth login`: register an identity, issue a token, persist it. */
async function seedLogin(dir: string, dbPath: string): Promise<string> {
  const store = new SqliteStore(dbPath);
  try {
    const svc = new IdentityService(store);
    const identity = await svc.registerIdentity("alice@x.com", "Alice");
    const token = await svc.issueToken(identity.id);
    atomicWriteText(join(dir, "auth-token"), token, { mode: 0o600 });
    return identity.id;
  } finally {
    await store.close();
  }
}

describe("cli/room", () => {
  let dir: string | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    dir = undefined;
    cwd = undefined;
  });

  it("create → list → join round-trips through the collab store", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    const identityId = await seedLogin(dir, dbPath);

    const created = await createRoom({ name: "My Checkout", dbPath });
    expect(created.roomId).toBe("my-checkout");

    const rooms = await listRooms({ dbPath });
    expect(rooms.map((r) => r.roomId)).toContain("my-checkout");

    cwd = mkdtempSync(join(tmpdir(), "agentbridge-room-cwd-"));
    const joined = await joinRoom({ roomId: created.roomId, cwd, dbPath });
    expect(joined).toEqual({ roomId: "my-checkout", agentId: identityId });

    // membership + cwd→room map persisted under a fresh service over the same DB
    const store = new SqliteStore(dbPath);
    try {
      const svc = new RoomService(store);
      expect(await svc.isMember("my-checkout", identityId)).toBe(true);
      expect(await svc.resolveRoomForCwd(cwd)).toBe("my-checkout");
    } finally {
      await store.close();
    }
  });

  it("supports Chinese room names, auto-joins the creator, and reports created vs reused", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    const identityId = await seedLogin(dir, dbPath);
    cwd = mkdtempSync(join(tmpdir(), "agentbridge-room-cwd-"));

    const first = await createRoom({ name: "结账", cwd, dbPath });
    expect(first).toEqual({ roomId: "结账", created: true });

    // creator is auto-joined + cwd mapped — no separate `abg join` needed
    const store = new SqliteStore(dbPath);
    try {
      const svc = new RoomService(store);
      expect(await svc.isMember("结账", identityId)).toBe(true);
      expect(await svc.resolveRoomForCwd(cwd)).toBe("结账");
    } finally {
      await store.close();
    }

    // creating the same slug again reuses it (created=false), creator still a member
    expect(await createRoom({ name: "结账", cwd, dbPath })).toEqual({ roomId: "结账", created: false });
  });

  it("throws a friendly 'abg auth login' error when not logged in", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    // no seedLogin → no auth-token file at all

    await expect(createRoom({ name: "X", dbPath })).rejects.toThrow(/abg auth login/);

    // pre-create the room so joinRoom would pass the existence check; it must
    // still fail at the auth gate, not the room-existence one.
    const store = new SqliteStore(dbPath);
    try {
      await new RoomService(store).createRoom("x", "X", "someone");
    } finally {
      await store.close();
    }
    await expect(joinRoom({ roomId: "x", dbPath })).rejects.toThrow(/abg auth login/);
  });
});
