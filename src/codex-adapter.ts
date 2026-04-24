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
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";
import type { ServerWebSocket } from "bun";
import {
  isAppServerNotification,
  isAppServerRequestMessage,
  isAppServerResponseMessage,
  isTrackedAppServerRequestMethod,
  type AppServerItem,
  type AppServerNotification,
  type AppServerRequest,
  type AppServerResponse,
  type AppServerServerRequestMethod,
  type AppServerTrackedRequestMethod,
  type TurnStartParams,
} from "./app-server-protocol";

interface TuiSocketData {
  connId: number;
}

interface PendingServerRequest {
  raw: string;
  serverId: number | string;
  connId: number;
  method: AppServerServerRequestMethod | string;
  timestamp: number;
  threadId: string | null;
}

interface BufferedServerRequest {
  raw: string;
  serverId: number | string;
  method: AppServerServerRequestMethod | string;
  threadId: string | null;
}

interface PendingServerResponse {
  raw: string;
  serverId: number | string;
  method: AppServerServerRequestMethod | string;
  timestamp: number;
}

interface PendingRequest {
  method: AppServerTrackedRequestMethod;
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
  private readonly logFile: string;
  private tuiConnId = 0; // tracks which TUI connection is "current" (primary)
  private connIdCounter = 0; // monotonically increasing counter for unique conn IDs
  // Secondary (picker) connections: each gets its own dedicated app-server WS
  // for raw passthrough. The primary connection stays untouched.
  private secondaryConnections = new Map<number, {
    tuiWs: ServerWebSocket<TuiSocketData>;
    appServerWs: WebSocket | null;
    buffer: string[];
  }>();

  private agentMessageBuffers = new Map<string, string[]>();
  private pendingRequests = new Map<string, PendingRequest>();
  private activeTurnIds = new Set<string>();
  turnInProgress = false;

  // Proxy-layer id rewriting: upstream uses globally unique ids
  private nextProxyId = 100000;
  private upstreamToClient = new Map<number, { connId: number; clientId: number | string }>();
  private serverRequestToProxy = new Map<number, PendingServerRequest>();
  private pendingServerRequests: BufferedServerRequest[] = [];
  private pendingServerResponses = new Map<number, PendingServerResponse>();
  private staleProxyIds = new Map<number, ReturnType<typeof setTimeout>>();
  private bridgeRequestIds = new Map<number, ReturnType<typeof setTimeout>>();
  private intentionalDisconnect = false;
  // Fresh-session reconnection: buffer TUI messages while reconnecting app-server
  private pendingTuiMessages: string[] = [];
  private reconnectingForNewSession = false;
  private replayingBufferedMessages = false;
  // Generation counter to prevent stale app-server close handlers from interfering
  private appServerGeneration = 0;

