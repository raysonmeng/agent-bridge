import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeCollaborationSections } from "../cli/init";
import { MARKER_ID } from "../collaboration-content";

const START = `<!-- ${MARKER_ID}:start -->`;
const END = `<!-- ${MARKER_ID}:end -->`;

describe("writeCollaborationSections", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-collab-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates CLAUDE.md and AGENTS.md when they don't exist", () => {
    const results = writeCollaborationSections(tempDir);

    expect(results).toHaveLength(2);
    expect(results[0]).toContain("CLAUDE.md: created");
    expect(results[1]).toContain("AGENTS.md: created");

    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(claude).toContain(START);
    expect(claude).toContain(END);
    expect(claude).toContain("Multi-Agent Collaboration");
    expect(claude).toContain("Codex");

    const agents = readFileSync(join(tempDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain(START);
    expect(agents).toContain(END);
    expect(agents).toContain("Multi-Agent Collaboration");
    expect(agents).toContain("Claude");
  });

  test("appends to existing CLAUDE.md without markers", () => {
    const existingContent = "# My Project Rules\n\nDo not break things.\n";
    writeFileSync(join(tempDir, "CLAUDE.md"), existingContent, "utf-8");

    const results = writeCollaborationSections(tempDir);

    expect(results[0]).toContain("CLAUDE.md: appended");

    const claude = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    // Original content preserved
    expect(claude).toContain("# My Project Rules");
    expect(claude).toContain("Do not break things.");
    // New section appended
    expect(claude).toContain(START);
    expect(claude).toContain("Multi-Agent Collaboration");
  });

  test("replaces existing markers on re-run", () => {
    // First run
    writeCollaborationSections(tempDir);
    const firstRun = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(firstRun).toContain(START);

    // Second run (idempotent replace)
    const results = writeCollaborationSections(tempDir);
    expect(results[0]).toContain("unchanged");

    const secondRun = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(secondRun).toBe(firstRun);
  });

  test("preserves pre-existing content when appending", () => {
    const projectRules = [
      "# Project CLAUDE.md",
      "",
      "## Git Rules",
      "- Always use feature branches",
      "- Squash merge only",
      "",
    ].join("\n");
    writeFileSync(join(tempDir, "CLAUDE.md"), projectRules, "utf-8");

    writeCollaborationSections(tempDir);

    const result = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    // All original content preserved
    expect(result).toContain("# Project CLAUDE.md");
    expect(result).toContain("## Git Rules");
    expect(result).toContain("Always use feature branches");
    expect(result).toContain("Squash merge only");
    // Collaboration section added
    expect(result).toContain("Multi-Agent Collaboration");
  });

  test("updates when section content changes between versions", () => {
    // Simulate an older version's markers with different content
    const oldContent = `# Project\n\n${START}\nOLD COLLABORATION CONTENT\n${END}\n`;
    writeFileSync(join(tempDir, "CLAUDE.md"), oldContent, "utf-8");

    const results = writeCollaborationSections(tempDir);
    expect(results[0]).toContain("CLAUDE.md: updated");

    const updated = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8");
    expect(updated).not.toContain("OLD COLLABORATION CONTENT");
    expect(updated).toContain("Multi-Agent Collaboration");
    expect(updated).toContain("# Project");
  });
});
