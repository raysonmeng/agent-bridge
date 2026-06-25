import { describe, test, expect } from "bun:test";
import { PostgresStore } from "../backbone/store/postgres-store";
import { makeEnvelope } from "./backbone-fixtures";

/**
 * PostgresStore is a §11.3 skeleton: every method must reject until the real
 * driver lands. Spot-check a representative slice across the surface.
 */
describe("PostgresStore skeleton — every method rejects (not implemented)", () => {
  const s = new PostgresStore();

  test("identity/agent methods reject", async () => {
    await expect(s.upsertIdentity("x", "X")).rejects.toThrow(/not implemented/);
    await expect(s.getIdentity("x")).rejects.toThrow(/not implemented/);
    await expect(s.upsertAgent("ag", "p", "claude")).rejects.toThrow(/not implemented/);
    await expect(s.getAgent("ag")).rejects.toThrow(/not implemented/);
  });

  test("session/workspace methods reject", async () => {
    await expect(s.recordSession("sess", "ag", 1)).rejects.toThrow(/not implemented/);
    await expect(s.getLastSession("/repo", "claude")).rejects.toThrow(/not implemented/);
    await expect(s.setLastSession("/repo", "claude", "sess")).rejects.toThrow(/not implemented/);
  });

  test("room/member/cwd methods reject", async () => {
    await expect(s.createRoom("r", "r", "ag")).rejects.toThrow(/not implemented/);
    await expect(s.getRoom("r")).rejects.toThrow(/not implemented/);
    await expect(s.listRooms()).rejects.toThrow(/not implemented/);
    await expect(s.addMember("r", "ag")).rejects.toThrow(/not implemented/);
    await expect(s.removeMember("r", "ag")).rejects.toThrow(/not implemented/);
    await expect(s.getMembers("r")).rejects.toThrow(/not implemented/);
    await expect(s.getRoomsForAgent("ag")).rejects.toThrow(/not implemented/);
    await expect(s.mapCwd("/repo", "r")).rejects.toThrow(/not implemented/);
    await expect(s.getRoomForCwd("/repo")).rejects.toThrow(/not implemented/);
  });

  test("ledger/whiteboard/pending/close methods reject", async () => {
    await expect(s.appendEvent("r", makeEnvelope())).rejects.toThrow(/not implemented/);
    await expect(s.getRecentEvents("r", 10)).rejects.toThrow(/not implemented/);
    await expect(s.getWhiteboard("r")).rejects.toThrow(/not implemented/);
    await expect(
      s.saveWhiteboard("r", {
        roomId: "r",
        contractsReady: [],
        inProgress: [],
        blockers: [],
        recentMilestones: [],
        updatedAt: 0,
      }),
    ).rejects.toThrow(/not implemented/);
    await expect(s.enqueuePending("ag", makeEnvelope())).rejects.toThrow(/not implemented/);
    await expect(s.drainPending("ag")).rejects.toThrow(/not implemented/);
    await expect(s.close()).rejects.toThrow(/not implemented/);
  });
});
