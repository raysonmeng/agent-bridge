#!/usr/bin/env node
/**
 * Build-input code hash — the stamp-independent code identity behind
 * `BUILD_INFO.codeHash` (`__AGENTBRIDGE_BUILD_CODEHASH__`).
 *
 * Why this exists: the embedded commit stamp is a chicken-and-egg — a bundle
 * committed in commit X can only ever embed X's PARENT, so under squash-merge
 * the stamp ALWAYS lags master by one even when the code is byte-identical.
 * Runtime drift detection that compares stamps therefore replace-wars healthy
 * daemons (live incident). The fix: hash the BUILD INPUTS instead of stamping
 * the build OUTPUT, so two builds of the same source get the same identity no
 * matter which sha (or AGENTBRIDGE_BUILD_COMMIT_OVERRIDE) stamped them.
 *
 * Hash inputs (everything that can change bundle bytes, nothing that can't):
 *   - src non-test .ts files   (the code that gets bundled)
 *   - package.json             (require()d at runtime by cli/update-notifier;
 *                               dependency ranges change what gets bundled)
 *   - bun.lock                 (exact dependency versions are bundled in)
 *   - the bun version          (a different bundler emits different bytes)
 * Excluded: src/unit-test/**, src/integration-test/**, *.test.ts — tests never
 * enter a bundle, so test-only edits must not move the daemon's code identity.
 * Also (by construction) excluded: git sha, commit override, bundle kind —
 * these are stamps ABOUT the build, not inputs TO it. This is the same
 * normalization contract verify-plugin-sync.cjs applies byte-wise (rebuild with
 * the stamp pinned, then compare content), expressed at the input side.
 *
 * Same per-build value for every target (cli/daemon/bridge-plugin/daemon-plugin):
 * the launcher (cli.js / bridge-server.js) and the daemon (daemon.js) are
 * DIFFERENT entrypoints, so per-artifact output hashes could never be compared
 * across the launcher↔daemon /healthz boundary — a source-tree identity can.
 */
const { createHash } = require("node:crypto");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = resolve(__dirname, "..");
const CODE_HASH_HEX_LENGTH = 12;
/** Test-only directories under src/ — never bundled, never hashed. */
const EXCLUDED_SRC_DIRS = new Set(["unit-test", "integration-test"]);
/** Non-src files whose content changes bundle bytes. */
const EXTRA_INPUT_FILES = ["package.json", "bun.lock"];

/**
 * Pure: deterministic sha256 over (path, content) entries, truncated to
 * 12 hex. Entries are canonically sorted by path and joined with NUL
 * separators, so the digest is independent of enumeration order and immune
 * to path/content concatenation ambiguity. Does not mutate `entries`.
 */
function computeCodeHashFromEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of sorted) {
    hash.update(entry.path, "utf-8");
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, CODE_HASH_HEX_LENGTH);
}

/**
 * Enumerate the build-input files of a repo checkout, as sorted POSIX-style
 * paths relative to `repoRoot` (stable across platforms and readdir order).
 * Fails fast when a required input is missing — a silent partial hash would
 * make two genuinely different builds compare equal.
 */
function listCodeHashInputFiles(repoRoot) {
  const srcRoot = join(repoRoot, "src");
  if (!existsSync(srcRoot)) {
    throw new Error(`code-hash: required build input directory src/ not found under ${repoRoot}`);
  }

  const files = [];
  const walk = (relDir) => {
    for (const entry of readdirSync(join(repoRoot, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_SRC_DIRS.has(entry.name)) continue;
        walk(rel);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(rel);
      }
    }
  };
  walk("src");

  for (const extra of EXTRA_INPUT_FILES) {
    if (!existsSync(join(repoRoot, extra))) {
      throw new Error(`code-hash: required build input ${extra} not found under ${repoRoot}`);
    }
    files.push(extra);
  }

  files.sort();
  return files;
}

/**
 * The bundler is itself a build input: the same source compiled by a different
 * bun emits different bytes. Resolved once per process; injectable via
 * opts.bunVersion for tests. Fails fast — every caller is about to run
 * `bun build` anyway, so a missing bun is a hard error either way.
 */
let cachedBunVersion = null;
function resolveBunVersion() {
  if (cachedBunVersion !== null) return cachedBunVersion;
  try {
    cachedBunVersion = execFileSync("bun", ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new Error(`code-hash: cannot resolve bun version (it is a build input): ${error.message}`);
  }
  return cachedBunVersion;
}

/**
 * The source-tree code identity for a repo checkout. Same value for every
 * build target of one source state; stable across git shas / commit overrides.
 */
function computeCodeHash(repoRoot, opts = {}) {
  const bunVersion = opts.bunVersion ?? resolveBunVersion();
  const entries = listCodeHashInputFiles(repoRoot).map((path) => ({
    path,
    content: readFileSync(join(repoRoot, path)),
  }));
  // Virtual entry: "<...>" cannot collide with a real relative path.
  entries.push({ path: "<bun-version>", content: Buffer.from(bunVersion, "utf-8") });
  return computeCodeHashFromEntries(entries);
}

module.exports = { computeCodeHash, computeCodeHashFromEntries, listCodeHashInputFiles };

if (require.main === module) {
  process.stdout.write(`${computeCodeHash(REPO_ROOT)}\n`);
}
