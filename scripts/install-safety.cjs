#!/usr/bin/env node

/**
 * Shared install-time safety checks.
 *
 * This intentionally stays CommonJS so both the ESM local installer and npm's
 * CommonJS postinstall hook can use the same stop/verify behavior.
 */

const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

const PACKAGE_ROOT = path.resolve(__dirname, "..");

const REQUIRED_ARTIFACTS = Object.freeze([
  "dist/cli.js",
  "dist/daemon.js",
  ".claude-plugin/marketplace.json",
  "plugins/agentbridge/.claude-plugin/plugin.json",
  "plugins/agentbridge/.mcp.json",
  "plugins/agentbridge/README.md",
  "plugins/agentbridge/commands/init.md",
  "plugins/agentbridge/hooks/hooks.json",
  "plugins/agentbridge/scripts/health-check.sh",
  "plugins/agentbridge/scripts/plugin-update-notice.mjs",
  "plugins/agentbridge/scripts/publish-completion.sh",
  "plugins/agentbridge/server/bridge-server.js",
  "plugins/agentbridge/server/daemon.js",
  "package.json",
  "README.md",
  "scripts/install-safety.cjs",
  "scripts/postinstall.cjs",
]);

function quote(arg) {
  return /^[A-Za-z0-9_@%+=:,./<>-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(cmd, args) {
  return [cmd, ...args].map(quote).join(" ");
}

function fail(message, details = []) {
  process.stderr.write(`install-safety: ${message}\n`);
  for (const detail of details) {
    process.stderr.write(`  - ${detail}\n`);
  }
  process.exit(1);
}

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8"));
}

function requiredPackagePaths() {
  const pkg = readPackageJson();
  const binTargets = Object.values(pkg.bin ?? {});
  return [...new Set([...REQUIRED_ARTIFACTS, ...binTargets])];
}

function buildStopCommand() {
  const sourceCli = path.join(PACKAGE_ROOT, "src", "cli.ts");
  const bundledCli = path.join(PACKAGE_ROOT, "dist", "cli.js");
  if (existsSync(sourceCli)) return ["bun", ["run", "src/cli.ts", "kill", "--all"]];
  return ["bun", ["run", bundledCli, "kill", "--all"]];
}

function agentBridgeInstallEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AGENTBRIDGE_")) delete env[key];
  }
  delete env.CODEX_WS_PORT;
  delete env.CODEX_PROXY_PORT;
  return env;
}

function stopRunningAgentBridge(options = {}) {
  const { dryRun = false, bestEffort = false } = options;
  const [cmd, args] = buildStopCommand();
  if (dryRun) {
    process.stdout.write(`$ ${commandLine(cmd, args)}  # stop running AgentBridge daemons/TUIs\n`);
    return { status: 0 };
  }

  process.stdout.write(`$ ${commandLine(cmd, args)}\n`);
  const res = spawnSync(cmd, args, {
    cwd: PACKAGE_ROOT,
    env: agentBridgeInstallEnv(),
    stdio: "inherit",
  });

  if (res.error || res.status !== 0) {
    const message = res.error
      ? `failed to start stop command: ${res.error.message}`
      : `stop command exited with ${res.status}`;
    if (bestEffort) {
      process.stdout.write(`install-safety: ${message}; continuing because this hook is best-effort\n`);
      return res;
    }
    fail(message);
  }
  return res;
}

function verifyBuiltArtifacts() {
  const missing = [];
  const empty = [];
  const notExecutable = [];
  const pkg = readPackageJson();
  const required = requiredPackagePaths();
  const binTargets = new Set(Object.values(pkg.bin ?? {}));

  for (const rel of required) {
    const absolute = path.join(PACKAGE_ROOT, rel);
    if (!existsSync(absolute)) {
      missing.push(rel);
      continue;
    }
    const stat = statSync(absolute);
    if (stat.size <= 0) empty.push(rel);
    if (process.platform !== "win32" && binTargets.has(rel) && (stat.mode & 0o111) === 0) {
      notExecutable.push(rel);
    }
  }

  const problems = [
    ...missing.map((rel) => `missing: ${rel}`),
    ...empty.map((rel) => `empty: ${rel}`),
    ...notExecutable.map((rel) => `not executable: ${rel}`),
  ];
  if (problems.length > 0) {
    fail("built artifact verification failed", problems);
  }

  process.stdout.write(`install-safety: verified ${required.length} built artifact(s)\n`);
}

function verifyTarball(tarballPath) {
  if (!tarballPath) fail("verify-tarball requires a tarball path");
  if (!existsSync(tarballPath)) fail(`tarball does not exist: ${tarballPath}`);

  const res = spawnSync("tar", ["-tf", tarballPath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) fail(`failed to inspect tarball: ${res.error.message}`);
  if (res.status !== 0) {
    fail(`tar -tf failed with ${res.status}`, [res.stderr?.trim()].filter(Boolean));
  }

  const packed = new Set(
    res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^package\//, "")),
  );
  const required = requiredPackagePaths();
  const missing = required.filter((rel) => !packed.has(rel));
  if (missing.length > 0) {
    fail("packed tarball is missing required artifact(s)", missing);
  }

  process.stdout.write(`install-safety: verified ${required.length} artifact(s) in ${tarballPath}\n`);
}

function usage() {
  process.stderr.write(`Usage:
  node scripts/install-safety.cjs stop-running [--dry-run] [--best-effort]
  node scripts/install-safety.cjs verify-built
  node scripts/install-safety.cjs verify-tarball <tarball>
`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "stop-running") {
    stopRunningAgentBridge({
      dryRun: args.includes("--dry-run"),
      bestEffort: args.includes("--best-effort"),
    });
    return;
  }
  if (command === "verify-built") {
    verifyBuiltArtifacts();
    return;
  }
  if (command === "verify-tarball") {
    verifyTarball(args[0]);
    return;
  }
  usage();
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_ARTIFACTS,
  agentBridgeInstallEnv,
  commandLine,
  requiredPackagePaths,
  stopRunningAgentBridge,
  verifyBuiltArtifacts,
  verifyTarball,
};
