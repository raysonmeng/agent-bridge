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
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  const { allowFailure = false, cwd = root, captureStdout = false } = options;
  process.stdout.write(`$ ${commandLine(cmd, commandArgs)}\n`);
  const res = spawnSync(cmd, commandArgs, {
    cwd,
    encoding: "utf-8",
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

function installLocal() {
  if (dryRun) {
    printDry("bun", ["run", "prepublishOnly"]);
    printDry("npm", ["pack", "--pack-destination", "<temp>"]);
    printDry("npm", ["uninstall", "-g", packageName], "  # ignored if not installed");
    printDry("npm", ["install", "-g", "--force", "<packed-tarball>"]);
    return;
  }

  let packDir = "";
  try {
    run("bun", ["run", "prepublishOnly"]);
    packDir = mkdtempSync(join(tmpdir(), "agentbridge-pack-"));
    const packed = run("npm", ["pack", "--pack-destination", packDir], { captureStdout: true });
    const tarball = packedTarballFrom(packed.stdout ?? "", packDir);
    run("npm", ["uninstall", "-g", packageName], { allowFailure: true });
    run("npm", ["install", "-g", "--force", tarball]);
    process.stdout.write(`install-global: installed ${packageName} globally from local source\n`);
  } finally {
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  }
}

function installNpm() {
  const spec = `${packageName}@latest`;
  if (dryRun) {
    printDry("npm", ["view", spec, "version"]);
    printDry("npm", ["uninstall", "-g", packageName], "  # ignored if not installed");
    printDry("npm", ["install", "-g", "--force", spec]);
    return;
  }

  run("npm", ["view", spec, "version"]);
  run("npm", ["uninstall", "-g", packageName], { allowFailure: true });
  run("npm", ["install", "-g", "--force", spec]);
  process.stdout.write(`install-global: installed ${packageName} globally from npm latest\n`);
}

if (mode === "local" || mode === "source") {
  installLocal();
} else if (mode === "npm" || mode === "registry") {
  installNpm();
} else {
  usage();
  process.exit(1);
}
