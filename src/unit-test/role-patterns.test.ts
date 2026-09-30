import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, CLAUDE_INSTRUCTIONS } from "../claude-adapter";
import { AGENTS_MD_SECTION } from "../collaboration-content";

describe("role-aware collaboration guidance", () => {
  test("claude instructions include role keywords and thinking patterns", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("Claude: Reviewer, Planner, Hypothesis Challenger");
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex: Implementer, Executor, Reproducer/Verifier");
    expect(CLAUDE_INSTRUCTIONS).toContain("Independent Analysis & Convergence");
    expect(CLAUDE_INSTRUCTIONS).toContain("Architect -> Builder -> Critic");
    expect(CLAUDE_INSTRUCTIONS).toContain("Hypothesis -> Experiment -> Interpretation");
    expect(CLAUDE_INSTRUCTIONS).toContain("My independent view is:");
    expect(CLAUDE_INSTRUCTIONS).toContain("I agree on:");
    expect(CLAUDE_INSTRUCTIONS).toContain("I disagree on:");
    expect(CLAUDE_INSTRUCTIONS).toContain("Current consensus:");
  });

  test("claude instructions include turn coordination guidance", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("Codex working/finished notices report only Codex turn state");
    expect(CLAUDE_INSTRUCTIONS).toContain("explicit to and optional in_reply_to");
    expect(CLAUDE_INSTRUCTIONS).toContain("do not block explicitly addressed messages to other local agents");
    expect(CLAUDE_INSTRUCTIONS).not.toContain("reply` only reaches the local Codex");
  });

  // The Codex-side bridge contract (message markers / git-forbidden / role
  // guidance) now lives in AGENTS.md (injected once by `abg init`), instead of
  // being appended to every claude→codex message. These assertions guard that the
  // contract semantics survive that move — Codex still learns them on startup.
  test("AGENTS.md collaboration section carries codex role guidance", () => {
    expect(AGENTS_MD_SECTION).toContain("Implementer, Executor, Verifier");
    expect(AGENTS_MD_SECTION).toContain("Independent Analysis & Convergence");
    expect(AGENTS_MD_SECTION).toContain("Architect → Builder → Critic");
    expect(AGENTS_MD_SECTION).toContain("Hypothesis → Experiment → Interpretation");
    expect(AGENTS_MD_SECTION).toContain("Do not blindly follow Claude");
    expect(AGENTS_MD_SECTION).toContain("My independent view is:");
  });

  test("AGENTS.md collaboration section requires explicit tools, never normal output markers", () => {
    expect(AGENTS_MD_SECTION).toContain("agentbridge_local_send");
    expect(AGENTS_MD_SECTION).toContain("in_reply_to");
    expect(AGENTS_MD_SECTION).toContain("ordinary output is never forwarded");
    expect(AGENTS_MD_SECTION).toContain("do not send anything");
    expect(AGENTS_MD_SECTION).not.toContain("No tool call needed");
  });

  test("AGENTS.md collaboration section forbids git write operations", () => {
    expect(AGENTS_MD_SECTION).toContain("Git operations — FORBIDDEN");
    expect(AGENTS_MD_SECTION).toContain("MUST NOT run git **write** commands");
    expect(AGENTS_MD_SECTION).toContain("hang your session");
    expect(AGENTS_MD_SECTION).toContain("Delegate **all** git writes to Claude");
  });

  test("CLAUDE_INSTRUCTIONS is wired into MCP Server", () => {
    const adapter = new ClaudeAdapter() as any;
    // Verify the exported constant is actually passed to the Server constructor
    const serverInstructions = adapter.server._instructions;
    expect(serverInstructions).toBe(CLAUDE_INSTRUCTIONS);
  });
});
