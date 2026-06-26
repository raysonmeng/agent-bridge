import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRoomMember, createRoom, inviteRoomMember, isLoopbackBrokerUrl, joinRoom, listRooms, removeRoomMember, runRoom } from "../cli/room";
import { IdentityService } from "../backbone/identity-service";
import { RoomService } from "../room-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { atomicWriteText } from "../atomic-json";

/** Mimic `abg auth login`: register an identity, issue a token, persist it. */
async function seedLogin(
  dir: string,
  dbPath: string,
  id = "alice@x.com",
  name = "Alice",
): Promise<string> {
  const store = new SqliteStore(dbPath);
  try {
    const svc = new IdentityService(store);
    const identity = await svc.registerIdentity(id, name);
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
    expect(joined).toEqual({ roomId: "my-checkout", agentId: identityId, local: true });

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

  it("relaxes join for a REMOTE room (no local record): maps cwd, grants no membership", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    // EDGE machine: NO local identity / room / auth-token at all. Remote join must STILL
    // succeed (the remote branch resolves no local identity — it doesn't read auth-token —
    // and the broker validates membership at subscribe). Writing no token proves that.
    cwd = mkdtempSync(join(tmpdir(), "agentbridge-room-cwd-"));

    // The room does not exist locally → no throw, no identity resolution required.
    const result = await joinRoom({ roomId: "remote-room", cwd, dbPath });
    expect(result).toEqual({ roomId: "remote-room", agentId: null, local: false });

    const store = new SqliteStore(dbPath);
    try {
      const svc = new RoomService(store);
      // cwd was mapped (routing intent) …
      expect(await svc.resolveRoomForCwd(cwd)).toBe("remote-room");
      // … but NO membership was granted (broker stays authoritative).
      expect(await svc.getMembers("remote-room")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("invite (CLI): prints the 3 onboarding commands + the env-persist note", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    await seedLogin(dir, dbPath, "alice@x.com", "Alice"); // alice logged in (writes auth-token)
    await createRoom({ name: "ship-it", cwd: dir, dbPath }); // alice creates → is a member, so she may invite
    const prevDb = process.env.AGENTBRIDGE_COLLAB_DB;
    process.env.AGENTBRIDGE_COLLAB_DB = dbPath; // runRoom resolves the db via env
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    try {
      await runRoom(["invite", "ship-it", "bob@x.com", "--broker-url", "ws://100.90.1.42:4700/ws"]);
    } finally {
      console.log = origLog;
      if (prevDb === undefined) delete process.env.AGENTBRIDGE_COLLAB_DB;
      else process.env.AGENTBRIDGE_COLLAB_DB = prevDb;
    }
    const out = logs.join("\n");
    expect(out).toContain("export AGENTBRIDGE_BROKER_URL=ws://100.90.1.42:4700/ws");
    expect(out).toContain("abg auth login --token "); // invitee installs the issued token
    expect(out).toContain("abg join ship-it");
    expect(out).toContain("~/.zshrc"); // the env-persist note (MEDIUM fix) must be present
  });

  it("invite: member issues a broker-verifiable token + grants membership", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    const callerId = await seedLogin(dir, dbPath);
    await createRoom({ name: "Ship It", dbPath }); // caller is the creator → member

    const { token, brokerUrl } = await inviteRoomMember({
      roomId: "ship-it",
      identityId: "bob@x.com",
      name: "Bob",
      dbPath,
    });

    expect(token).toBeTruthy();
    expect(brokerUrl).toMatch(/^wss?:\/\//);
    expect(token).not.toBe(callerId); // sanity: it's a token, not the caller id

    const store = new SqliteStore(dbPath);
    try {
      // invitee is now a member …
      expect(await new RoomService(store).isMember("ship-it", "bob@x.com")).toBe(true);
      // … and the issued token authenticates against the broker's provider as the invitee.
      const identity = await new StorePskIdentityProvider(store).authenticate(token);
      expect(identity).toEqual({ id: "bob@x.com", displayName: "Bob" });
    } finally {
      await store.close();
    }
  });

  it("invite: a NON-member caller is rejected (only insiders can invite)", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    await seedLogin(dir, dbPath); // caller = alice, logged in but NOT a member of the target room

    // Create a room owned by someone else (alice is not a member of it).
    const store = new SqliteStore(dbPath);
    try {
      await new RoomService(store).createRoom("secret", "Secret", "owner@x.com");
    } finally {
      await store.close();
    }

    await expect(
      inviteRoomMember({ roomId: "secret", identityId: "mallory@x.com", dbPath }),
    ).rejects.toThrow(/只有房间成员能邀请/);
  });

  it("invite: preserves an existing display name when --name is omitted", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    await seedLogin(dir, dbPath);
    await createRoom({ name: "Room", dbPath });

    // Pre-register the invitee with a real name.
    const setup = new SqliteStore(dbPath);
    try {
      await new IdentityService(setup).registerIdentity("carol@x.com", "Carol Original");
    } finally {
      await setup.close();
    }

    await inviteRoomMember({ roomId: "room", identityId: "carol@x.com", dbPath }); // no --name

    const store = new SqliteStore(dbPath);
    try {
      const id = await new IdentityService(store).getIdentity("carol@x.com");
      expect(id?.displayName).toBe("Carol Original"); // not clobbered with the id
    } finally {
      await store.close();
    }

    // addRoomMember stays importable + usable (no regression to the existing add path).
    expect(typeof addRoomMember).toBe("function");
  });

  it("invite: --broker-url overrides the loopback default so the URL is reachable", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    await seedLogin(dir, dbPath);
    await createRoom({ name: "Net", dbPath });

    const routable = "ws://100.90.1.42:4700/ws";
    const { brokerUrl } = await inviteRoomMember({
      roomId: "net",
      identityId: "dave@x.com",
      brokerUrl: routable,
      dbPath,
    });
    expect(brokerUrl).toBe(routable);
    expect(isLoopbackBrokerUrl(brokerUrl)).toBe(false);
  });

  it("remove: a member removes another member", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    await seedLogin(dir, dbPath); // alice = creator → member, may add/remove
    await createRoom({ name: "Crew", dbPath });
    await addRoomMember({ roomId: "crew", identityId: "bob@x.com", dbPath });

    const before = new SqliteStore(dbPath);
    try {
      expect(await new RoomService(before).isMember("crew", "bob@x.com")).toBe(true);
    } finally {
      await before.close();
    }

    await removeRoomMember({ roomId: "crew", identityId: "bob@x.com", dbPath });

    const after = new SqliteStore(dbPath);
    try {
      expect(await new RoomService(after).isMember("crew", "bob@x.com")).toBe(false);
    } finally {
      await after.close();
    }
  });

  it("remove: rejects a non-existent room (the existence guard)", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    const dbPath = join(dir, "collab.db");
    await seedLogin(dir, dbPath);
    await expect(
      removeRoomMember({ roomId: "ghost", identityId: "bob@x.com", dbPath }),
    ).rejects.toThrow(/房间不存在/);
  });
});

describe("isLoopbackBrokerUrl", () => {
  it("flags loopback hosts, accepts routable ones", () => {
    expect(isLoopbackBrokerUrl("ws://127.0.0.1:4700/ws")).toBe(true);
    expect(isLoopbackBrokerUrl("ws://localhost:4700/ws")).toBe(true);
    expect(isLoopbackBrokerUrl("ws://[::1]:4700/ws")).toBe(true);
    expect(isLoopbackBrokerUrl("ws://100.90.1.42:4700/ws")).toBe(false);
    expect(isLoopbackBrokerUrl("ws://192.168.1.5:4700/ws")).toBe(false);
    expect(isLoopbackBrokerUrl("wss://broker.example.com/ws")).toBe(false);
  });
});
