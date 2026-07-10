import { describe, expect, test } from "bun:test";
import { removeMarkedSection, upsertMarkedSection } from "../marker-section";

const SECTION_ID = "TestSection";
const START = `<!-- ${SECTION_ID}:start -->`;
const END = `<!-- ${SECTION_ID}:end -->`;

describe("upsertMarkedSection", () => {
  test("case 1: empty content → creates block with markers", () => {
    const result = upsertMarkedSection("", SECTION_ID, "Hello World");
    expect(result).toBe(`${START}\nHello World\n${END}\n`);
  });

  test("case 1: whitespace-only content → creates block with markers", () => {
    const result = upsertMarkedSection("  \n  \n", SECTION_ID, "Hello World");
    expect(result).toBe(`${START}\nHello World\n${END}\n`);
  });

  test("case 2: existing content without markers → appends block", () => {
    const existing = "# My Project\n\nSome content here.\n";
    const result = upsertMarkedSection(existing, SECTION_ID, "New section");
    expect(result).toBe(
      `# My Project\n\nSome content here.\n\n${START}\nNew section\n${END}\n`,
    );
  });

  test("case 2: existing content without trailing newline → adds newline before block", () => {
    const existing = "# My Project\n\nSome content here.";
    const result = upsertMarkedSection(existing, SECTION_ID, "New section");
    expect(result).toBe(
      `# My Project\n\nSome content here.\n\n${START}\nNew section\n${END}\n`,
    );
  });

  test("case 3: existing content with markers → replaces between markers", () => {
    const existing = `# My Project\n\n${START}\nOld content\n${END}\n\n## Footer\n`;
    const result = upsertMarkedSection(existing, SECTION_ID, "Updated content");
    expect(result).toBe(
      `# My Project\n\n${START}\nUpdated content\n${END}\n\n## Footer\n`,
    );
  });

  test("case 3: replaces even when section content is identical", () => {
    const section = "Same content";
    const existing = `${START}\n${section}\n${END}\n`;
    const result = upsertMarkedSection(existing, SECTION_ID, section);
    // Should return identical content (no change)
    expect(result).toBe(existing);
  });

  test("preserves content before and after markers", () => {
    const before = "# Title\n\nParagraph.\n\n";
    const after = "\n\n## Other Section\n\nMore text.\n";
    const existing = `${before}${START}\nOLD\n${END}${after}`;
    const result = upsertMarkedSection(existing, SECTION_ID, "NEW");
    expect(result).toBe(`${before}${START}\nNEW\n${END}${after}`);
  });

  test("different section IDs don't interfere", () => {
    const existing = `<!-- Other:start -->\nKeep this\n<!-- Other:end -->\n`;
    const result = upsertMarkedSection(existing, SECTION_ID, "New block");
    // Should append (no matching markers for TestSection)
    expect(result).toContain("Keep this");
    expect(result).toContain(START);
    expect(result).toContain("New block");
  });

  test("malformed: orphan start marker → throws instead of silently appending", () => {
    // User manually deleted the end marker. A naive append would create a second
    // start marker, and the next call would splice out content in between.
    const existing = `# Title\n${START}\nOld notes\n## Other Section\nUser content\n`;
    expect(() => upsertMarkedSection(existing, SECTION_ID, "NEW")).toThrow(
      /Malformed .* markers/,
    );
  });

  test("malformed: orphan end marker → throws", () => {
    const existing = `# Title\nUser content\n${END}\nMore content\n`;
    expect(() => upsertMarkedSection(existing, SECTION_ID, "NEW")).toThrow(
      /Malformed .* markers/,
    );
  });

  test("malformed: end marker before start marker → throws", () => {
    // Pathological case from git merge or manual editing — markers out of order.
    // Silently splicing here reverses slice direction and destroys content.
    const existing = `# Title\n${END}\nUser notes\n${START}\nOld block\n`;
    expect(() => upsertMarkedSection(existing, SECTION_ID, "NEW")).toThrow(
      /Malformed .* markers/,
    );
  });
});

describe("removeMarkedSection", () => {
  test("no markers → untouched, removed=false", () => {
    const content = "# My Project\n\nSome content here.\n";
    const result = removeMarkedSection(content, SECTION_ID);
    expect(result.removed).toBe(false);
    expect(result.content).toBe(content);
  });

  test("file that was ONLY the block collapses to empty string", () => {
    const onlyBlock = upsertMarkedSection("", SECTION_ID, "Hello World");
    const result = removeMarkedSection(onlyBlock, SECTION_ID);
    expect(result.removed).toBe(true);
    expect(result.content).toBe("");
  });

  test("upsert → remove round-trips an existing file", () => {
    const original = "# My Project\n\nSome content here.\n";
    const withBlock = upsertMarkedSection(original, SECTION_ID, "Injected section");
    const result = removeMarkedSection(withBlock, SECTION_ID);
    expect(result.removed).toBe(true);
    expect(result.content).toBe(original);
  });

  test("upsert → remove on a file without trailing newline adds at most that newline", () => {
    const original = "# My Project\n\nSome content here.";
    const withBlock = upsertMarkedSection(original, SECTION_ID, "Injected section");
    const result = removeMarkedSection(withBlock, SECTION_ID);
    expect(result.removed).toBe(true);
    expect(result.content).toBe(original + "\n");
  });

  test("mid-file block: keeps surrounding content, collapses separator blank lines", () => {
    const existing = `# Title\n\n${START}\nBlock body\n${END}\n\n## Footer\nText.\n`;
    const result = removeMarkedSection(existing, SECTION_ID);
    expect(result.removed).toBe(true);
    expect(result.content).toBe("# Title\n## Footer\nText.\n");
  });

  test("different section IDs are not touched", () => {
    const existing = `<!-- Other:start -->\nKeep this\n<!-- Other:end -->\n`;
    const result = removeMarkedSection(existing, SECTION_ID);
    expect(result.removed).toBe(false);
    expect(result.content).toBe(existing);
  });

  test("malformed: orphan start marker → throws (never guess the block extent)", () => {
    const existing = `# Title\n${START}\nOld notes\nUser content\n`;
    expect(() => removeMarkedSection(existing, SECTION_ID)).toThrow(/Malformed .* markers/);
  });

  test("malformed: end marker before start marker → throws", () => {
    const existing = `# Title\n${END}\nUser notes\n${START}\nOld block\n`;
    expect(() => removeMarkedSection(existing, SECTION_ID)).toThrow(/Malformed .* markers/);
  });
});
