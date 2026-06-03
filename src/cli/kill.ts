import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { PairError, detectLegacyRootDaemon, type PairEntry, type PairPorts } from "../pair-registry";
import {
  computeBaseDir,
  findPairForFlag,
  listPairs,
  parseKillArgs,
  portsForEntry,
} from "../pair-resolver";
import {
  commandForPid,
  commandMatchesManagedCodexTui,
  findManagedCodexTuiProcesses,
  isProcessAlive,
  terminateProcessSync,
} from "../process-lifecycle";
import { StateDirResolver } from "../state-dir";

type LogFn = (msg: string) => void;

export interface StopResult {
  label: string;
  daemonKilled: boolean;
  tuiKilled: boolean;
  error?: unknown;
}

export async function runKill(args: string[] = []) {
  const argError = validateKillArgs(args);
  if (argError === "help") {
    printKillUsage();
    return;
  }
  if (argError) {
    console.error(`Error: ${argError}`);
    printKillUsage();
    process.exit(1);
  }

  const parsed = parseKillArgs(args);

  if (parsed.pairFlag !== undefined && parsed.all) {
    console.error('Error: use either "--pair <name>" or "--all", not both.');
    process.exit(1);
  }

  const base = computeBaseDir();
  console.log("AgentBridge Kill — stopping AgentBridge pair processes\n");

  const results: StopResult[] = [];
  let restartCommand = "agentbridge claude";
  if (parsed.pairFlag !== undefined) {
    // The friendly name is scoped to the current directory (same name elsewhere
    // is a different pair); findPairForFlag composes it with the cwd, falling
    // back to a raw pairId match for an id copied from `abg pairs` — same cwd only.
    let pair: PairEntry | null;
    try {
      pair = findPairForFlag(base, process.cwd(), parsed.pairFlag);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (!pair) {
      console.log(`No such pair: "${parsed.pairFlag}" in ${process.cwd()}`);
      printKnownPairs(base);
      return;
    }
    restartCommand = `agentbridge --pair ${pair.name ?? parsed.pairFlag} claude`;
    results.push(await stopPairEntry(base, pair));
  } else {
    for (const pair of listPairs(base)) {
      results.push(await stopPairEntry(base, pair));
    }
    const legacy = detectLegacyRootDaemon(base);
    if (legacy) {
      results.push(await stopStateDir("(legacy-root)", new StateDirResolver(base), {
        appPort: 4500,
        proxyPort: 4501,
        controlPort: legacy.controlPort,
      }));
    }
  }

  printSummary(results, restartCommand);
}

function validateKillArgs(args: string[]): string | "help" | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--all") continue;
    if (arg === "--pair") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return 'Missing value for "--pair".';
      }
      i++;
      continue;
    }
    if (arg.startsWith("--pair=")) {
      if (arg.slice("--pair=".length).length === 0) {
        return 'Missing value for "--pair".';
      }
      continue;
    }
    return `Unknown kill argument: ${arg}`;
  }
  return null;
}

function printKillUsage() {
  console.log(`
Usage: abg kill [--all]
       abg [--pair <name|id>] kill

Stops AgentBridge daemon/TUI processes.

Options:
  --pair <name|id>  Stop only one pair — a cwd-scoped name (e.g. "main") or the
                    same pair id when run from that directory.
  --all             Stop all registered pairs and any legacy-root daemon.
  --help, -h        Show this help message.

No arguments are equivalent to --all.
`.trim());
}

export async function stopPairEntry(base: string, pair: PairEntry): Promise<StopResult> {
  const ports = portsForEntry(pair);
  const stateDir = new StateDirResolver(join(base, "pairs", pair.pairId));
  return stopStateDir(pair.pairId, stateDir, ports);
}

