import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, CLAUDE_INSTRUCTIONS } from "./claude-adapter";
import { BRIDGE_CONTRACT_REMINDER } from "./message-filter";

describe("protocol-level instructions", () => {
  test("claude instructions describe push channel format and reply protocol", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("notifications/claude/channel");
    expect(CLAUDE_INSTRUCTIONS).toContain("<channel source=\"agentbridge\"");
    expect(CLAUDE_INSTRUCTIONS).toContain("reply tool");
    expect(CLAUDE_INSTRUCTIONS).toContain("chat_id");
  });

  test("claude instructions describe pull fallback and marker semantics", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("get_messages");
    expect(CLAUDE_INSTRUCTIONS).toContain("[IMPORTANT] = decisions, reviews, completions, blockers.");
    expect(CLAUDE_INSTRUCTIONS).toContain("[STATUS] = progress updates");
    expect(CLAUDE_INSTRUCTIONS).toContain("[FYI] = background context");
  });

  test("claude instructions include turn coordination guidance", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex is working");
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex finished");
    expect(CLAUDE_INSTRUCTIONS).toContain("busy error");
  });

  test("claude instructions stay protocol-focused and omit collaboration style defaults", () => {
    expect(CLAUDE_INSTRUCTIONS).not.toContain("Claude: Reviewer, Planner, Hypothesis Challenger");
    expect(CLAUDE_INSTRUCTIONS).not.toContain("Independent Analysis & Convergence");
    expect(CLAUDE_INSTRUCTIONS).not.toContain("My independent view is:");
  });

  test("bridge contract reminder includes codex role guidance", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Your default role: Implementer, Executor, Verifier");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Independent Analysis & Convergence");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Architect -> Builder -> Critic");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Hypothesis -> Experiment -> Interpretation");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Do not blindly follow Claude");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("My independent view is:");
  });

  test("bridge contract reminder specifies marker must be at start", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("at the very start");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST be the first text");
  });

  test("CLAUDE_INSTRUCTIONS is wired into MCP Server", () => {
    const adapter = new ClaudeAdapter() as any;
    // Verify the exported constant is actually passed to the Server constructor
    const serverInstructions = adapter.server._instructions;
    expect(serverInstructions).toBe(CLAUDE_INSTRUCTIONS);
  });
});
