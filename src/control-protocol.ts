import type { BridgeMessage } from "./types";

/**
 * STM v2.3 §D7 P3: per-pair status snapshot. One entry per pair in
 * `DaemonStatus.pairs`. v2.2 `proxyUrl` / `appServerUrl` / `tuiConnected`
 * / `proxyTuiConnected` / `threadId` top-level fields stay populated from
 * the default pair as a backward-compatibility shim for existing CLI /
 * test readers.
 */
export interface PairStatus {
  pairId: string;
  /** True when the pair's CodexAdapter is started (codex.start() completed). */
  isLive: boolean;
  appServerUrl: string;
  proxyUrl: string;
  /** True when CodexAdapter has a TUI WS attached (any kind, direct or proxy). */
  tuiConnected: boolean;
  /** True when a `--via-proxy` TUI is connected to this pair. */
  proxyTuiConnected: boolean;
  /** Currently paired chatId, or null. */
  pairedChatId: string | null;
  /** Active Codex thread id for this pair, or null when not yet provisioned. */
  threadId: string | null;
  /** Chats whose `homePairId === pairId`, with their pair-relationship state. */
  attachedClaudes: { chatId: string; paired: boolean }[];
}

export interface DaemonStatus {
  bridgeReady: boolean;
  pid: number;
  /**
   * v2.2-compatible top-level mirror of the default pair's status. The
   * URL fields are config (always populated from the default pair's
   * registered ports). The runtime fields reflect actual state — `null`
   * when not yet known (e.g. threadId before bootstrap, or when default
   * is destroyed entirely in a future phase).
   *
   * Existing CLI and test code that reads these top-level fields keeps
   * working. New v2.3 code should prefer the `pairs` array below.
   */
  proxyUrl: string;
  appServerUrl: string;
  tuiConnected: boolean;
  proxyTuiConnected: boolean;
  threadId: string | null;
  /** Aggregate count across all pairs + isolated chats. */
  attachedClaudeCount: number;
  /** Aggregate count of buffered + status-buffer messages across all chats. */
  queuedMessageCount: number;
  /** STM v2.3 §D7: per-pair detail array. */
  pairs: PairStatus[];
}

// ── STM v2.3 §D6 P3: pair management error codes ────────────────────────

/**
 * Error codes returned in `pair_error` and `claude_connect_result` failure
 * responses. Each code has a corresponding human-readable `message` field
 * in the payload; the code is the canonical machine-readable identifier.
 */
export type PairErrorCode =
  /** Pair name fails the D1 validation regex (or is empty / reserved misuse). */
  | "INVALID_PAIR_NAME"
  /** No registry / live entry for the requested pair name. */
  | "PAIR_NOT_FOUND"
  /**
   * Pair is live and already has a paired Claude (D4 strict semantics:
   * explicit-pair Claude attaches see this instead of falling back to isolated).
   */
  | "PAIR_BUSY"
  /**
   * Allocated ports for this pair are held by a foreign process. Recovery
   * via `destroy_pair --forget` or stopping the conflicting process.
   * `details.conflictPort` and `details.conflictPid` are populated.
   */
  | "PAIR_PORTS_BUSY"
  /** Daemon reached `AGENTBRIDGE_MAX_PAIRS` live pairs. */
  | "MAX_PAIRS"
  /** Port range exhausted within `AGENTBRIDGE_PAIR_PORT_MAX` strides. */
  | "ALLOCATION_FAILED"
  /**
   * `destroy_pair` invoked on a paired-live pair without `force: true`.
   * CLI maps to a "use --force" message.
   */
  | "PAIR_BUSY_NOT_FORCED"
  /** Daemon is in the middle of SIGTERM-driven shutdown; reject new ensures. */
  | "DAEMON_SHUTTING_DOWN";

export interface PairErrorDetails {
  conflictPort?: number;
  conflictPid?: number;
  [key: string]: unknown;
}

// ── Control messages ────────────────────────────────────────────────────

/**
 * `chatId` identifies a logical Claude session. Each Claude MCP instance
 * generates and registers one on `claude_connect`. Subsequent control
 * messages from that session carry the same id so the daemon can route
 * inbound/outbound traffic to the correct ClaudeThread + Claude WebSocket.
 *
 * When omitted, the daemon falls back to legacy single-session behavior
 * (assigns a synthetic chatId so the routing path still works).
 *
 * STM v2.3 P3: `claude_connect` gains an optional `pairId` per D4. The
 * bridge sources this from `AGENTBRIDGE_PAIR` env (set by `agentbridge
 * claude --pair NAME`) and forwards it to the daemon for explicit-pair
 * binding. Absence triggers FIFO claim across pairs.
 *
 * `claude_connect` also gains an optional `requestId` so the daemon's
 * `claude_connect_result` response can be correlated. v2.2 bridges that
 * omit `requestId` get a result with `requestId: undefined` which they
 * treat as a fire-and-forget acknowledgement (backwards-compatible).
 */
export type ControlClientMessage =
  | {
      type: "claude_connect";
      requestId?: string;
      chatId?: string;
      pairId?: string;
    }
  | { type: "claude_disconnect"; chatId?: string }
  | {
      type: "claude_to_codex";
      requestId: string;
      chatId?: string;
      message: BridgeMessage;
      requireReply?: boolean;
    }
  | { type: "status" }
  // STM v2.3 §D6 P3 — pair management API.
  | { type: "ensure_pair"; requestId: string; pairId: string }
  | { type: "destroy_pair"; requestId: string; pairId: string; forget?: boolean; force?: boolean }
  | { type: "list_pairs"; requestId: string };

export type ControlServerMessage =
  | { type: "codex_to_claude"; chatId?: string; message: BridgeMessage }
  | {
      type: "claude_to_codex_result";
      requestId: string;
      success: boolean;
      error?: string;
    }
  | { type: "status"; status: DaemonStatus }
  // STM v2.3 §D6 P3 — typed claude_connect response so bridges can surface
  // strict-pair failures as a user-visible disabled state.
  | {
      type: "claude_connect_result";
      requestId?: string;
      ok: true;
      chatId: string;
      homePairId: string | null;
      paired: boolean;
    }
  | {
      type: "claude_connect_result";
      requestId?: string;
      ok: false;
      error: Extract<PairErrorCode, "INVALID_PAIR_NAME" | "PAIR_NOT_FOUND" | "PAIR_BUSY">;
      message: string;
    }
  // STM v2.3 §D6 P3 — pair management responses.
  | {
      type: "pair_ensured";
      requestId: string;
      pairId: string;
      appServerUrl: string;
      proxyUrl: string;
      isLive: true;
    }
  | {
      type: "pair_destroyed";
      requestId: string;
      pairId: string;
      wasLive: boolean;
      registryEntryRemoved: boolean;
    }
  | {
      type: "pair_list";
      requestId: string;
      pairs: PairStatus[];
    }
  | {
      type: "pair_error";
      requestId: string;
      pairId: string;
      code: PairErrorCode;
      message: string;
      details?: PairErrorDetails;
    };

/** WebSocket close code sent by the daemon when a newer Claude session replaces the current one. */
export const CLOSE_CODE_REPLACED = 4001;
