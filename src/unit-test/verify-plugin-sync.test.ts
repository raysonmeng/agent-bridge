import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

describe("verify-plugin-sync script", () => {
  test("accepts plugin bundles from a bundle-only commit", () => {
    const result = spawnSync("node", ["scripts/verify-plugin-sync.cjs"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout + result.stderr).toContain("Plugin bundles are already in sync with source.");
  });
});
