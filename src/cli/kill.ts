import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle } from "../daemon-lifecycle";

export async function runKill() {
  console.log("AgentBridge Kill — stopping all AgentBridge processes\n");

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
  const killed = await lifecycle.kill();

  if (killed) {
    console.log("\nAgentBridge daemon stopped.");
  } else {
    console.log("\nNo running AgentBridge daemon found.");
    console.log("Stale state files cleaned up (if any).");
  }
}
