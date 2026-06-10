export type BridgeDisabledReason =
  | "killed"
  | "rejected"
  | "evicted"
  | "probe_in_progress"
  | "auto_recovery_exhausted";

import { pairScopedCommand } from "./pair-command";

export function disabledReplyError(reason: BridgeDisabledReason): string {
  // These render in the bridge (MCP server) process, which inherits
  // AGENTBRIDGE_PAIR_ID in multi-pair mode — so the suggested commands carry
  // `--pair <id>` and don't send the user to a different pair / kill all pairs.
  const claudeCmd = pairScopedCommand("claude");
  switch (reason) {
    case "rejected":
      return `AgentBridge rejected this session — another Claude Code session is already connected. Close the other session first, or run \`${pairScopedCommand("kill")}\` to reset.`;
    case "evicted":
      return `AgentBridge evicted this session because it stopped responding to liveness probes — a newer Claude Code session has taken over. Close this session and start a new one with \`${claudeCmd}\`.`;
    case "probe_in_progress":
      return `AgentBridge rejected this session — a liveness probe is currently checking the incumbent Claude session. Retry in a few seconds with \`${claudeCmd}\`.`;
    case "auto_recovery_exhausted":
      return `AgentBridge auto-recovery gave up after exhausting its retry budget for the in-flight liveness probe contention. Retry manually with \`${claudeCmd}\`.`;
    case "killed":
      return `AgentBridge is disabled by \`${pairScopedCommand("kill")}\`. Restart Claude Code (\`${claudeCmd}\`), switch to a new conversation, or run \`/resume\` to reconnect.`;
  }
}
