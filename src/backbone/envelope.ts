/**
 * v3 message envelope (spec §3.1 + Appendix A).
 *
 * The control-plane unit the broker routes. Coexists with the legacy 2-party
 * `BridgeMessage` (src/types.ts) — v3 routing uses THIS envelope; the single-
 * machine Claude↔Codex flow keeps `BridgeMessage`. Carries only structured
 * signals (a few hundred bytes); NEVER file/code content (data plane = git, §2.6).
 */

export type DeliveryMode = "online_only" | "store_if_offline";

export interface EnvelopeSender {
  /** Logical agent id — events are signed precisely to this (§2.1). */
  agentId: string;
  /** Ephemeral current session (§2.1); never a membership key. */
  sessionId?: string;
  agentType: string;
  /** Display name, for UI only; routing never uses it (§2.2). */
  name?: string;
}

export interface Envelope {
  /** Room scope (§2.3). */
  roomId: string;
  /** Stable per-message id. */
  messageId: string;
  /**
   * Stable trace id for loop prevention across multi-hop forwarding (§3.2) —
   * the generalisation of the v1 binary-source guard.
   */
  traceId: string;
  /** Dedup key for at-least-once redelivery (§3.2 offline replay). */
  idempotencyKey: string;
  from: EnvelopeSender;
  /** Event-type discriminator, e.g. "task_completed" | "dm" | "member_joined". */
  kind: string;
  /** Event-specific body. Kept small; the ledger stores summaries, not blobs (§4.1). */
  payload?: unknown;
  timestamp: number;
  deliveryMode: DeliveryMode;
  /** Present ⇒ DM (only the listed agents receive it, §3.2). Absent ⇒ room broadcast. */
  to?: string[];
  /** @-mentions: delivered to the room, highlighted for these agents (§3.2). */
  mentions?: string[];
  /** Remaining forward hops; dropped at 0 (multi-party loop prevention, §3.2). */
  hop?: number;
  ack?: { requested: boolean };
}
