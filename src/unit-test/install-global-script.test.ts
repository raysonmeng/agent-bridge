import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/install-global.mjs");
const PACKAGE_NAME = "@raysonmeng/agentbridge";

function runDry(mode: string): { status: number | null; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["node", SCRIPT, mode, "--dry-run"], {
    env: process.env,
  });
  return {
    status: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

function dryRunCommands(mode: string): string[] {
  const res = runDry(mode);
  expect(res.status).toBe(0);
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("$ "));
}

describe("scripts/install-global.mjs", () => {
  test("local mode builds and packs before replacing the global install", () => {
    const commands = dryRunCommands("local");
    expect(commands).toEqual([
      "$ bun run prepublishOnly",
      "$ npm pack --pack-destination <temp>",
      `$ npm uninstall -g ${PACKAGE_NAME}  # ignored if not installed`,
      "$ npm install -g --force <packed-tarball>",
    ]);
  });

  test("npm mode verifies the registry package before replacing the global install", () => {
    const commands = dryRunCommands("npm");
    expect(commands).toEqual([
      `$ npm view ${PACKAGE_NAME}@latest version`,
      `$ npm uninstall -g ${PACKAGE_NAME}  # ignored if not installed`,
      `$ npm install -g --force ${PACKAGE_NAME}@latest`,
    ]);
  });

  test("package.json exposes one-line local and npm install commands", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    expect(pkg.scripts["install:global"]).toBe("node scripts/install-global.mjs local");
    expect(pkg.scripts["install:global:local"]).toBe("node scripts/install-global.mjs local");
    expect(pkg.scripts["install:global:npm"]).toBe("node scripts/install-global.mjs npm");
  });

  test("unknown mode fails with usage", () => {
    const res = runDry("elsewhere");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Usage:");
  });
});
