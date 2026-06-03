import { describe, expect, test } from "bun:test";
import { formatWaitingForCodexTuiMessage } from "../waiting-message";

describe("waiting message", () => {
  test("shows pair identity and explains cwd-scoped Codex launches", () => {
    const message = formatWaitingForCodexTuiMessage({
      attachCmd: "agentbridge codex",
      cwd: "/Users/raysonmeng/repo/agent_bridge",
      pairId: "main-288b7863",
      pairName: "main",
      slot: 2,
      proxyUrl: "ws://127.0.0.1:4521",
    });

    expect(message).toContain("Waiting for Codex TUI");
    expect(message).toContain("cwd=/Users/raysonmeng/repo/agent_bridge");
    expect(message).toContain("pair=main");
    expect(message).toContain("pairId=main-288b7863");
    expect(message).toContain("slot=2");
    expect(message).toContain("proxy=ws://127.0.0.1:4521");
    expect(message).toContain("different cwd");
    expect(message).toContain("another pair");
    expect(message).toContain("agentbridge codex");
  });
});
