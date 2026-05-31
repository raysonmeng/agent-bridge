#!/usr/bin/env node
/**
 * Bump the AgentBridge version in lock-step across all three manifests that
 * `scripts/check-plugin-versions.js` enforces equal:
 *   - package.json                                  .version
 *   - plugins/agentbridge/.claude-plugin/plugin.json .version
 *   - .claude-plugin/marketplace.json                .plugins[name===plugin.name].version
 *
 * Usage:  node scripts/bump-version.mjs [patch|minor|major]   (default: patch)
 * Prints a human line to STDERR and the new version (only) to STDOUT, so CI can
 * capture it with `NEW=$(node scripts/bump-version.mjs patch)`.
 *
 * Refuses to run if the current version is not a clean stable `X.Y.Z` (so we
 * never publish a prerelease/garbage version automatically).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const pluginPath = join(root, "plugins/agentbridge/.claude-plugin/plugin.json");
const marketplacePath = join(root, ".claude-plugin/marketplace.json");

const STABLE_RE = /^\d+\.\d+\.\d+$/;
const LEVELS = ["patch", "minor", "major"];

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}
function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}
function die(msg) {
  process.stderr.write(`bump-version: ${msg}\n`);
  process.exit(1);
}

const level = (process.argv[2] ?? "patch").toLowerCase();
if (!LEVELS.includes(level)) die(`unknown bump level "${level}" (expected ${LEVELS.join("|")})`);

const pkg = readJson(pkgPath);
const current = pkg.version;
if (typeof current !== "string" || !STABLE_RE.test(current)) {
  die(`package.json version ${JSON.stringify(current)} is not a clean X.Y.Z stable version`);
}

const [major, minor, patch] = current.split(".").map(Number);
const next =
  level === "major" ? `${major + 1}.0.0`
  : level === "minor" ? `${major}.${minor + 1}.0`
  : `${major}.${minor}.${patch + 1}`;

// package.json
pkg.version = next;
writeJson(pkgPath, pkg);

// plugin.json
const plugin = readJson(pluginPath);
plugin.version = next;
writeJson(pluginPath, plugin);

// marketplace.json — the entry whose name matches the plugin's name
const marketplace = readJson(marketplacePath);
const entry = Array.isArray(marketplace.plugins)
  ? marketplace.plugins.find((p) => p.name === plugin.name)
  : null;
if (!entry) die(`.claude-plugin/marketplace.json is missing the "${plugin.name}" plugin entry`);
entry.version = next;
writeJson(marketplacePath, marketplace);

process.stderr.write(`bump-version: ${current} -> ${next} (package.json, plugin.json, marketplace.json)\n`);
process.stdout.write(`${next}\n`);
