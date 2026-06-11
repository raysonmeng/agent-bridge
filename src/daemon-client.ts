import { EventEmitter } from "node:events";
import type { BridgeMessage } from "./types";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
  CLOSE_CODE_PAIR_MISMATCH,
  CLOSE_CODE_TOKEN_MISMATCH,
  CLOSE_CODE_CONTRACT_MISMATCH,
} from "./control-protocol";
import type { ControlClientIdentity, ControlClientMessage, ControlServerMessage, DaemonStatus, TurnPhase } from "./control-protocol";
import { CLIENT_REPLY_TIMEOUT_MS } from "./interrupt-timing";
import { PendingRequestRegistry } from "./pending-request-registry";

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
  // Reply waiter: id-keyed pending-request registry. RESOLVE-ONLY semantics —
  // a timeout, a daemon result, and a connection drop all RESOLVE the promise
  // with a SendReplyResult (success or failure); none of them reject. The
  // CLIENT_REPLY_TIMEOUT_MS timer is intentionally ref'd (registry default),
  // matching the prior raw setTimeout.
  private pendingReplies = new PendingRequestRegistry<SendReplyResult>();
  // Event-style waiters (attach-status / probe-incumbent). Keyed by the control
  // message TYPE we are awaiting ("status" / "incumbent_status") — safe because
  // these requests never race the same type on one connection (attach reconnect
  // is serialized by bridge.ts's reconnectTask + disabledRecoveryInFlight guards;
  // probeIncumbent runs once per short-lived DaemonClient). Distinct types use
  // distinct keys, so a concurrent attach+probe would still be independent.
  // RESOLVE-ONLY: every exit path (typed response, disconnect, rejected,
  // timeout, send throw) RESOLVES with a per-site fail-open / success value;
  // none reject. Timers are ref'd (registry default), matching the prior raw
  // setTimeout in both waiters.
  private pendingEventWaiters = new PendingRequestRegistry<unknown>();

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

    // Fail-OPEN to null on timeout / disconnect / rejected close / send throw,
    // so a hung or contesting daemon lets the caller proceed (the daemon's own
    // admission probe at attach time is the backstop). Resolves the actual
    // DaemonStatus when the daemon confirms the attach via a `status` event.
    return this.awaitTypedResponse<DaemonStatus | null>({
      key: "status",
      successEvent: "status",
      successValue: (status: DaemonStatus) => status,
      failValue: null,
      timeoutMs,
      send: () => this.attachClaude(),
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

    // Fail-OPEN to {connected:false, alive:false} on timeout, a closed socket,
    // a rejected close, a send throw, or an older daemon that stays silent —
    // so the conflict guard never blocks a legitimate launch on a probe
    // failure (admission #68 is the backstop). Resolves the daemon's reported
    // incumbent state when it answers via an `incumbentStatus` event.
    return this.awaitTypedResponse<{ connected: boolean; alive: boolean }>({
      key: "incumbent_status",
      successEvent: "incumbentStatus",
      successValue: (s: { connected: boolean; alive: boolean }) => s,
      failValue: { connected: false, alive: false },
      timeoutMs,
      send: () => this.send({ type: "probe_incumbent" }),
    });
  }

  /**
   * Shared skeleton for the two event-style request/response waiters
   * (attach-status, probe-incumbent). Each waiter sends a control message and
   * awaits a single typed response, with RESOLVE-ONLY fail-open semantics on
   * timeout / disconnect / rejected close / send throw.
   *
   * The `PendingRequestRegistry` owns the timer + idempotent settle bookkeeping
   * (keyed by the awaited message `key`). This helper additionally wires the
   * EventEmitter listeners the registry does not manage: the success event maps
   * to `settle(key, successValue)`, while `disconnect` / `rejected` settle the
   * fail value. Listeners are removed on EVERY settle path via the promise's
   * `finally`, so no path leaks a listener — equivalent to the prior per-waiter
   * `cleanup()` that ran on its single `settled` transition.
   *
   * NOTE on key collision: `key` is the awaited message TYPE. attach uses
   * "status" and probe uses "incumbent_status" (distinct), and same-type calls
   * never run concurrently on one connection (see `pendingEventWaiters` doc), so
   * the registry's id→entry map never overwrites a live waiter here.
   */
  private awaitTypedResponse<T>(opts: {
    key: string;
    successEvent: "status" | "incumbentStatus";
    successValue: (payload: any) => T;
    failValue: T;
    timeoutMs: number;
    send: () => void;
  }): Promise<T> {
    const { key, successEvent, successValue, failValue, timeoutMs, send } = opts;

    const onSuccess = (payload: any) => {
      this.pendingEventWaiters.settle(key, successValue(payload));
    };
    const onRejected = () => {
      this.pendingEventWaiters.settle(key, failValue);
    };
    const onDisconnect = () => {
      this.pendingEventWaiters.settle(key, failValue);
    };

    const pending = this.pendingEventWaiters.register(key, {
      timeoutMs,
      onTimeout: ({ resolve }) => resolve(failValue),
    }) as Promise<T>;

    // Remove listeners on every settle path (success / disconnect / rejected /
    // timeout / send-throw). registry.settle and the timeout both resolve the
    // promise, so `finally` is the single cleanup site — matching the prior
    // idempotent `cleanup()`.
    const cleanup = () => {
      this.off(successEvent, onSuccess);
      this.off("rejected", onRejected);
      this.off("disconnect", onDisconnect);
    };
    pending.finally(cleanup);

    this.on(successEvent, onSuccess);
    this.on("rejected", onRejected);
    this.on("disconnect", onDisconnect);

    try {
      send();
    } catch {
      this.pendingEventWaiters.settle(key, failValue);
    }

    return pending;
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
    // CLIENT_REPLY_TIMEOUT_MS applies to the daemon's IMMEDIATE result. The
    // interrupt path can legitimately defer the result until the daemon-side
    // terminal-wait budget elapses — that budget is CLAMPED below this value
    // (see interrupt-timing.ts: clampInterruptTimeoutMs), so the daemon always
    // answers before this timer fires. INVARIANT: do not shrink this timeout
    // without also lowering MAX_INTERRUPT_TIMEOUT_MS, or an over-large
    // AGENTBRIDGE_INTERRUPT_TIMEOUT_MS could outlast it and a false timeout +
    // Claude retry would double-turn.
    const pending = this.pendingReplies.register(requestId, {
      timeoutMs: CLIENT_REPLY_TIMEOUT_MS,
      onTimeout: ({ resolve }) =>
        resolve({ success: false, error: "Timed out waiting for AgentBridge daemon reply." }),
    });
    this.send({
      type: "claude_to_codex",
      requestId,
      message,
      ...(requireReply ? { requireReply: true } : {}),
      ...(onBusy && onBusy !== "reject" ? { onBusy } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return pending;
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
          // Pass the PR B structured fields through when the daemon sent them
          // (older daemons only populate success/error). settle() is a no-op for
          // an unknown / already-settled requestId — same guard as the prior
          // `if (!pending) return`.
          this.pendingReplies.settle(message.requestId, {
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
          event.code === CLOSE_CODE_TOKEN_MISMATCH ||
          event.code === CLOSE_CODE_CONTRACT_MISMATCH
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
    // RESOLVE-ONLY teardown: every in-flight reply resolves with a failure
    // value (never rejects), matching the prior per-entry resolve(). Use the
    // factory form so each settled promise gets its OWN result object, exactly
    // as the old per-entry literal did (no shared reference across callers).
    this.pendingReplies.settleAll(() => ({ success: false, error }));
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
