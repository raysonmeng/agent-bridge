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
});
