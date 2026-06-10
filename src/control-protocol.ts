import type { BridgeMessage } from "./types";
import type { AgentBridgeBuildInfo } from "./build-info";
import type { BudgetSnapshot } from "./budget/types";

export interface ControlClientIdentity {
  pairId?: string | null;
  pairName?: string | null;
  cwd?: string;
  baseDir?: string | null;
  stateDir?: string | null;
  clientPid?: number;
  contractVersion?: number;
}

/**
 * Codex turn lifecycle phase (collaboration-protocol v2, PR A).
 * STRICTLY the turn lifecycle — the bridge's routing/attention window is a
 * separate axis (attentionWindowActive). `aborted` means the LAST turn ended
 * abnormally and no new turn has started since.
 */
export type TurnPhase = "idle" | "running" | "stalled" | "aborted";

export interface DaemonStatus {
  bridgeReady: boolean;
  tuiConnected: boolean;
  threadId: string | null;
  queuedMessageCount: number;
  proxyUrl: string;
  appServerUrl: string;
  pid: number;
  /** Multi-pair identity for diagnostics; null in legacy/manual single-pair mode. */
  pairId?: string | null;
  cwd?: string | null;
  stateDir?: string | null;
  build?: AgentBridgeBuildInfo;
  /** Latest budget coordination snapshot; absent when budget sensing is unavailable/disabled. */
  budget?: BudgetSnapshot;
  /**
   * Whether a Codex turn is currently executing. Exposed on BOTH /healthz and
   * status.json (kept in sync so the two payloads don't drift) so the TUI
   * wrapper can classify a clean exit as exit_0_during_turn vs exit_0_idle at
   * the moment the TUI dies (issue #102).
   *
   * COMPAT: kept for one version as the mapping `turnPhase ∈ {running,stalled}`.
   * New consumers should read turnPhase.
   */
  turnInProgress?: boolean;
  /** Codex turn lifecycle phase (protocol v2 PR A). */
  turnPhase?: TurnPhase;
  /**
   * Whether the bridge's attention window is open (STATUS messages buffered to
   * give Claude space to respond). A routing-layer axis, deliberately NOT part
   * of turnPhase.
   */
  attentionWindowActive?: boolean;
}

export type ControlClientMessage =
  | { type: "claude_connect"; identity?: ControlClientIdentity }
  | { type: "claude_disconnect" }
  | {
      type: "claude_to_codex";
      requestId: string;
      message: BridgeMessage;
      requireReply?: boolean;
      /**
       * Busy-turn policy (protocol v2 B0). "reject" (default): fail with the
       * busy error when a Codex turn is running. "steer": feed the message
       * into the RUNNING turn via turn/steer — Codex sees it mid-turn without
       * losing work. ("interrupt" lands with PR B's ACK/idempotency machinery.)
       */
      onBusy?: "reject" | "steer";
    }
  | { type: "status" }
  // Non-attaching probe: ask the daemon whether it already has a LIVE Claude
  // frontend attached, WITHOUT contesting/attaching this socket. Used by the
  // `abg claude` CLI conflict guard so a second session in the same pair errors
  // out up front instead of evicting a live incumbent (issue #68 admission still
  // arbitrates the authoritative live/stale decision at actual attach time).
  | { type: "probe_incumbent" };

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "status"; status: DaemonStatus }
  // Reply to `probe_incumbent`. `connected` = a Claude frontend socket is
  // currently attached; `alive` = it responded to a liveness ping (a half-open
  // dead incumbent reports connected:true, alive:false → safe to take over).
  | { type: "incumbent_status"; connected: boolean; alive: boolean };

/** WebSocket close code sent by the daemon when a newer Claude session replaces the current one. */
export const CLOSE_CODE_REPLACED = 4001;

/**
 * WebSocket close code sent by the daemon when it evicts a stale Claude frontend
 * that failed to respond to a liveness probe. Used by challenge-on-contest admission
 * so a newer session can take over when the OS never surfaced FIN on a dead peer.
 */
export const CLOSE_CODE_EVICTED_STALE = 4002;

/**
 * WebSocket close code sent by the daemon when a contestant arrives while a
 * liveness probe is already in flight against the incumbent. Distinct from
 * CLOSE_CODE_REPLACED so the contestant's UI can suggest retrying shortly
 * (the in-flight probe will conclude within LIVENESS_PROBE_TIMEOUT_MS).
 */
export const CLOSE_CODE_PROBE_IN_PROGRESS = 4003;

/** WebSocket close code reserved for pair/cwd identity mismatch enforcement. */
export const CLOSE_CODE_PAIR_MISMATCH = 4004;
