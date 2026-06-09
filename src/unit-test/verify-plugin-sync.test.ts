import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dir, "../..");

/**
 * Tests the MECHANISM behind bundle-only-commit acceptance: build-bundles.mjs
 * honors AGENTBRIDGE_BUILD_COMMIT_OVERRIDE, which verify-plugin-sync.cjs uses to
 * rebuild comparison bundles with the commit already embedded in the committed
 * bundle (so a rebuild-only commit doesn't fail sync purely because HEAD moved).
 *
 * Deliberately does NOT run verify-plugin-sync against the live working tree:
 * that comparison legitimately fails whenever src/ has uncommitted changes,
 * which would make `bun test src` unrunnable exactly when developers need it —
 * mid-change. Whole-tree sync remains enforced by `bun run check` (pre-commit).
 */
describe("build-bundles commit override (verify-plugin-sync mechanism)", () => {
  test("AGENTBRIDGE_BUILD_COMMIT_OVERRIDE embeds the given commit into the bundle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "abg-bundle-override-"));
    try {
      const outfile = join(tempDir, "bridge-server.js");
      const result = spawnSync(
        "node",
        ["scripts/build-bundles.mjs", "bridge-plugin", "--outfile", outfile],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          env: { ...process.env, AGENTBRIDGE_BUILD_COMMIT_OVERRIDE: "feedc0de" },
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const bundle = readFileSync(outfile, "utf-8");
      expect(bundle).toContain('"feedc0de"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("blank override is ignored and falls back to git HEAD", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "abg-bundle-override-"));
    try {
      const outfile = join(tempDir, "bridge-server.js");
      const result = spawnSync(
        "node",
        ["scripts/build-bundles.mjs", "bridge-plugin", "--outfile", outfile],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          env: { ...process.env, AGENTBRIDGE_BUILD_COMMIT_OVERRIDE: "   " },
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf-8",
      }).stdout.trim();
      expect(readFileSync(outfile, "utf-8")).toContain(`"${head}"`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
