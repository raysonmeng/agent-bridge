#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { computeCodeHash } = require("./code-hash.cjs");

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));

/**
 * Contract version is extracted from its single source (src/contract-version.ts)
 * instead of a second hardcoded constant here — a bump touching only one of
 * the two copies split source-mode and bundled builds into "incompatible"
 * contracts. A unit test locks this extraction against the TS export.
 */
function readContractVersion() {
  const source = readFileSync(resolve(repoRoot, "src/contract-version.ts"), "utf-8");
  const match = source.match(/export const CONTRACT_VERSION = (\d+);/);
  if (!match) {
    console.error("build-bundles: cannot extract CONTRACT_VERSION from src/contract-version.ts");
    process.exit(1);
  }
  return Number(match[1]);
}
const CONTRACT_VERSION = readContractVersion();

const TARGETS = {
  cli: { source: "src/cli.ts", output: "dist/cli.js", bundle: "dist", executable: true },
  daemon: { source: "src/daemon.ts", output: "dist/daemon.js", bundle: "dist" },
  "bridge-plugin": { source: "src/bridge.ts", output: "plugins/agentbridge/server/bridge-server.js", bundle: "plugin" },
  "daemon-plugin": { source: "src/daemon.ts", output: "plugins/agentbridge/server/daemon.js", bundle: "plugin" },
};

function usage() {
  console.error(`Usage:
  node scripts/build-bundles.mjs <target...>
  node scripts/build-bundles.mjs <target> --outfile <path>

Targets: ${Object.keys(TARGETS).join(", ")}
`);
}

function gitCommit() {
  const override = process.env.AGENTBRIDGE_BUILD_COMMIT_OVERRIDE;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }

  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// Stamp-independent code identity (see scripts/code-hash.cjs): the SAME value
// for every target of this build, and for any rebuild of identical source —
// regardless of git sha or AGENTBRIDGE_BUILD_COMMIT_OVERRIDE. Computed once
// per build invocation.
let cachedCodeHash = null;
function codeHash() {
  if (cachedCodeHash === null) {
    cachedCodeHash = computeCodeHash(repoRoot);
  }
  return cachedCodeHash;
}

function defineArgs(bundle) {
  const defines = {
    __AGENTBRIDGE_BUILD_VERSION__: pkg.version,
    __AGENTBRIDGE_BUILD_COMMIT__: gitCommit(),
    __AGENTBRIDGE_BUILD_BUNDLE__: bundle,
    __AGENTBRIDGE_CONTRACT_VERSION__: CONTRACT_VERSION,
    __AGENTBRIDGE_BUILD_CODEHASH__: codeHash(),
  };
  return Object.entries(defines).flatMap(([key, value]) => [
    "--define",
    `${key}=${JSON.stringify(value)}`,
  ]);
}

function runBuild(targetName, outfileOverride) {
  const target = TARGETS[targetName];
  if (!target) {
    console.error(`Unknown build target: ${targetName}`);
    usage();
    process.exit(1);
  }

  const output = outfileOverride ?? target.output;
  const args = [
    "build",
    target.source,
    "--outfile",
    output,
    "--target",
    "bun",
    ...defineArgs(target.bundle),
  ];

  const res = spawnSync("bun", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (res.error) {
    console.error(`build-bundles: failed to start bun: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }

  if (!outfileOverride && target.executable) {
    chmodSync(resolve(repoRoot, output), 0o755);
  }
}

const args = process.argv.slice(2);
const outfileIndex = args.indexOf("--outfile");
let outfile;
if (outfileIndex !== -1) {
  outfile = args[outfileIndex + 1];
  args.splice(outfileIndex, 2);
  if (!outfile || args.length !== 1) {
    usage();
    process.exit(1);
  }
}

if (args.length === 0) {
  usage();
  process.exit(1);
}

for (const target of args) {
  runBuild(target, outfile);
}
