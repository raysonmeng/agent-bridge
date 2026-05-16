import type { BridgeMessage } from "./types";

export interface DaemonStatus {
  bridgeReady: boolean;
  tuiConnected: boolean;
  threadId: string | null;
  queuedMessageCount: number;
  proxyUrl: string;
  appServerUrl: string;
  pid: number;
  attachedClaudeCount?: number;
  /**
   * Spec v2.2 §7: true when a `--via-proxy` TUI is currently connected.
   * CLI uses this for pre-flight check before launching a second
   * `agentbridge codex --via-proxy` instance.
   */
  proxyTuiConnected?: boolean;
}

/**
 * `chatId` identifies a logical Claude session. Each Claude MCP instance
 * generates and registers one on `claude_connect`. Subsequent control
 * messages from that session carry the same id so the daemon can route
 * inbound/outbound traffic to the correct ClaudeThread + Claude WebSocket.
 *
 * When omitted, the daemon falls back to legacy single-session behavior
 * (assigns a synthetic chatId so the routing path still works).
 */
export type ControlClientMessage =
  | { type: "claude_connect"; chatId?: string }
  | { type: "claude_disconnect"; chatId?: string }
  | {
      type: "claude_to_codex";
      requestId: string;
      chatId?: string;
      message: BridgeMessage;
      requireReply?: boolean;
    }
  | { type: "status" };

export type ControlServerMessage =
  | { type: "codex_to_claude"; chatId?: string; message: BridgeMessage }
  | {
      type: "claude_to_codex_result";
      requestId: string;
      success: boolean;
      error?: string;
    }
  | { type: "status"; status: DaemonStatus };

/** WebSocket close code sent by the daemon when a newer Claude session replaces the current one. */
export const CLOSE_CODE_REPLACED = 4001;
