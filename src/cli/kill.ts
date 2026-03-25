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

  const killed = await lifecycle.kill();
  lifecycle.markKilled();

  if (killed) {
    console.log("\nAgentBridge daemon stopped.");
  } else {
    console.log("\nNo running AgentBridge daemon found.");
    console.log("Stale state files cleaned up (if any).");
  }
}
