import { EventEmitter } from "node:events";
import type { BridgeMessage } from "./types";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";

interface DaemonClientEvents {
  codexMessage: [BridgeMessage];
  disconnect: [];
  rejected: [];
  status: [DaemonStatus];
}

let nextSocketId = 0;

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private ws: WebSocket | null = null;
  private wsId: number = 0; // Track socket identity for debugging
  private nextRequestId = 1;
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: { success: boolean; error?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /**
   * STM v2.3 §D4 / §D6 P4-cleanup: pending attachClaude promises waiting
   * on `claude_connect_result`. Separate from `pendingReplies` because
   * the response shape is discriminated (ok=true vs ok=false) and
   * different from `claude_to_codex_result`.
   */
  private pendingAttachReplies = new Map<
    string,
    {
      resolve: (value:
        | { ok: true; homePairId: string | null; paired: boolean }
        | { ok: false; error: string; message: string }
      ) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private chatId: string | undefined;
  /**
   * STM v2.3 §D4 P4b: optional explicit pair binding. Read from
   * `AGENTBRIDGE_PAIR` env at bridge.ts startup and forwarded to the
   * daemon's `attachClaude` via the `claude_connect` control message.
   * The daemon validates per D1 / D4 and responds with a typed
   * `claude_connect_result` (PAIR_NOT_FOUND / PAIR_BUSY / ok=true).
   */
  private pairId: string | undefined;

  constructor(
    private readonly url: string,
    opts?: { chatId?: string; pairId?: string },
  ) {
    super();
    this.chatId = opts?.chatId;
    this.pairId = opts?.pairId;
  }

  setChatId(chatId: string) {
    this.chatId = chatId;
  }

  setPairId(pairId: string | undefined) {
    this.pairId = pairId;
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

  /**
   * STM v2.3 §D4 / §D6 P4-cleanup: send `claude_connect` and await the
   * typed `claude_connect_result` (Codex P4 review codex_msg_5753c73beafc_123
   * HIGH#2). Returns the daemon's verdict so bridge.ts can enter a
   * disabled state on PAIR_NOT_FOUND / PAIR_BUSY / INVALID_PAIR_NAME
   * instead of silently claiming "bridge ready" after a fire-and-forget
   * attach. Falls through to {ok:true} after a short timeout against
   * an older daemon that doesn't emit the typed result (so v2.2 bridges
   * keep working).
   */
  async attachClaude(timeoutMs = 5000): Promise<
    | { ok: true; homePairId: string | null; paired: boolean }
    | { ok: false; error: string; message: string }
  > {
    const requestId = `attach_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAttachReplies.delete(requestId);
        // Old daemon (or test fixture) didn't reply with a typed
        // claude_connect_result — assume success for backwards-compat.
        resolve({ ok: true, homePairId: null, paired: false });
      }, timeoutMs);
      this.pendingAttachReplies.set(requestId, { resolve, timer });
      this.send({
        type: "claude_connect",
        requestId,
        chatId: this.chatId,
        pairId: this.pairId,
      });
    });
  }

  async disconnect() {
    if (!this.ws) return;

    try {
      this.send({ type: "claude_disconnect", chatId: this.chatId });
    } catch {}

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
    this.rejectPendingReplies("Daemon connection closed");
  }

  async sendReply(message: BridgeMessage, requireReply?: boolean): Promise<{ success: boolean; error?: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: "AgentBridge daemon is not connected." };
    }

    const requestId = `reply_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ success: false, error: "Timed out waiting for AgentBridge daemon reply." });
      }, 15000);

      this.pendingReplies.set(requestId, { resolve, timer });
      this.send({
        type: "claude_to_codex",
        requestId,
        chatId: this.chatId,
        message,
        ...(requireReply ? { requireReply: true } : {}),
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
          pending.resolve({ success: message.success, error: message.error });
          return;
        }
        case "claude_connect_result": {
          // STM v2.3 §D6 P4-cleanup: resolve the matching pending attach
          // promise. requestId may be absent for old-style callers (no
          // pending entry → drop).
          if (!message.requestId) return;
          const pending = this.pendingAttachReplies.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingAttachReplies.delete(message.requestId);
          if (message.ok) {
            pending.resolve({
              ok: true,
              homePairId: message.homePairId,
              paired: message.paired,
            });
          } else {
            pending.resolve({
              ok: false,
              error: message.error,
              message: message.message,
            });
          }
          return;
        }
        case "status":
          this.emit("status", message.status);
          return;
      }
    };

    ws.onclose = (event) => {
      const isCurrent = this.ws === ws;
      this.log(`ws#${socketId} onclose (code=${event.code}, reason=${event.reason || "none"}, isCurrent=${isCurrent}, currentWsId=${this.wsId})`);
      if (isCurrent) {
        this.ws = null;
        this.rejectPendingReplies("AgentBridge daemon disconnected.");
        if (event.code === CLOSE_CODE_REPLACED) {
          this.emit("rejected");
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
    // STM v2.3 §D6 P4-cleanup (Codex P4 final re-pass codex_msg_5753c73beafc_128):
    // also drain pending attach promises so a close-before-response does
    // not silently timeout-to-ok after the daemon is gone. Resolves with
    // ok=false carrying a synthetic DAEMON_SHUTTING_DOWN code so callers
    // (bridge.ts) enter the disabled-state path uniformly.
    for (const [requestId, pending] of this.pendingAttachReplies.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: "DAEMON_SHUTTING_DOWN",
        message: `claude_connect interrupted: ${error}`,
      });
      this.pendingAttachReplies.delete(requestId);
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
