import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../room-service";
import { InMemoryStore } from "../backbone/store/memory-store";

describe("RoomService — rooms + persistent membership + cwd→room (§2.3–2.4)", () => {
  let store: InMemoryStore;
  let svc: RoomService;
  beforeEach(() => {
    store = new InMemoryStore();
    svc = new RoomService(store);
  });

  test("create / get / list", async () => {
    await svc.createRoom("room-checkout", "checkout", "ag-1");
    expect(await svc.getRoom("room-checkout")).toEqual({
      roomId: "room-checkout",
      name: "checkout",
      createdBy: "ag-1",
    });
    await svc.createRoom("room-auth", "auth", "ag-2");
    expect((await svc.listRooms()).map((r) => r.roomId).sort()).toEqual([
      "room-auth",
      "room-checkout",
    ]);
  });

  test("membership: join is persistent + bidirectional + idempotent; leave works", async () => {
    await svc.createRoom("r1", "r1", "ag-1");
    await svc.join("r1", "ag-1");
    await svc.join("r1", "ag-2");
    await svc.join("r1", "ag-1"); // idempotent
    expect((await svc.getMembers("r1")).sort()).toEqual(["ag-1", "ag-2"]);
    expect(await svc.getRoomsForAgent("ag-1")).toEqual(["r1"]);
    expect(await svc.isMember("r1", "ag-2")).toBe(true);
    await svc.leave("r1", "ag-2");
    expect(await svc.isMember("r1", "ag-2")).toBe(false);
  });

  test("cwd→room map + autoJoinByCwd (joins once, then no-op; unmapped → null)", async () => {
    await svc.createRoom("r1", "r1", "ag-1");
    expect(await svc.resolveRoomForCwd("/repo/a")).toBeNull();
    await svc.mapCwd("/repo/a", "r1");
    expect(await svc.resolveRoomForCwd("/repo/a")).toBe("r1");
    expect(await svc.autoJoinByCwd("/repo/a", "ag-9")).toEqual({ roomId: "r1", joined: true });
    expect(await svc.autoJoinByCwd("/repo/a", "ag-9")).toEqual({ roomId: "r1", joined: false });
    expect(await svc.isMember("r1", "ag-9")).toBe(true);
    expect(await svc.autoJoinByCwd("/repo/unmapped", "ag-9")).toBeNull();
  });

  test("cwd map normalizes via realpath — a symlinked path resolves the same room", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentbridge-room-"));
    try {
      const real = join(dir, "real");
      mkdirSync(real);
      const link = join(dir, "link");
      symlinkSync(real, link);
      await svc.createRoom("rr", "rr", "ag-1");
      await svc.mapCwd(real, "rr");
      // resolving through the SYMLINK lands the same room (realpath normalization)
      expect(await svc.resolveRoomForCwd(link)).toBe("rr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
