import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_MD_SECTION } from "../collaboration-content";
import {
  checkAgentsMdContract,
  isFreshAgentsMdContract,
} from "../agents-contract";

const FRESH_BODY = `<!-- AgentBridge:start -->\n${AGENTS_MD_SECTION}\n<!-- AgentBridge:end -->`;

describe("agents contract (read-only)", () => {
  test("missing AGENTS.md is never created and reports not-fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-agents-"));
    try {
      const result = checkAgentsMdContract(root);
      expect(result.exists).toBe(false);
      expect(result.fresh).toBe(false);
      expect(result.message).toContain("abg init");
      // The check must NEVER write the file.
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale AGENTS.md is left untouched and reports not-fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-agents-"));
    try {
      const original = "# Rules\n\n<!-- AgentBridge:start -->\nold\n<!-- AgentBridge:end -->\n";
      writeFileSync(join(root, "AGENTS.md"), original, "utf-8");
      const result = checkAgentsMdContract(root);
      expect(result.exists).toBe(true);
      expect(result.fresh).toBe(false);
      expect(result.message).toContain("abg init");
      // The file content must remain exactly as written — no auto-fix.
      expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fresh AGENTS.md reports fresh:true without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-agents-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), `# Rules\n\n${FRESH_BODY}\n`, "utf-8");
      const result = checkAgentsMdContract(root);
      expect(result.exists).toBe(true);
      expect(result.fresh).toBe(true);
      expect(result.message).toContain("up to date");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("old implicit-output guidance is stale", () => {
    expect(isFreshAgentsMdContract([
      "<!-- AgentBridge:start -->", "AgentBridge is a transparent proxy.", "Do not bypass it.",
      "Use sendToClaude to talk back.", "Git operations are handled by Claude.",
      "Roles: Implementer, Executor, Verifier.", "<!-- AgentBridge:end -->",
    ].join("\n"))).toBe(false);
  });

  test("isFreshAgentsMdContract recognizes a complete contract block", () => {
    expect(isFreshAgentsMdContract(FRESH_BODY)).toBe(true);
    expect(isFreshAgentsMdContract("# Rules\n")).toBe(false);
    expect(
      isFreshAgentsMdContract("<!-- AgentBridge:start -->\nold\n<!-- AgentBridge:end -->"),
    ).toBe(false);
  });
});
