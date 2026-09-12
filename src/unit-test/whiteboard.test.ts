import { describe, test, expect } from "bun:test";
import { mergeWhiteboard, emptyWhiteboard, MAX_WHITEBOARD_SLOT } from "../whiteboard";
import { buildTaskCompletedEnvelope } from "../task-completed";
import { buildPresenceEnvelope } from "../presence";
import type { Envelope } from "../backbone/envelope";
import type { WhiteboardRecord } from "../backbone/store";

function tc(opts: { summary: string; contract?: string; repo?: string; branch?: string; agentId?: string }): Envelope {
  return buildTaskCompletedEnvelope({
    roomId: "r1",
    from: { agentId: opts.agentId ?? "bob@x.com", agentType: "codex" },
    summary: opts.summary,
    contract: opts.contract,
    repo: opts.repo,
    branch: opts.branch,
    now: () => 100,
  });
}

describe("mergeWhiteboard — zero-LLM mechanical merge (§4.2)", () => {
  test("task_completed appends a milestone; a named contract also lands in contractsReady", () => {
    const wb = mergeWhiteboard(null, tc({ summary: "auth done", contract: "auth/v1", repo: "app", branch: "main" }), () => 7)!;
    expect(wb.recentMilestones).toHaveLength(1);
    expect(wb.recentMilestones[0]).toMatchObject({ summary: "auth done", by: "bob@x.com", repo: "app", branch: "main" });
    expect(wb.contractsReady).toHaveLength(1);
    expect(wb.contractsReady[0]).toMatchObject({ contract: "auth/v1", by: "bob@x.com", summary: "auth done" });
    expect(wb.updatedAt).toBe(7);
  });

  test("directed completions never enter any public whiteboard slot", () => {
    const prev = mergeWhiteboard(null, tc({ summary: "public" }))!;
    for (const to of [[], ["bob@x.com"]]) {
      const privateCompletion = { ...tc({ summary: "private", contract: "secret/v1" }), to };
      expect(mergeWhiteboard(prev, privateCompletion)).toBe(prev);
      expect(mergeWhiteboard(null, privateCompletion)).toBeNull();
    }
  });

  test("a completion without a contract only touches recentMilestones", () => {
    const wb = mergeWhiteboard(null, tc({ summary: "wip" }))!;
    expect(wb.recentMilestones).toHaveLength(1);
    expect(wb.contractsReady).toHaveLength(0);
  });

  test("unmergeable kinds return the SAME reference (caller skips the Store write)", () => {
    const prev: WhiteboardRecord = emptyWhiteboard("r1", () => 1);
    const joined = buildPresenceEnvelope({ kind: "member_joined", roomId: "r1", agentId: "a", displayName: "A" });
    expect(mergeWhiteboard(prev, joined)).toBe(prev); // same ref
    expect(mergeWhiteboard(null, joined)).toBeNull(); // null stays null
  });

  test("does not mutate the input record (immutable)", () => {
    const prev = mergeWhiteboard(null, tc({ summary: "first" }))!;
    const before = JSON.stringify(prev);
    const next = mergeWhiteboard(prev, tc({ summary: "second" }))!;
    expect(JSON.stringify(prev)).toBe(before); // prev untouched
    expect(next.recentMilestones).toHaveLength(2);
  });

  test("each slot is capped at MAX_WHITEBOARD_SLOT, keeping the newest", () => {
    let wb: WhiteboardRecord | null = null;
    for (let i = 0; i < MAX_WHITEBOARD_SLOT + 10; i++) {
      wb = mergeWhiteboard(wb, tc({ summary: `s${i}` }));
    }
    expect(wb!.recentMilestones).toHaveLength(MAX_WHITEBOARD_SLOT);
    expect(wb!.recentMilestones[0]!.summary).toBe(`s10`); // oldest 10 dropped
    expect(wb!.recentMilestones.at(-1)!.summary).toBe(`s${MAX_WHITEBOARD_SLOT + 9}`);
  });
});
