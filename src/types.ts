// ===== Bridge Core Types =====

// "room" tags cross-machine room-event notices injected by the daemon's room
// bridge. It is a CHANNEL-attribution source only (renders as user="Room",
// distinct from the trusted local "codex" partner) — it never participates in
// the Claude→Codex reply/forward paths, so the source-never-forwarded invariant
// is unchanged.
export type MessageSource = "claude" | "codex" | "room";

export interface BridgeMessage {
  id: string;
  source: MessageSource;
  content: string;
  timestamp: number;
  /**
   * Stable budget-resume correlation id (PR4, additive). Present ONLY on Claude
   * channel resume pushes (system_budget_resume directives). When set, the
   * Claude adapter surfaces it as `meta.resume_id` so Claude can echo it back
   * via the `ack_resume` MCP tool. Does NOT affect the source-never-forwarded
   * invariant — it is an opaque payload field, not a routing key.
   */
  resumeId?: string;
}

// ===== JSON-RPC 2.0 =====

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  method: string;
  id: number;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, any>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ===== MCP Tool Schema =====

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}
