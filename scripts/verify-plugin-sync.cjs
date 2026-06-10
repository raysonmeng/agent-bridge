#!/usr/bin/env node

const { mkdtempSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = resolve(__dirname, "..");
const pluginBundles = [
  {
    label: "plugins/agentbridge/server/bridge-server.js",
    target: "bridge-plugin",
    output: resolve(repoRoot, "plugins/agentbridge/server/bridge-server.js"),
    outfileName: "bridge-server.js",
  },
  {
    label: "plugins/agentbridge/server/daemon.js",
    target: "daemon-plugin",
    output: resolve(repoRoot, "plugins/agentbridge/server/daemon.js"),
    outfileName: "daemon.js",
  },
];

function readSnapshot(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    console.error(`Failed to execute ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function extractBuildCommit(snapshot) {
  if (!snapshot) return null;

  const match = snapshot
    .toString("utf-8")
    .match(/commit:\s*defineString\("([^"]+)",\s*"source"\)/);

  return match ? match[1] : null;
}

const tempDir = mkdtempSync(join(tmpdir(), "agentbridge-plugin-sync-"));

try {
  for (const bundle of pluginBundles) {
    const current = readSnapshot(bundle.output);
    const buildCommit = extractBuildCommit(current);
    const env = buildCommit
      ? { ...process.env, AGENTBRIDGE_BUILD_COMMIT_OVERRIDE: buildCommit }
      : process.env;
    const tempOutput = join(tempDir, bundle.outfileName);
    run("node", ["scripts/build-bundles.mjs", bundle.target, "--outfile", tempOutput], { env });
    bundle.generated = tempOutput;
  }

  const changedBundles = pluginBundles.filter((bundle) => {
    const current = readSnapshot(bundle.output);
    const generated = readSnapshot(bundle.generated);

    if (current === null || generated === null) {
      return current !== generated;
    }

    return !current.equals(generated);
  });

  if (changedBundles.length > 0) {
    console.error("\nPlugin bundles are out of sync with source. Run `bun run build:plugin` and commit the updated files:");
    for (const bundle of changedBundles) {
      console.error(`- ${bundle.label}`);
    }
    process.exit(1);
  }

  console.log("Plugin bundles are already in sync with source.");

  // Guard: ensure src/cli.ts has not been overwritten by a bundle artifact.
  const cliSource = resolve(repoRoot, "src/cli.ts");
  if (existsSync(cliSource)) {
    const cliContent = readFileSync(cliSource, "utf-8");
    const bundleMarkers = ["// @bun", "var __commonJS", "var __defProp = Object.defineProperty"];
    const found = bundleMarkers.find((m) => cliContent.includes(m));
    if (found) {
      console.error(
        `\nsrc/cli.ts contains bundle marker "${found}" — it looks like a compiled artifact was written back over the source file.`
      );
      console.error('Run: git restore src/cli.ts');
      process.exit(1);
    }
  }
  console.log("src/cli.ts is not a bundle artifact.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