async function stopStateDir(label: string, stateDir: StateDirResolver, ports: PairPorts): Promise<StopResult> {
  const prefix = `  [${label} ${ports.appPort}/${ports.proxyPort}/${ports.controlPort}]`;
  const log: LogFn = (msg) => console.log(`${prefix} ${msg}`);

  console.log(`${prefix} stopping`);
  try {
    const lifecycle = new DaemonLifecycle({
      stateDir,
      controlPort: ports.controlPort,
      log,
    });

    lifecycle.markKilled();
    // Prefer the daemon's own status.json proxyUrl over the slot's computed port:
    // the legacy/manual kill path resolves ports heuristically (e.g. the legacy
    // root daemon is reported as 4501) and a custom CODEX_PROXY_PORT would not
    // match the slot default. The TUI connected to whatever proxyUrl the daemon
    // advertised, so that is the URL the orphan scan must match. Read it BEFORE
    // killing the daemon (kill() deletes status.json). Fall back to the slot port.
    const status = lifecycle.readStatus();
    const proxyUrl =
      typeof status?.proxyUrl === "string" && status.proxyUrl.length > 0
        ? status.proxyUrl
        : `ws://127.0.0.1:${ports.proxyPort}`;
    const tuiKilled = await killManagedCodexTui(stateDir, proxyUrl, log);
    const daemonKilled = await lifecycle.kill();
    return { label, daemonKilled, tuiKilled };
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return { label, daemonKilled: false, tuiKilled: false, error };
  }
}

function printKnownPairs(base: string) {
  try {
    const pairs = listPairs(base);
    if (pairs.length === 0) {
      console.log("No pairs registered.");
      return;
    }
    console.log("Known pairs:");
    for (const pair of pairs) {
      const ports = portsForEntry(pair);
      console.log(`  ${pair.pairId} (slot ${pair.slot}, ports ${ports.appPort}/${ports.proxyPort}/${ports.controlPort})`);
    }
  } catch (error) {
    if (error instanceof PairError) {
      console.log(`Could not read pair registry: ${error.message}`);
      return;
    }
    throw error;
  }
}

function printSummary(results: StopResult[], restartCommand: string) {
  if (results.length === 0) {
    console.log("No pairs registered.");
    return;
  }

  const stopped = results.filter((r) => r.daemonKilled || r.tuiKilled).length;
  const failed = results.filter((r) => r.error).length;
  console.log("");
  if (stopped > 0) {
    console.log("AgentBridge stopped.");
    console.log(`Please restart Claude Code (\`${restartCommand}\`), switch to a new conversation, or run \`/resume\` to fully disconnect.`);
  } else {
    console.log("No running AgentBridge daemon or managed Codex TUI found.");
  }
  console.log(`Stopped ${stopped}/${results.length} target${results.length === 1 ? "" : "s"}.`);
  if (failed > 0) {
    console.log(`${failed} target${failed === 1 ? "" : "s"} reported errors; see log lines above.`);
  }
  console.log("Registry entries were preserved. Use `abg pairs rm <name|id>` to stop and release a slot.");
}

async function killManagedCodexTui(
  stateDir: StateDirResolver,
  proxyUrl: string,
  log: LogFn,
  gracefulTimeoutMs = 3000,
): Promise<boolean> {
  const pid = readTuiPid(stateDir);
  let killed = false;
  if (!pid) {
    log("No Codex TUI pid file found");
    removeTuiPidFile(stateDir);
  } else if (!isProcessAlive(pid)) {
    log(`Codex TUI pid ${pid} is not alive, cleaning up stale pid file`);
    removeTuiPidFile(stateDir);
  } else if (!isManagedCodexTuiProcess(pid, proxyUrl)) {
    log(`Pid ${pid} is alive but is NOT a managed AgentBridge Codex TUI — refusing to kill. Cleaning up stale pid file.`);
    removeTuiPidFile(stateDir);
  } else {
    log(`Stopping Codex TUI pid ${pid}`);
    terminateProcessSync(pid, { gracefulTimeoutMs, log });
    removeTuiPidFile(stateDir);
    killed = true;
  }

  const orphanCandidates = findManagedCodexTuiProcesses(proxyUrl)
    .filter((entry) => entry.pid !== pid);
  for (const candidate of orphanCandidates) {
    log(`Stopping orphan Codex TUI pid ${candidate.pid} attached to ${proxyUrl}`);
    terminateProcessSync(candidate.pid, { gracefulTimeoutMs, log });
    killed = true;
  }

  removeTuiPidFile(stateDir);
  return killed;
}

function readTuiPid(stateDir: StateDirResolver): number | null {
  try {
    const raw = readFileSync(stateDir.tuiPidFile, "utf-8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function removeTuiPidFile(stateDir: StateDirResolver) {
  try {
    unlinkSync(stateDir.tuiPidFile);
  } catch {}
}

function isManagedCodexTuiProcess(pid: number, proxyUrl: string): boolean {
  const cmd = commandForPid(pid);
  return cmd !== null && commandMatchesManagedCodexTui(cmd, proxyUrl);
}
