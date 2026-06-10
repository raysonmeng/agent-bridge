#!/usr/bin/env bun

// Packaged-artifact smoke test: verifies that `npm pack` would ship every file
// the CLI + daemon + plugin need at runtime.
//
// Background: a recent release shipped a broken package because `build:cli` did
// not emit `dist/daemon.js` and nothing verified the packed output. This script
// is the packaging-completeness guard (sibling to scripts/smoke-built-cli.mjs).
//
// It is deterministic, fast, offline, and side-effect-free on the repo:
//   1. builds dist/ + plugin bundles,
//   2. asks `npm pack --dry-run --json` what would be packed (no publish, no
//      install, no postinstall),
//   3. asserts every required artifact (incl. dist/daemon.js and the bin
//      targets) is present and that bin targets exist + are executable on disk.
//
// Manual regression check (confirm it catches the original bug class — a
// build:cli that FAILS to emit dist/daemon.js): temporarily delete the
// `bun build src/daemon.ts ...` step from the build:cli script, then run
// `bun scripts/smoke-pack.mjs` — it must exit non-zero (MISSING: dist/daemon.js).
// Restore build:cli afterward. (Deleting dist/daemon.js on disk does NOT
// reproduce it — this script rebuilds dist/ before packing.)
// `npm pack --dry-run` writes no tarball, so this script touches nothing on disk.

import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { trackedBundleCommit } = createRequire(import.meta.url)("./bundle-commit.cjs");

function fail(message, details = []) {
  console.error(`\nsmoke-pack FAILED: ${message}`);
  for (const line of details) {
    console.error(`  - ${line}`);
  }
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function build() {
  console.log("smoke-pack: building dist/ + plugin bundles ...");
  // The plugin bundles are TRACKED files. Rebuilding them with the current
  // HEAD stamp rewrites their embedded commit and dirties the working tree on
  // every smoke run (breaking the "side-effect-free on the repo" promise
  // above). Same strategy as verify-plugin-sync: rebuild with the stamp the
  // tracked file already carries, so identical source produces identical
  // bytes. dist/ is untracked — no override needed there.
  const trackedCommit = trackedBundleCommit();
  if (!trackedCommit) {
    // Without a tracked stamp the rebuild would embed the real HEAD commit and
    // dirty the tree — fail loud instead of silently breaking the
    // side-effect-free promise (fresh clones must build bundles first anyway).
    fail("no commit stamp found in tracked plugin bundles", [
      "run `bun run build:plugin` and commit the bundles before smoke-pack",
    ]);
  }
  const pluginEnv = { ...process.env, AGENTBRIDGE_BUILD_COMMIT_OVERRIDE: trackedCommit };
  for (const script of ["build:cli", "build:plugin"]) {
    execFileSync("bun", ["run", script], {
      cwd: repoRoot,
      stdio: "inherit",
      env: script === "build:plugin" ? pluginEnv : process.env,
    });
  }
}

function packedPaths() {
  // `npm pack --dry-run --json` reports exactly what would ship, without
  // publishing or creating a tarball on disk. Output is a JSON array whose
  // single entry has a `files: [{ path }]` list.
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`could not parse \`npm pack --dry-run --json\` output: ${error.message}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    fail("`npm pack --dry-run --json` did not return a files list");
  }
  return new Set(entry.files.map((f) => f.path));
}

function main() {
  build();

  const pkg = readJson(join(repoRoot, "package.json"));
  const binTargets = [...new Set(Object.values(pkg.bin ?? {}))];
  if (binTargets.length === 0) {
    fail("package.json has no bin targets to verify");
  }

  // Required artifacts the published package must contain for CLI + daemon +
  // plugin to work. Bin targets are unioned in so package.json drift is caught.
  const required = new Set([
    "dist/cli.js",
    "dist/daemon.js", // ← the omission that shipped the original broken package
    ".claude-plugin/marketplace.json",
    "plugins/agentbridge/.claude-plugin/plugin.json",
    "plugins/agentbridge/.mcp.json",
    "plugins/agentbridge/README.md",
    "plugins/agentbridge/commands/init.md",
    "plugins/agentbridge/hooks/hooks.json",
    "plugins/agentbridge/scripts/health-check.sh",
    "plugins/agentbridge/scripts/plugin-update-notice.mjs",
    "plugins/agentbridge/server/bridge-server.js",
    "plugins/agentbridge/server/daemon.js",
    "package.json",
    "README.md",
    "scripts/install-safety.cjs",
    "scripts/postinstall.cjs",
    ...binTargets,
  ]);

  const packed = packedPaths();
  const missing = [...required].filter((path) => !packed.has(path)).sort();
  if (missing.length > 0) {
    const present = [...packed].sort();
    fail(
      `${missing.length} required artifact(s) missing from the packed set`,
      [
        ...missing.map((path) => `MISSING: ${path}`),
        `--- ${present.length} packed paths ---`,
        ...present.map((path) => `present: ${path}`),
      ],
    );
  }

  // Bin targets must also exist on disk and be executable (chmod +x), since the
  // packed `mode` only matters if the source file is actually executable.
  const binProblems = [];
  for (const target of binTargets) {
    const absolute = join(repoRoot, target);
    if (!existsSync(absolute)) {
      binProblems.push(`bin target does not exist on disk: ${target}`);
      continue;
    }
    const mode = statSync(absolute).mode;
    const isExecutable = (mode & 0o111) !== 0;
    if (!isExecutable) {
      binProblems.push(`bin target is not executable (missing +x): ${target}`);
    }
  }
  if (binProblems.length > 0) {
    fail("bin target on-disk checks failed", binProblems);
  }

  console.log(
    `\nsmoke-pack OK: ${packed.size} files packed, all ${required.size} required artifacts present; ` +
      `bin targets [${binTargets.join(", ")}] exist + are executable.`,
  );
  process.exit(0);
}

// `npm pack --dry-run` writes no tarball, so the script touches nothing on disk
// (and never the repo) — no temp dir to manage.
main();
