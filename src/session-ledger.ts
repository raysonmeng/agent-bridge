import type { Store } from "./backbone/store";

export type SessionContinuity = "new" | "resumed";

export interface SessionStartResult {
  continuity: SessionContinuity;
  /** The prior session id for this workspace+agentType (what to resume from), or null. */
  previousSessionId: string | null;
}

/**
 * §2.5 session accounting (Edge-local — a workspace path is per-machine).
 *
 * Records `(workspace, agentType) → lastSessionId` and reports whether a starting
 * session is a cold "new" start or a "resumed" continuation, so presence (§3.4)
 * can tell the room whether the joining member needs catch-up context.
 *
 * AgentBridge only STORES + GIVES the sessionId; the actual context resume is the
 * agent's own native command (Claude `--resume <id>`, etc.), driven by its
 * adapter — "记账在 AgentBridge，恢复在 adapter+agent" (§2.5).
 */
export class SessionLedger {
  constructor(private readonly store: Store) {}

  /** Record a starting session; returns whether it continues a prior one + the id to resume. */
  async recordSessionStart(
    workspacePath: string,
    agentType: string,
    sessionId: string,
  ): Promise<SessionStartResult> {
    const previousSessionId = await this.store.getLastSession(workspacePath, agentType);
    await this.store.setLastSession(workspacePath, agentType, sessionId);
    return {
      continuity: previousSessionId ? "resumed" : "new",
      previousSessionId,
    };
  }

  /** The last recorded session id for this workspace+agentType, or null. */
  async lastSession(workspacePath: string, agentType: string): Promise<string | null> {
    return this.store.getLastSession(workspacePath, agentType);
  }
}
