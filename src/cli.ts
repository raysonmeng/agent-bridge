#!/usr/bin/env bun

/**
 * AgentBridge CLI
 *
 * Commands:
 *   agentbridge init        — Install plugin, check deps, generate project config
 *   agentbridge dev         — Register local marketplace + install plugin for local dev
 *   agentbridge claude      — Start Claude Code with push channel flags
 *   agentbridge codex       — Start Codex TUI connected to daemon
 *   agentbridge kill        — Force kill all AgentBridge processes
 */

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

// Marketplace name constant (shared with plugin)
export const MARKETPLACE_NAME = "agentbridge";
export const PLUGIN_NAME = "agentbridge";

/** Commands that print an update notice. claude/codex also trigger the daily refresh. */
const REFRESH_COMMANDS = new Set(["claude", "codex"]);
const NOTIFY_COMMANDS = new Set(["claude", "codex", "init", "dev"]);

async function main() {
  // Best-effort, non-blocking update notice. Fully guarded — never blocks,
  // delays, or fails the command (see src/update-notifier.ts).
  if (command && NOTIFY_COMMANDS.has(command)) {
    try {
      const { maybeNotifyUpdate } = await import("./update-notifier");
      maybeNotifyUpdate({ refresh: REFRESH_COMMANDS.has(command) });
    } catch {
      // ignore — the notifier must never affect the command
    }
  }

  switch (command) {
    case "init":
      const { runInit } = await import("./cli/init");
      await runInit();
      break;
    case "dev":
      const { runDev } = await import("./cli/dev");
      await runDev();
      break;
    case "claude":
      const { runClaude } = await import("./cli/claude");
      await runClaude(restArgs);
      break;
    case "codex":
      const { runCodex } = await import("./cli/codex");
      await runCodex(restArgs);
      break;
    case "kill":
      const { runKill } = await import("./cli/kill");
      await runKill(restArgs);
      break;
    case "pairs":
      const { runPairs } = await import("./cli/pairs");
      await runPairs(restArgs);
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run "agentbridge --help" (or "abg --help") for usage.`);
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
AgentBridge — Multi-agent collaboration bridge

Usage:
  agentbridge <command> [args...]
  abg <command> [args...]

Commands:
  init               Install plugin, check dependencies, generate project config
  dev                Register local marketplace + install plugin (for local dev)
  claude [args...]   Start Claude Code with push channel enabled
  codex [args...]    Start Codex TUI connected to AgentBridge daemon
  pairs [rm <id>]    List running Claude+Codex pairs (or remove one)
  kill [--pair <id>] Stop all pairs, or just one with --pair (alias: --all)

Options:
  --pair <name>      Run claude/codex in a named pair (multiple pairs per machine).
                     Without it, the pair is derived from the current directory.
  --help, -h         Show this help message
  --version, -v      Show version

Multi-pair:
  Each pair is an isolated daemon with its own port triple. The first pair uses
  the classic ports 4500/4501/4502; each additional pair steps +10.

Examples:
  abg init                     # First-time setup
  abg claude                   # Start Claude Code (pair derived from cwd)
  abg claude --pair work       # Start a named pair "work"
  abg codex  --pair work       # Connect Codex to the "work" pair
  abg claude --pair review     # A second, parallel pair
  abg pairs                    # List all pairs and their ports/status
  abg pairs rm work            # Stop the "work" pair and free its slot
  abg kill --pair work         # Stop only the "work" pair
  abg kill                     # Stop ALL pairs
`.trim());
}

function printVersion() {
  try {
    const pkg = require("../package.json");
    console.log(`agentbridge v${pkg.version}`);
  } catch {
    console.log("agentbridge (version unknown)");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
