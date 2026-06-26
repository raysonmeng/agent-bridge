import { realpathSync } from "node:fs";
import type { Store, RoomRecord } from "./backbone/store";

export interface AutoJoinResult {
  roomId: string;
  /** true if this call newly joined the agent; false if it was already a member. */
  joined: boolean;
}

/**
 * §2.3–2.4 room service over a Store.
 *
 * A room = one requirement/workflow, cross-repo + cross-person. Anyone can create
 * a room; others join. Membership binds to a LOGICAL AGENT id and is PERSISTENT
 * (survives restart) — never a session id (§2.3). Three join paths (§2.4): the
 * cwd→room map (automatic), explicit `join`, and worktree (just another cwd).
 *
 * The cwd→room map keys on the REALPATH of the workspace dir so symlinks/`..`
 * don't fork a room; it never writes anything into the repo (no marker files that
 * could be committed). Broker subscription on join is the adapter's job
 * (BrokerClient.subscribe) — this service owns only the persistent membership.
 */
export class RoomService {
  constructor(private readonly store: Store) {}

  // --- rooms ---
  async createRoom(roomId: string, name: string, createdBy: string): Promise<void> {
    await this.store.createRoom(roomId, name, createdBy);
  }
  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return this.store.getRoom(roomId);
  }
  async listRooms(): Promise<RoomRecord[]> {
    return this.store.listRooms();
  }

  // --- membership (persistent, bound to logical agent id) ---
  async join(roomId: string, agentId: string): Promise<void> {
    await this.store.addMember(roomId, agentId);
  }
  async leave(roomId: string, agentId: string): Promise<void> {
    await this.store.removeMember(roomId, agentId);
  }
  async getMembers(roomId: string): Promise<string[]> {
    return this.store.getMembers(roomId);
  }
  async getRoomsForAgent(agentId: string): Promise<string[]> {
    return this.store.getRoomsForAgent(agentId);
  }
  async isMember(roomId: string, agentId: string): Promise<boolean> {
    return (await this.store.getMembers(roomId)).includes(agentId);
  }

  // --- cwd → room map (§2.4 automatic join) ---
  async mapCwd(workspacePath: string, roomId: string): Promise<void> {
    await this.store.mapCwd(this.normalizeCwd(workspacePath), roomId);
  }
  async resolveRoomForCwd(workspacePath: string): Promise<string | null> {
    return this.store.getRoomForCwd(this.normalizeCwd(workspacePath));
  }

  /**
   * Resolve `workspacePath` to its mapped room and join `agentId` to it if not
   * already a member. Returns null when the cwd has no mapping (caller falls back
   * to an explicit join). The primary auto-join path (§2.4).
   */
  async autoJoinByCwd(workspacePath: string, agentId: string): Promise<AutoJoinResult | null> {
    const roomId = await this.resolveRoomForCwd(workspacePath);
    if (!roomId) return null;
    const already = await this.isMember(roomId, agentId);
    if (!already) await this.join(roomId, agentId);
    return { roomId, joined: !already };
  }

  /** Realpath the workspace dir so symlinks/`..` map to the same room; fall back on error. */
  private normalizeCwd(workspacePath: string): string {
    try {
      return realpathSync(workspacePath);
    } catch {
      return workspacePath;
    }
  }
}
