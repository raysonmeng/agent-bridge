import { describe, test, expect } from "bun:test";
import { buildPresenceEnvelope } from "../presence";

describe("buildPresenceEnvelope (§11.1 bullet 9)", () => {
  test("member_joined: broadcast, online_only, echoes displayName + reserved meta", () => {
    const env = buildPresenceEnvelope({
      kind: "member_joined",
      roomId: "checkout",
      agentId: "alice@x.com",
      displayName: "Alice",
      meta: { agentType: "claude", host: "tailnet-1", capabilities: ["review", "plan"], budgetHint: "low" },
      now: () => 7,
    });
    expect(env.kind).toBe("member_joined");
    expect(env.roomId).toBe("checkout");
    expect(env.deliveryMode).toBe("online_only"); // ephemeral — never stored for offline replay
    expect(env.to).toBeUndefined(); // broadcast
    expect(env.timestamp).toBe(7);
    expect(env.from).toEqual({ agentId: "alice@x.com", agentType: "claude" });
    expect(env.payload).toEqual({
      displayName: "Alice",
      host: "tailnet-1",
      capabilities: ["review", "plan"],
      budgetHint: "low",
    });
  });

  test("member_left with no meta: empty payload, agentType defaults to unknown", () => {
    const env = buildPresenceEnvelope({ kind: "member_left", roomId: "r1", agentId: "bob@x.com" });
    expect(env.kind).toBe("member_left");
    expect(env.from).toEqual({ agentId: "bob@x.com", agentType: "unknown" });
    expect(env.payload).toEqual({});
    expect(env.deliveryMode).toBe("online_only");
  });

  test("omits empty capabilities and absent reserved fields", () => {
    const env = buildPresenceEnvelope({
      kind: "member_joined",
      roomId: "r1",
      agentId: "a",
      displayName: "A",
      meta: { capabilities: [] },
    });
    expect(env.payload).toEqual({ displayName: "A" });
  });
});
