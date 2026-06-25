import type { Envelope } from "./envelope";

/**
 * Store interface (spec §6.1, §12 data model).
 *
 * The persistence seam. Battery impl = SQLite (WAL); production impl = Postgres
 * behind the same interface. Methods are async to anticipate the networked
 * production backend (§6.4: swapping the driver must not change the core), even
 * though the SQLite/in-memory battery impls do synchronous work under the hood.
 *
 * Holds only control-plane state (§12) — identities, rooms, membership, session
 * accounting, the event ledger, the whiteboard, pending deliveries. Never code.
 */

export interface IdentityRecord {
  id: string;
  displayName: string;
}

export interface AgentRecord {
  agentId: string;
  personId: string;
  type: string;
}

export interface RoomRecord {
  roomId: string;
  name: string;
  createdBy: string;
}

/** A whiteboard slot item — flexible shape filled by the mechanical merge (§4.2). */
export type WhiteboardItem = Record<string, unknown>;

/** The four structured whiteboard slots (Appendix B). */
export interface WhiteboardRecord {
  roomId: string;
  contractsReady: WhiteboardItem[];
  inProgress: WhiteboardItem[];
  blockers: WhiteboardItem[];
  recentMilestones: WhiteboardItem[];
  updatedAt: number;
}

export interface Store {
  // --- identities (§2.2): UNIQUE id; same id re-registering REUSES the row ---
  upsertIdentity(id: string, displayName: string): Promise<IdentityRecord>;
  getIdentity(id: string): Promise<IdentityRecord | null>;

  // --- agents / logical agent (§2.1) ---
  upsertAgent(agentId: string, personId: string, type: string): Promise<void>;
  getAgent(agentId: string): Promise<AgentRecord | null>;

  // --- sessions (§2.5): current/historical session rows ---
  recordSession(sessionId: string, agentId: string, startedAt: number): Promise<void>;

  // --- workspace session accounting (§2.5): (workspace, agentType) → lastSessionId ---
  getLastSession(workspacePath: string, agentType: string): Promise<string | null>;
  setLastSession(workspacePath: string, agentType: string, sessionId: string): Promise<void>;

  // --- rooms (§2.3): anyone can create, others join ---
  createRoom(roomId: string, name: string, createdBy: string): Promise<void>;
  getRoom(roomId: string): Promise<RoomRecord | null>;
  listRooms(): Promise<RoomRecord[]>;

  // --- room members (§2.3): bound to logical agent id, persistent (survives restart) ---
  addMember(roomId: string, agentId: string): Promise<void>;
  removeMember(roomId: string, agentId: string): Promise<void>;
  getMembers(roomId: string): Promise<string[]>;
  getRoomsForAgent(agentId: string): Promise<string[]>;

  // --- cwd → room map (§2.4): auto-join by workspace path ---
  mapCwd(workspacePath: string, roomId: string): Promise<void>;
  getRoomForCwd(workspacePath: string): Promise<string | null>;

  // --- room_events: append-only ledger (§4.1); store envelopes (summaries, not blobs) ---
  appendEvent(roomId: string, envelope: Envelope): Promise<void>;
  /** Most-recent-first, capped at `limit` (rolling retention, §4.3). */
  getRecentEvents(roomId: string, limit: number): Promise<Envelope[]>;

  // --- room_whiteboard: one overwriting row per room (§4.2) ---
  getWhiteboard(roomId: string): Promise<WhiteboardRecord | null>;
  saveWhiteboard(roomId: string, whiteboard: WhiteboardRecord): Promise<void>;

  // --- pending_deliveries: offline replay queue (§3.2), dedup by idempotencyKey ---
  enqueuePending(targetAgentId: string, envelope: Envelope): Promise<void>;
  /** Remove and return the target's pending envelopes (deduped by idempotencyKey). */
  drainPending(targetAgentId: string): Promise<Envelope[]>;

  /** Release resources (close the DB handle). Idempotent. */
  close(): Promise<void>;
}
