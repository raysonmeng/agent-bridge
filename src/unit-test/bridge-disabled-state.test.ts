import { describe, expect, test } from "bun:test";
import { disabledReplyError } from "../bridge-disabled-state";

describe("bridge disabled-state messaging", () => {
  test("kill-disabled sessions explain how to reconnect", () => {
    expect(disabledReplyError("killed")).toContain("disabled by `agentbridge kill`");
    expect(disabledReplyError("killed")).toContain("/resume");
  });

  test("replaced sessions stay permanently dormant and do not suggest reconnect", () => {
    const message = disabledReplyError("replaced");
    expect(message).toContain("replaced by a newer Claude Code session");
    expect(message).toContain("permanently idle");
    expect(message).not.toContain("agentbridge kill");
    expect(message).not.toContain("/resume");
  });
});
