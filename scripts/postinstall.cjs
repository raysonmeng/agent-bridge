#!/usr/bin/env node

/**
 * postinstall: verify Bun, register marketplace, install plugin.
 * Runs after `npm install -g @raysonmeng/agentbridge`.
 *
 * All steps are best-effort — a failure here does not block the npm install.
 * Users can always fall back to `abg init` for manual setup.
 */

const { execFileSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");
const { stopRunningAgentBridge } = require("./install-safety.cjs");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const MARKETPLACE_NAME = "agentbridge";
const PLUGIN_NAME = "agentbridge";
// Every external command gets a hard timeout: postinstall runs inside the
// user's `npm install`, and a hung `claude` CLI (auth prompt, broken update)
// previously hung the whole install with it. Timeouts fall through to the
// existing warn-and-continue paths (`abg init` is always the fallback).
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const PLUGIN_STEP_TIMEOUT_MS = 30_000;

/**
 * Declarative opt-out of the marketplace/plugin registration steps (CI image
 * builds, air-gapped installs) — symmetric with AGENTBRIDGE_POSTINSTALL_STOP.
 */
function skipPluginRegistration(env = process.env) {
  return env.AGENTBRIDGE_POSTINSTALL_PLUGIN === "0";
}
/**
 * Decide whether postinstall should stop ALL running AgentBridge pairs.
 *
 * Stop-the-world is destructive (it kills every running daemon/TUI), so it is
 * gated to INTENTIONAL global self-installs only. The intentional installer
 * (scripts/install-global.mjs) already calls install-safety stop-running
 * directly, so postinstall only needs to react to an explicit global signal.
 *
 * Pure + injectable for unit testing.
 *
 * @param {{ env?: NodeJS.ProcessEnv, hasSourceCli?: boolean }} [opts]
 * @returns {boolean}
 */
function shouldStopRunningDaemons({
  env = process.env,
  hasSourceCli = existsSync(path.join(PACKAGE_ROOT, "src", "cli.ts")),
} = {}) {
  // hasSourceCli is accepted for symmetry/future use; intentionally unused so
  // that a packed (no-src) install no longer triggers stop-the-world on its own.
  void hasSourceCli;
  if (env.AGENTBRIDGE_POSTINSTALL_STOP === "0") return false;
  if (env.AGENTBRIDGE_POSTINSTALL_STOP === "1") return true;
  if (env.npm_config_global === "true") return true;
  if (env.npm_config_location === "global") return true;
  return false;
}

function runPostinstall() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    stopRunningAgentBridge({ dryRun: true });
    console.log("$ claude --version");
    console.log(`$ claude plugin marketplace add ${PACKAGE_ROOT}`);
    console.log(`$ claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    process.exit(0);
  }

  // Step 1: Check Bun
  let bunOk = false;
  try {
    const version = execFileSync("bun", ["--version"], { encoding: "utf-8", timeout: VERSION_PROBE_TIMEOUT_MS }).trim();
    console.log(`\x1b[32m✔\x1b[0m AgentBridge: Bun ${version} detected.`);
    bunOk = true;
  } catch (e) {
    // A timeout means bun exists but hung — "install Bun" advice would be
    // misleading there; tell the truth and point at the abg init fallback.
    if (e && e.code === "ETIMEDOUT") {
      console.warn(`\x1b[33m⚠\x1b[0m AgentBridge: \`bun --version\` timed out — run \`abg init\` after the install completes.`);
    } else {
      console.warn(`
\x1b[33m⚠ AgentBridge requires Bun (v1.0+) as its runtime.\x1b[0m

The CLI was installed, but it won't work without Bun.
Install Bun with:

  curl -fsSL https://bun.sh/install | bash

Then restart your terminal and run:

  abg init
`);
    }
  }

  // Step 2: Register marketplace + install plugin (requires Claude Code)
  if (bunOk && !skipPluginRegistration()) {
    if (shouldStopRunningDaemons()) {
      try {
        stopRunningAgentBridge({ bestEffort: true });
      } catch {
        console.log(`\x1b[33m⚠\x1b[0m AgentBridge: could not stop running daemons — run \`abg kill --all\` before relying on this install.`);
      }
    } else {
      console.log(`\x1b[33m⚠\x1b[0m AgentBridge: not an explicit global self-install — leaving running daemons untouched (use \`abg kill --all\` or install-global to stop).`);
    }

    try {
      execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: VERSION_PROBE_TIMEOUT_MS });
    } catch {
      console.log(`\x1b[33m⚠\x1b[0m AgentBridge: Claude Code not found — skipping plugin install.`);
      console.log(`  After installing Claude Code, run: abg init`);
      process.exit(0);
    }

    try {
      execFileSync("claude", ["plugin", "marketplace", "add", PACKAGE_ROOT], {
        stdio: "pipe",
        timeout: PLUGIN_STEP_TIMEOUT_MS,
      });
      console.log(`\x1b[32m✔\x1b[0m AgentBridge: Marketplace registered.`);
    } catch (e) {
      console.log(`\x1b[33m⚠\x1b[0m AgentBridge: Marketplace registration failed — run \`abg init\` to retry.`);
      process.exit(0);
    }

    try {
      execFileSync("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], {
        stdio: "pipe",
        timeout: PLUGIN_STEP_TIMEOUT_MS,
      });
      console.log(`\x1b[32m✔\x1b[0m AgentBridge: Plugin installed. Run \`abg claude\` to start.`);
    } catch (e) {
      console.log(`\x1b[33m⚠\x1b[0m AgentBridge: Plugin install failed — run \`abg init\` to retry.`);
    }
  }
}

module.exports = { shouldStopRunningDaemons, skipPluginRegistration };

// Only run install side effects when invoked directly (not when require()'d
// from a unit test).
if (require.main === module) {
  runPostinstall();
}
