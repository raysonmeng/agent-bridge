#!/usr/bin/env node

/**
 * postinstall: verify Bun, register marketplace, install plugin.
 * Runs after `npm install -g @raysonmeng/agentbridge`.
 *
 * All steps are best-effort — a failure here does not block the npm install.
 * Users can always fall back to `abg init` for manual setup.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const MARKETPLACE_NAME = "agentbridge";
const PLUGIN_NAME = "agentbridge";

// Step 1: Check Bun
let bunOk = false;
try {
  const version = execFileSync("bun", ["--version"], { encoding: "utf-8" }).trim();
  console.log(`\x1b[32m✔\x1b[0m AgentBridge: Bun ${version} detected.`);
  bunOk = true;
} catch {
  console.warn(`
\x1b[33m⚠ AgentBridge requires Bun (v1.0+) as its runtime.\x1b[0m

The CLI was installed, but it won't work without Bun.
Install Bun with:

  curl -fsSL https://bun.sh/install | bash

Then restart your terminal and run:

  abg init
`);
}

// Step 2: Register marketplace + install plugin (requires Claude Code)
if (bunOk) {
  try {
    execFileSync("claude", ["--version"], { encoding: "utf-8" });
  } catch {
    console.log(`\x1b[33m⚠\x1b[0m AgentBridge: Claude Code not found — skipping plugin install.`);
    console.log(`  After installing Claude Code, run: abg init`);
    process.exit(0);
  }

  try {
    execFileSync("claude", ["plugin", "marketplace", "add", PACKAGE_ROOT], {
      stdio: "pipe",
    });
    console.log(`\x1b[32m✔\x1b[0m AgentBridge: Marketplace registered.`);
  } catch (e) {
    console.log(`\x1b[33m⚠\x1b[0m AgentBridge: Marketplace registration failed — run \`abg init\` to retry.`);
    process.exit(0);
  }

  try {
    execFileSync("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], {
      stdio: "pipe",
    });
    console.log(`\x1b[32m✔\x1b[0m AgentBridge: Plugin installed. Run \`abg claude\` to start.`);
  } catch (e) {
    console.log(`\x1b[33m⚠\x1b[0m AgentBridge: Plugin install failed — run \`abg init\` to retry.`);
  }
}
