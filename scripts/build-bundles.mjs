#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8"));
const CONTRACT_VERSION = 1;

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

function defineArgs(bundle) {
  const defines = {
    __AGENTBRIDGE_BUILD_VERSION__: pkg.version,
    __AGENTBRIDGE_BUILD_COMMIT__: gitCommit(),
    __AGENTBRIDGE_BUILD_BUNDLE__: bundle,
    __AGENTBRIDGE_CONTRACT_VERSION__: CONTRACT_VERSION,
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
