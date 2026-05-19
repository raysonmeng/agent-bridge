export type BridgeDisabledReason =
  | "killed"
  | "rejected"
  | "evicted"
  | "probe_in_progress"
  | "auto_recovery_exhausted";

export function disabledReplyError(reason: BridgeDisabledReason): string {
  switch (reason) {
    case "rejected":
      return "AgentBridge rejected this session — another Claude Code session is already connected. Close the other session first, or run `agentbridge kill` to reset.";
    case "evicted":
      return "AgentBridge evicted this session because it stopped responding to liveness probes — a newer Claude Code session has taken over. Close this session and start a new one with `agentbridge claude`.";
    case "probe_in_progress":
      return "AgentBridge rejected this session — a liveness probe is currently checking the incumbent Claude session. Retry in a few seconds with `agentbridge claude`.";
    case "auto_recovery_exhausted":
      return "AgentBridge auto-recovery gave up after exhausting its retry budget for the in-flight liveness probe contention. Retry manually with `agentbridge claude`.";
    case "killed":
      return "AgentBridge is disabled by `agentbridge kill`. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.";
  }
}
