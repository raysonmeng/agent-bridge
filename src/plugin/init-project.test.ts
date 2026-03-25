import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProjectDefaults } from "./init-project";

describe("plugin init-project bootstrap", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-plugin-init-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("checks prerequisites and creates default project config files", () => {
    const result = initProjectDefaults(tempDir, (command) => {
      if (command === "bun --version") return "1.3.11";
      if (command === "codex --version") return "0.1.0";
      throw new Error(`unexpected command: ${command}`);
    });

    expect(result.checked.bun).toBe("1.3.11");
    expect(result.checked.codex).toBe("0.1.0");
    expect(result.created).toContain(result.files.config);
    expect(result.created).toContain(result.files.collaboration);
    expect(existsSync(result.files.config)).toBe(true);
    expect(existsSync(result.files.collaboration)).toBe(true);
  });

  test("does not overwrite existing config on repeated runs", () => {
    const runCommand = (command: string) => {
      if (command === "bun --version") return "1.3.11";
      if (command === "codex --version") return "0.1.0";
      throw new Error(`unexpected command: ${command}`);
    };

    const first = initProjectDefaults(tempDir, runCommand);
    expect(first.created).toHaveLength(2);

    const second = initProjectDefaults(tempDir, runCommand);
    expect(second.created).toHaveLength(0);
  });

  test("fails with actionable error when codex is missing", () => {
    expect(() =>
      initProjectDefaults(tempDir, (command) => {
        if (command === "bun --version") return "1.3.11";
        throw new Error("not found");
      }),
    ).toThrow("codex not found in PATH. Install Codex: https://github.com/openai/codex");
  });
});
