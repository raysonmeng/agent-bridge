import type { Envelope } from "./backbone/envelope";
import type { WhiteboardItem, WhiteboardRecord } from "./backbone/store";

/** Per-slot cap (§4.3): keep the newest items, drop the oldest, so a slot can't grow unbounded. */
export const MAX_WHITEBOARD_SLOT = 50;

type SlotName = "contractsReady" | "inProgress" | "blockers" | "recentMilestones";

export function emptyWhiteboard(roomId: string, now: () => number = Date.now): WhiteboardRecord {
  return { roomId, contractsReady: [], inProgress: [], blockers: [], recentMilestones: [], updatedAt: now() };
}

/** Derive the slot additions for an event. Empty ⇒ the kind doesn't touch the whiteboard. */
function additionsFor(env: Envelope): Array<{ slot: SlotName; item: WhiteboardItem }> {
  if (env.kind !== "task_completed") return []; // only completions distill today (note/etc. = future)
  if (env.to !== undefined) return []; // the whiteboard is public to every room member
  const p = (env.payload ?? {}) as {
    summary?: string;
    contract?: string;
    repo?: string;
    branch?: string;
    commit?: string;
  };
  const by = env.from?.agentId ?? "unknown";
  const ts = env.timestamp;
  const milestone: WhiteboardItem = { summary: p.summary ?? "", by, ts };
  if (p.repo) milestone.repo = p.repo;
  if (p.branch) milestone.branch = p.branch;
  if (p.commit) milestone.commit = p.commit;
  const out: Array<{ slot: SlotName; item: WhiteboardItem }> = [{ slot: "recentMilestones", item: milestone }];
  // A completion that names the contract it provides also lands in contractsReady,
  // the "you can build on this now" slot (§4.2).
  if (p.contract) out.push({ slot: "contractsReady", item: { contract: p.contract, by, ts, summary: p.summary ?? "" } });
  return out;
}

function capSlot(items: WhiteboardItem[]): WhiteboardItem[] {
  return items.length > MAX_WHITEBOARD_SLOT ? items.slice(items.length - MAX_WHITEBOARD_SLOT) : items;
}

/**
 * Mechanical, zero-LLM whiteboard merge (§4.2). Appends the event's distilled
 * items to their slots (newest kept, per-slot capped), returning a NEW record —
 * the input `prev` is never mutated. For a kind that doesn't touch the whiteboard
 * it returns `prev` UNCHANGED (same reference, possibly null), so the caller can
 * skip the Store write via an identity check.
 */
export function mergeWhiteboard(
  prev: WhiteboardRecord | null,
  env: Envelope,
  now: () => number = Date.now,
): WhiteboardRecord | null {
  const additions = additionsFor(env);
  if (additions.length === 0) return prev; // unmergeable kind → no change (caller skips save)
  const base = prev ?? emptyWhiteboard(env.roomId, now);
  const next: WhiteboardRecord = {
    roomId: env.roomId,
    contractsReady: [...base.contractsReady],
    inProgress: [...base.inProgress],
    blockers: [...base.blockers],
    recentMilestones: [...base.recentMilestones],
    updatedAt: now(),
  };
  for (const { slot, item } of additions) {
    next[slot] = capSlot([...next[slot], item]);
  }
  return next;
}
