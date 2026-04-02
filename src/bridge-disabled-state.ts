export type BridgeDisabledReason = "killed" | "rejected";

export function disabledReplyError(reason: BridgeDisabledReason): string {
  switch (reason) {
    case "rejected":
      return "AgentBridge rejected this session — another Claude Code session is already connected. Close the other session first, or run `agentbridge kill` to reset.";
    case "killed":
      return "AgentBridge is disabled by `agentbridge kill`. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.";
  }
}
