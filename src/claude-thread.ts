/**
 * ClaudeThread — one dedicated Codex thread per attached Claude session.
 *
 * Each Claude session gets its own WebSocket to the codex app-server and
 * its own thread. Turns on different threads execute concurrently in the
 * app-server (verified by `tools/agentbridge-multi/probes/concurrency.ts`).
 *
 * Lifecycle: bootstrap() opens the WS, runs initialize + thread/start, then
 * emits "ready" with the threadId. injectMessage() sends turn/start on this
 * thread. Notifications from codex are filtered to this threadId and
 * surfaced via "agentMessage" / "turnStarted" / "turnCompleted" events so
 * the daemon can route them back to the owning Claude WS by chatId.
 *
 * This is intentionally a LEAN adapter — no proxy, no TUI reconnect dance.
 * For TUI flow see `codex-adapter.ts`.
 */

import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import type { AppServerItem } from "./app-server-protocol";
import type { BridgeMessage } from "./types";

export interface ClaudeThreadOptions {
  appServerUrl: string;
  chatId: string;
  logFile: string;
  cwd?: string;
}

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 30_000;

export class ClaudeThread extends EventEmitter {
  readonly chatId: string;
  private readonly appServerUrl: string;
  private readonly logFile: string;
  private readonly cwd: string | undefined;

  private ws: WebSocket | null = null;
  private threadId: string | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private turnInProgress = false;
  private agentMessageBuffers = new Map<string, string[]>();
  private bootstrapped = false;
  private closed = false;

  constructor(opts: ClaudeThreadOptions) {
    super();
    this.chatId = opts.chatId;
    this.appServerUrl = opts.appServerUrl;
    this.logFile = opts.logFile;
    this.cwd = opts.cwd;
  }

  get activeThreadId(): string | null { return this.threadId; }
  get isTurnInProgress(): boolean { return this.turnInProgress; }
  get isReady(): boolean { return this.bootstrapped && this.threadId !== null; }

