import type { Envelope } from "../backbone/envelope";

/** Build a v3 Envelope with sensible defaults for contract tests. */
export function makeEnvelope(over: Partial<Envelope> = {}): Envelope {
  return {
    roomId: "room-1",
    messageId: "m1",
    traceId: "t1",
    idempotencyKey: "k1",
    from: { agentId: "ag-1", agentType: "claude" },
    kind: "task_completed",
    timestamp: 1,
    deliveryMode: "store_if_offline",
    ...over,
  };
}
