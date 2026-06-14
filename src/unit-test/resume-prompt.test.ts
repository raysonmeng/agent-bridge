import { describe, expect, test } from "bun:test";
import { RESUME_PROMPT } from "../budget/resume-prompt";

describe("RESUME_PROMPT", () => {
  test("points Codex at checkpoint next steps and DONE stop marker", () => {
    expect(RESUME_PROMPT).toContain("额度窗口已刷新");
    expect(RESUME_PROMPT).toContain(".agent/checkpoint.md");
    expect(RESUME_PROMPT).toContain("下一步");
    expect(RESUME_PROMPT).toContain("DONE");
  });
});
