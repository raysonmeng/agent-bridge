import type { Envelope } from "../envelope";
import type {
  AgentRecord,
  IdentityRecord,
  RoomRecord,
  Store,
  WhiteboardRecord,
} from "../store";

const NOT_IMPLEMENTED =
  "PostgresStore: not implemented — production backend skeleton (§11.3)";

/**
 * Production backend skeleton (§6.4, §11.3). Proves the Store seam admits a
 * networked Postgres driver without touching the core; every method throws
 * until the real driver lands.
 */
export class PostgresStore implements Store {
  async upsertIdentity(_id: string, _displayName: string): Promise<IdentityRecord> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getIdentity(_id: string): Promise<IdentityRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async upsertAgent(_agentId: string, _personId: string, _type: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getAgent(_agentId: string): Promise<AgentRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async recordSession(_sessionId: string, _agentId: string, _startedAt: number): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getLastSession(_workspacePath: string, _agentType: string): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async setLastSession(
    _workspacePath: string,
    _agentType: string,
    _sessionId: string,
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async createRoom(_roomId: string, _name: string, _createdBy: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getRoom(_roomId: string): Promise<RoomRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listRooms(): Promise<RoomRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async setRoomPassword(_roomId: string, _passwordHash: string | null): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getRoomPasswordHash(_roomId: string): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async addMember(_roomId: string, _agentId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async removeMember(_roomId: string, _agentId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getMembers(_roomId: string): Promise<string[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getRoomsForAgent(_agentId: string): Promise<string[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async mapCwd(_workspacePath: string, _roomId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getRoomForCwd(_workspacePath: string): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async appendEvent(_roomId: string, _envelope: Envelope): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getRecentEvents(_roomId: string, _limit: number): Promise<Envelope[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getWhiteboard(_roomId: string): Promise<WhiteboardRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async saveWhiteboard(_roomId: string, _whiteboard: WhiteboardRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async enqueuePending(_targetAgentId: string, _envelope: Envelope): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async drainPending(_targetAgentId: string): Promise<Envelope[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async issueToken(_token: string, _identityId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async resolveToken(_token: string): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listTokens(): Promise<Array<{ token: string; identityId: string }>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async revokeTokens(_identityId: string): Promise<number> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async close(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
