import type { Envelope } from "./backbone/envelope";

export interface AgentRegistration {
  /** The logical agent id this session registered as (§2.1). */
  agentId: string;
  /** The room(s) the session joined (cwd→room map / explicit join, §2.4). */
  roomIds: string[];
}

/**
 * §5.2 thin adapter contract (Appendix D) — the Edge seam each supported agent
 * implements; the broker side is unchanged per agent.
 *
 *   1. register            — on session start, resolve identity + join room(s) (§2.4).
 *   2. onCompletion        — hook the agent's native completion event; publish a
 *                            structured task_completed envelope into the active room.
 *   3. receiveIntoSession  — push an inbound envelope into the agent's live session.
 *
 * Adapters stay THIN: a wrapper over each agent's native hooks (publish) + a
 * message channel (receive). Agents with no hooks are unsupported (§5.1). The
 * real Claude / Codex / OpenCode adapters implement this in later PRs; here it is
 * the frozen contract they target.
 */
export interface AgentAdapter {
  register(ctx: { cwd: string; agentType: string }): Promise<AgentRegistration>;
  onCompletion(publish: (envelope: Envelope) => void): void;
  receiveIntoSession(envelope: Envelope): Promise<void>;
}
