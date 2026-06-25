import { Database } from "bun:sqlite";
import type { Envelope } from "../envelope";
import type {
  AgentRecord,
  IdentityRecord,
  RoomRecord,
  Store,
  WhiteboardRecord,
} from "../store";

/**
 * Battery-grade Store impl (§6.4): SQLite (WAL) behind the async interface.
 * The same contract suite passes here and against InMemoryStore / Postgres.
 */
export class SqliteStore implements Store {
  private db: Database;
  private closed = false;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_sessions (
        workspace_path TEXT,
        agent_type TEXT,
        last_session_id TEXT NOT NULL,
        PRIMARY KEY (workspace_path, agent_type)
      );
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT,
        agent_id TEXT,
        PRIMARY KEY (room_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS cwd_room_map (
        workspace_path TEXT PRIMARY KEY,
        room_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        envelope TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_whiteboard (
        room_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        target_agent_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        envelope TEXT NOT NULL,
        UNIQUE (target_agent_id, idempotency_key)
      );
    `);
  }

  // --- identities ---
  async upsertIdentity(id: string, displayName: string): Promise<IdentityRecord> {
    this.db
      .query(
        "INSERT INTO identities(id, display_name) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name",
      )
      .run(id, displayName);
    return { id, displayName };
  }

  async getIdentity(id: string): Promise<IdentityRecord | null> {
    const row = this.db
      .query("SELECT id, display_name FROM identities WHERE id=?")
      .get(id) as { id: string; display_name: string } | null;
    return row ? { id: row.id, displayName: row.display_name } : null;
  }

  // --- agents ---
  async upsertAgent(agentId: string, personId: string, type: string): Promise<void> {
    this.db
      .query(
        "INSERT INTO agents(agent_id, person_id, type) VALUES(?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET person_id=excluded.person_id, type=excluded.type",
      )
      .run(agentId, personId, type);
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    const row = this.db
      .query("SELECT agent_id, person_id, type FROM agents WHERE agent_id=?")
      .get(agentId) as { agent_id: string; person_id: string; type: string } | null;
    return row ? { agentId: row.agent_id, personId: row.person_id, type: row.type } : null;
  }

  // --- sessions ---
  async recordSession(sessionId: string, agentId: string, startedAt: number): Promise<void> {
    this.db
      .query("INSERT OR REPLACE INTO sessions(session_id, agent_id, started_at) VALUES(?, ?, ?)")
      .run(sessionId, agentId, startedAt);
  }

  async getLastSession(workspacePath: string, agentType: string): Promise<string | null> {
    const row = this.db
      .query(
        "SELECT last_session_id FROM workspace_sessions WHERE workspace_path=? AND agent_type=?",
      )
      .get(workspacePath, agentType) as { last_session_id: string } | null;
    return row ? row.last_session_id : null;
  }

  async setLastSession(
    workspacePath: string,
    agentType: string,
    sessionId: string,
  ): Promise<void> {
    this.db
      .query(
        "INSERT INTO workspace_sessions(workspace_path, agent_type, last_session_id) VALUES(?, ?, ?) ON CONFLICT(workspace_path, agent_type) DO UPDATE SET last_session_id=excluded.last_session_id",
      )
      .run(workspacePath, agentType, sessionId);
  }

  // --- rooms ---
  async createRoom(roomId: string, name: string, createdBy: string): Promise<void> {
    this.db
      .query("INSERT OR IGNORE INTO rooms(room_id, name, created_by) VALUES(?, ?, ?)")
      .run(roomId, name, createdBy);
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const row = this.db
      .query("SELECT room_id, name, created_by FROM rooms WHERE room_id=?")
      .get(roomId) as { room_id: string; name: string; created_by: string } | null;
    return row ? { roomId: row.room_id, name: row.name, createdBy: row.created_by } : null;
  }

  async listRooms(): Promise<RoomRecord[]> {
    const rows = this.db
      .query("SELECT room_id, name, created_by FROM rooms")
      .all() as { room_id: string; name: string; created_by: string }[];
    return rows.map((r) => ({ roomId: r.room_id, name: r.name, createdBy: r.created_by }));
  }

  // --- room members ---
  async addMember(roomId: string, agentId: string): Promise<void> {
    this.db
      .query("INSERT OR IGNORE INTO room_members(room_id, agent_id) VALUES(?, ?)")
      .run(roomId, agentId);
  }

  async removeMember(roomId: string, agentId: string): Promise<void> {
    this.db
      .query("DELETE FROM room_members WHERE room_id=? AND agent_id=?")
      .run(roomId, agentId);
  }

  async getMembers(roomId: string): Promise<string[]> {
    const rows = this.db
      .query("SELECT agent_id FROM room_members WHERE room_id=?")
      .all(roomId) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  async getRoomsForAgent(agentId: string): Promise<string[]> {
    const rows = this.db
      .query("SELECT room_id FROM room_members WHERE agent_id=?")
      .all(agentId) as { room_id: string }[];
    return rows.map((r) => r.room_id);
  }

  // --- cwd → room map ---
  async mapCwd(workspacePath: string, roomId: string): Promise<void> {
    this.db
      .query(
        "INSERT INTO cwd_room_map(workspace_path, room_id) VALUES(?, ?) ON CONFLICT(workspace_path) DO UPDATE SET room_id=excluded.room_id",
      )
      .run(workspacePath, roomId);
  }

  async getRoomForCwd(workspacePath: string): Promise<string | null> {
    const row = this.db
      .query("SELECT room_id FROM cwd_room_map WHERE workspace_path=?")
      .get(workspacePath) as { room_id: string } | null;
    return row ? row.room_id : null;
  }

  // --- event ledger ---
  async appendEvent(roomId: string, envelope: Envelope): Promise<void> {
    this.db
      .query("INSERT INTO room_events(room_id, envelope) VALUES(?, ?)")
      .run(roomId, JSON.stringify(envelope));
  }

  async getRecentEvents(roomId: string, limit: number): Promise<Envelope[]> {
    // Non-positive limit → empty (SQLite treats `LIMIT -1` as "unlimited"; keep
    // the semantics crisp and identical to InMemoryStore).
    if (limit <= 0) return [];
    const rows = this.db
      .query("SELECT envelope FROM room_events WHERE room_id=? ORDER BY seq DESC LIMIT ?")
      .all(roomId, limit) as { envelope: string }[];
    return rows.map((r) => JSON.parse(r.envelope) as Envelope);
  }

  // --- whiteboard ---
  async getWhiteboard(roomId: string): Promise<WhiteboardRecord | null> {
    const row = this.db
      .query("SELECT data FROM room_whiteboard WHERE room_id=?")
      .get(roomId) as { data: string } | null;
    return row ? (JSON.parse(row.data) as WhiteboardRecord) : null;
  }

  async saveWhiteboard(roomId: string, whiteboard: WhiteboardRecord): Promise<void> {
    this.db
      .query(
        "INSERT INTO room_whiteboard(room_id, data) VALUES(?, ?) ON CONFLICT(room_id) DO UPDATE SET data=excluded.data",
      )
      .run(roomId, JSON.stringify(whiteboard));
  }

  // --- pending deliveries ---
  async enqueuePending(targetAgentId: string, envelope: Envelope): Promise<void> {
    this.db
      .query(
        "INSERT OR IGNORE INTO pending_deliveries(target_agent_id, idempotency_key, envelope) VALUES(?, ?, ?)",
      )
      .run(targetAgentId, envelope.idempotencyKey, JSON.stringify(envelope));
  }

  async drainPending(targetAgentId: string): Promise<Envelope[]> {
    const rows = this.db
      .query("SELECT envelope FROM pending_deliveries WHERE target_agent_id=? ORDER BY seq")
      .all(targetAgentId) as { envelope: string }[];
    this.db
      .query("DELETE FROM pending_deliveries WHERE target_agent_id=?")
      .run(targetAgentId);
    return rows.map((r) => JSON.parse(r.envelope) as Envelope);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
