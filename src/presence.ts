import { randomUUID } from "node:crypto";
import type { Envelope } from "./backbone/envelope";

export type PresenceKind = "member_joined" | "member_left";

/**
 * Reserved presence metadata a client may declare at `hello` (§5.2 / §11.1
 * bullet 9). `host`/`capabilities` describe the agent; `budgetHint` is reserved
 * for the budget-aware B-class and is IGNORED by the A-class MVP. All optional —
 * presence works with none of them.
 */
export interface PresenceMeta {
  agentType?: string;
  host?: string;
  capabilities?: string[];
  /** Reserved (§11.1): budget coordination is B-class; A-class never reads this. */
  budgetHint?: string;
}

export interface BuildPresenceInput {
  kind: PresenceKind;
  roomId: string;
  agentId: string;
  /** Server-authoritative display name (from the resolved identity), for UI only. */
  displayName?: string;
  meta?: PresenceMeta;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Build a presence Envelope (member_joined / member_left, §11.1 bullet 9).
 *
 * Broadcast to the room (no `to`) and `online_only` — presence is EPHEMERAL, so
 * it is never persisted for offline replay (a member who was absent doesn't need
 * a backlog of stale join/leave churn; they get the live roster on reconnect).
 * The reserved `host`/`capabilities`/`budgetHint` ride in the payload for the
 * receiving adapter to render; routing never uses them.
 */
export function buildPresenceEnvelope(input: BuildPresenceInput): Envelope {
  const payload: Record<string, unknown> = {};
  if (input.displayName) payload.displayName = input.displayName;
  if (input.meta?.host) payload.host = input.meta.host;
  if (input.meta?.capabilities && input.meta.capabilities.length > 0) {
    payload.capabilities = input.meta.capabilities;
  }
  if (input.meta?.budgetHint) payload.budgetHint = input.meta.budgetHint;
  return {
    roomId: input.roomId,
    messageId: randomUUID(),
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    from: { agentId: input.agentId, agentType: input.meta?.agentType ?? "unknown" },
    kind: input.kind,
    payload,
    timestamp: (input.now ?? Date.now)(),
    deliveryMode: "online_only",
  };
}
