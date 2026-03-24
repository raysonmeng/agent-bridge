/**
 * Codex Adapter — WebSocket Proxy Mode
 *
 * Spawns `codex app-server --listen ws://127.0.0.1:<port>` and runs a proxy
 * on a second port. Codex TUI connects to the proxy; Bridge forwards all
 * traffic while intercepting agentMessages for Claude.
 *
 * Key design: app-server connection is PERSISTENT (never closed on TUI
 * disconnect), because TUI rapidly reconnects between bootstrap phases.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import type { BridgeMessage, CodexItem } from "./types";
import type { ServerWebSocket } from "bun";

interface TuiSocketData {
  connId: number;
}

const LOG_FILE = "/tmp/agentbridge.log";
const TRACKED_REQUEST_METHODS = new Set(["thread/start", "thread/resume", "turn/start"]);

type TrackedRequestMethod = "thread/start" | "thread/resume" | "turn/start";

interface PendingRequest {
  method: TrackedRequestMethod;
  threadId?: string;
}

export class CodexAdapter extends EventEmitter {
  private static readonly RESPONSE_TRACKING_TTL_MS = 30000;

  private proc: ChildProcess | null = null;
  private appServerWs: WebSocket | null = null;
  private tuiWs: ServerWebSocket<TuiSocketData> | null = null;
  private proxyServer: ReturnType<typeof Bun.serve> | null = null;
  private threadId: string | null = null;
  // Reserve negative ids for bridge-originated requests so they never collide
  // with proxy-rewritten TUI request ids.
  private nextInjectionId = -1;
  private appPort: number;
  private proxyPort: number;
  private tuiConnId = 0; // tracks which TUI connection is "current"

  private agentMessageBuffers = new Map<string, string[]>();
  private pendingRequests = new Map<string, PendingRequest>();
  private activeTurnIds = new Set<string>();
  turnInProgress = false;

  // Proxy-layer id rewriting: upstream uses globally unique ids
  private nextProxyId = 100000;
  private upstreamToClient = new Map<number, { connId: number; clientId: number | string }>();
  private staleProxyIds = new Map<number, ReturnType<typeof setTimeout>>();
  private bridgeRequestIds = new Map<number, ReturnType<typeof setTimeout>>();
  private intentionalDisconnect = false;

  constructor(appPort = 4500, proxyPort = 4501) {
    super();
    this.appPort = appPort;
    this.proxyPort = proxyPort;
  }

  get appServerUrl() { return `ws://127.0.0.1:${this.appPort}`; }
  get proxyUrl() { return `ws://127.0.0.1:${this.proxyPort}`; }
  get activeThreadId() { return this.threadId; }

  // ── Lifecycle ──────────────────────────────────────────────

  async start() {
    this.intentionalDisconnect = false;
    await this.checkPorts();
    this.log(`Spawning codex app-server on ${this.appServerUrl}`);
    this.proc = spawn("codex", ["app-server", "--listen", this.appServerUrl], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => this.emit("exit", code));

    const stderrRl = createInterface({ input: this.proc.stderr! });
    stderrRl.on("line", (l) => this.log(`[codex-server] ${l}`));
    const stdoutRl = createInterface({ input: this.proc.stdout! });
    stdoutRl.on("line", (l) => this.log(`[codex-stdout] ${l}`));

    await this.waitForHealthy();

    // Connect to app-server once, keep it alive permanently
    await this.connectToAppServer();

    this.startProxy();
    this.log(`Proxy ready on ${this.proxyUrl}`);
  }

  /** Disconnect the bridge (proxy + app-server WS) without killing the Codex process. */
  disconnect() {
    this.intentionalDisconnect = true;

    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.appServerWs?.close();
    this.appServerWs = null;
    this.proxyServer?.stop();
    this.proxyServer = null;
    this.clearResponseTrackingState();
  }

  /** Fully stop: disconnect bridge AND kill the Codex process. */
  stop() {
    this.intentionalDisconnect = true;
    this.disconnect();

    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill("SIGTERM");
      // SIGKILL fallback if SIGTERM doesn't work within 2s
      const killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 2000);
      proc.on("exit", () => clearTimeout(killTimer));
    }
  }

  /** Inject a message into the active Codex thread via turn/start. Returns true if sent. */
  injectMessage(text: string): boolean {
    if (!this.threadId) {
      this.log("Cannot inject: no active thread");
      return false;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      this.log("Cannot inject: app-server WebSocket not connected");
      return false;
    }
    if (this.turnInProgress) {
      this.log(`Rejected injection: Codex turn is in progress (thread ${this.threadId})`);
      return false;
    }
    this.log(`Injecting message into Codex (${text.length} chars)`);
    const requestId = this.nextInjectionId--;
    this.trackBridgeRequestId(requestId);
    try {
      this.appServerWs.send(JSON.stringify({
        method: "turn/start",
        id: requestId,
        params: { threadId: this.threadId, input: [{ type: "text", text }] },
      }));
      return true;
    } catch (err: any) {
      this.untrackBridgeRequestId(requestId);
      this.log(`Injection send failed: ${err.message}`);
      return false;
    }
  }

  // ── Health Check ───────────────────────────────────────────

  private async waitForHealthy(maxRetries = 20, delayMs = 500) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.appPort}/healthz`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error("Codex app-server failed to become healthy");
  }

  // ── Persistent App-Server Connection ───────────────────────

  private connectToAppServer(isReconnect = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const appWs = new WebSocket(this.appServerUrl);

      appWs.onopen = () => {
        this.appServerWs = appWs;
        this.intentionalDisconnect = false;
        this.reconnectAttempts = 0;
        this.log(isReconnect ? "Reconnected to app-server" : "Connected to app-server (persistent)");
        resolve();
      };

      appWs.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : event.data.toString();

        const forwarded = this.handleAppServerPayload(data);
        if (forwarded === null) return;

        // Forward to current TUI connection
        if (this.tuiWs) {
          try { this.tuiWs.send(forwarded); } catch (e: any) {
            this.log(`Failed to forward message to TUI: ${e.message}`);
          }
        } else {
          this.log("WARNING: response from app-server but no TUI connected, message dropped");
        }
      };

      appWs.onerror = () => {
        this.log("App-server connection error");
        if (!isReconnect) reject(new Error("Failed to connect to app-server"));
      };

      appWs.onclose = () => {
        this.log("App-server connection closed");
        this.appServerWs = null;
        this.clearResponseTrackingState();
        this.activeTurnIds.clear();
        this.turnInProgress = false;
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  // ── Auto-Reconnect ──────────────────────────────────────────

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;

  private scheduleReconnect() {
    // Don't reconnect if we're shutting down or process is dead
    if (!this.proc) return;

    if (this.reconnectAttempts >= CodexAdapter.MAX_RECONNECT_ATTEMPTS) {
      this.log(`App-server reconnect failed after ${this.reconnectAttempts} attempts. Giving up.`);
      this.emit("error", new Error("App-server connection lost and reconnect failed"));
      return;
    }

    const delay = Math.min(
      CodexAdapter.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      30000,
    );
    this.reconnectAttempts++;
    this.log(`Scheduling app-server reconnect attempt ${this.reconnectAttempts}/${CodexAdapter.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectToAppServer(true);
        this.log("App-server reconnect successful");
      } catch {
        this.log("App-server reconnect attempt failed");
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── Proxy Server ───────────────────────────────────────────

  private startProxy() {
    const self = this;
    this.proxyServer = Bun.serve({
      port: this.proxyPort,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          return fetch(`http://127.0.0.1:${self.appPort}${url.pathname}`);
        }
        if (server.upgrade(req, { data: { connId: 0 } })) return undefined;
        return new Response("AgentBridge Codex Proxy");
      },
      websocket: {
        open: (ws: ServerWebSocket<TuiSocketData>) => self.onTuiConnect(ws),
        close: (ws: ServerWebSocket<TuiSocketData>) => self.onTuiDisconnect(ws),
        message: (ws: ServerWebSocket<TuiSocketData>, msg) => self.onTuiMessage(ws, msg),
      },
    });
  }

  private onTuiConnect(ws: ServerWebSocket<TuiSocketData>) {
    this.tuiConnId++;
    ws.data.connId = this.tuiConnId;
    this.tuiWs = ws;
    this.log(`TUI connected (conn #${this.tuiConnId})`);
    this.emit("tuiConnected", this.tuiConnId);
  }

  private onTuiDisconnect(ws: ServerWebSocket<TuiSocketData>) {
    const connId = ws.data.connId;
    // Only clear tuiWs if this is still the current connection
    if (this.tuiWs === ws) {
      this.log(`TUI disconnected (conn #${connId})`);
      this.tuiWs = null;
      this.emit("tuiDisconnected", connId);
    } else {
      this.log(`Stale TUI disconnected (conn #${connId}, current is #${this.tuiConnId})`);
    }
    this.retireConnectionState(connId);
    // Do NOT close app-server connection — TUI will reconnect shortly
  }

  private onTuiMessage(ws: ServerWebSocket<TuiSocketData>, msg: string | Buffer) {
    const data = typeof msg === "string" ? msg : msg.toString();
    const connId = ws.data.connId;

    // Ignore messages from stale connections
    if (connId !== this.tuiConnId) {
      this.log(`Dropping message from stale TUI conn #${connId} (current is #${this.tuiConnId})`);
      return;
    }

    let forwarded = data;
    try {
      const parsed = JSON.parse(data);
      const method = parsed.method ?? `response:${parsed.id}`;
      this.log(`TUI → app-server: ${method}`);

      // Rewrite request id to globally unique proxy id
      if (parsed.id !== undefined && parsed.method) {
        const proxyId = this.nextProxyId++;
        this.upstreamToClient.set(proxyId, { connId, clientId: parsed.id });
        this.trackPendingRequest(parsed, connId, proxyId);
        parsed.id = proxyId;
        forwarded = JSON.stringify(parsed);
      } else {
        this.trackPendingRequest(parsed, connId);
      }
    } catch {
      this.log(`TUI → app-server: (unparseable)`);
    }

    // Forward to app-server
    if (this.appServerWs?.readyState === WebSocket.OPEN) {
      this.appServerWs.send(forwarded);
    } else {
      this.log(`WARNING: app-server not connected, dropping message`);
    }
  }

  // ── Response Patching ──────────────────────────────────────

  private handleAppServerPayload(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw);

      if (parsed.id === undefined) {
        const forwarded = this.patchResponse(parsed, raw);
        this.interceptServerMessage(parsed);
        return forwarded;
      }

      return this.handleAppServerResponse(parsed, raw);
    } catch {
      return raw;
    }
  }

  private handleAppServerResponse(parsed: any, raw: string): string | null {
    const responseId = parsed.id;
    // Handle response IDs that may arrive as numeric strings (e.g. "100005"
    // instead of 100005). Non-numeric string IDs like "initialize" stay NaN
    // and fall through to the unmatched response log at the end of this method.
    const numericId = typeof responseId === "number" ? responseId : (typeof responseId === "string" && /^-?\d+$/.test(responseId) ? Number(responseId) : NaN);
    const mapping = !isNaN(numericId) ? this.upstreamToClient.get(numericId) : undefined;

    if (mapping) {
      this.upstreamToClient.delete(numericId);

      if (mapping.connId !== this.tuiConnId) {
        this.log(`Dropping stale response (upstream id ${responseId}, from conn #${mapping.connId}, current #${this.tuiConnId})`);
        return null;
      }

      parsed.id = mapping.clientId;
      const forwarded = this.patchResponse(parsed, JSON.stringify(parsed));
      this.interceptServerMessage(parsed, mapping.connId);
      return forwarded;
    }

    if (!isNaN(numericId) && this.consumeBridgeRequestId(numericId)) {
      if (parsed.error) {
        this.log(`Bridge-originated request failed (id ${responseId}): ${parsed.error.message ?? "unknown error"}`);
      } else {
        this.log(`Bridge-originated request completed (id ${responseId})`);
      }
      return null;
    }

    if (!isNaN(numericId) && this.consumeStaleProxyId(numericId)) {
      this.log(`Dropping stale response for retired upstream id ${responseId}`);
      return null;
    }

    this.log(`Dropping unmatched app-server response id ${String(responseId)}`);
    return null;
  }

  private patchResponse(parsed: any, raw: string): string {
    if (parsed.error && parsed.id !== undefined) {
      const errMsg: string = parsed.error.message ?? "";
      if (errMsg.includes("rate limits") || errMsg.includes("rateLimits")) {
        this.log(`Patching rateLimits error → mock success (id: ${parsed.id})`);
        return JSON.stringify({
          id: parsed.id,
          result: {
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: null },
              secondary: null,
              credits: null,
              planType: null,
            },
            rateLimitsByLimitId: null,
          },
        });
      }
      // Patch "Already initialized" — just return success
      if (errMsg.includes("Already initialized")) {
        this.log(`Patching "Already initialized" error (id: ${parsed.id})`);
        return JSON.stringify({
          id: parsed.id,
          result: {
            userAgent: "agent_bridge/0.1.0",
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      }
    }
    return raw;
  }

  // ── Server Message Interception (for Bridge) ───────────────

  private interceptServerMessage(msg: any, connId?: number) {
    this.handleTrackedResponse(msg, connId);
    if (msg.method) this.handleServerNotification(msg);
  }

  private handleServerNotification(msg: any) {
    const { method, params } = msg;
    switch (method) {
      case "turn/started":
        this.markTurnStarted(params?.turn?.id);
        break;
      case "item/started": {
        const item: CodexItem = params?.item;
        if (item?.type === "agentMessage") this.agentMessageBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const buf = this.agentMessageBuffers.get(params?.itemId);
        if (buf && params?.delta) buf.push(params.delta);
        break;
      }
      case "item/completed": {
        const item: CodexItem = params?.item;
        if (item?.type === "agentMessage") {
          const content = this.extractContent(item);
          this.agentMessageBuffers.delete(item.id);
          if (content) {
            this.log(`Agent message completed (${content.length} chars)`);
            this.emit("agentMessage", {
              id: item.id, source: "codex" as const, content, timestamp: Date.now(),
            } satisfies BridgeMessage);
          }
        }
        break;
      }
      case "turn/completed": {
        const wasInProgress = this.turnInProgress;
        this.markTurnCompleted(params?.turn?.id);
        // Only emit when all turns are done (symmetric with turnStarted)
        if (wasInProgress && !this.turnInProgress) {
          this.emit("turnCompleted");
        }
        break;
      }
    }
  }

  private extractContent(item: CodexItem): string {
    if (item.content?.length) {
      return item.content.filter((c) => c.type === "text" && c.text).map((c) => c.text!).join("");
    }
    return this.agentMessageBuffers.get(item.id)?.join("") ?? "";
  }

  /** Build a generation-scoped key: "connId:rpcId" to prevent cross-reconnect collisions. */
  private pendingKey(rpcId: unknown, connId?: number): string | null {
    const base = this.requestKey(rpcId);
    if (!base) return null;
    return `${connId ?? this.tuiConnId}:${base}`;
  }

  private trackPendingRequest(message: any, connId: number, _proxyId?: number) {
    const method = message?.method;
    const key = this.pendingKey(message?.id, connId);

    this.log(`[track] method=${method} id=${message?.id} (type=${typeof message?.id}) key=${key}`);

    if (!key || !TRACKED_REQUEST_METHODS.has(method)) return;

    const pending: PendingRequest = { method };
    if (method === "turn/start") {
      const threadId = message?.params?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) {
        pending.threadId = threadId;
      }
    }

    if (this.pendingRequests.has(key)) {
      this.log(`WARNING: overwriting pending request for key ${key}`);
    }

    this.pendingRequests.set(key, pending);
  }

  private handleTrackedResponse(message: any, connId?: number) {
    const key = this.pendingKey(message?.id, connId);
    if (!key) return;

    const pending = this.pendingRequests.get(key);
    if (!pending) {
      // Log responses that have result.thread.id for debugging
      if (message?.result?.thread?.id) {
        this.log(`[track-resp] Unmatched response with thread.id=${message.result.thread.id}, key=${key}, pending keys=[${[...this.pendingRequests.keys()].join(",")}]`);
      }
      return;
    }

    this.pendingRequests.delete(key);

    if (message?.error) {
      this.log(
        `Tracked request failed (${pending.method}, id ${key}): ${message.error.message ?? "unknown error"}`,
      );
      return;
    }

    switch (pending.method) {
      case "thread/start": {
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/start response ${key}`);
        }
        break;
      }
      case "thread/resume": {
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/resume response ${key}`);
        }
        break;
      }
      case "turn/start":
        if (pending.threadId) {
          this.setActiveThreadId(pending.threadId, `turn/start response ${key}`);
        }
        break;
    }
  }

  private setActiveThreadId(threadId: string, reason: string) {
    if (this.threadId === threadId) return;

    const previousThreadId = this.threadId;
    this.threadId = threadId;

    if (previousThreadId) {
      this.log(`Active thread changed: ${previousThreadId} → ${threadId} (${reason})`);
      return;
    }

    this.log(`Thread detected: ${threadId} (${reason})`);
    this.emit("ready", threadId);
  }

  private markTurnStarted(turnId?: string) {
    const wasInProgress = this.turnInProgress;
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.add(turnId);
    } else {
      this.activeTurnIds.add(`unknown:${Date.now()}`);
    }

    this.turnInProgress = this.activeTurnIds.size > 0;
    if (!wasInProgress && this.turnInProgress) {
      this.emit("turnStarted");
    }
  }

  private markTurnCompleted(turnId?: string) {
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.delete(turnId);
    } else {
      this.activeTurnIds.clear();
    }

    this.turnInProgress = this.activeTurnIds.size > 0;
  }

  private requestKey(id: unknown): string | null {
    if (typeof id === "number" || typeof id === "string") return String(id);
    return null;
  }

  private retireConnectionState(connId: number) {
    const prefix = `${connId}:`;
    for (const key of this.pendingRequests.keys()) {
      if (key.startsWith(prefix)) this.pendingRequests.delete(key);
    }

    for (const [upId, mapping] of this.upstreamToClient.entries()) {
      if (mapping.connId !== connId) continue;
      this.upstreamToClient.delete(upId);
      this.trackStaleProxyId(upId);
    }
  }

  private trackStaleProxyId(proxyId: number) {
    this.clearTrackedId(this.staleProxyIds, proxyId);

    const timer = setTimeout(() => {
      this.staleProxyIds.delete(proxyId);
    }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
    timer.unref?.();
    this.staleProxyIds.set(proxyId, timer);
  }

  private consumeStaleProxyId(proxyId: number) {
    return this.clearTrackedId(this.staleProxyIds, proxyId);
  }

  private trackBridgeRequestId(requestId: number) {
    this.clearTrackedId(this.bridgeRequestIds, requestId);

    const timer = setTimeout(() => {
      this.bridgeRequestIds.delete(requestId);
    }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
    timer.unref?.();
    this.bridgeRequestIds.set(requestId, timer);
  }

  private consumeBridgeRequestId(requestId: number) {
    return this.clearTrackedId(this.bridgeRequestIds, requestId);
  }

  private untrackBridgeRequestId(requestId: number) {
    this.clearTrackedId(this.bridgeRequestIds, requestId);
  }

  private clearTrackedId(store: Map<number, ReturnType<typeof setTimeout>>, id: number) {
    const timer = store.get(id);
    if (!timer) return false;
    clearTimeout(timer);
    store.delete(id);
    return true;
  }

  private clearResponseTrackingState() {
    this.pendingRequests.clear();
    this.upstreamToClient.clear();

    for (const timer of this.staleProxyIds.values()) {
      clearTimeout(timer);
    }
    this.staleProxyIds.clear();

    for (const timer of this.bridgeRequestIds.values()) {
      clearTimeout(timer);
    }
    this.bridgeRequestIds.clear();
  }

  /**
   * Clean up stale ports before starting.
   * Only kills `codex app-server` processes (our own spawns). If the port is
   * occupied by something else, throws with a clear message.
   */
  private async checkPorts() {
    for (const port of [this.appPort, this.proxyPort]) {
      try {
        const pids = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
        if (!pids) continue;

        // Check if the occupying process is a codex app-server (our own stale spawn)
        const pidList = pids.split("\n").map((p) => p.trim()).filter(Boolean);
        const staleCodexPids: string[] = [];
        const foreignPids: string[] = [];

        for (const pid of pidList) {
          try {
            const cmdline = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8" }).trim();
            if (cmdline.includes("codex") && cmdline.includes("app-server")) {
              staleCodexPids.push(pid);
            } else {
              foreignPids.push(pid);
            }
          } catch {
            // Process already gone
          }
        }

        // Kill stale codex app-server processes (our own previous spawns)
        if (staleCodexPids.length > 0) {
          this.log(`Cleaning up stale codex app-server on port ${port}: PID(s) ${staleCodexPids.join(", ")}`);
          for (const pid of staleCodexPids) {
            try { execSync(`kill ${pid}`, { encoding: "utf-8" }); } catch {}
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        // If foreign processes still occupy the port, fail with a clear message
        if (foreignPids.length > 0) {
          throw new Error(
            `Port ${port} is already in use by non-Codex process(es): PID(s) ${foreignPids.join(", ")}. ` +
            `Please stop the process or set a different port via ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} env var.`
          );
        }

        // Verify port is now free
        try {
          const remaining = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
          if (remaining) {
            throw new Error(
              `Port ${port} is still occupied (PID(s): ${remaining.replace(/\n/g, ", ")}) after cleanup. ` +
              `Please stop the process or set a different port via ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} env var.`
            );
          }
        } catch (err: any) {
          if (err.message?.includes("Port")) throw err;
          // lsof exit 1 = port free, good
        }
      } catch (err: any) {
        // lsof returns exit code 1 if no match — port is free
        if (err.message?.includes("Port") || err.message?.includes("non-Codex")) throw err;
      }
    }
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString()}] [CodexAdapter] ${msg}\n`;
    process.stderr.write(line);
    try { appendFileSync(LOG_FILE, line); } catch {}
  }
}
