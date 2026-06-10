import { EventEmitter } from "node:events";
import type { BridgeMessage } from "./types";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
  CLOSE_CODE_PAIR_MISMATCH,
  CLOSE_CODE_TOKEN_MISMATCH,
} from "./control-protocol";
import type { ControlClientIdentity, ControlClientMessage, ControlServerMessage, DaemonStatus, TurnPhase } from "./control-protocol";
import { CLIENT_REPLY_TIMEOUT_MS } from "./interrupt-timing";

/**
 * Result of a claude_to_codex round trip. `code` / `phase` / `retryAfterMs`
 * are the protocol v2 PR B structured fields (populated by newer daemons
 * alongside the legacy error string; absent against older daemons).
 */
export interface SendReplyResult {
  success: boolean;
  error?: string;
  code?: string;
  phase?: TurnPhase;
  retryAfterMs?: number;
}

interface DaemonClientEvents {
  codexMessage: [BridgeMessage];
  disconnect: [];
  rejected: [number];
  status: [DaemonStatus];
  incumbentStatus: [{ connected: boolean; alive: boolean }];
  /** turn_started ACK (protocol v2 PR B): a bridge-injected turn was confirmed started. */
  turnStarted: [{ requestId: string; idempotencyKey?: string; threadId: string; turnId: string }];
}

let nextSocketId = 0;

