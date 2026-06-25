import type { Envelope } from "../envelope";
import type {
  AgentRecord,
  IdentityRecord,
  RoomRecord,
  Store,
  WhiteboardRecord,
} from "../store";

/**
 * In-memory Store impl — same contract as SqliteStore (§6.4), zero persistence.
 * Used for fast unit tests and ephemeral runs. Maps mirror the SQLite schema.
 */
export class InMemoryStore implements Store {
  private identities = new Map<string, IdentityRecord>();
  private agents = new Map<string, AgentRecord>();
  private sessions = new Map<string, { agentId: string; startedAt: number }>();
  private workspaceSessions = new Map<string, string>(); // `${path}\0${type}` → sessionId
  private rooms = new Map<string, RoomRecord>();
  private members = new Map<string, Set<string>>(); // roomId → agentIds
  private cwdRoom = new Map<string, string>();
  private events = new Map<string, Envelope[]>(); // roomId → append-ordered ledger
  private whiteboards = new Map<string, WhiteboardRecord>();
  // targetAgentId → (idempotencyKey → envelope); Map preserves insertion order
  private pending = new Map<string, Map<string, Envelope>>();

  async upsertIdentity(id: string, displayName: string): Promise<IdentityRecord> {
    const record = { id, displayName };
    this.identities.set(id, record);
    return record;
  }

  async getIdentity(id: string): Promise<IdentityRecord | null> {
    return this.identities.get(id) ?? null;
  }

  async upsertAgent(agentId: string, personId: string, type: string): Promise<void> {
    this.agents.set(agentId, { agentId, personId, type });
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return this.agents.get(agentId) ?? null;
  }

  async recordSession(sessionId: string, agentId: string, startedAt: number): Promise<void> {
    this.sessions.set(sessionId, { agentId, startedAt });
  }

  async getLastSession(workspacePath: string, agentType: string): Promise<string | null> {
    return this.workspaceSessions.get(`${workspacePath}\0${agentType}`) ?? null;
  }

  async setLastSession(
    workspacePath: string,
    agentType: string,
    sessionId: string,
  ): Promise<void> {
    this.workspaceSessions.set(`${workspacePath}\0${agentType}`, sessionId);
  }

  async createRoom(roomId: string, name: string, createdBy: string): Promise<void> {
    if (this.rooms.has(roomId)) return; // INSERT OR IGNORE — first create wins
    this.rooms.set(roomId, { roomId, name, createdBy });
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async listRooms(): Promise<RoomRecord[]> {
    return [...this.rooms.values()];
  }

  async addMember(roomId: string, agentId: string): Promise<void> {
    let set = this.members.get(roomId);
    if (!set) {
      set = new Set();
      this.members.set(roomId, set);
    }
    set.add(agentId); // Set membership is naturally idempotent
  }

  async removeMember(roomId: string, agentId: string): Promise<void> {
    this.members.get(roomId)?.delete(agentId);
  }

  async getMembers(roomId: string): Promise<string[]> {
    return [...(this.members.get(roomId) ?? [])];
  }

  async getRoomsForAgent(agentId: string): Promise<string[]> {
    // ponytail: O(rooms) scan; fine for control-plane sizes
    const out: string[] = [];
    for (const [roomId, set] of this.members) {
      if (set.has(agentId)) out.push(roomId);
    }
    return out;
  }

  async mapCwd(workspacePath: string, roomId: string): Promise<void> {
    this.cwdRoom.set(workspacePath, roomId); // remap overwrites
  }

  async getRoomForCwd(workspacePath: string): Promise<string | null> {
    return this.cwdRoom.get(workspacePath) ?? null;
  }

  async appendEvent(roomId: string, envelope: Envelope): Promise<void> {
    let list = this.events.get(roomId);
    if (!list) {
      list = [];
      this.events.set(roomId, list);
    }
    list.push(envelope);
  }

  async getRecentEvents(roomId: string, limit: number): Promise<Envelope[]> {
    // Non-positive limit → empty (matches SqliteStore). Without this, slice(-0)
    // === slice(0) would return the WHOLE ledger for limit=0.
    if (limit <= 0) return [];
    const list = this.events.get(roomId) ?? [];
    return list.slice(-limit).reverse(); // last N, most-recent-first
  }

  async getWhiteboard(roomId: string): Promise<WhiteboardRecord | null> {
    return this.whiteboards.get(roomId) ?? null;
  }

  async saveWhiteboard(roomId: string, whiteboard: WhiteboardRecord): Promise<void> {
    this.whiteboards.set(roomId, whiteboard); // overwrite
  }

  async enqueuePending(targetAgentId: string, envelope: Envelope): Promise<void> {
    let byKey = this.pending.get(targetAgentId);
    if (!byKey) {
      byKey = new Map();
      this.pending.set(targetAgentId, byKey);
    }
    if (!byKey.has(envelope.idempotencyKey)) {
      byKey.set(envelope.idempotencyKey, envelope); // dedup: first wins
    }
  }

  async drainPending(targetAgentId: string): Promise<Envelope[]> {
    const byKey = this.pending.get(targetAgentId);
    if (!byKey) return [];
    this.pending.delete(targetAgentId);
    return [...byKey.values()];
  }

  async close(): Promise<void> {
    // No handle to release; idempotent no-op.
  }
}
