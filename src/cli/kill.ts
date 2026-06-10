import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { PairError, detectLegacyRootDaemon, listPairDirs, type PairEntry, type PairPorts } from "../pair-registry";
import {
  computeBaseDir,
  findPairForFlag,
  listPairs,
  listPairsForCwd,
  parseKillArgs,
  portsForEntry,
} from "../pair-resolver";
import {
  commandForPid,
  commandMatchesManagedCodexTui,
  findManagedCodexTuiProcesses,
  isProcessAlive,
  listBridgeFrontendProcesses,
  terminateProcessSync,
  type ProcessListEntry,
} from "../process-lifecycle";
import { StateDirResolver } from "../state-dir";

type LogFn = (msg: string) => void;

export interface StopResult {
  label: string;
  /** "appPort/proxyPort/controlPort" for display. */
  portsLabel: string;
  daemonKilled: boolean;
  tuiKilled: boolean;
  /** Buffered per-target log lines (printed only when something happened). */
  details: string[];
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
  } else if (parsed.all) {
    // The registry is exactly the state that gets corrupted when things go
    // wrong — the recovery command must not depend on what it is recovering.
    // On a corrupt registry, degrade to the directory scan below so everything
    // stoppable still gets stopped.
    let registered: PairEntry[] = [];
    try {
      registered = listPairs(base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`⚠️  pair registry 不可读（${message}）——降级为状态目录扫描，仍会停止能找到的全部 pair。`);
    }
    for (const pair of registered) {
      results.push(await stopPairEntry(base, pair));
    }
    // Third enumeration source: state dirs on disk with NO registry entry
    // (old builds, resurrected log dirs, corrupt registry). Daemons in these
    // were previously unkillable by ANY CLI command — and without a killed
    // sentinel written here, a surviving frontend would relaunch them.
    const registeredIds = new Set(registered.map((pair) => pair.pairId));
    for (const dirName of listPairDirsSafe(base)) {
      if (registeredIds.has(dirName)) continue;
      const stateDir = new StateDirResolver(join(base, "pairs", dirName));
      results.push(await stopStateDir(`${dirName} (unregistered)`, stateDir, portsFromStateDir(stateDir)));
    }
    const legacy = detectLegacyRootDaemon(base);
    if (legacy) {
      results.push(await stopStateDir("(legacy-root)", new StateDirResolver(base), {
        appPort: 4500,
        proxyPort: 4501,
        controlPort: legacy.controlPort,
      }));
    }
  } else {
    // Same corrupt-registry degradation as --all: the no-arg path is what a
    // stuck user types FIRST — it must not be the only path that crashes.
    let cwdPairs: PairEntry[] = [];
    try {
      cwdPairs = listPairsForCwd(base, process.cwd());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `⚠️  pair registry 不可读（${message}）——无法按目录定位 pair。` +
          "运行 `abg kill --all` 可降级为全盘状态目录扫描，停止所有能找到的 pair。",
      );
      process.exitCode = 2;
    }
    for (const pair of cwdPairs) {
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
    if (results.length === 0) {
      console.log(`No AgentBridge pairs registered for current directory: ${process.cwd()}`);
      console.log("Use `abg kill all` or `abg kill --all` to stop pairs from every directory.");
      return;
    }
  }

  printSummary(results, restartCommand);
}

function validateKillArgs(args: string[]): string | "help" | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "all") continue;
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
       abg kill all
       abg [--pair <name|id>] kill

Stops AgentBridge daemon/TUI processes.

Options:
  --pair <name|id>  Stop only one pair — a cwd-scoped name (e.g. "main") or the
                    same pair id when run from that directory.
  all, --all        Stop all registered pairs and any legacy-root daemon.
  --help, -h        Show this help message.