export interface DaemonClientOptions {
  /**
   * Client identity sent in `claude_connect`. Either a fixed object or a
   * resolver evaluated on EACH attach. A resolver is required for the
   * capability token (arch-review P1 #283): the token file is written by the
   * daemon and may not exist when the client is constructed, so it must be read
   * lazily at attach time, AND re-read on reconnect after a daemon restart
   * rotates the token.
   */
  identity?: ControlClientIdentity | (() => ControlClientIdentity);
}

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private ws: WebSocket | null = null;
  private wsId: number = 0; // Track socket identity for debugging
  private nextRequestId = 1;
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: SendReplyResult) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly url: string, private readonly options: DaemonClientOptions = {}) {
    super();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log(`connect() skipped — ws#${this.wsId} already OPEN`);
      return;
    }

    // Close any lingering socket in non-OPEN state to avoid orphans
    if (this.ws) {
      const state = this.ws.readyState;
      this.log(`connect() closing lingering ws#${this.wsId} (readyState=${state})`);
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const socketId = ++nextSocketId;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;

      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        this.wsId = socketId;
        this.attachSocketHandlers(ws, socketId);
        this.log(`ws#${socketId} opened and attached`);
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to connect to AgentBridge daemon at ${this.url}`));
      };

      ws.onclose = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`AgentBridge daemon closed the connection during startup (${this.url})`));
      };
    });
  }

  attachClaude() {
    const identity = this.resolveIdentity();
    this.send({
      type: "claude_connect",
      ...(identity ? { identity } : {}),
    });
  }

  /**
   * Resolve the identity for this attach. A function option is evaluated NOW
   * (lazily, per attach) so the capability token is read fresh from disk —
   * critical because the daemon may not have written the token when this client
   * was constructed, and a daemon restart rotates it (arch-review P1 #283).
   */
  private resolveIdentity(): ControlClientIdentity | undefined {
    const opt = this.options.identity;
    return typeof opt === "function" ? opt() : opt;
  }

  async attachClaudeAndWaitForStatus(timeoutMs = 1000): Promise<DaemonStatus | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return null;
    }

    return await new Promise<DaemonStatus | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.off("status", onStatus);
        this.off("rejected", onRejected);
        this.off("disconnect", onDisconnect);
      };

      const finish = (value: DaemonStatus | null) => {
        cleanup();
        resolve(value);
      };

      const onStatus = (status: DaemonStatus) => finish(status);
      const onRejected = () => finish(null);
      const onDisconnect = () => finish(null);

      this.on("status", onStatus);
      this.on("rejected", onRejected);
      this.on("disconnect", onDisconnect);

      timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);

      try {
        this.attachClaude();
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Ask the daemon whether it already has a LIVE Claude frontend attached,
   * WITHOUT attaching this socket (so it never contests the incumbent).
   *
   * Fail-OPEN: on timeout, a closed socket, or an older daemon that doesn't
   * understand `probe_incumbent` (it stays silent), this resolves to
   * `{ connected:false, alive:false }` so the conflict guard never blocks a
   * legitimate launch on a probe failure — admission (#68) is the backstop.
   */
  async probeIncumbent(timeoutMs = 3000): Promise<{ connected: boolean; alive: boolean }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { connected: false, alive: false };
    }

    return await new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (value: { connected: boolean; alive: boolean }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.off("incumbentStatus", onStatus);
        this.off("disconnect", onDisconnect);
        this.off("rejected", onRejected);
        resolve(value);
      };

      const onStatus = (s: { connected: boolean; alive: boolean }) => finish(s);
      const onDisconnect = () => finish({ connected: false, alive: false });
      const onRejected = () => finish({ connected: false, alive: false });

      this.on("incumbentStatus", onStatus);
      this.on("disconnect", onDisconnect);
      this.on("rejected", onRejected);

      timer = setTimeout(() => finish({ connected: false, alive: false }), timeoutMs);

      try {
        this.send({ type: "probe_incumbent" });
      } catch {
        finish({ connected: false, alive: false });
      }
    });
  }

  async disconnect() {
    if (!this.ws) return;

    try {
      this.send({ type: "claude_disconnect" });
    } catch {}

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
    this.rejectPendingReplies("Daemon connection closed");
  }

  async sendReply(
    message: BridgeMessage,
    requireReply?: boolean,
    onBusy?: "reject" | "steer" | "interrupt",
    idempotencyKey?: string,
  ): Promise<SendReplyResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: "AgentBridge daemon is not connected." };
    }

    const requestId = `reply_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      // CLIENT_REPLY_TIMEOUT_MS applies to the daemon's IMMEDIATE result. The
      // interrupt path can legitimately defer the result until the daemon-side
      // terminal-wait budget elapses — that budget is CLAMPED below this value
      // (see interrupt-timing.ts: clampInterruptTimeoutMs), so the daemon always
      // answers before this timer fires. INVARIANT: do not shrink this timeout
      // without also lowering MAX_INTERRUPT_TIMEOUT_MS, or an over-large
      // AGENTBRIDGE_INTERRUPT_TIMEOUT_MS could outlast it and a false timeout +
      // Claude retry would double-turn.
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ success: false, error: "Timed out waiting for AgentBridge daemon reply." });
      }, CLIENT_REPLY_TIMEOUT_MS);

      this.pendingReplies.set(requestId, { resolve, timer });
      this.send({
        type: "claude_to_codex",
        requestId,
        message,
        ...(requireReply ? { requireReply: true } : {}),
        ...(onBusy && onBusy !== "reject" ? { onBusy } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    });
  }

  private attachSocketHandlers(ws: WebSocket, socketId: number) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();

      let message: ControlServerMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      switch (message.type) {
        case "codex_to_claude":
          this.emit("codexMessage", message.message);
          return;
        case "claude_to_codex_result": {
          const pending = this.pendingReplies.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingReplies.delete(message.requestId);
          // Pass the PR B structured fields through when the daemon sent them
          // (older daemons only populate success/error).
          pending.resolve({
            success: message.success,
            error: message.error,
            ...(message.code !== undefined ? { code: message.code } : {}),
            ...(message.phase !== undefined ? { phase: message.phase } : {}),
            ...(message.retryAfterMs !== undefined ? { retryAfterMs: message.retryAfterMs } : {}),
          });
          return;
        }
        case "turn_started":
          this.emit("turnStarted", {
            requestId: message.requestId,
            ...(message.idempotencyKey !== undefined ? { idempotencyKey: message.idempotencyKey } : {}),
            threadId: message.threadId,
            turnId: message.turnId,
          });
          return;
        case "status":
          this.emit("status", message.status);
          return;
        case "incumbent_status":
          this.emit("incumbentStatus", { connected: message.connected, alive: message.alive });
          return;
      }
    };

    ws.onclose = (event) => {
      const isCurrent = this.ws === ws;
      this.log(`ws#${socketId} onclose (code=${event.code}, reason=${event.reason || "none"}, isCurrent=${isCurrent}, currentWsId=${this.wsId})`);
      if (isCurrent) {
        this.ws = null;
        this.rejectPendingReplies("AgentBridge daemon disconnected.");
        if (
          event.code === CLOSE_CODE_REPLACED ||
          event.code === CLOSE_CODE_EVICTED_STALE ||
          event.code === CLOSE_CODE_PROBE_IN_PROGRESS ||
          event.code === CLOSE_CODE_PAIR_MISMATCH ||
          event.code === CLOSE_CODE_TOKEN_MISMATCH
        ) {
          this.emit("rejected", event.code);
        } else {
          this.emit("disconnect");
        }
      }
      // If this.ws !== ws, this socket was replaced by a newer connection —
      // don't emit "disconnect" or it will trigger a reconnect loop.
    };

    ws.onerror = () => {
      // The close handler is the single place that tears down pending state.
    };
  }

  private rejectPendingReplies(error: string) {
    for (const [requestId, pending] of this.pendingReplies.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
      this.pendingReplies.delete(requestId);
    }
  }

  private send(message: ControlClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("AgentBridge daemon socket is not open.");
    }

    this.ws.send(JSON.stringify(message));
  }

  private log(msg: string) {
    process.stderr.write(`[${new Date().toISOString()}] [DaemonClient] ${msg}\n`);
  }
}