  /** Open the WS, initialize, and start a thread. Resolves once ready. */
  async bootstrap(): Promise<string> {
    if (this.bootstrapped && this.threadId) return this.threadId;
    await this.openSocket();
    await this.callRpc("initialize", {
      clientInfo: { name: "agentbridge-claude-thread", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    // Use approvalPolicy="never" so Codex never escalates approvals to us.
    // Sandbox boundaries still apply; if a command can't run under the
    // configured sandbox it fails as a turn error rather than triggering an
    // interactive approval flow we have no UI to satisfy. Approval-method
    // server requests are still handled below as a defense-in-depth fallback.
    const params: Record<string, unknown> = { approvalPolicy: "never" };
    if (this.cwd) params.cwd = this.cwd;
    const startRes: any = await this.callRpc("thread/start", params);
    const tid = startRes?.thread?.id ?? startRes?.threadId ?? null;
    if (typeof tid !== "string" || tid.length === 0) {
      throw new Error("thread/start did not return a threadId");
    }
    this.threadId = tid;
    this.bootstrapped = true;
    this.log(`bootstrap ok threadId=${tid}`);
    this.emit("ready", tid);
    return tid;
  }

  /** Send a turn/start on this thread. Returns true on send success. */
  injectMessage(text: string): boolean {
    if (!this.threadId) {
      this.log("inject rejected: not bootstrapped");
      return false;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("inject rejected: ws not open");
      return false;
    }
    if (this.turnInProgress) {
      this.log(`inject rejected: turn already in progress`);
      return false;
    }
    const id = this.nextId++;
    const msg = {
      jsonrpc: "2.0",
      id,
      method: "turn/start",
      params: {
        threadId: this.threadId,
        input: [{ type: "text", text }],
      },
    };
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err: any) {
      this.log(`inject send failed: ${err.message}`);
      return false;
    }
  }

  /** Close the WS. Does NOT delete the thread on the server side (could be resumed). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ClaudeThread closed"));
    }
    this.pending.clear();
  }

  // ── internals ──────────────────────────────────────────────

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.appServerUrl);
      let settled = false;
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        this.ws = ws;
        this.attachHandlers(ws);
        resolve();
      };
      ws.onerror = (e: any) => {
        if (settled) return;
        settled = true;
        reject(new Error(`ws connect failed: ${e?.message ?? "unknown"}`));
      };
      ws.onclose = (e: any) => {
        if (!settled) {
          settled = true;
          reject(new Error(`ws closed during handshake (code=${e?.code})`));
          return;
        }
      };
    });
  }

  private attachHandlers(ws: WebSocket) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      this.handlePayload(raw);
    };
    ws.onclose = () => {
      this.log(`ws closed (chatId=${this.chatId}, threadId=${this.threadId})`);
      this.ws = null;
      this.emit("close");
    };
    ws.onerror = (e: any) => {
      this.log(`ws error: ${e?.message ?? "unknown"}`);
      this.emit("error", e);
    };
  }

  private handlePayload(raw: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    // response to one of our rpc requests
    if (typeof parsed.id === "number" && this.pending.has(parsed.id) && (parsed.result !== undefined || parsed.error !== undefined)) {
      const pending = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(parsed.error).slice(0, 200)}`));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Server-initiated request (approvals, fuzzy file, etc.). We have no
    // interactive UI bound to this thread — and we've already set
    // approvalPolicy="never" at thread/start, so in steady state these
    // should not arrive. This block is a defense-in-depth fallback:
    //
    //   - Approval-like methods (commandExecution / fileChange) → auto-accept,
    //     since the human-equivalent for this thread is the Claude that
    //     issued the task. Sandbox boundaries already constrain what can be
    //     executed; a separate approval handshake adds no security here.
    //   - Permission-grant requests → auto-deny (grant nothing extra) so the
    //     sandbox can't be silently widened by Codex.
    //   - Anything else (future server requests we don't know) → reply with
    //     -32601 and log; surfacing a clear error is better than silently
    //     ignoring the id and leaving Codex hung waiting for a response.
    if (parsed.id !== undefined && typeof parsed.method === "string") {
      const tid = parsed.params?.threadId;
      if (tid && this.threadId && tid !== this.threadId) return;
      this.respondToServerRequest(parsed.id, parsed.method, parsed.params);
      return;
    }

    // notification (anything with method + no id)
    if (typeof parsed.method === "string" && parsed.id === undefined) {
      const tid = parsed.params?.threadId;
      if (tid && this.threadId && tid !== this.threadId) {
        // Notification for a different thread — ignore (defense in depth;
        // each ClaudeThread has its own WS so this should not happen in practice).
        return;
      }
      this.handleNotification(parsed.method as string, parsed.params ?? {});
    }
  }

  private handleNotification(method: string, params: any) {
    switch (method) {
      case "turn/started": {
        if (!this.turnInProgress) {
          this.turnInProgress = true;
          this.emit("turnStarted");
        }
        break;
      }
      case "item/started": {
        const item: AppServerItem | undefined = (params as any)?.item;
        if (item?.type === "agentMessage") this.agentMessageBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = (params as any)?.itemId;
        const delta = (params as any)?.delta;
        if (typeof itemId === "string") {
          const buf = this.agentMessageBuffers.get(itemId);
          if (buf && typeof delta === "string") buf.push(delta);
        }
        break;
      }
      case "item/completed": {
        const item: AppServerItem | undefined = (params as any)?.item;
        if (item?.type === "agentMessage") {
          const content = this.extractContent(item);
          this.agentMessageBuffers.delete(item.id);
          if (content) {
            const bridgeMsg: BridgeMessage = {
              id: item.id,
              source: "codex",
              content,
              timestamp: Date.now(),
            };
            this.emit("agentMessage", bridgeMsg);
          }
        }
        break;
      }
      case "turn/completed": {
        if (this.turnInProgress) {
          this.turnInProgress = false;
          this.emit("turnCompleted");
        }
        break;
      }
      case "turn/failed": {
        if (this.turnInProgress) {
          this.turnInProgress = false;
          this.emit("turnCompleted");
        }
        this.emit("turnFailed", params);
        break;
      }
    }
  }

  private extractContent(item: AppServerItem): string {
    if (item.content?.length) {
      return item.content.filter((c) => c.type === "text" && c.text).map((c) => c.text!).join("");
    }
    return this.agentMessageBuffers.get(item.id)?.join("") ?? "";
  }

  private callRpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("callRpc: ws not open"));
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws!.send(msg);
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Respond to a server-initiated request (Codex asking the client to
   * approve a command, file change, permission widening, etc.).
   *
   * See `ExecCommandApprovalResponse` / `CommandExecutionRequestApprovalResponse`
   * / `FileChangeRequestApprovalResponse` / `PermissionsRequestApprovalResponse`
   * in the codex app-server schema for the exact shapes.
   */
  private respondToServerRequest(
    id: number | string,
    method: string,
    _params: unknown,
  ): void {
    let result: Record<string, unknown> | undefined;
    let error: { code: number; message: string } | undefined;

    switch (method) {
      case "item/commandExecution/requestApproval":
        // CommandExecutionApprovalDecision allowed values:
        //   "accept" | "acceptForSession" | {acceptWithExecpolicyAmendment} |
        //   {applyNetworkPolicyAmendment} | "decline" | "cancel"
        result = { decision: "accept" };
        this.log(`auto-accepted ${method} (id=${id})`);
        break;
      case "item/fileChange/requestApproval":
        // FileChangeApprovalDecision: accept | acceptForSession | decline | cancel
        result = { decision: "accept" };
        this.log(`auto-accepted ${method} (id=${id})`);
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        // ReviewDecision: approved | approved_for_session | denied | timed_out | abort
        result = { decision: "approved" };
        this.log(`auto-approved ${method} (id=${id})`);
        break;
      case "item/permissions/requestApproval":
        // PermissionsRequestApprovalResponse requires `permissions`. Returning
        // an empty profile effectively grants nothing additional — the
        // existing sandbox stays in force. This is the conservative path:
        // we don't widen what Codex is allowed to do.
        result = { permissions: {} };
        this.log(`auto-denied permission widening for ${method} (id=${id})`);
        break;
      default:
        error = {
          code: -32601,
          message: `ClaudeThread received unknown server request method '${method}' with no handler`,
        };
        this.log(`unknown server request method: ${method} (id=${id}) — replying -32601`);
        break;
    }

    const payload: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (result !== undefined) payload.result = result;
    if (error !== undefined) payload.error = error;
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (err: any) {
      this.log(`failed to send server-request response: ${err?.message ?? err}`);
    }
  }

  private log(s: string) {
    const line = `[${new Date().toISOString()}] [ClaudeThread:${this.chatId}] ${s}\n`;
    process.stderr.write(line);
    try { appendFileSync(this.logFile, line); } catch {}
  }
}
