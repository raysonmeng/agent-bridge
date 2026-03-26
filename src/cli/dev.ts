import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync, cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";

/** Resolve the project root from the CLI module location (not cwd). */
function getProjectRoot(): string {
  // src/cli/dev.ts -> project root is ../../
  return resolve(dirname(import.meta.dir), "..");
}

export async function runDev() {
  console.log("AgentBridge Dev Setup\n");

  const projectRoot = getProjectRoot();
  const marketplacePath = resolve(projectRoot, ".claude-plugin", "marketplace.json");
  const pluginDir = resolve(projectRoot, "plugins", "agentbridge");
  const pluginManifest = resolve(pluginDir, ".claude-plugin", "plugin.json");

  // Step 1: Validate local plugin exists
  if (!existsSync(pluginManifest)) {
    console.error(`  ERROR: Plugin manifest not found at ${pluginManifest}`);
    console.error("  Run 'bun run build:plugin' first, or check your working tree.");
    process.exit(1);
  }
  if (!existsSync(marketplacePath)) {
    console.error(`  ERROR: Marketplace manifest not found at ${marketplacePath}`);
    process.exit(1);
  }
  console.log(`  Plugin source: ${pluginDir}`);

  // Step 2: Register local marketplace (idempotent)
  console.log("\nRegistering local marketplace...");
  try {
    const listOutput = execFileSync("claude", ["plugin", "marketplace", "list"], { encoding: "utf-8" });
    if (listOutput.includes(MARKETPLACE_NAME)) {
      console.log(`  Marketplace '${MARKETPLACE_NAME}' already registered.`);
    } else {
      execFileSync("claude", ["plugin", "marketplace", "add", projectRoot], { stdio: "inherit" });
    }
  } catch {
    try {
      execFileSync("claude", ["plugin", "marketplace", "add", projectRoot], { stdio: "inherit" });
    } catch (e: any) {
      console.error(`  ERROR: Failed to register marketplace: ${e.message}`);
      process.exit(1);
    }
  }

  // Step 3: Install plugin, then force-sync local files to cache
  const pluginRef = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
  console.log("\nInstalling plugin...");
  try {
    const listOutput = execFileSync("claude", ["plugin", "list"], { encoding: "utf-8" });
    if (!listOutput.includes(pluginRef)) {
      execFileSync("claude", ["plugin", "install", pluginRef], { stdio: "inherit" });
    } else {
      console.log(`  Plugin '${pluginRef}' already installed.`);
    }
  } catch (e: any) {
    console.error(`  ERROR: Failed to install plugin: ${e.message}`);
    process.exit(1);
  }

  // Step 4: Force-sync local plugin files to cache (bypasses version check)
  console.log("\nSyncing local plugin to cache...");
  const cacheDir = resolve(homedir(), ".claude", "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME);
  if (existsSync(cacheDir)) {
    // Find the version directory (e.g., 0.1.0)
    const versionDirs = Bun.spawnSync(["ls", cacheDir]).stdout.toString().trim().split("\n").filter(Boolean);
    for (const ver of versionDirs) {
      const targetDir = resolve(cacheDir, ver);
      // Remove old cached files and copy fresh ones
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(pluginDir, targetDir, { recursive: true });
      console.log(`  Synced to ${targetDir}`);
    }
  } else {
    console.log("  Cache directory not found, plugin install should have created it.");
  }

  console.log("\n✅ Dev setup complete!\n");
  console.log("Next steps:");
  console.log("  agentbridge claude    # Start Claude Code (plugin auto-loaded)");
  console.log("  agentbridge codex     # Start Codex TUI");
  console.log("");
  console.log("Code changed? Run 'agentbridge dev' again, then restart Claude Code or /reload-plugins.");
}
