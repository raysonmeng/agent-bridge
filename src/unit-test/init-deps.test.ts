import { describe, expect, test } from "bun:test";
import { formatDepChecks, type DepCheck } from "../cli/init";

describe("init: formatDepChecks", () => {
  test("renders doctor-style 'STATUS name: detail' lines with padded status", () => {
    const lines = formatDepChecks(
      [
        { name: "bun", status: "ok", detail: "1.3.11" },
        { name: "claude", status: "ok", detail: "2.1.80" },
        { name: "codex", status: "ok", detail: "0.20.0" },
      ],
      "abg",
    );
    // padEnd(4): "OK  " is 4 chars wide, matching formatDoctorReport's column.
    expect(lines).toContain("  OK   bun: 1.3.11");
    expect(lines).toContain("  OK   claude: 2.1.80");
    expect(lines).toContain("  OK   codex: 0.20.0");
  });

  test("prints a ↳ hint line under a non-OK check (warn and fail)", () => {
    const lines = formatDepChecks(
      [
        { name: "claude", status: "fail", detail: "not found in PATH", hint: "Install Claude Code: npm ..." },
        { name: "codex", status: "warn", detail: "not found in PATH", hint: "Install Codex: https://..." },
      ],
      "abg",
    );
    const text = lines.join("\n");
    expect(text).toContain("  FAIL claude: not found in PATH");
    expect(text).toContain("       ↳ Install Claude Code: npm ...");
    expect(text).toContain("  WARN codex: not found in PATH");
    expect(text).toContain("       ↳ Install Codex: https://...");
  });

  test("an OK check never emits a ↳ hint line", () => {
    const lines = formatDepChecks([{ name: "bun", status: "ok", detail: "1.3.11", hint: "should not show" }], "abg");
    expect(lines.join("\n")).not.toContain("↳");
  });

  test("closes with a '验证安装: <cli> doctor' line echoing the invocation name", () => {
    expect(formatDepChecks([], "abg")).toContain("  验证安装: abg doctor");
    expect(formatDepChecks([], "agentbridge")).toContain("  验证安装: agentbridge doctor");
  });
});

describe("init: dependency-check fatal semantics", () => {
  // Mirrors the abort decision in runInit: `depChecks.some(c => c.status === "fail")`.
  const isFatal = (checks: DepCheck[]) => checks.some((c) => c.status === "fail");

  test("a missing codex is a WARN, not a FAIL — init must NOT abort on it", () => {
    const checks: DepCheck[] = [
      { name: "bun", status: "ok", detail: "1.3.11" },
      { name: "claude", status: "ok", detail: "2.1.80" },
      { name: "codex", status: "warn", detail: "not found in PATH", hint: "Install Codex later" },
    ];
    expect(isFatal(checks)).toBe(false);
  });

  test("a missing bun or claude IS fatal — init aborts", () => {
    expect(isFatal([{ name: "bun", status: "fail", detail: "not found" }])).toBe(true);
    expect(isFatal([{ name: "claude", status: "fail", detail: "too old" }])).toBe(true);
  });

  test("all three checks are reported even when an early one fails (collect-then-report)", () => {
    // The formatter renders every check it is given — the runner collects all
    // three before deciding, so the user sees the full picture in one pass.
    const lines = formatDepChecks(
      [
        { name: "bun", status: "ok", detail: "1.3.11" },
        { name: "claude", status: "fail", detail: "not found in PATH", hint: "install claude" },
        { name: "codex", status: "warn", detail: "not found in PATH", hint: "install codex" },
      ],
      "abg",
    );
    const text = lines.join("\n");
    expect(text).toContain("bun:");
    expect(text).toContain("claude:");
    expect(text).toContain("codex:");
  });
});
