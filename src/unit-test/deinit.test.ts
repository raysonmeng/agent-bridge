import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeCollaborationSections } from "../cli/deinit";
import { MARKER_ID } from "../collaboration-content";
import { upsertMarkedSection } from "../marker-section";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abg-deinit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("removeCollaborationSections", () => {
  test("strips injected sections and restores the original file", () => {
    const original = "# My Project\n\nDocs.\n";
    writeFileSync(join(dir, "CLAUDE.md"), upsertMarkedSection(original, MARKER_ID, "collab"), "utf-8");
    writeFileSync(join(dir, "AGENTS.md"), upsertMarkedSection(original, MARKER_ID, "collab"), "utf-8");

    const results = removeCollaborationSections(dir);

    expect(results).toEqual(["CLAUDE.md: section removed", "AGENTS.md: section removed"]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe(original);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe(original);
  });

  test("missing files are reported, not created", () => {
    const results = removeCollaborationSections(dir);
    expect(results[0]).toContain("CLAUDE.md: not found");
    expect(results[1]).toContain("AGENTS.md: not found");
  });

  test("file that was only the injected block → emptied with a delete hint", () => {
    writeFileSync(join(dir, "CLAUDE.md"), upsertMarkedSection("", MARKER_ID, "collab"), "utf-8");

    const results = removeCollaborationSections(dir);

    expect(results[0]).toContain("file is now empty");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("");
  });

  test("files without markers are left untouched", () => {
    const content = "# Plain file\n";
    writeFileSync(join(dir, "AGENTS.md"), content, "utf-8");

    const results = removeCollaborationSections(dir);

    expect(results[1]).toContain("no AgentBridge section found");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe(content);
  });

  test("malformed markers → skipped with the repair message, file untouched", () => {
    const malformed = `# Title\n<!-- ${MARKER_ID}:start -->\norphaned\n`;
    writeFileSync(join(dir, "CLAUDE.md"), malformed, "utf-8");

    const results = removeCollaborationSections(dir);

    expect(results[0]).toContain("skipped");
    expect(results[0]).toContain("Malformed");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe(malformed);
  });
});
