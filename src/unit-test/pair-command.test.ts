import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pairScopedCommand } from "../pair-command";

describe("pairScopedCommand", () => {
  let savedId: string | undefined;
  let savedName: string | undefined;
  beforeEach(() => {
    savedId = process.env.AGENTBRIDGE_PAIR_ID;
    savedName = process.env.AGENTBRIDGE_PAIR_NAME;
    delete process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_NAME;
  });
  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTBRIDGE_PAIR_ID;
    else process.env.AGENTBRIDGE_PAIR_ID = savedId;
    if (savedName === undefined) delete process.env.AGENTBRIDGE_PAIR_NAME;
    else process.env.AGENTBRIDGE_PAIR_NAME = savedName;
  });

  test("legacy/manual mode (no AGENTBRIDGE_PAIR_ID) → bare command", () => {
    expect(pairScopedCommand("codex")).toBe("agentbridge codex");
    expect(pairScopedCommand("claude")).toBe("agentbridge claude");
    expect(pairScopedCommand("kill")).toBe("agentbridge kill");
  });

  test("pair mode → puts --pair <selector> BEFORE the subcommand", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "work-1a2b3c4d";
    process.env.AGENTBRIDGE_PAIR_NAME = "work";
    expect(pairScopedCommand("codex")).toBe("agentbridge --pair work codex");
    expect(pairScopedCommand("claude")).toBe("agentbridge --pair work claude");
    expect(pairScopedCommand("kill")).toBe("agentbridge --pair work kill");
  });

  test("prefers the friendly name over the composite pairId", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "main-deadbeef";
    process.env.AGENTBRIDGE_PAIR_NAME = "main";
    expect(pairScopedCommand("codex")).toBe("agentbridge --pair main codex");
  });

  test("--pair precedes the subcommand's own extra args", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "review-1a2b3c4d";
    process.env.AGENTBRIDGE_PAIR_NAME = "review";
    expect(pairScopedCommand("claude --resume")).toBe("agentbridge --pair review claude --resume");
  });

  test("an empty-string AGENTBRIDGE_PAIR_ID is treated as unset (no --pair)", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "";
    expect(pairScopedCommand("codex")).toBe("agentbridge codex");
  });

  test("falls back to the composite pairId when no friendly name is set", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "myproj-1a2b3c4d";
    expect(pairScopedCommand("codex")).toBe("agentbridge --pair myproj-1a2b3c4d codex");
  });
});
