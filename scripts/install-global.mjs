#!/usr/bin/env node
/**
 * Install AgentBridge globally in a way that is convenient for local testing.
 *
 * Modes:
 *   local  build this checkout, pack it, uninstall the global package, install the tarball
 *   npm    verify npm latest exists, uninstall the global package, install latest
 *
 * The uninstall step is intentionally ignored when the package is not installed:
 * the goal is a clean replacement, not a brittle precondition.
 *
 * PREFIX RESOLUTION: a plain `npm install -g` targets npm's configured global
 * prefix, which is NOT always where the user's `agentbridge` command resolves —
 * e.g. an nvm node's bin dir is first on PATH while npm's prefix points elsewhere.
 * In that case the upgrade installs to a directory that is not on PATH and the
 * new bytes silently never take effect. So we resolve the prefix of the
 * `agentbridge`/`abg` currently on PATH and target THAT (via `npm_config_prefix`),
 * falling back to npm's default when nothing is installed yet.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { agentBridgeInstallEnv } = require("./install-safety.cjs");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const packageName = pkg.name;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mode = args.find((arg) => !arg.startsWith("-"));

function usage() {
  process.stderr.write(`Usage: node scripts/install-global.mjs <local|npm> [--dry-run]

Examples:
  bun run install:global:local   # build this checkout, then fully replace the global install
  bun run install:global:npm     # fully replace the global install with npm latest
`);
}

/**
 * Derive the install prefix from a resolved bin path like `<prefix>/bin/<name>`.
 * Returns the prefix, or null when the path is not under a `bin/` directory.
 */
export function installPrefixFromBinPath(binPath) {
  if (!binPath) return null;
  const binDir = dirname(binPath.trim());
  if (basename(binDir) !== "bin") return null;
  return dirname(binDir);
}

/**
 * Resolve the install prefix of the `agentbridge`/`abg` currently on PATH so the
 * global install lands where the user's command actually runs from. Returns the
 * prefix, or null to fall back to npm's default (e.g. first-ever install).
 *
 * `which` is injectable for testing.
 */
export function resolveInstallPrefix(which = (bin) => spawnSync("which", [bin], { encoding: "utf-8" })) {
  for (const bin of ["agentbridge", "abg"]) {
    const res = which(bin);
    const binPath = ((res && res.stdout) || "").trim().split("\n").filter(Boolean)[0];
    if (res && res.status === 0 && binPath) {
      const prefix = installPrefixFromBinPath(binPath);
      if (prefix) return prefix;
    }
  }
  return null;
}

/** Env additions that pin npm's global prefix to the on-PATH install location. */
function prefixEnv(prefix) {
  return prefix ? { npm_config_prefix: prefix } : {};
}

function quote(arg) {
  return /^[A-Za-z0-9_@%+=:,./<>-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(cmd, commandArgs) {
  return [cmd, ...commandArgs].map(quote).join(" ");
}

function printDry(cmd, commandArgs, suffix = "") {
  process.stdout.write(`$ ${commandLine(cmd, commandArgs)}${suffix}\n`);
}

function run(cmd, commandArgs, options = {}) {
  const { allowFailure = false, cwd = root, captureStdout = false, envExtra = {} } = options;
  process.stdout.write(`$ ${commandLine(cmd, commandArgs)}\n`);
  const res = spawnSync(cmd, commandArgs, {
    cwd,
    encoding: "utf-8",
    env: { ...agentBridgeInstallEnv(process.env), ...envExtra },
    stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (res.error) {
    process.stderr.write(`install-global: failed to start ${cmd}: ${res.error.message}\n`);
    if (!allowFailure) process.exit(1);
  }
  if (res.status !== 0 && !allowFailure) {
    process.stderr.write(`install-global: command failed with exit code ${res.status}: ${commandLine(cmd, commandArgs)}\n`);
    process.exit(res.status ?? 1);
  }
  return res;
}

function packedTarballFrom(stdout, destination) {
  const file = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!file) {
    process.stderr.write("install-global: npm pack did not report a tarball name\n");
    process.exit(1);
  }
  return isAbsolute(file) ? file : join(destination, file);
}

/** Print where the install will land (a `#` note — never a `$ ` command line). */
function reportPrefix(prefix) {
  if (prefix) {
    process.stdout.write(
      `# install target: npm_config_prefix=${prefix} (where your \`agentbridge\` resolves on PATH)\n`,
    );
  } else {
    process.stdout.write(
      "# install target: npm default prefix (no agentbridge on PATH yet)\n",
    );
  }
}

function installLocal() {
  const prefix = dryRun ? resolveInstallPrefix() : null;
  if (dryRun) {
    reportPrefix(prefix);
    printDry("node", ["scripts/install-safety.cjs", "stop-running", "--dry-run"]);
    printDry("bun", ["run", "prepublishOnly"]);
    printDry("node", ["scripts/install-safety.cjs", "verify-built"]);
    printDry("npm", ["pack", "--pack-destination", "<temp>"]);
    printDry("node", ["scripts/install-safety.cjs", "verify-tarball", "<packed-tarball>"]);
    printDry("npm", ["uninstall", "-g", packageName], "  # ignored if not installed");
    printDry("npm", ["install", "-g", "--force", "<packed-tarball>"]);
    return;
  }

  const target = resolveInstallPrefix();
  reportPrefix(target);
  const env = prefixEnv(target);
  let packDir = "";
  try {
    run("node", ["scripts/install-safety.cjs", "stop-running"]);
    run("bun", ["run", "prepublishOnly"]);
    run("node", ["scripts/install-safety.cjs", "verify-built"]);
    packDir = mkdtempSync(join(tmpdir(), "agentbridge-pack-"));
    const packed = run("npm", ["pack", "--pack-destination", packDir], { captureStdout: true });
    const tarball = packedTarballFrom(packed.stdout ?? "", packDir);
    run("node", ["scripts/install-safety.cjs", "verify-tarball", tarball]);
    run("npm", ["uninstall", "-g", packageName], { allowFailure: true, envExtra: env });
    run("npm", ["install", "-g", "--force", tarball], { envExtra: env });
    process.stdout.write(`install-global: installed ${packageName} globally from local source\n`);
  } finally {
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  }
}

function installNpm() {
  const spec = `${packageName}@latest`;
  const prefix = dryRun ? resolveInstallPrefix() : null;
  if (dryRun) {
    reportPrefix(prefix);
    printDry("node", ["scripts/install-safety.cjs", "stop-running", "--dry-run"]);
    printDry("npm", ["view", spec, "version"]);
    printDry("npm", ["uninstall", "-g", packageName], "  # ignored if not installed");
    printDry("npm", ["install", "-g", "--force", spec]);
    return;
  }

  const target = resolveInstallPrefix();
  reportPrefix(target);
  const env = prefixEnv(target);
  run("node", ["scripts/install-safety.cjs", "stop-running"]);
  run("npm", ["view", spec, "version"]);
  run("npm", ["uninstall", "-g", packageName], { allowFailure: true, envExtra: env });
  run("npm", ["install", "-g", "--force", spec], { envExtra: env });
  process.stdout.write(`install-global: installed ${packageName} globally from npm latest\n`);
}

// Only dispatch when executed directly (so the helpers above stay importable in tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (mode === "local" || mode === "source") {
    installLocal();
  } else if (mode === "npm" || mode === "registry") {
    installNpm();
  } else {
    usage();
    process.exit(1);
  }
}
