import type { ServerWebSocket } from "bun";
import type { BridgeMessage } from "./types";
import type { ControlClientIdentity, ControlServerMessage } from "./control-protocol";
import { BoundedMessageBuffer } from "./delivery-buffer";
import { probeLiveness as probeLivenessImpl } from "./liveness-probe";

/** WebSocket.OPEN. */
const OPEN = 1;

/**
 * Per-socket state carried on `ws.data` for every control-WS connection.
 *
 * Lives here (not in daemon.ts) because it is intrinsically tied to
 * {@link ConnectionSession}: the session wraps a `ServerWebSocket<ControlSocketData>`
 * and `ControlSocketData.session` points back at it. Keeping both in one file
 * avoids a daemon↔session circular type import. The shape is unchanged from the
 * prior daemon-local interface.
 */
export interface ControlSocketData {
  clientId: number;
  attached: boolean;
  /** Wall-clock of the last pong (used only for the contest diagnostic log). */
  lastPongAt: number;
  /** Monotonic pong counter — the liveness probe's source of truth (see liveness-probe.ts). */
  pongCount: number;
  identity?: ControlClientIdentity;
  /**
   * Bridge messages ws.send() returned -1 for: enqueued in Bun's socket buffer
   * under backpressure, NOT yet on the wire. Bun discards that buffer if the
   * socket closes before `drain` fires, so these are re-buffered at detach for
   * redelivery on reconnect (at-least-once: a pre-close partial flush can
   * produce a duplicate; silent loss cannot).
   */
  pendingBackpressure: BoundedMessageBuffer;
  /** The behaviour wrapper over this socket. Set in the WS `open` handler. */
  session?: ConnectionSession;
}

export interface ConnectionSessionDeps {
  log: (msg: string) => void;
  /** Poll interval for the liveness probe (LIVENESS_PROBE_POLL_MS). */
  livenessPollMs: number;
}

/**
 * §2.1 session layer: a thin behaviour wrapper over one live control socket.
 *
 * Owns only per-socket MECHANICS (send / protocol-send / liveness probe / pong
 * bookkeeping / backpressure rebuffer). Holds no membership or pairing state —
 * that is AgentRegistry/RoomManager's job. Bodies are moved verbatim from the
 * prior daemon module functions so behaviour is bit-identical; the daemon keeps
 * the old function names as one-line delegators to `ws.data.session`.
 */
export class ConnectionSession {
  constructor(
    readonly ws: ServerWebSocket<ControlSocketData>,
    private readonly deps: ConnectionSessionDeps,
  ) {}

  get clientId(): number {
    return this.ws.data.clientId;
  }
  get identity(): ControlClientIdentity | undefined {
    return this.ws.data.identity;
  }
  set identity(v: ControlClientIdentity | undefined) {
    this.ws.data.identity = v;
  }
  get readyState(): number {
    return this.ws.readyState;
  }
  /** True iff the socket is OPEN (readyState === WebSocket.OPEN). */
  get isOpen(): boolean {
    return this.ws.readyState === OPEN;
  }
  get attached(): boolean {
    return this.ws.data.attached;
  }
  /** Wall-clock of the last pong (contest diagnostic only). */
  get lastPongAt(): number {
    return this.ws.data.lastPongAt;
  }
  get pongCount(): number {
    return this.ws.data.pongCount;
  }
  get pendingBackpressureSize(): number {
    return this.ws.data.pendingBackpressure.length;
  }

  markAttached(value: boolean): void {
    this.ws.data.attached = value;
  }

  /** Record a pong: refresh the diagnostic timestamp and advance the probe counter. */
  recordPong(): void {
    this.ws.data.lastPongAt = Date.now();
    this.ws.data.pongCount++;
  }

  /**
   * Send a bridge message to this socket. Returns false ONLY on a dropped send
   * (result 0) or a throw; -1 (backpressure) is success — the message IS enqueued
   * and is tracked in pendingBackpressure so detach can re-buffer it. (Treating
   * -1 as failure would re-buffer an already-queued message and deliver twice.)
   */
  send(message: BridgeMessage): boolean {
    try {
      const result = this.ws.send(
        JSON.stringify({ type: "codex_to_claude", message } satisfies ControlServerMessage),
      );
      if (typeof result === "number" && result === 0) {
        this.deps.log("Bridge message send returned 0 (dropped)");
        return false;
      }
      if (typeof result === "number" && result === -1) {
        // Enqueued but not on the wire: Bun owns the bytes until `drain`
        // confirms delivery, and drops them if the socket closes first. Track
        // the message so detach can re-buffer it for the next attach.
        this.ws.data.pendingBackpressure.push(message);
      }
      return true;
    } catch (err: any) {
      this.deps.log(`Failed to send bridge message: ${err.message}`);
      return false;
    }
  }

  /**
   * Send a request-scoped control message. A dropped send (socket closed) is
   * NOT retried — the client's pending request has already timed out — but it is
   * logged so a dropped claude_to_codex_result leaves a trail.
   */
  sendProtocol(message: ControlServerMessage): void {
    try {
      const result = this.ws.send(JSON.stringify(message));
      if (typeof result === "number" && result === 0) {
        this.deps.log(`Control message dropped (socket closed): type=${message.type}`);
      }
    } catch (err: any) {
      this.deps.log(`Failed to send control message: ${err.message}`);
    }
  }

  /** Send a WS ping frame. May throw synchronously on a failed write. */
  ping(): void {
    this.ws.ping();
  }

  /**
   * Probe this socket for liveness (challenge-on-contest / probe_incumbent).
   * Resolves true iff a NEW pong is observed within `timeoutMs` (see
   * liveness-probe.ts for the counter-not-timestamp rationale).
   */
  probeLiveness(timeoutMs: number): Promise<boolean> {
    const ws = this.ws;
    return probeLivenessImpl(
      {
        get readyState() {
          return ws.readyState;
        },
        get pongCount() {
          return ws.data.pongCount;
        },
        ping: () => {
          ws.ping();
        },
      },
      { timeoutMs, pollMs: this.deps.livenessPollMs },
    );
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  /**
   * Move this socket's backpressured messages into the room backlog for
   * redelivery on reconnect (detach path). Prepends (they predate everything
   * already buffered) via BoundedMessageBuffer.unshiftMany. Returns the count
   * moved (for the log line).
   */
  drainPendingBackpressureInto(backlog: BoundedMessageBuffer): number {
    const reBuffered = this.ws.data.pendingBackpressure.drainAll();
    backlog.unshiftMany(reBuffered);
    return reBuffered.length;
  }

  /**
   * Drain-handler confirmation: clear tracked backpressure ONLY when the socket
   * buffer is fully empty. After a partial drain the tail can still be lost on
   * close, and a duplicate beats silent loss, so we keep tracking until empty.
   */
  confirmDrainIfFlushed(): void {
    if (this.ws.data.pendingBackpressure.length > 0 && this.ws.getBufferedAmount() === 0) {
      this.ws.data.pendingBackpressure.clear();
    }
  }
}
