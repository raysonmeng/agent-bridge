import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { Identity } from "./identity";

/**
 * Three-layer identity service (§2.1–2.2) over a Store.
 *
 * Enforces the id/displayName separation: `id` (an email or GitHub name) is the
 * UNIQUE routing key the core uses for signing / routing / membership; the
 * displayName is display-only and may collide. Persists person identities,
 * logical agents (e.g. "Alice's Claude Code") and sessions, and issues PSK
 * tokens bound to an identity (`abg auth login`).
 *
 * The three layers map to Store rows: identities (person), agents (logical
 * agent, FK personId), sessions (ephemeral). Re-registering the same id reuses
 * the row (a second device → same identity), never a new one (§2.2).
 */
export class IdentityService {
  constructor(private readonly store: Store) {}

  /** Register a person identity (or update its display name). Returns it. */
  async registerIdentity(id: string, displayName: string): Promise<Identity> {
    const trimmed = id.trim();
    if (trimmed === "") throw new Error("identity id must be non-empty (use an email or GitHub name)");
    const rec = await this.store.upsertIdentity(trimmed, displayName);
    return { id: rec.id, displayName: rec.displayName };
  }

  async getIdentity(id: string): Promise<Identity | null> {
    const rec = await this.store.getIdentity(id);
    return rec ? { id: rec.id, displayName: rec.displayName } : null;
  }

  /** Register a logical agent under a person (§2.1). Re-register updates type. */
  async registerAgent(agentId: string, personId: string, type: string): Promise<void> {
    await this.store.upsertAgent(agentId, personId, type);
  }

  async recordSession(sessionId: string, agentId: string, startedAt: number): Promise<void> {
    await this.store.recordSession(sessionId, agentId, startedAt);
  }

  /** Roll a logical agent up to its owning person id (§2.1). Null if unknown. */
  async resolvePerson(agentId: string): Promise<string | null> {
    const agent = await this.store.getAgent(agentId);
    return agent ? agent.personId : null;
  }

  /**
   * Issue a fresh PSK token bound to an existing identity (`abg auth login`).
   * The identity MUST already be registered. Returns the opaque token to hand to
   * the user; the (token → identity) binding is persisted for the broker to
   * verify via {@link Store.resolveToken}.
   */
  async issueToken(identityId: string): Promise<string> {
    if (!(await this.store.getIdentity(identityId))) {
      throw new Error(`unknown identity: ${identityId} (register it first)`);
    }
    const token = randomUUID();
    await this.store.issueToken(token, identityId);
    return token;
  }

  /**
   * Revoke ALL PSK tokens bound to an identity (§11.3). Returns how many bindings were deleted. The
   * identity must `abg auth login`/`issue` again to get a fresh token; old tokens are rejected at the
   * broker's next authenticate. Does NOT close already-open connections (auth is checked at hello) —
   * pair with `abg room remove` to evict a live session (membership is re-checked on delivery).
   */
  async revokeTokens(identityId: string): Promise<number> {
    return this.store.revokeTokens(identityId);
  }
}
