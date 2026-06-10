#!/usr/bin/env node
/**
 * Shared extractor for the build-commit stamp embedded in a committed plugin
 * bundle, plus a tiny CLI (`node scripts/bundle-commit.cjs`) that prints the
 * stamp of the tracked daemon bundle.
 *
 * Why this exists: the bundle stamp is a chicken-and-egg — a bundle committed
 * in commit X can only ever embed X's PARENT. Any script that rebuilds the
 * bundles WITHOUT intending a content change (verify-plugin-sync, smoke-pack,
 * release version bumps) must rebuild with AGENTBRIDGE_BUILD_COMMIT_OVERRIDE
 * set to the stamp already in the tracked file, so the rebuild is
 * byte-comparable and the working tree stays clean. Three scripts now share
 * this one extractor instead of growing private copies.
 */
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const REPO_ROOT = resolve(__dirname, "..");
const DAEMON_BUNDLE = resolve(REPO_ROOT, "plugins/agentbridge/server/daemon.js");

/** Extract the commit stamp from bundle source text; null when absent. */
function extractBuildCommit(snapshot) {
  if (!snapshot) return null;

  const match = snapshot
    .toString("utf-8")
    .match(/commit:\s*defineString\("([^"]+)",\s*"source"\)/);

  return match ? match[1] : null;
}

/** Stamp of the tracked daemon bundle on disk; null when unreadable/absent. */
function trackedBundleCommit() {
  try {
    return extractBuildCommit(readFileSync(DAEMON_BUNDLE));
  } catch {
    return null;
  }
}

module.exports = { extractBuildCommit, trackedBundleCommit };

if (require.main === module) {
  const commit = trackedBundleCommit();
  if (!commit) {
    process.stderr.write("bundle-commit: no commit stamp found in tracked daemon bundle\n");
    process.exit(1);
  }
  process.stdout.write(`${commit}\n`);
}