  constructor(appPort = 4500, proxyPort = 4501, logFile = new StateDirResolver().logFile) {
    super();
    this.appPort = appPort;
    this.proxyPort = proxyPort;
    this.logFile = logFile;
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
    // Close all secondary (picker) connections
    for (const [id, sec] of this.secondaryConnections) {
      try { sec.appServerWs?.close(); } catch {}
      this.secondaryConnections.delete(id);
    }
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
      } satisfies AppServerRequest<"turn/start", TurnStartParams>));
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
    const generation = ++this.appServerGeneration;
    return new Promise((resolve, reject) => {
      const appWs = new WebSocket(this.appServerUrl);

      appWs.onopen = () => {
        if (this.appServerGeneration !== generation) {
          appWs.close();
          return;
        }
        this.appServerWs = appWs;
        this.intentionalDisconnect = false;
        this.reconnectAttempts = 0;
        this.log(isReconnect ? "Reconnected to app-server" : "Connected to app-server");
        this.flushPendingServerResponses();
        resolve();
      };

      appWs.onmessage = (event) => {
        if (this.appServerGeneration !== generation) return;
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
        if (this.appServerGeneration !== generation) return;
        this.log("App-server connection error");
        if (!isReconnect) reject(new Error("Failed to connect to app-server"));
      };

      appWs.onclose = () => {
        if (this.appServerGeneration !== generation) return;
        this.handleAppServerClose();
      };
    });
  }

  /** Reconnect app-server WS to give TUI a fresh connection-scoped session. */
  private async reconnectAppServerForNewSession(tuiWs: ServerWebSocket<TuiSocketData>) {
    // Bump generation so stale handlers from the old connection become no-ops
    this.appServerGeneration++;
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close old connection
    const oldWs = this.appServerWs;
    this.appServerWs = null;
    if (oldWs) {
      try { oldWs.close(); } catch {}
    }

    // Clear connection-scoped state (upstreamToClient etc.) but preserve
    // pendingServerRequests — those must survive the intentional reconnect
    // so they can be replayed after the TUI completes thread/resume.
    this.clearResponseTrackingStateForAppServerReconnect();
    this.activeTurnIds.clear();
    this.turnInProgress = false;

    try {
      await this.connectToAppServer(false);
      this.log("App-server reconnected for new TUI session — replaying buffered messages");

      // Replay raw buffered messages through onTuiMessage so they get
      // proper id-rewriting and response tracking on the fresh connection.
      const messages = this.pendingTuiMessages;
      this.pendingTuiMessages = [];
      this.reconnectingForNewSession = false;

      this.replayingBufferedMessages = true;
      try {
        for (const msg of messages) {
          this.onTuiMessage(tuiWs, msg);
        }
      } finally {
        this.replayingBufferedMessages = false;
      }
    } catch (err: any) {
      this.log(`Failed to reconnect app-server for new session: ${err.message}`);
      this.pendingTuiMessages = [];
      this.reconnectingForNewSession = false;
      this.intentionalDisconnect = false;
      this.scheduleReconnect();
    }
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

  private handleAppServerClose() {
    this.log("App-server connection closed");
    this.appServerWs = null;
    // Approval request/response ids are scoped to the current app-server session.
    // If the socket reconnects, replaying old approval state would forward stale ids.
    this.clearResponseTrackingState();
    this.activeTurnIds.clear();
    this.turnInProgress = false;
    if (!this.intentionalDisconnect) {
      this.scheduleReconnect();
    }
  }

  // ── Proxy Server ───────────────────────────────────────────

  private startProxy() {
    const self = this;
    this.proxyServer = Bun.serve({
      port: this.proxyPort,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
        self.log(`HTTP ${req.method} ${url.pathname} (upgrade=${isUpgrade})`);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          return fetch(`http://127.0.0.1:${self.appPort}${url.pathname}`);
        }
        if (server.upgrade(req, { data: { connId: 0 } })) return undefined;
        self.log(`WARNING: non-upgrade HTTP request not handled: ${req.method} ${url.pathname}`);
        return new Response("AgentBridge Codex Proxy");
      },
      websocket: {
        open: (ws: ServerWebSocket<TuiSocketData>) => self.onTuiConnect(ws),
        close: (ws: ServerWebSocket<TuiSocketData>, code: number, reason: string) => {
          self.log(`WebSocket close event: conn #${ws.data.connId}, code=${code}, reason=${reason || "none"}`);
          self.onTuiDisconnect(ws);
        },
        message: (ws: ServerWebSocket<TuiSocketData>, msg) => self.onTuiMessage(ws, msg),
      },
    });
  }

  private onTuiConnect(ws: ServerWebSocket<TuiSocketData>) {
    const connId = ++this.connIdCounter;
    ws.data.connId = connId;

    // If a primary TUI connection is still alive, this is a secondary (picker)
    // connection. The Codex TUI opens a parallel WS for the resume picker while
    // the main session connection stays open. Give the secondary its own
    // app-server WS so the primary is not disturbed.
    if (this.tuiWs) {
      this.log(`Secondary TUI connected (conn #${connId}, primary is #${this.tuiConnId})`);
      this.setupSecondaryConnection(ws, connId);
      return;
    }

    // No active primary — this becomes the new primary connection
    const previousConnId = this.tuiConnId > 0 ? this.tuiConnId : null;
    this.tuiConnId = connId;
    this.tuiWs = ws;
    // Reset threadId to prevent premature message injection before TUI completes
    // its handshake (initialize → thread/start or thread/resume).
    this.threadId = null;
    this.log(`TUI connected (conn #${this.tuiConnId})`);
    this.emit("tuiConnected", this.tuiConnId);
    if (previousConnId !== null) {
      this.retireConnectionState(previousConnId);
    }
    // Do not replay pendingServerRequests here — defer until TUI completes its
    // handshake (thread/resume to matching thread, or thread/start which drops
    // orphan entries). See handleTrackedResponse and dropOrphanPendingRequests.
  }

  /** Set up a secondary (picker) connection with its own dedicated app-server WS. */
  private setupSecondaryConnection(ws: ServerWebSocket<TuiSocketData>, connId: number) {
    const appWs = new WebSocket(this.appServerUrl);
    // Store the appWs handle immediately (not just in onopen) so that
    // onTuiDisconnect can close it even if the picker disconnects before
    // the app-server WS finishes connecting.
    const entry = { tuiWs: ws, appServerWs: appWs, buffer: [] as string[] };
    this.secondaryConnections.set(connId, entry);

    appWs.onopen = () => {
      // Picker may have already disconnected — if so, close immediately
      if (!this.secondaryConnections.has(connId)) {
        appWs.close();
        return;
      }
      this.log(`Secondary conn #${connId}: app-server WS connected, flushing ${entry.buffer.length} buffered messages`);
      for (const msg of entry.buffer) {
        try { appWs.send(msg); } catch {}
      }
      entry.buffer = [];
    };
    appWs.onmessage = (event) => {
      if (!this.secondaryConnections.has(connId)) return;
      const data = typeof event.data === "string" ? event.data : event.data.toString();
      try { ws.send(data); } catch {}
    };
    appWs.onerror = () => {
      this.log(`Secondary conn #${connId}: app-server WS error`);
    };
    appWs.onclose = () => {
      this.log(`Secondary conn #${connId}: app-server WS closed`);
      const sec = this.secondaryConnections.get(connId);
      if (sec) {
        // App-server died — tear down the picker TUI socket too so it
        // doesn't become a zombie that silently drops messages.
        this.secondaryConnections.delete(connId);
        try { sec.tuiWs.close(); } catch {}
      }
    };
  }

  /**
   * Replay buffered server requests that belong to the given thread.
   *
   * Entries are replayed when their threadId matches `resumedThreadId`, or
   * when they have no threadId (fallback: cannot attribute, so assume they
   * belong to whatever the TUI is resuming). Non-matching entries stay in
   * the buffer — they may match a subsequent resume.
   */
  private replayPendingForThread(resumedThreadId: string, ws: ServerWebSocket<TuiSocketData>) {
    const remaining: BufferedServerRequest[] = [];
    for (const buffered of this.pendingServerRequests) {
      const belongsToThread = buffered.threadId === null || buffered.threadId === resumedThreadId;
      if (!belongsToThread) {
        remaining.push(buffered);
        continue;
      }
      const proxyId = this.nextProxyId++;
      try {
        const parsed = JSON.parse(buffered.raw);
        parsed.id = proxyId;
        ws.send(JSON.stringify(parsed));
        this.serverRequestToProxy.set(proxyId, {
          raw: buffered.raw,
          serverId: buffered.serverId,
          connId: this.tuiConnId,
          method: buffered.method,
          timestamp: Date.now(),
          threadId: buffered.threadId,
        });
        if (buffered.threadId === null) {
          this.log(`WARNING: Replaying pending server request with unknown threadId (experimental fallback, may surface orphan UI on wrong thread): ${buffered.method} (server id=${buffered.serverId} → proxy id=${proxyId})`);
        } else {
          this.log(`Replayed buffered server request on thread/resume: ${buffered.method} (server id=${buffered.serverId} → proxy id=${proxyId}, threadId=${buffered.threadId})`);
        }
      } catch (e: any) {
        this.log(`Failed to replay buffered server request: ${buffered.method} (server id=${buffered.serverId}): ${e.message}`);
        remaining.push(buffered);
      }
    }
    this.pendingServerRequests = remaining;
  }

  /**
   * Drop buffered server requests that cannot be delivered because the TUI
   * has started a brand-new thread (thread/start), or has resumed a thread
   * that does not match the entry's threadId. The original listener in the
   * app-server is already dead for these entries, so keeping them would
   * just produce orphan approval UI on subsequent reconnects.
   */
  private dropOrphanPendingRequests(reason: string, matchThreadId: string | null = null) {
    if (this.pendingServerRequests.length === 0) return;
    const remaining: BufferedServerRequest[] = [];
    for (const buffered of this.pendingServerRequests) {
      const shouldDrop = matchThreadId === null
        ? true
        : buffered.threadId !== null && buffered.threadId !== matchThreadId;
      if (shouldDrop) {
        this.log(`Dropped orphan pending server request: ${buffered.method} (server id=${buffered.serverId}, threadId=${buffered.threadId ?? "unknown"}, reason=${reason})`);
        continue;
      }
      remaining.push(buffered);
    }
    this.pendingServerRequests = remaining;
  }

  private onTuiDisconnect(ws: ServerWebSocket<TuiSocketData>) {
    const connId = ws.data.connId;

    // Check if this is a secondary (picker) connection
    const secondary = this.secondaryConnections.get(connId);
    if (secondary) {
      this.log(`Secondary TUI disconnected (conn #${connId})`);
      this.secondaryConnections.delete(connId);
      if (secondary.appServerWs) {
        try { secondary.appServerWs.close(); } catch {}
      }
      return;
    }

    // Only clear tuiWs if this is still the current connection
    if (this.tuiWs === ws) {
      this.log(`TUI disconnected (conn #${connId})`);
      this.tuiWs = null;
      // Clear any pending reconnection state
      if (this.reconnectingForNewSession) {
        this.log("Clearing pending TUI message buffer (TUI disconnected during app-server reconnect)");
        this.pendingTuiMessages = [];
        this.reconnectingForNewSession = false;
      }
      this.emit("tuiDisconnected", connId);
    } else {
      this.log(`Stale TUI disconnected (conn #${connId}, current is #${this.tuiConnId})`);
    }
    this.retireConnectionState(connId);
  }

  private onTuiMessage(ws: ServerWebSocket<TuiSocketData>, msg: string | Buffer) {
    const data = typeof msg === "string" ? msg : msg.toString();
    const connId = ws.data.connId;

    // Route secondary (picker) connection messages to their own app-server WS
    const secondary = this.secondaryConnections.get(connId);
    if (secondary) {
      if (secondary.appServerWs && secondary.appServerWs.readyState === WebSocket.OPEN) {
        try { secondary.appServerWs.send(data); } catch {}
      } else {
        secondary.buffer.push(data);
      }
      return;
    }

    // Ignore messages from stale connections
    if (connId !== this.tuiConnId) {
      this.log(`Dropping message from stale TUI conn #${connId} (current is #${this.tuiConnId})`);
      return;
    }

    // Check if this is a response to a server-originated request
    try {
      const parsed = JSON.parse(data);
      if (parsed.id !== undefined && !parsed.method) {
        const normalizedId = this.normalizeNumericId(parsed.id);
        if (!isNaN(normalizedId) && this.pendingServerResponses.has(normalizedId)) {
          this.log(`Ignoring duplicate approval response while app-server reconnect is pending (proxy id=${normalizedId})`);
          return;
        }
        const pending = !isNaN(normalizedId) ? this.serverRequestToProxy.get(normalizedId) : undefined;
        if (pending !== undefined) {
          if (pending.connId !== connId) {
            this.log(`Dropping stale server request response (proxy id=${normalizedId}, expected conn #${pending.connId}, got #${connId})`);
            return;
          }
          parsed.id = pending.serverId;
          const forwardedResponse = JSON.stringify(parsed);
          if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
            this.bufferPendingServerResponse(normalizedId, pending, forwardedResponse, "app-server disconnected");
            return;
          }
          try {
            this.appServerWs.send(forwardedResponse);
            this.serverRequestToProxy.delete(normalizedId);
            this.log(`TUI → app-server: ${pending.method} response (proxy id=${normalizedId} → server id=${pending.serverId})`);
          } catch (e: any) {
            this.bufferPendingServerResponse(normalizedId, pending, forwardedResponse, `send failed: ${e.message}`);
          }
          return;
        }
      }
    } catch {}

    // Detect method before id-rewriting so we can intercept `initialize`
    // and buffer the RAW (un-rewritten) message for replay after reconnect.
    let detectedMethod: string | undefined;
    try {
      const parsed = JSON.parse(data);
      detectedMethod = typeof parsed.method === "string" ? parsed.method : undefined;
    } catch {}

    // When TUI sends `initialize`, reconnect app-server to give it a fresh
    // connection-scoped session (the upstream protocol requires per-connection init).
    // Buffer the raw message — id-rewriting happens after reconnect during replay.
    // Skip this check during replay to avoid infinite recursion.
    if (!this.replayingBufferedMessages) {
      if (detectedMethod === "initialize") {
        this.log("Detected initialize — reconnecting app-server for fresh session");
        this.reconnectingForNewSession = true;
        this.pendingTuiMessages = [data];
        this.reconnectAppServerForNewSession(ws);
        return;
      }

      // Buffer raw messages while reconnecting app-server for a fresh session
      if (this.reconnectingForNewSession) {
        this.pendingTuiMessages.push(data);
        return;
      }
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
      const parsed: unknown = JSON.parse(raw);
      if (isAppServerNotification(parsed) || (typeof parsed === "object" && parsed !== null && !("id" in parsed))) {
        const notificationLike = parsed as Record<string, unknown>;
        const forwarded = this.patchResponse(notificationLike, raw);
        this.interceptServerMessage(notificationLike);
        return forwarded;
      }

      if (isAppServerRequestMessage(parsed)) {
        // Intentionally uses the broad isAppServerRequestMessage (any id+method) instead of
        // the narrow isAppServerServerRequest (only known approval methods). This ensures
        // unknown future server-to-client requests are forwarded rather than silently dropped
        // (lesson from issue #37).
        this.handleServerRequest(parsed, raw);
        return null;
      }

      if (isAppServerResponseMessage(parsed)) {
        return this.handleAppServerResponse(parsed, raw);
      }

      // Drop unclassifiable messages (not notification, not request, not response).
      this.log(`Dropping unclassifiable app-server message: ${raw.slice(0, 100)}`);
      return null;
    } catch {
      return raw;
    }
  }

  private handleServerRequest(parsed: AppServerRequest, raw: string): void {
    const serverId = parsed.id;
    const method = parsed.method;
    const threadId = this.extractThreadIdFromParams(parsed.params);

    if (!this.tuiWs) {
      this.pendingServerRequests.push({ raw, serverId, method, threadId });
      this.log(`Server request buffered (no TUI): ${method} (server id=${serverId}, threadId=${threadId ?? "unknown"})`);
      return;
    }

    const proxyId = this.nextProxyId++;
    parsed.id = proxyId;

    try {
      this.tuiWs.send(JSON.stringify(parsed));
    } catch (e: any) {
      this.log(`Server request send failed, buffering: ${method} (server id=${serverId}): ${e.message}`);
      this.pendingServerRequests.push({ raw, serverId, method, threadId });
      return;
    }

    this.serverRequestToProxy.set(proxyId, {
      raw,
      serverId,
      connId: this.tuiConnId,
      method,
      timestamp: Date.now(),
      threadId,
    });
    this.log(`Server request: ${method} (server id=${serverId} → proxy id=${proxyId}, conn #${this.tuiConnId}, threadId=${threadId ?? "unknown"})`);
  }

  private extractThreadIdFromParams(params: unknown): string | null {
    if (typeof params !== "object" || params === null) return null;
    const tid = (params as Record<string, unknown>).threadId;
    return typeof tid === "string" && tid.length > 0 ? tid : null;
  }

  /** Normalize a JSON-RPC id to a number. Returns NaN for non-numeric strings. */
  private normalizeNumericId(id: unknown): number {
    if (typeof id === "number") return id;
    if (typeof id === "string" && /^-?\d+$/.test(id)) return Number(id);
    return NaN;
  }

  private bufferPendingServerResponse(
    proxyId: number,
    pending: PendingServerRequest,
    forwardedResponse: string,
    reason: string,
  ) {
    this.pendingServerResponses.set(proxyId, {
      raw: forwardedResponse,
      serverId: pending.serverId,
      method: pending.method,
      timestamp: Date.now(),
    });
    this.serverRequestToProxy.delete(proxyId);
    this.log(`Buffered approval response until app-server reconnect (${reason}) (proxy id=${proxyId} → server id=${pending.serverId})`);
  }

  private flushPendingServerResponses() {
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) return;

    for (const [proxyId, pending] of this.pendingServerResponses.entries()) {
      try {
        this.appServerWs.send(pending.raw);
        this.pendingServerResponses.delete(proxyId);
        this.log(`Flushed buffered approval response after app-server reconnect (proxy id=${proxyId} → server id=${pending.serverId})`);
      } catch (e: any) {
        this.log(`Failed to flush buffered approval response (proxy id=${proxyId}): ${e.message}`);
        break;
      }
    }
  }

  private handleAppServerResponse(parsed: AppServerResponse, raw: string): string | null {
    const responseId = parsed.id;
    const numericId = this.normalizeNumericId(responseId);
    const mapping = !isNaN(numericId) ? this.upstreamToClient.get(numericId) : undefined;

    if (mapping) {
      this.upstreamToClient.delete(numericId);

      if (mapping.connId !== this.tuiConnId) {
        this.log(`Dropping stale response (upstream id ${responseId}, from conn #${mapping.connId}, current #${this.tuiConnId})`);
        return null;
      }

      parsed.id = mapping.clientId;
      this.log(`app-server → TUI: response (proxy id=${numericId} → client id=${String(mapping.clientId)}, conn #${mapping.connId})`);
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

  private patchResponse(parsed: AppServerNotification | AppServerResponse | Record<string, unknown>, raw: string): string {
    if (isAppServerResponseMessage(parsed) && parsed.error && parsed.id !== undefined) {
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
      // "Already initialized" is no longer patched — we reconnect the app-server
      // WS on each TUI `initialize` request, giving it a fresh connection scope.
    }
    return raw;
  }

  // ── Server Message Interception (for Bridge) ───────────────

  private interceptServerMessage(msg: AppServerNotification | AppServerResponse | Record<string, unknown>, connId?: number) {
    this.handleTrackedResponse(msg, connId);
    if ("method" in msg && typeof msg.method === "string" && isAppServerNotification(msg)) {
      this.handleServerNotification(msg);
    }
  }

  private handleServerNotification(msg: AppServerNotification) {
    const { method, params } = msg;
    switch (method) {
      case "turn/started":
        this.markTurnStarted(params?.turn?.id);
        break;
      case "item/started": {
        const item: AppServerItem | undefined = params?.item;
        if (item?.type === "agentMessage") this.agentMessageBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = params?.itemId;
        if (typeof itemId !== "string") break;
        const buf = this.agentMessageBuffers.get(itemId);
        if (buf && params?.delta) buf.push(params.delta);
        break;
      }
      case "item/completed": {
        const item: AppServerItem | undefined = params?.item;
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

  private extractContent(item: AppServerItem): string {
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

  private trackPendingRequest(message: AppServerRequest | Record<string, unknown>, connId: number, _proxyId?: number) {
    const rpcId = "id" in message ? message.id : undefined;
    const method = "method" in message && typeof message.method === "string" ? message.method : undefined;
    const key = this.pendingKey(rpcId, connId);

    if (!key || !isTrackedAppServerRequestMethod(method)) return;

    const pending: PendingRequest = { method };
    if (method === "turn/start") {
      const params = "params" in message && typeof message.params === "object" && message.params !== null
        ? message.params as Record<string, unknown>
        : undefined;
      const threadId = params?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) {
        pending.threadId = threadId;
      }
    }

    if (this.pendingRequests.has(key)) {
      this.log(`WARNING: overwriting pending request for key ${key}`);
    }

    this.pendingRequests.set(key, pending);
  }

  // TODO: narrow this type further once response shapes are fully typed (#47 follow-up)
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
        // User started a brand-new session — any buffered server requests
        // belong to a thread the user has abandoned. Drop them so they do
        // not surface as orphan approval UI.
        this.dropOrphanPendingRequests(`thread/start (new session)`);
        break;
      }
      case "thread/resume": {
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/resume response ${key}`);
          if (this.tuiWs) {
            this.replayPendingForThread(threadId, this.tuiWs);
          }
          // Drop any entries that belong to a different thread than the
          // resumed one — the user did not return to them.
          this.dropOrphanPendingRequests(`thread/resume to ${threadId}`, threadId);
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

    const requeuedServerRequests: BufferedServerRequest[] = [];
    for (const [proxyId, pending] of this.serverRequestToProxy.entries()) {
      if (pending.connId === connId) {
        this.serverRequestToProxy.delete(proxyId);
        requeuedServerRequests.push({
          raw: pending.raw,
          serverId: pending.serverId,
          method: pending.method,
          threadId: pending.threadId,
        });
        this.log(`Requeued in-flight server request after TUI disconnect (proxy id=${proxyId}, server id=${pending.serverId}, method=${pending.method}, threadId=${pending.threadId ?? "unknown"})`);
      }
    }

    if (requeuedServerRequests.length === 0) return;

    this.pendingServerRequests.push(...requeuedServerRequests);

    // Do not replay immediately even if a new primary is already connected.
    // Replay is deferred until the new TUI completes thread/resume to a
    // matching thread — see handleTrackedResponse.
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

  private clearTransientResponseTrackingState() {
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

  private clearResponseTrackingState() {
    this.clearTransientResponseTrackingState();
    this.serverRequestToProxy.clear();
    this.pendingServerRequests = [];
    this.pendingServerResponses.clear();
  }

  /**
   * Variant used by the intentional app-server reconnect triggered by a TUI
   * `initialize` message. Preserves `pendingServerRequests` so they can be
   * replayed after the TUI completes `thread/resume`. In-flight server
   * requests are moved into the pending buffer so they get the same
   * replay-on-resume treatment. The serverIds are stale with respect to
   * the new app-server session — the subsequent response will most likely
   * be rejected upstream, which is precisely what the A' experiment tests.
   */
  private clearResponseTrackingStateForAppServerReconnect() {
    this.clearTransientResponseTrackingState();
    for (const pending of this.serverRequestToProxy.values()) {
      this.pendingServerRequests.push({
        raw: pending.raw,
        serverId: pending.serverId,
        method: pending.method,
        threadId: pending.threadId,
      });
      this.log(`Requeued in-flight server request on app-server reconnect (server id=${pending.serverId}, method=${pending.method}, threadId=${pending.threadId ?? "unknown"})`);
    }
    this.serverRequestToProxy.clear();
    // Intentionally preserve pendingServerRequests across the reconnect.
    this.pendingServerResponses.clear();
  }

  /**
   * Build the lsof command used to find LISTENing processes on a TCP port.
   *
   * Restricting to `-sTCP:LISTEN` is critical: a bare `lsof -ti :PORT` also
   * returns processes that merely have an outbound (client) FD to that port,
   * including stale CLOSED connections from crashed clients. Those false
   * positives caused `abg claude` to refuse startup whenever a previous
   * Codex TUI process lingered with a half-closed connection to port 4501.
   */
  static buildPortListenLsofCommand(port: number): string {
    return `lsof -ti tcp:${port} -sTCP:LISTEN`;
  }

  /**
   * Clean up stale ports before starting.
   * Only kills `codex app-server` processes (our own spawns). If the port is
   * occupied by something else, throws with a clear message.
   */
  private async checkPorts() {
    for (const port of [this.appPort, this.proxyPort]) {
      try {
        const pids = execSync(CodexAdapter.buildPortListenLsofCommand(port), {
          encoding: "utf-8",
        }).trim();
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
          const remaining = execSync(CodexAdapter.buildPortListenLsofCommand(port), {
            encoding: "utf-8",
          }).trim();
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
    try { appendFileSync(this.logFile, line); } catch {}
  }
}
