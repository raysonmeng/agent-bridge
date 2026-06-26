import { describe, test, expect } from "bun:test";
import { sanitizePresence } from "../broker";

// sanitizePresence is the trust boundary for the untrusted `presence` blob a
// client sends at hello (§7.3). These assert malformed input is dropped, never
// echoed into a member_joined that fans out to the room.
describe("sanitizePresence — hello presence trust boundary", () => {
  test("non-objects ⇒ undefined", () => {
    for (const bad of [null, undefined, 42, "str", true, []]) {
      expect(sanitizePresence(bad)).toBeUndefined();
    }
  });

  test("malformed fields are dropped; an all-malformed blob ⇒ undefined", () => {
    expect(sanitizePresence({ agentType: 123 })).toBeUndefined(); // non-string
    expect(sanitizePresence({ host: { nested: true } })).toBeUndefined(); // object
    expect(sanitizePresence({ capabilities: "not-an-array" })).toBeUndefined();
    expect(sanitizePresence({ capabilities: [42, { x: 1 }] })).toBeUndefined(); // filtered empty ⇒ omitted
    expect(sanitizePresence({ budgetHint: ["arr"] })).toBeUndefined();
  });

  test("valid fields survive; non-string capability entries are filtered out", () => {
    expect(
      sanitizePresence({ agentType: "claude", host: 5, capabilities: ["a", 1, { x: 1 }, "b"], budgetHint: 7 }),
    ).toEqual({ agentType: "claude", capabilities: ["a", "b"] }); // host/budgetHint dropped (non-string)
    expect(sanitizePresence({ agentType: "codex", host: "tailnet-1", capabilities: ["review"], budgetHint: "low" })).toEqual({
      agentType: "codex",
      host: "tailnet-1",
      capabilities: ["review"],
      budgetHint: "low",
    });
  });

  test("a __proto__ payload neither pollutes Object.prototype nor leaks into the result", () => {
    const raw = JSON.parse('{"__proto__":{"polluted":1},"host":"h"}');
    const out = sanitizePresence(raw);
    expect(out).toEqual({ host: "h" }); // only the known string field survives
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no prototype pollution
  });

  test("over-long fields are length-capped and over-many capabilities are count-capped (fan-out DoS)", () => {
    // A member's presence blob is broadcast to the whole room; an unbounded field or
    // list would let one member amplify a multi-MB payload across all subscribers.
    const out = sanitizePresence({
      host: "h".repeat(5000),
      agentType: "a".repeat(5000),
      budgetHint: "b".repeat(5000),
      capabilities: Array.from({ length: 100 }, (_, i) => `cap-${i}`),
    })!;
    // Count CODE POINTS (Array.from), matching the impl's code-point slice — a
    // plain .length (UTF-16 units) would over-count emoji and diverge from the cap.
    expect(Array.from(out.host!).length).toBeLessThanOrEqual(200); // PRESENCE_FIELD_CAP
    expect(Array.from(out.agentType!).length).toBeLessThanOrEqual(200);
    expect(Array.from(out.budgetHint!).length).toBeLessThanOrEqual(200);
    expect(out.capabilities!.length).toBe(20); // PRESENCE_CAPS_CAP (array count)
    expect(out.capabilities!.every((c) => Array.from(c).length <= 200)).toBe(true);
  });
});
