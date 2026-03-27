import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
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
  const tuiKilled = await killManagedCodexTui(stateDir, (msg) => console.log(`  ${msg}`));
  const killed = await lifecycle.kill();

  if (killed || tuiKilled) {
    console.log("\nAgentBridge stopped.");
    console.log("Please restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to fully disconnect.");
  } else {
    console.log("\nNo running AgentBridge daemon or managed Codex TUI found.");
    console.log("Stale state files cleaned up (if any).");
  }
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
