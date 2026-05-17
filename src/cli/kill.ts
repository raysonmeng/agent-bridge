import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle, isProcessAlive } from "../daemon-lifecycle";

export async function runKill() {
  console.log("AgentBridge Kill — stopping daemon and managed Codex TUI\n");

  const stateDir = new StateDirResolver();
  const controlPort = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.log(`  ${msg}`),
  });

  // Mark the daemon as intentionally stopped before terminating the process.
  // This closes the reconnect race where the frontend sees the disconnect
  // before the sentinel is written and relaunches the daemon.
  lifecycle.markKilled();

  // STM v2.3 §8.4 P4d: walk every pair's codex.pid in pairs/*/codex.pid
  // and SIGTERM the lot before tearing down the daemon. Best-effort —
  // a malformed pair dir is logged and skipped, not fatal.
  const pairTuiKills = await killAllPairTuis(stateDir, (msg) => console.log(`  ${msg}`));
  // Legacy root-level codex-tui.pid for default pair (written for v2.2
  // backwards-compat). Skip if we already killed via the per-pair path.
  const tuiKilled = await killManagedCodexTui(stateDir, (msg) => console.log(`  ${msg}`));
  const killed = await lifecycle.kill();

  if (killed || tuiKilled || pairTuiKills > 0) {
    console.log("\nAgentBridge stopped.");
    if (pairTuiKills > 0) {
      console.log(`Killed ${pairTuiKills} pair-managed Codex TUI process(es).`);
    }
    console.log("Please restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to fully disconnect.");
  } else {
    console.log("\nNo running AgentBridge daemon or managed Codex TUI found.");
    console.log("Stale state files cleaned up (if any).");
  }
}

/**
 * STM v2.3 §8.4 P4d: walk `<stateDir>/pairs/*\/codex.pid` and SIGTERM
 * each managed Codex TUI. Best-effort — a malformed pair dir is logged
 * and skipped, not fatal. Returns the count of successfully killed
 * processes.
 */
async function killAllPairTuis(
  stateDir: StateDirResolver,
  log: (msg: string) => void,
  gracefulTimeoutMs = 3000,
): Promise<number> {
  const pairsRoot = join(stateDir.dir, "pairs");
  if (!existsSync(pairsRoot)) return 0;

  let entries: string[];
  try {
    entries = readdirSync(pairsRoot);
  } catch (err: any) {
    log(`Failed to read pairs/ dir: ${err?.message ?? err}`);
    return 0;
  }

  let killCount = 0;
  for (const pairId of entries) {
    if (pairId === "registry.json") continue; // skip the registry file
    const pidPath = join(pairsRoot, pairId, "codex.pid");
    if (!existsSync(pidPath)) continue;
    let pid: number | null = null;
    try {
      const raw = readFileSync(pidPath, "utf-8").trim();
      if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) pid = parsed;
      }
    } catch {}
    if (pid === null) {
      log(`Pair "${pairId}": malformed pid file, skipping`);
      try { unlinkSync(pidPath); } catch {}
      continue;
    }
    if (!isProcessAlive(pid)) {
      log(`Pair "${pairId}": pid ${pid} not alive, cleaning stale pid file`);
      try { unlinkSync(pidPath); } catch {}
      continue;
    }
    if (!isManagedCodexTuiProcess(pid)) {
      log(`Pair "${pairId}": pid ${pid} is alive but NOT a managed AgentBridge Codex TUI — skipping`);
      try { unlinkSync(pidPath); } catch {}
      continue;
    }
    log(`Pair "${pairId}": sending SIGTERM to pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: any) {
      log(`Pair "${pairId}": SIGTERM failed: ${err?.message ?? err}`);
      try { unlinkSync(pidPath); } catch {}
      continue;
    }

    const deadline = Date.now() + gracefulTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isProcessAlive(pid)) {
      log(`Pair "${pairId}": pid ${pid} did not stop gracefully, sending SIGKILL`);
      try { process.kill(pid, "SIGKILL"); } catch {}
    } else {
      log(`Pair "${pairId}": pid ${pid} stopped gracefully`);
    }
    try { unlinkSync(pidPath); } catch {}
    killCount++;
  }
  return killCount;
}

async function killManagedCodexTui(
  stateDir: StateDirResolver,
  log: (msg: string) => void,
  gracefulTimeoutMs = 3000,
): Promise<boolean> {
  const pid = readTuiPid(stateDir);
  if (!pid) {
    log("No Codex TUI pid file found");
    removeTuiPidFile(stateDir);
    return false;
  }

  if (!isProcessAlive(pid)) {
    log(`Codex TUI pid ${pid} is not alive, cleaning up stale pid file`);
    removeTuiPidFile(stateDir);
    return false;
  }

  if (!isManagedCodexTuiProcess(pid)) {
    log(`Pid ${pid} is alive but is NOT a managed AgentBridge Codex TUI — refusing to kill. Cleaning up stale pid file.`);
    removeTuiPidFile(stateDir);
    return false;
  }

  log(`Sending SIGTERM to Codex TUI pid ${pid}`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removeTuiPidFile(stateDir);
    return false;
  }

  const deadline = Date.now() + gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      log(`Codex TUI pid ${pid} stopped gracefully`);
      removeTuiPidFile(stateDir);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  log(`Codex TUI pid ${pid} did not stop gracefully, sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  removeTuiPidFile(stateDir);
  return true;
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

function isManagedCodexTuiProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
    return (
      cmd.includes("codex")
      && cmd.includes("--enable")
      && cmd.includes("tui_app_server")
      && cmd.includes("--remote")
    );
  } catch {
    return false;
  }
}
