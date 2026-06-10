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

// Marketplace name constant (shared with plugin)
export const MARKETPLACE_NAME = "agentbridge";
export const PLUGIN_NAME = "agentbridge";

/** Commands that print an update notice. claude/codex/resume also trigger the daily refresh. */
export const REFRESH_COMMANDS = new Set(["claude", "codex", "resume"]);
export const NOTIFY_COMMANDS = new Set(["claude", "codex", "init", "dev", "resume"]);

/** Subcommands that accept a `--pair <name>` selector. */
export const PAIR_AWARE_COMMANDS = new Set(["claude", "codex", "kill", "doctor", "budget", "resume", "logs"]);

/**
 * Split argv into the subcommand and its args, allowing a leading `--pair <name>`
 * (or `--pair=<name>`) to appear BEFORE the subcommand:
 *
 *   abg --pair work claude --resume   →  command="claude", restArgs=["--pair","work","--resume"]
 *
 * The leading pair token(s) are re-attached to the front of the subcommand's args
 * (only for pair-aware commands), so each command's own `--pair` parser
 * (parsePairFlag / parseKillArgs) handles BOTH the new leading position and the
 * classic trailing `abg claude --pair work`. For non-pair-aware commands a leading
 * `--pair` is dropped (those commands ignore it), preserving prior behaviour.
 */
export function parseTopLevel(args: string[]): { command: string | undefined; restArgs: string[] } {
  const pairTokens: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pair") {
      pairTokens.push(a);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        pairTokens.push(next);
        i++;
      }
      continue;
    }
    if (a.startsWith("--pair=")) {
      pairTokens.push(a);
      continue;
    }
    break; // first non-pair token is the subcommand
  }

  const command = args[i];
  const tail = args.slice(i + 1);
  if (command !== undefined && PAIR_AWARE_COMMANDS.has(command)) {
    return { command, restArgs: [...pairTokens, ...tail] };
  }
  return { command, restArgs: tail };
}

async function main(command: string | undefined, restArgs: string[]) {
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
      await runDev(restArgs);
      break;
    case "claude":
      const { runClaude } = await import("./cli/claude");
      await runClaude(restArgs);
      break;
    case "codex":
      const { runCodex } = await import("./cli/codex");
      await runCodex(restArgs);
      break;
    case "resume":
      const { runResume } = await import("./cli/resume");
      await runResume(restArgs);
      break;
    case "kill":
      const { runKill } = await import("./cli/kill");
      await runKill(restArgs);
      break;
    case "pairs":
      const { runPairs } = await import("./cli/pairs");
      await runPairs(restArgs);
      break;
    case "doctor":
      const { runDoctor } = await import("./cli/doctor");
      await runDoctor(restArgs);
      break;
    case "budget":
      const { runBudget } = await import("./cli/budget");
      await runBudget(restArgs);
      break;
    case "logs":
      const { runLogs } = await import("./cli/logs");
      await runLogs(restArgs);
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
  agentbridge [--pair <name>] <command> [args...]
  abg [--pair <name>] <command> [args...]

Commands:
  init               Install plugin, check dependencies, generate project config
  dev                Register local marketplace + install plugin (for local dev)
  claude [args...]   Start Claude Code with push channel enabled
  codex [args...]    Start Codex TUI connected to AgentBridge daemon
                     (bare command auto-resumes the last thread; --new starts fresh)
  resume [claude|codex]
                     No target: print resume commands for this directory's last
                     Claude session + this pair's current Codex thread.
                     With target: resume that side directly.
  pairs [rm <name|id> | prune [--apply]]
                     List pairs; remove one (rm), or reclaim orphan dirs + stranded
                     entries (prune previews by default; --apply to delete)
  doctor [--json]    Diagnose env, daemon, build drift, logs, and current thread
  doctor resume-pollution [--apply]  Find/fix old AgentBridge kickoff metadata
  budget [--json]    Show both agents' subscription quota snapshot (5h/weekly, drift, pause state)
  logs [--codex] [-f] [-n N]
                     Tail this pair's daemon log (or the codex wrapper log with
                     --codex). -n N: last N lines (default 100). -f: follow/stream.
  kill [all | --all | --pair <name|id>]
                     Stop this directory's pairs (default), every pair (all/--all), or one (--pair)

Options:
  --pair <name>      Run claude/codex/resume/kill/doctor/budget in a named pair. The name is scoped to
                     the current directory, so the same name in another directory
                     is a separate pair. Goes BEFORE the command. Without it, the
                     pair name defaults to "main" for the current directory.
  --safe             Disable the max-permission defaults for this launch.
                     Goes AFTER the command (abg claude --safe); also auto-
                     suppressed when you pass any explicit permission flag
                     (-a/--sandbox for codex, --permission-mode for claude).
                     (abg claude runs with --dangerously-skip-permissions and
                     abg codex with --yolo by default; AGENTBRIDGE_SAFE=1 also
                     disables both.)
  --help, -h         Show this help message
  --version, -v      Show version

Multi-pair:
  Each pair is an isolated daemon with its own port triple. The first pair uses
  the classic ports 4500/4501/4502; each additional pair steps +10. If "main" in
  this directory already has a live Claude session, "abg claude" errors instead of
  contesting it — pick another --pair name (or kill the live one first).

Examples:
  abg init                     # First-time setup
  abg claude                   # Start the "main" pair for this directory
  abg codex                    # Connect Codex to this directory's "main" pair
  abg resume                   # Print resume commands for both sides
  abg resume claude            # Resume the last Claude Code session here
  abg resume codex             # Resume this pair's current Codex thread
  abg claude --safe            # One launch without the max-permission default
  abg --pair work claude       # Start a named pair "work" (this directory)
  abg --pair work codex        # Connect Codex to the "work" pair
  abg --pair review claude     # A second, parallel pair
  abg pairs                    # List all pairs and their ports/status
  abg pairs --threads          # Include current thread mapping
  abg doctor --json            # Emit a structured diagnostics report
  abg logs                     # Tail the last 100 lines of this pair's daemon log
  abg logs -f -n 200           # Follow the log, starting from the last 200 lines
  abg logs --codex             # Tail the codex wrapper log instead
  abg --pair work logs         # Tail the "work" pair's daemon log
  abg pairs rm work            # Stop this directory's "work" pair and free its slot
  abg pairs rm work-1a2b3c4d   # ...or by its full id (from that pair's directory)
  abg pairs prune              # Preview reclaimable: orphan dirs + stranded entries (cwd-gone, dead, >1d)
  abg pairs prune --apply      # ...actually delete the previewed dirs + entries
  abg --pair work kill         # Stop only this directory's "work" pair
  abg kill                     # Stop this directory's pairs (+ any legacy-root daemon)
  abg kill all                 # Stop every pair in every directory (+ legacy-root)
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

// Only dispatch when executed as the CLI entrypoint. cli.ts is also imported as a
// module (e.g. claude.ts/codex.ts pull MARKETPLACE_NAME, tests pull parseTopLevel);
// in those cases import.meta.main is false and we must NOT run the command switch.
if (import.meta.main) {
  const { command, restArgs } = parseTopLevel(process.argv.slice(2));
  main(command, restArgs).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
