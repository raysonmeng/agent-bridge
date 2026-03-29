import { execSync, execFileSync } from "node:child_process";
import { ConfigService } from "../config-service";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { findPackageRoot, registerMarketplace } from "./pkg-root";

const MIN_CLAUDE_VERSION = "2.1.80";

export async function runInit() {
  console.log("AgentBridge Init\n");

  // Step 1: Check dependencies
  console.log("Checking dependencies...");
  checkBun();
  checkClaude();
  checkCodex();
  console.log("");

  // Step 2: Generate project config
  console.log("Generating project config...");
  const configService = new ConfigService();
  const created = configService.initDefaults();

  if (created.length > 0) {
    for (const file of created) {
      console.log(`  Created: ${file}`);
    }
  } else {
    console.log("  Project config already exists, skipping.");
  }
  console.log("");

  // Step 3: Register marketplace + install plugin (best-effort)
  console.log("Installing AgentBridge plugin...");
  try {
    registerMarketplace(findPackageRoot());
    execFileSync("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], {
      stdio: "inherit",
    });
    console.log("  Plugin installed successfully.");
  } catch {
    console.log("  Plugin install skipped (marketplace registration or install failed).");
    console.log("  You can install it later with:");
    console.log(`    abg dev   # registers marketplace and installs plugin`);
  }
  console.log("");

  // Step 4: Done
  console.log("Setup complete!\n");
  console.log("Next steps:");
  console.log("  1. If Claude Code is already running, execute /reload-plugins in your session");
  console.log("  2. Start Claude Code:  agentbridge claude");
  console.log("  3. Start Codex TUI:    agentbridge codex");
}

function checkBun() {
  try {
    const version = execSync("bun --version", { encoding: "utf-8" }).trim();
    console.log(`  bun: ${version}`);
  } catch {
    console.error("  ERROR: bun not found in PATH.");
    console.error("  Install Bun: https://bun.sh");
    process.exit(1);
  }
}

function checkClaude() {
  try {
    const versionOutput = execSync("claude --version", { encoding: "utf-8" }).trim();
    // Extract version number (may be in format "claude v2.1.80" or just "2.1.80")
    const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      const version = match[1];
      console.log(`  claude: ${version}`);
      if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
        console.error(`  ERROR: Claude Code version ${version} is too old.`);
        console.error(`  Channels require >= ${MIN_CLAUDE_VERSION}.`);
        console.error("  Update: npm update -g @anthropic-ai/claude-code");
        process.exit(1);
      }
    } else {
      console.log(`  claude: ${versionOutput} (version check skipped)`);
    }
  } catch {
    console.error("  ERROR: claude not found in PATH.");
    console.error("  Install Claude Code: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
}

function checkCodex() {
  try {
    const version = execSync("codex --version", { encoding: "utf-8" }).trim();
    console.log(`  codex: ${version}`);
  } catch {
    console.error("  ERROR: codex not found in PATH.");
    console.error("  Install Codex: https://github.com/openai/codex");
    process.exit(1);
  }
}

/** Compare semver strings. Returns -1, 0, or 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

export { compareVersions };