No arguments stop this directory's registered pairs and any legacy-root daemon.
`.trim());
}

export async function stopPairEntry(base: string, pair: PairEntry): Promise<StopResult> {
  const ports = portsForEntry(pair);
  const stateDir = new StateDirResolver(join(base, "pairs", pair.pairId));
  return stopStateDir(pair.pairId, stateDir, ports);
}

function listPairDirsSafe(base: string): string[] {
  try {
    return listPairDirs(base);
  } catch {
    return [];
  }
}

/**
 * Best-effort port recovery for an UNREGISTERED state dir (no slot to compute
 * from): read what the daemon advertised in its own status.json. Zeroes are
 * fine — kill() targets the pid file, not the ports.
 */
function portsFromStateDir(stateDir: StateDirResolver): PairPorts {
  try {
    const raw = JSON.parse(readFileSync(stateDir.statusFile, "utf-8"));
    return {
      appPort: portFromUrl(raw?.appServerUrl) ?? 0,
      proxyPort: portFromUrl(raw?.proxyUrl) ?? 0,
      controlPort: typeof raw?.controlPort === "number" ? raw.controlPort : 0,
    };
  } catch {
    return { appPort: 0, proxyPort: 0, controlPort: 0 };
  }
}

function portFromUrl(url: unknown): number | null {
  if (typeof url !== "string") return null;
  const match = url.match(/:(\d+)(?:[/?]|$)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

async function stopStateDir(label: string, stateDir: StateDirResolver, ports: PairPorts): Promise<StopResult> {
  const portsLabel = `${ports.appPort}/${ports.proxyPort}/${ports.controlPort}`;
  // Buffer instead of printing: a kill sweep over many idle pairs used to emit
  // 3+ "nothing to do" lines per pair, drowning the few targets that actually
  // stopped something. The caller prints details only for targets that acted.
  const details: string[] = [];
  const log: LogFn = (msg) => details.push(msg);

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
    return { label, portsLabel, daemonKilled, tuiKilled, details };
  } catch (error) {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return { label, portsLabel, daemonKilled: false, tuiKilled: false, details, error };
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
      // Name + cwd are the columns the user needs to ACT on this list: pair
      // names are cwd-scoped, so "no such pair here" is only resolvable by
      // seeing where each pair actually lives.
      console.log(
        `  ${pair.pairId} (name=${pair.name ?? "main"}, cwd=${pair.cwd}, slot ${pair.slot}, ports ${ports.appPort}/${ports.proxyPort}/${ports.controlPort})`,
      );
    }
  } catch (error) {
    if (error instanceof PairError) {
      console.log(`Could not read pair registry: ${error.message}`);
      return;
    }
    throw error;
  }
}

function describeStopped(result: StopResult): string {
  const parts: string[] = [];
  if (result.daemonKilled) parts.push("daemon");
  if (result.tuiKilled) parts.push("Codex TUI");
  return `${result.label}（${parts.join(" + ")}）`;
}

/**
 * Render the kill report. Pure (no I/O) so the exact shape is unit-testable.
 * Design constraint from real-world use: the person running `abg kill` is
 * already debugging something — the output must answer, at a glance,
 * "停了什么、什么本来就没在跑、什么失败了、还有什么会让它复活".
 */
export function formatKillReport(
  results: StopResult[],
  frontends: ProcessListEntry[],
  restartCommand: string,
): string[] {
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push("No pairs registered.");
    return lines;
  }

  const stopped = results.filter((r) => (r.daemonKilled || r.tuiKilled) && !r.error);
  const failed = results.filter((r) => r.error);
  const idle = results.filter((r) => !r.daemonKilled && !r.tuiKilled && !r.error);

  // Per-target detail blocks ONLY for targets where something actually happened —
  // idle pairs collapse into one summary line instead of 3+ noise lines each.
  for (const result of [...stopped, ...failed]) {
    lines.push(`  [${result.label} ${result.portsLabel}]`);
    for (const detail of result.details) lines.push(`    ${detail}`);
  }
  if (stopped.length > 0 || failed.length > 0) lines.push("");

  lines.push(`总结（共 ${results.length} 个目标）:`);
  if (stopped.length > 0) {
    lines.push(`  ✅ 已停止 ${stopped.length} 个: ${stopped.map(describeStopped).join(", ")}`);
  }
  if (idle.length > 0) {
    lines.push(`  ⚪ 本来就没在运行 ${idle.length} 个: ${idle.map((r) => r.label).join(", ")}`);
  }
  if (failed.length > 0) {
    lines.push(`  ❌ 失败 ${failed.length} 个: ${failed.map((r) => r.label).join(", ")}（详见上方日志）`);
  }
  lines.push("");

  if (stopped.length > 0) {
    lines.push("AgentBridge stopped.");
    lines.push(
      `Please restart Claude Code (\`${restartCommand}\`), switch to a new conversation, or run \`/resume\` to fully disconnect.`,
    );
    lines.push(
      "ℹ️  已写入 killed 哨兵：被停止的 pair 不会被自动复活；" +
        `下次 \`${restartCommand}\` / \`agentbridge codex\` 会清除哨兵并用当前安装版本启动全新 daemon。`,
    );
  } else {
    lines.push("No running AgentBridge daemon or managed Codex TUI found.");
    lines.push("ℹ️  目标 pair 都没有在运行的进程——如果你仍看到 AgentBridge 活动，见下方前端提示。");
  }

  if (frontends.length > 0) {
    lines.push(
      `⚠️  检测到 ${frontends.length} 个仍在运行的 Claude Code 桥接前端 (pid ${frontends
        .map((f) => f.pid)
        .join(", ")})：`,
    );
    lines.push("    它们现在处于待机状态、不会复活已停止的 daemon；但旧窗口里加载的插件代码");
    lines.push("    不会自动更新——升级后需要新版本时，请关闭并重开对应的 Claude Code 窗口。");
  }

  lines.push("Registry entries were preserved. Use `abg pairs rm <name|id>` to stop and release a slot.");
  return lines;
}

function printSummary(results: StopResult[], restartCommand: string) {
  const frontends = listBridgeFrontendProcesses();
  for (const line of formatKillReport(results, frontends, restartCommand)) {
    console.log(line);
  }
  // Scriptability: partial failure must be observable without grepping stdout.
  if (results.some((r) => r.error)) {
    process.exitCode = 2;
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
  } else if (parsed.all) {
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
  } else {
    for (const pair of listPairsForCwd(base, process.cwd())) {
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
    if (results.length === 0) {
      console.log(`No AgentBridge pairs registered for current directory: ${process.cwd()}`);
      console.log("Use `abg kill all` or `abg kill --all` to stop pairs from every directory.");
      return;
    }
  }

  printSummary(results, restartCommand);
}

function validateKillArgs(args: string[]): string | "help" | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "all") continue;
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
       abg kill all
       abg [--pair <name|id>] kill

Stops AgentBridge daemon/TUI processes.

Options:
  --pair <name|id>  Stop only one pair — a cwd-scoped name (e.g. "main") or the
                    same pair id when run from that directory.
  all, --all        Stop all registered pairs and any legacy-root daemon.
  --help, -h        Show this help message.

No arguments stop this directory's registered pairs and any legacy-root daemon.
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
