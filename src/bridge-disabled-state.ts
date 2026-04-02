export type BridgeDisabledReason = "killed" | "replaced";

export function disabledReplyError(reason: BridgeDisabledReason): string {
  switch (reason) {
    case "replaced":
      return "AgentBridge was replaced by a newer Claude Code session. This session is now permanently idle. Switch to the active session or start a new Claude Code session with `agentbridge claude`.";
    case "killed":
      return "AgentBridge is disabled by `agentbridge kill`. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.";
  }
}
