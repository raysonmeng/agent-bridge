#!/usr/bin/env bun
// @bun

// src/daemon.ts
import { appendFileSync as appendFileSync3 } from "fs";

// src/codex-adapter.ts
import { spawn, execSync } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { appendFileSync } from "fs";
import { createHash } from "crypto";

// src/state-dir.ts
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

class StateDirResolver {
  stateDir;
  constructor(envOverride) {
    const override = envOverride ?? process.env.AGENTBRIDGE_STATE_DIR;
    if (override) {
      this.stateDir = override;
    } else if (platform() === "darwin") {
      this.stateDir = join(homedir(), "Library", "Application Support", "AgentBridge");
    } else {
      const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
      this.stateDir = join(xdgState, "agentbridge");
    }
  }
  ensure() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }
  get dir() {
    return this.stateDir;
  }
  get pidFile() {
    return join(this.stateDir, "daemon.pid");
  }
  get tuiPidFile() {
    return join(this.stateDir, "codex-tui.pid");
  }
  get lockFile() {
    return join(this.stateDir, "daemon.lock");
  }
  get statusFile() {
    return join(this.stateDir, "status.json");
  }
  get portsFile() {
    return join(this.stateDir, "ports.json");
  }
  get logFile() {
    return join(this.stateDir, "agentbridge.log");
  }
  get codexWrapperLogFile() {
    return join(this.stateDir, "codex-wrapper.log");
  }
  get killedFile() {
    return join(this.stateDir, "killed");
  }
  pairDir(pairId) {
    return join(this.stateDir, "pairs", pairId);
  }
  pairCodexPidFile(pairId) {
    return join(this.pairDir(pairId), "codex.pid");
  }
  pairCodexWrapperLogFile(pairId) {
    return join(this.pairDir(pairId), "codex-wrapper.log");
  }
  ensurePairDir(pairId) {
    const dir = this.pairDir(pairId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// src/app-server-protocol.ts
var APP_SERVER_TRACKED_REQUEST_METHODS = [
  "thread/start",
  "thread/resume",
  "turn/start"
];
var APP_SERVER_SERVER_REQUEST_METHODS = [
  "item/permissions/requestApproval",
  "item/fileChange/requestApproval",
  "item/commandExecution/requestApproval"
];
var APP_SERVER_NOTIFICATION_METHODS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/agentMessage/delta",
  "item/completed",
  "error",
  "thread/closed"
];
var TRACKED_REQUEST_METHOD_SET = new Set(APP_SERVER_TRACKED_REQUEST_METHODS);
var SERVER_REQUEST_METHOD_SET = new Set(APP_SERVER_SERVER_REQUEST_METHODS);
var NOTIFICATION_METHOD_SET = new Set(APP_SERVER_NOTIFICATION_METHODS);
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTrackedAppServerRequestMethod(method) {
  return typeof method === "string" && TRACKED_REQUEST_METHOD_SET.has(method);
}
function isAppServerRequestMessage(value) {
  if (!isObjectRecord(value))
    return false;
  return (typeof value.id === "number" || typeof value.id === "string") && typeof value.method === "string";
}
function isAppServerNotification(value) {
  if (!isObjectRecord(value))
    return false;
  return value.id === undefined && typeof value.method === "string" && NOTIFICATION_METHOD_SET.has(value.method);
}
function isAppServerResponseMessage(value) {
  if (!isObjectRecord(value))
    return false;
  return (typeof value.id === "number" || typeof value.id === "string") && value.method === undefined && (("result" in value) || ("error" in value));
}

// src/codex-adapter.ts
class CodexAdapter extends EventEmitter {
  static RESPONSE_TRACKING_TTL_MS = 30000;
  proc = null;
  appServerWs = null;
  tuiWs = null;
  proxyServer = null;
  threadId = null;
  nextInjectionId = -1;
  appPort;
  proxyPort;
  logFile;
  tuiConnId = 0;
  connIdCounter = 0;
  secondaryConnections = new Map;
  agentMessageBuffers = new Map;
  pendingRequests = new Map;
  activeTurnIds = new Set;
  turnInProgress = false;
  nextProxyId = 1e5;
  upstreamToClient = new Map;
  serverRequestToProxy = new Map;
  pendingServerRequests = [];
  pendingServerResponses = new Map;
  staleProxyIds = new Map;
  bridgeRequestIds = new Map;
  intentionalDisconnect = false;
  pendingTuiMessages = [];
  reconnectingForNewSession = false;
  replayingBufferedMessages = false;
  appServerGeneration = 0;
  outageQueue = [];
  outageTimer = null;
  static OUTAGE_QUEUE_MAX = 64;
  static OUTAGE_TIMEOUT_MS = 5000;
  lastInitializeRaw = null;
  lastInitializedRaw = null;
  sessionRestoreInProgress = false;
  replayPending = new Map;
  static SESSION_REPLAY_TIMEOUT_MS = 5000;
  pairedChatId = null;
  injectedTurnIds = new Map;
  pendingInjectionHashes = new Map;
  pendingInjectionByReqId = new Map;
  static ECHO_DEDUP_TTL_MS = 60000;
  static PENDING_HASH_TTL_MS = 5000;
  _pairId;
  constructor(opts) {
    super();
    this._pairId = opts.pairId ?? "default";
    this.appPort = opts.appPort;
    this.proxyPort = opts.proxyPort;
    this.logFile = opts.logFile ?? new StateDirResolver().logFile;
  }
  get pairId() {
    return this._pairId;
  }
  get appServerUrl() {
    return `ws://127.0.0.1:${this.appPort}`;
  }
  get proxyUrl() {
    return `ws://127.0.0.1:${this.proxyPort}`;
  }
  get activeThreadId() {
    return this.threadId;
  }
  async start() {
    this.intentionalDisconnect = false;
    await this.checkPorts();
    this.log(`Spawning codex app-server on ${this.appServerUrl}`);
    this.proc = spawn("codex", ["app-server", "--listen", this.appServerUrl], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => this.emit("exit", code));
    const stderrRl = createInterface({ input: this.proc.stderr });
    stderrRl.on("line", (l) => this.log(`[codex-server] ${l}`));
    const stdoutRl = createInterface({ input: this.proc.stdout });
    stdoutRl.on("line", (l) => this.log(`[codex-stdout] ${l}`));
    await this.waitForHealthy();
    await this.connectToAppServer();
    this.startProxy();
    this.log(`Proxy ready on ${this.proxyUrl}`);
  }
  disconnect() {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.outageQueue = [];
    this.clearOutageTimer();
    this.appServerWs?.close();
    this.appServerWs = null;
    for (const [id, sec] of this.secondaryConnections) {
      try {
        sec.appServerWs?.close();
      } catch {}
      this.secondaryConnections.delete(id);
    }
    this.proxyServer?.stop();
    this.proxyServer = null;
    this.clearResponseTrackingState();
  }
  stop() {
    this.intentionalDisconnect = true;
    this.disconnect();
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 2000);
      proc.on("exit", () => clearTimeout(killTimer));
    }
  }
  injectMessage(text) {
    if (!this.threadId) {
      this.log("Cannot inject: no active thread");
      return false;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      this.log("Cannot inject: app-server WebSocket not connected");
      return false;
    }
    if (this.sessionRestoreInProgress) {
      this.log(`Rejected injection: shared Codex TUI session restore in progress`);
      return false;
    }
    if (this.turnInProgress) {
      this.log(`Rejected injection: Codex turn is in progress (thread ${this.threadId})`);
      return false;
    }
    this.log(`Injecting message into Codex (${text.length} chars)`);
    const requestId = this.nextInjectionId--;
    this.trackBridgeRequestId(requestId);
    const contentHash = this.hashInjectionContent(text);
    this.pendingInjectionHashes.set(contentHash, Date.now() + CodexAdapter.PENDING_HASH_TTL_MS);
    this.pendingInjectionByReqId.set(requestId, contentHash);
    try {
      this.appServerWs.send(JSON.stringify({
        method: "turn/start",
        id: requestId,
        params: { threadId: this.threadId, input: [{ type: "text", text }] }
      }));
      return true;
    } catch (err) {
      this.untrackBridgeRequestId(requestId);
      this.pendingInjectionByReqId.delete(requestId);
      this.pendingInjectionHashes.delete(contentHash);
      this.log(`Injection send failed: ${err.message}`);
      return false;
    }
  }
  setPairedChat(chatId) {
    this.pairedChatId = chatId;
    this.log(`Paired chat set to: ${chatId ?? "<none>"}`);
  }
  isPaired(chatId) {
    return this.pairedChatId !== null && this.pairedChatId === chatId;
  }
  get currentPairedChatId() {
    return this.pairedChatId;
  }
  hashInjectionContent(text) {
    return createHash("sha1").update(text).digest("hex").slice(0, 16);
  }
  isEchoOfInjection(content, turnId) {
    if (typeof turnId === "string" && turnId.length > 0) {
      const expiresAt = this.injectedTurnIds.get(turnId);
      if (expiresAt !== undefined) {
        if (Date.now() <= expiresAt)
          return true;
        this.injectedTurnIds.delete(turnId);
      }
    }
    const hash = this.hashInjectionContent(content);
    const hashExpiresAt = this.pendingInjectionHashes.get(hash);
    if (hashExpiresAt !== undefined) {
      if (Date.now() <= hashExpiresAt) {
        this.pendingInjectionHashes.delete(hash);
        return true;
      }
      this.pendingInjectionHashes.delete(hash);
    }
    return false;
  }
  recordInjectedTurnId(turnId, contentHash) {
    this.injectedTurnIds.set(turnId, Date.now() + CodexAdapter.ECHO_DEDUP_TTL_MS);
    if (contentHash)
      this.pendingInjectionHashes.delete(contentHash);
  }
  async waitForHealthy(maxRetries = 20, delayMs = 500) {
    for (let i = 0;i < maxRetries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.appPort}/healthz`);
        if (res.ok)
          return;
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error("Codex app-server failed to become healthy");
  }
  connectToAppServer(isReconnect = false) {
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
        if (isReconnect) {
          this.handleSessionRestoreAfterReconnect().finally(() => this.drainOutageQueue()).catch((e) => {
            const m = e instanceof Error ? e.message : String(e);
            this.log(`session restore unexpected error: ${m}`);
          });
        } else {
          this.drainOutageQueue();
        }
        resolve();
      };
      appWs.onmessage = (event) => {
        if (this.appServerGeneration !== generation)
          return;
        const data = typeof event.data === "string" ? event.data : event.data.toString();
        const forwarded = this.handleAppServerPayload(data);
        if (forwarded === null)
          return;
        if (this.tuiWs) {
          try {
            this.tuiWs.send(forwarded);
          } catch (e) {
            this.log(`Failed to forward message to TUI: ${e.message}`);
          }
        } else {
          this.log("WARNING: response from app-server but no TUI connected, message dropped");
        }
      };
      appWs.onerror = () => {
        if (this.appServerGeneration !== generation)
          return;
        this.log("App-server connection error");
        if (!isReconnect)
          reject(new Error("Failed to connect to app-server"));
      };
      appWs.onclose = () => {
        if (this.appServerGeneration !== generation)
          return;
        this.handleAppServerClose();
      };
    });
  }
  async reconnectAppServerForNewSession(tuiWs) {
    this.appServerGeneration++;
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const oldWs = this.appServerWs;
    this.appServerWs = null;
    if (oldWs) {
      try {
        oldWs.close();
      } catch {}
    }
    this.clearResponseTrackingStateForAppServerReconnect();
    this.activeTurnIds.clear();
    this.turnInProgress = false;
    try {
      await this.connectToAppServer(false);
      this.log("App-server reconnected for new TUI session \u2014 replaying buffered messages");
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
    } catch (err) {
      this.log(`Failed to reconnect app-server for new session: ${err.message}`);
      this.pendingTuiMessages = [];
      this.reconnectingForNewSession = false;
      this.intentionalDisconnect = false;
      this.scheduleReconnect();
    }
  }
  reconnectAttempts = 0;
  reconnectTimer = null;
  static MAX_RECONNECT_ATTEMPTS = 10;
  static RECONNECT_BASE_DELAY_MS = 1000;
  scheduleReconnect() {
    if (!this.proc)
      return;
    if (this.reconnectAttempts >= CodexAdapter.MAX_RECONNECT_ATTEMPTS) {
      this.log(`App-server reconnect failed after ${this.reconnectAttempts} attempts. Giving up.`);
      this.emit("error", new Error("App-server connection lost and reconnect failed"));
      return;
    }
    const delay = Math.min(CodexAdapter.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts), 30000);
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
  handleAppServerClose() {
    const intentional = this.intentionalDisconnect;
    const tuiConnected = this.tuiWs !== null;
    this.log(`App-server connection closed (intentional=${intentional}, tuiConnected=${tuiConnected}, turnInProgress=${this.turnInProgress})`);
    this.appServerWs = null;
    this.clearResponseTrackingState();
    this.activeTurnIds.clear();
    this.turnInProgress = false;
    if (!intentional) {
      this.scheduleReconnect();
    }
  }
  bufferDuringOutage(ws, raw) {
    if (this.outageQueue.length >= CodexAdapter.OUTAGE_QUEUE_MAX) {
      this.log(`ERROR: outage queue overflow (${this.outageQueue.length}/${CodexAdapter.OUTAGE_QUEUE_MAX}) \u2014 closing TUI with 1011`);
      this.outageQueue = [];
      this.clearOutageTimer();
      if (this.tuiWs && this.tuiWs === ws) {
        try {
          ws.close(1011, "agentbridge: app-server unavailable; pending TUI queue overflow");
        } catch (e) {
          this.log(`Failed to close TUI WS after outage queue overflow: ${e.message}`);
        }
      }
      return;
    }
    this.outageQueue.push({ raw, connId: ws.data.connId });
    this.log(`DIAGNOSTIC: buffered TUI message while app-server unavailable (queue size=${this.outageQueue.length}/${CodexAdapter.OUTAGE_QUEUE_MAX})`);
    this.ensureOutageTimer();
  }
  ensureOutageTimer() {
    if (this.outageTimer !== null)
      return;
    this.outageTimer = setTimeout(() => {
      this.outageTimer = null;
      const buffered = this.outageQueue.length;
      this.outageQueue = [];
      this.log(`ERROR: app-server did not return within ${CodexAdapter.OUTAGE_TIMEOUT_MS}ms (buffered=${buffered}) \u2014 closing TUI with 1011`);
      const ws = this.tuiWs;
      if (ws) {
        try {
          ws.close(1011, `agentbridge: app-server unavailable after ${CodexAdapter.OUTAGE_TIMEOUT_MS}ms; buffered=${buffered}`);
        } catch (e) {
          this.log(`Failed to close TUI WS on outage timeout: ${e.message}`);
        }
      }
    }, CodexAdapter.OUTAGE_TIMEOUT_MS);
  }
  clearOutageTimer() {
    if (this.outageTimer !== null) {
      clearTimeout(this.outageTimer);
      this.outageTimer = null;
    }
  }
  async handleSessionRestoreAfterReconnect() {
    if (!this.lastInitializeRaw) {
      this.log("DIAGNOSTIC: no cached initialize to replay after unintentional reconnect");
      return;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      this.log("DIAGNOSTIC: app-server not open at session restore start \u2014 skipping");
      return;
    }
    this.sessionRestoreInProgress = true;
    this.emit("sessionRestoreStart", { threadId: this.threadId });
    let restoreSucceeded = false;
    try {
      this.log(`DIAGNOSTIC: replaying cached initialize to restore session (threadId=${this.threadId ?? "none"})`);
      await this.sendReplayAndAwait(this.lastInitializeRaw, "initialize");
      if (this.lastInitializedRaw && this.appServerWs.readyState === WebSocket.OPEN) {
        this.appServerWs.send(this.lastInitializedRaw);
      }
      if (this.threadId && this.appServerWs.readyState === WebSocket.OPEN) {
        const replayId = `agentbridge-replay-thread-resume-${Date.now()}`;
        const resumeRaw = JSON.stringify({
          jsonrpc: "2.0",
          id: replayId,
          method: "thread/resume",
          params: { threadId: this.threadId }
        });
        await this.sendReplayAndAwait(resumeRaw, "thread/resume");
      }
      this.log(`DIAGNOSTIC: session restored after unintentional reconnect (threadId=${this.threadId ?? "none"})`);
      restoreSucceeded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`ERROR: session restore failed (${msg}) \u2014 closing TUI with 1011`);
      const tuiWs = this.tuiWs;
      if (tuiWs) {
        try {
          tuiWs.close(1011, `agentbridge: session restore failed: ${msg}`);
        } catch (closeErr) {
          const cm = closeErr instanceof Error ? closeErr.message : String(closeErr);
          this.log(`Failed to close TUI after session restore failure: ${cm}`);
        }
      }
    } finally {
      this.sessionRestoreInProgress = false;
      this.emit("sessionRestoreEnd", { threadId: this.threadId, ok: restoreSucceeded });
    }
  }
  get isSessionRestoreInProgress() {
    return this.sessionRestoreInProgress;
  }
  sendReplayAndAwait(raw, method) {
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("app-server not open"));
    }
    let id;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.id === undefined) {
        return Promise.reject(new Error(`replay payload for ${method} has no id`));
      }
      id = parsed.id;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return Promise.reject(new Error(`replay parse failed for ${method}: ${m}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replayPending.delete(id);
        reject(new Error(`replay timeout (${CodexAdapter.SESSION_REPLAY_TIMEOUT_MS}ms) for ${method} id=${JSON.stringify(id)}`));
      }, CodexAdapter.SESSION_REPLAY_TIMEOUT_MS);
      this.replayPending.set(id, { method, resolve, reject, timer });
      try {
        this.appServerWs.send(raw);
      } catch (e) {
        clearTimeout(timer);
        this.replayPending.delete(id);
        const m = e instanceof Error ? e.message : String(e);
        reject(new Error(`replay send failed for ${method}: ${m}`));
      }
    });
  }
  tryConsumeReplayResponse(payload) {
    const id = payload.id;
    if (id === undefined)
      return false;
    const pending = this.replayPending.get(id);
    if (!pending)
      return false;
    clearTimeout(pending.timer);
    this.replayPending.delete(id);
    if (payload.error !== undefined) {
      const errMsg = typeof payload.error === "object" && payload.error !== null && "message" in payload.error ? String(payload.error.message ?? "unknown") : JSON.stringify(payload.error);
      pending.reject(new Error(`${pending.method} rejected: ${errMsg}`));
    } else {
      pending.resolve(payload);
    }
    return true;
  }
  drainOutageQueue() {
    if (this.outageQueue.length === 0) {
      this.clearOutageTimer();
      return;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN)
      return;
    const ws = this.tuiWs;
    if (!ws) {
      this.outageQueue = [];
      this.clearOutageTimer();
      return;
    }
    const messages = this.outageQueue;
    this.outageQueue = [];
    this.clearOutageTimer();
    this.log(`DIAGNOSTIC: replaying ${messages.length} buffered TUI messages after app-server reconnect`);
    for (const msg of messages) {
      try {
        this.onTuiMessage(ws, msg.raw);
      } catch (e) {
        this.log(`Failed to replay buffered TUI message (conn #${msg.connId}): ${e.message}`);
      }
    }
  }
  startProxy() {
    const self = this;
    this.proxyServer = Bun.serve({
      port: this.proxyPort,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
        const queryToken = url.searchParams.get("abg_token") ?? "";
        const authHeader = req.headers.get("authorization") ?? "";
        const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
        const token = bearerToken || queryToken;
        const tokenSource = bearerToken ? "authorization" : queryToken ? "query" : "none";
        self.log(`HTTP ${req.method} ${url.pathname} (upgrade=${isUpgrade}, token=${token ? token.slice(0, 8) + "\u2026" : "<none>"}, tokenSource=${tokenSource})`);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          return fetch(`http://127.0.0.1:${self.appPort}${url.pathname}`);
        }
        if (server.upgrade(req, { data: { connId: 0, token } }))
          return;
        self.log(`WARNING: non-upgrade HTTP request not handled: ${req.method} ${url.pathname}`);
        return new Response("AgentBridge Codex Proxy");
      },
      websocket: {
        open: (ws) => self.onTuiConnect(ws),
        close: (ws, code, reason) => {
          self.log(`WebSocket close event: conn #${ws.data.connId}, code=${code}, reason=${reason || "none"}`);
          self.onTuiDisconnect(ws);
        },
        message: (ws, msg) => self.onTuiMessage(ws, msg)
      }
    });
  }
  onTuiConnect(ws) {
    const connId = ++this.connIdCounter;
    ws.data.connId = connId;
    if (this.tuiWs) {
      const primaryToken = this.tuiWs.data.token;
      const newToken = ws.data.token;
      if (primaryToken !== newToken) {
        this.log(`Rejecting second proxy TUI: token mismatch (primary conn #${this.tuiConnId} token=${primaryToken ? primaryToken.slice(0, 8) + "\u2026" : "<none>"}, new conn #${connId} token=${newToken ? newToken.slice(0, 8) + "\u2026" : "<none>"})`);
        try {
          ws.close(4002, "another --via-proxy TUI is already connected");
        } catch (err) {
          this.log(`Failed to close rejected second TUI cleanly: ${err.message}`);
        }
        return;
      }
      this.log(`Secondary TUI connected (conn #${connId}, primary is #${this.tuiConnId}, token matches)`);
      this.setupSecondaryConnection(ws, connId);
      return;
    }
    const previousConnId = this.tuiConnId > 0 ? this.tuiConnId : null;
    this.tuiConnId = connId;
    this.tuiWs = ws;
    this.threadId = null;
    this.log(`TUI connected (conn #${this.tuiConnId}, token=${ws.data.token ? ws.data.token.slice(0, 8) + "\u2026" : "<none>"})`);
    this.emit("tuiConnected", this.tuiConnId, ws.data.token);
    if (previousConnId !== null) {
      this.retireConnectionState(previousConnId);
    }
  }
  setupSecondaryConnection(ws, connId) {
    const appWs = new WebSocket(this.appServerUrl);
    const entry = { tuiWs: ws, appServerWs: appWs, buffer: [] };
    this.secondaryConnections.set(connId, entry);
    appWs.onopen = () => {
      if (!this.secondaryConnections.has(connId)) {
        appWs.close();
        return;
      }
      this.log(`Secondary conn #${connId}: app-server WS connected, flushing ${entry.buffer.length} buffered messages`);
      for (const msg of entry.buffer) {
        try {
          appWs.send(msg);
        } catch {}
      }
      entry.buffer = [];
    };
    appWs.onmessage = (event) => {
      if (!this.secondaryConnections.has(connId))
        return;
      const data = typeof event.data === "string" ? event.data : event.data.toString();
      try {
        ws.send(data);
      } catch {}
    };
    appWs.onerror = () => {
      this.log(`Secondary conn #${connId}: app-server WS error`);
    };
    appWs.onclose = () => {
      this.log(`Secondary conn #${connId}: app-server WS closed`);
      const sec = this.secondaryConnections.get(connId);
      if (sec) {
        this.secondaryConnections.delete(connId);
        try {
          sec.tuiWs.close();
        } catch {}
      }
    };
  }
  replayPendingForThread(resumedThreadId, ws) {
    const remaining = [];
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
          threadId: buffered.threadId
        });
        if (buffered.threadId === null) {
          this.log(`WARNING: Replaying pending server request with unknown threadId (experimental fallback, may surface orphan UI on wrong thread): ${buffered.method} (server id=${buffered.serverId} \u2192 proxy id=${proxyId})`);
        } else {
          this.log(`Replayed buffered server request on thread/resume: ${buffered.method} (server id=${buffered.serverId} \u2192 proxy id=${proxyId}, threadId=${buffered.threadId})`);
        }
      } catch (e) {
        this.log(`Failed to replay buffered server request: ${buffered.method} (server id=${buffered.serverId}): ${e.message}`);
        remaining.push(buffered);
      }
    }
    this.pendingServerRequests = remaining;
  }
  dropOrphanPendingRequests(reason, matchThreadId = null) {
    if (this.pendingServerRequests.length === 0)
      return;
    const remaining = [];
    for (const buffered of this.pendingServerRequests) {
      const shouldDrop = matchThreadId === null ? true : buffered.threadId !== null && buffered.threadId !== matchThreadId;
      if (shouldDrop) {
        this.log(`Dropped orphan pending server request: ${buffered.method} (server id=${buffered.serverId}, threadId=${buffered.threadId ?? "unknown"}, reason=${reason})`);
        continue;
      }
      remaining.push(buffered);
    }
    this.pendingServerRequests = remaining;
  }
  onTuiDisconnect(ws) {
    const connId = ws.data.connId;
    const secondary = this.secondaryConnections.get(connId);
    if (secondary) {
      this.log(`Secondary TUI disconnected (conn #${connId})`);
      this.secondaryConnections.delete(connId);
      if (secondary.appServerWs) {
        try {
          secondary.appServerWs.close();
        } catch {}
      }
      return;
    }
    if (this.tuiWs === ws) {
      const appServerOpen = this.appServerWs?.readyState === WebSocket.OPEN;
      this.log(`TUI disconnected (conn #${connId}, appServerOpen=${appServerOpen}, turnInProgress=${this.turnInProgress}, pendingTuiMessages=${this.pendingTuiMessages.length}, outageQueue=${this.outageQueue.length}, reconnectingForNewSession=${this.reconnectingForNewSession})`);
      this.tuiWs = null;
      if (this.reconnectingForNewSession) {
        this.log("Clearing pending TUI message buffer (TUI disconnected during app-server reconnect)");
        this.pendingTuiMessages = [];
        this.reconnectingForNewSession = false;
      }
      if (this.outageQueue.length > 0 || this.outageTimer !== null) {
        this.log(`Clearing outage queue on TUI disconnect (buffered=${this.outageQueue.length})`);
        this.outageQueue = [];
        this.clearOutageTimer();
      }
      this.emit("tuiDisconnected", connId);
    } else {
      this.log(`Stale TUI disconnected (conn #${connId}, current is #${this.tuiConnId})`);
    }
    this.retireConnectionState(connId);
  }
  onTuiMessage(ws, msg) {
    const data = typeof msg === "string" ? msg : msg.toString();
    const connId = ws.data.connId;
    const secondary = this.secondaryConnections.get(connId);
    if (secondary) {
      if (secondary.appServerWs && secondary.appServerWs.readyState === WebSocket.OPEN) {
        try {
          secondary.appServerWs.send(data);
        } catch {}
      } else {
        secondary.buffer.push(data);
      }
      return;
    }
    if (connId !== this.tuiConnId) {
      this.log(`Dropping message from stale TUI conn #${connId} (current is #${this.tuiConnId})`);
      return;
    }
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
            this.log(`TUI \u2192 app-server: ${pending.method} response (proxy id=${normalizedId} \u2192 server id=${pending.serverId})`);
          } catch (e) {
            this.bufferPendingServerResponse(normalizedId, pending, forwardedResponse, `send failed: ${e.message}`);
          }
          return;
        }
      }
    } catch {}
    let detectedMethod;
    try {
      const parsed = JSON.parse(data);
      detectedMethod = typeof parsed.method === "string" ? parsed.method : undefined;
    } catch {}
    if (!this.replayingBufferedMessages) {
      if (detectedMethod === "initialize") {
        this.lastInitializeRaw = data;
        this.log("Detected initialize \u2014 reconnecting app-server for fresh session");
        this.reconnectingForNewSession = true;
        this.pendingTuiMessages = [data];
        this.reconnectAppServerForNewSession(ws);
        return;
      }
      if (this.reconnectingForNewSession) {
        this.pendingTuiMessages.push(data);
        return;
      }
    }
    if (detectedMethod === "initialized") {
      this.lastInitializedRaw = data;
    }
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN || this.sessionRestoreInProgress) {
      if (this.tuiWs && this.tuiWs === ws) {
        this.bufferDuringOutage(ws, data);
      } else {
        this.log(`WARNING: non-primary TUI attempted to send while app-server down \u2014 dropped (connId=${connId})`);
      }
      return;
    }
    let forwarded = data;
    try {
      const parsed = JSON.parse(data);
      const method = parsed.method ?? `response:${parsed.id}`;
      this.log(`TUI \u2192 app-server: ${method}`);
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
      this.log(`TUI \u2192 app-server: (unparseable)`);
    }
    if (this.appServerWs?.readyState === WebSocket.OPEN) {
      this.appServerWs.send(forwarded);
    } else {
      this.log(`WARNING: app-server closed between OPEN check and send \u2014 message lost (connId=${ws.data.connId})`);
    }
  }
  handleAppServerPayload(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
        if (this.tryConsumeReplayResponse(parsed)) {
          return null;
        }
      }
      if (isAppServerNotification(parsed) || typeof parsed === "object" && parsed !== null && !("id" in parsed)) {
        const notificationLike = parsed;
        if (notificationLike.method === "thread/closed") {
          const params = notificationLike.params;
          const threadId = typeof params?.threadId === "string" ? params.threadId : "unknown";
          this.log(`DIAGNOSTIC: app-server emitted thread/closed (threadId=${threadId}) \u2014 TUI will exit(0) silently`);
        }
        const forwarded = this.patchResponse(notificationLike, raw);
        this.interceptServerMessage(notificationLike);
        return forwarded;
      }
      if (isAppServerRequestMessage(parsed)) {
        this.handleServerRequest(parsed, raw);
        return null;
      }
      if (isAppServerResponseMessage(parsed)) {
        return this.handleAppServerResponse(parsed, raw);
      }
      this.log(`Dropping unclassifiable app-server message: ${raw.slice(0, 100)}`);
      return null;
    } catch {
      return raw;
    }
  }
  handleServerRequest(parsed, raw) {
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
    } catch (e) {
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
      threadId
    });
    this.log(`Server request: ${method} (server id=${serverId} \u2192 proxy id=${proxyId}, conn #${this.tuiConnId}, threadId=${threadId ?? "unknown"})`);
  }
  extractThreadIdFromParams(params) {
    if (typeof params !== "object" || params === null)
      return null;
    const tid = params.threadId;
    return typeof tid === "string" && tid.length > 0 ? tid : null;
  }
  normalizeNumericId(id) {
    if (typeof id === "number")
      return id;
    if (typeof id === "string" && /^-?\d+$/.test(id))
      return Number(id);
    return NaN;
  }
  bufferPendingServerResponse(proxyId, pending, forwardedResponse, reason) {
    this.pendingServerResponses.set(proxyId, {
      raw: forwardedResponse,
      serverId: pending.serverId,
      method: pending.method,
      timestamp: Date.now()
    });
    this.serverRequestToProxy.delete(proxyId);
    this.log(`Buffered approval response until app-server reconnect (${reason}) (proxy id=${proxyId} \u2192 server id=${pending.serverId})`);
  }
  flushPendingServerResponses() {
    if (!this.appServerWs || this.appServerWs.readyState !== WebSocket.OPEN)
      return;
    for (const [proxyId, pending] of this.pendingServerResponses.entries()) {
      try {
        this.appServerWs.send(pending.raw);
        this.pendingServerResponses.delete(proxyId);
        this.log(`Flushed buffered approval response after app-server reconnect (proxy id=${proxyId} \u2192 server id=${pending.serverId})`);
      } catch (e) {
        this.log(`Failed to flush buffered approval response (proxy id=${proxyId}): ${e.message}`);
        break;
      }
    }
  }
  handleAppServerResponse(parsed, raw) {
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
      this.log(`app-server \u2192 TUI: response (proxy id=${numericId} \u2192 client id=${String(mapping.clientId)}, conn #${mapping.connId})`);
      const forwarded = this.patchResponse(parsed, JSON.stringify(parsed));
      this.interceptServerMessage(parsed, mapping.connId);
      return forwarded;
    }
    if (!isNaN(numericId) && this.consumeBridgeRequestId(numericId)) {
      if (parsed.error) {
        this.log(`Bridge-originated request failed (id ${responseId}): ${parsed.error.message ?? "unknown error"}`);
        const contentHash = this.pendingInjectionByReqId.get(numericId);
        if (contentHash) {
          this.pendingInjectionHashes.delete(contentHash);
          this.pendingInjectionByReqId.delete(numericId);
        }
      } else {
        const result = parsed.result ?? {};
        const turnId = result.turn?.id;
        const contentHash = this.pendingInjectionByReqId.get(numericId);
        this.pendingInjectionByReqId.delete(numericId);
        if (typeof turnId === "string" && turnId.length > 0) {
          this.recordInjectedTurnId(turnId, contentHash);
          this.log(`Bridge-originated request completed (id ${responseId}, turnId=${turnId} dedup)`);
        } else {
          this.log(`Bridge-originated request completed (id ${responseId}, no turnId \u2014 falling back to content-hash dedup)`);
        }
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
  patchResponse(parsed, raw) {
    if (isAppServerResponseMessage(parsed) && parsed.error && parsed.id !== undefined) {
      const errMsg = parsed.error.message ?? "";
      if (errMsg.includes("rate limits") || errMsg.includes("rateLimits")) {
        this.log(`Patching rateLimits error \u2192 mock success (id: ${parsed.id})`);
        return JSON.stringify({
          id: parsed.id,
          result: {
            rateLimits: {
              limitId: null,
              limitName: null,
              primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: null },
              secondary: null,
              credits: null,
              planType: null
            },
            rateLimitsByLimitId: null
          }
        });
      }
    }
    return raw;
  }
  interceptServerMessage(msg, connId) {
    this.handleTrackedResponse(msg, connId);
    if ("method" in msg && typeof msg.method === "string" && isAppServerNotification(msg)) {
      this.handleServerNotification(msg);
    }
  }
  handleServerNotification(msg) {
    const { method, params } = msg;
    switch (method) {
      case "turn/started": {
        this.markTurnStarted(params?.turn?.id);
        break;
      }
      case "item/started": {
        const item = params?.item;
        if (item?.type === "agentMessage")
          this.agentMessageBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = params?.itemId;
        if (typeof itemId !== "string")
          break;
        const buf = this.agentMessageBuffers.get(itemId);
        if (buf && params?.delta)
          buf.push(params.delta);
        break;
      }
      case "item/completed": {
        const item = params?.item;
        if (item?.type === "agentMessage") {
          const content = this.extractContent(item);
          this.agentMessageBuffers.delete(item.id);
          if (content) {
            this.log(`Agent message completed (${content.length} chars)`);
            this.emit("agentMessage", {
              id: item.id,
              source: "codex",
              content,
              timestamp: Date.now()
            });
          }
        } else if (item?.type === "userMessage") {
          const content = this.extractContent(item);
          if (content) {
            const turnIdFromParams = typeof params?.turnId === "string" ? params.turnId : undefined;
            if (this.isEchoOfInjection(content, turnIdFromParams)) {
              this.log(`Suppressed userMessage echo (item ${item.id}, ${content.length} chars)`);
            } else {
              this.log(`User message from TUI (${content.length} chars)`);
              this.emit("userMessage", {
                id: item.id,
                source: "codex",
                content,
                timestamp: Date.now(),
                turnId: turnIdFromParams
              });
            }
          }
        }
        break;
      }
      case "turn/completed": {
        const wasInProgress = this.turnInProgress;
        const turnId = params?.turn?.id;
        this.markTurnCompleted(turnId);
        if (wasInProgress && !this.turnInProgress) {
          this.emit("turnCompleted", { turnId });
        }
        break;
      }
      case "error": {
        const errorParams = params ?? {};
        const detail = errorParams.error?.message ?? "(no error message)";
        const code = errorParams.error?.code;
        this.log(`App-server error notification: ${detail}${code !== undefined ? ` (code ${code})` : ""}`);
        this.emit("errorItem", { code, message: detail, data: errorParams.error?.data });
        break;
      }
      case "thread/closed": {
        const closedThreadId = params ?? {};
        this.emit("threadClosed", { threadId: closedThreadId.threadId });
        break;
      }
    }
  }
  extractContent(item) {
    if (item.content?.length) {
      return item.content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
    }
    return this.agentMessageBuffers.get(item.id)?.join("") ?? "";
  }
  pendingKey(rpcId, connId) {
    const base = this.requestKey(rpcId);
    if (!base)
      return null;
    return `${connId ?? this.tuiConnId}:${base}`;
  }
  trackPendingRequest(message, connId, _proxyId) {
    const rpcId = "id" in message ? message.id : undefined;
    const method = "method" in message && typeof message.method === "string" ? message.method : undefined;
    const key = this.pendingKey(rpcId, connId);
    if (!key || !isTrackedAppServerRequestMethod(method))
      return;
    const pending = { method };
    if (method === "turn/start") {
      const params = "params" in message && typeof message.params === "object" && message.params !== null ? message.params : undefined;
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
  handleTrackedResponse(message, connId) {
    const key = this.pendingKey(message?.id, connId);
    if (!key)
      return;
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      if (message?.result?.thread?.id) {
        this.log(`[track-resp] Unmatched response with thread.id=${message.result.thread.id}, key=${key}, pending keys=[${[...this.pendingRequests.keys()].join(",")}]`);
      }
      return;
    }
    this.pendingRequests.delete(key);
    if (message?.error) {
      this.log(`Tracked request failed (${pending.method}, id ${key}): ${message.error.message ?? "unknown error"}`);
      return;
    }
    switch (pending.method) {
      case "thread/start": {
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/start response ${key}`);
        }
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
  setActiveThreadId(threadId, reason) {
    if (this.threadId === threadId)
      return;
    const previousThreadId = this.threadId;
    this.threadId = threadId;
    if (previousThreadId) {
      this.log(`Active thread changed: ${previousThreadId} \u2192 ${threadId} (${reason})`);
      return;
    }
    this.log(`Thread detected: ${threadId} (${reason})`);
    this.emit("ready", threadId);
  }
  markTurnStarted(turnId) {
    const wasInProgress = this.turnInProgress;
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.add(turnId);
    } else {
      this.activeTurnIds.add(`unknown:${Date.now()}`);
    }
    this.turnInProgress = this.activeTurnIds.size > 0;
    if (!wasInProgress && this.turnInProgress) {
      this.emit("turnStarted", { turnId });
    }
  }
  markTurnCompleted(turnId) {
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.delete(turnId);
    } else {
      this.activeTurnIds.clear();
    }
    this.turnInProgress = this.activeTurnIds.size > 0;
  }
  requestKey(id) {
    if (typeof id === "number" || typeof id === "string")
      return String(id);
    return null;
  }
  retireConnectionState(connId) {
    const prefix = `${connId}:`;
    for (const key of this.pendingRequests.keys()) {
      if (key.startsWith(prefix))
        this.pendingRequests.delete(key);
    }
    for (const [upId, mapping] of this.upstreamToClient.entries()) {
      if (mapping.connId !== connId)
        continue;
      this.upstreamToClient.delete(upId);
      this.trackStaleProxyId(upId);
    }
    const requeuedServerRequests = [];
    for (const [proxyId, pending] of this.serverRequestToProxy.entries()) {
      if (pending.connId === connId) {
        this.serverRequestToProxy.delete(proxyId);
        requeuedServerRequests.push({
          raw: pending.raw,
          serverId: pending.serverId,
          method: pending.method,
          threadId: pending.threadId
        });
        this.log(`Requeued in-flight server request after TUI disconnect (proxy id=${proxyId}, server id=${pending.serverId}, method=${pending.method}, threadId=${pending.threadId ?? "unknown"})`);
      }
    }
    if (requeuedServerRequests.length === 0)
      return;
    this.pendingServerRequests.push(...requeuedServerRequests);
  }
  trackStaleProxyId(proxyId) {
    this.clearTrackedId(this.staleProxyIds, proxyId);
    const timer = setTimeout(() => {
      this.staleProxyIds.delete(proxyId);
    }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
    timer.unref?.();
    this.staleProxyIds.set(proxyId, timer);
  }
  consumeStaleProxyId(proxyId) {
    return this.clearTrackedId(this.staleProxyIds, proxyId);
  }
  trackBridgeRequestId(requestId) {
    this.clearTrackedId(this.bridgeRequestIds, requestId);
    const timer = setTimeout(() => {
      this.bridgeRequestIds.delete(requestId);
    }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
    timer.unref?.();
    this.bridgeRequestIds.set(requestId, timer);
  }
  consumeBridgeRequestId(requestId) {
    return this.clearTrackedId(this.bridgeRequestIds, requestId);
  }
  untrackBridgeRequestId(requestId) {
    this.clearTrackedId(this.bridgeRequestIds, requestId);
  }
  clearTrackedId(store, id) {
    const timer = store.get(id);
    if (!timer)
      return false;
    clearTimeout(timer);
    store.delete(id);
    return true;
  }
  clearTransientResponseTrackingState() {
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
  clearResponseTrackingState() {
    this.clearTransientResponseTrackingState();
    this.serverRequestToProxy.clear();
    this.pendingServerRequests = [];
    this.pendingServerResponses.clear();
  }
  clearResponseTrackingStateForAppServerReconnect() {
    this.clearTransientResponseTrackingState();
    for (const pending of this.serverRequestToProxy.values()) {
      this.pendingServerRequests.push({
        raw: pending.raw,
        serverId: pending.serverId,
        method: pending.method,
        threadId: pending.threadId
      });
      this.log(`Requeued in-flight server request on app-server reconnect (server id=${pending.serverId}, method=${pending.method}, threadId=${pending.threadId ?? "unknown"})`);
    }
    this.serverRequestToProxy.clear();
    this.pendingServerResponses.clear();
  }
  static buildPortListenLsofCommand(port) {
    return `lsof -ti tcp:${port} -sTCP:LISTEN`;
  }
  async checkPorts() {
    for (const port of [this.appPort, this.proxyPort]) {
      try {
        const pids = execSync(CodexAdapter.buildPortListenLsofCommand(port), {
          encoding: "utf-8"
        }).trim();
        if (!pids)
          continue;
        const pidList = pids.split(`
`).map((p) => p.trim()).filter(Boolean);
        const staleCodexPids = [];
        const foreignPids = [];
        for (const pid of pidList) {
          try {
            const cmdline = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8" }).trim();
            if (cmdline.includes("codex") && cmdline.includes("app-server")) {
              staleCodexPids.push(pid);
            } else {
              foreignPids.push(pid);
            }
          } catch {}
        }
        if (staleCodexPids.length > 0) {
          this.log(`Cleaning up stale codex app-server on port ${port}: PID(s) ${staleCodexPids.join(", ")}`);
          for (const pid of staleCodexPids) {
            try {
              execSync(`kill ${pid}`, { encoding: "utf-8" });
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (foreignPids.length > 0) {
          throw new Error(`Port ${port} is already in use by non-Codex process(es): PID(s) ${foreignPids.join(", ")}. ` + `Please stop the process or set a different port via ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} env var.`);
        }
        try {
          const remaining = execSync(CodexAdapter.buildPortListenLsofCommand(port), {
            encoding: "utf-8"
          }).trim();
          if (remaining) {
            throw new Error(`Port ${port} is still occupied (PID(s): ${remaining.replace(/\n/g, ", ")}) after cleanup. ` + `Please stop the process or set a different port via ${port === this.appPort ? "CODEX_WS_PORT" : "CODEX_PROXY_PORT"} env var.`);
          }
        } catch (err) {
          if (err.message?.includes("Port"))
            throw err;
        }
      } catch (err) {
        if (err.message?.includes("Port") || err.message?.includes("non-Codex"))
          throw err;
      }
    }
  }
  log(msg) {
    const line = `[${new Date().toISOString()}] [CodexAdapter] ${msg}
`;
    process.stderr.write(line);
    try {
      appendFileSync(this.logFile, line);
    } catch {}
  }
}

// src/claude-thread.ts
import { EventEmitter as EventEmitter2 } from "events";
import { appendFileSync as appendFileSync2 } from "fs";
var RPC_TIMEOUT_MS = 30000;

class ClaudeThread extends EventEmitter2 {
  chatId;
  appServerUrl;
  logFile;
  cwd;
  ws = null;
  threadId = null;
  nextId = 1;
  pending = new Map;
  turnInProgress = false;
  agentMessageBuffers = new Map;
  bootstrapped = false;
  closed = false;
  constructor(opts) {
    super();
    this.chatId = opts.chatId;
    this.appServerUrl = opts.appServerUrl;
    this.logFile = opts.logFile;
    this.cwd = opts.cwd;
  }
  get activeThreadId() {
    return this.threadId;
  }
  get isTurnInProgress() {
    return this.turnInProgress;
  }
  get isReady() {
    return this.bootstrapped && this.threadId !== null;
  }
  async bootstrap() {
    if (this.bootstrapped && this.threadId)
      return this.threadId;
    await this.openSocket();
    await this.callRpc("initialize", {
      clientInfo: { name: "agentbridge-claude-thread", version: "0.1.0" },
      capabilities: { experimentalApi: false }
    });
    const params = { approvalPolicy: "never" };
    if (this.cwd)
      params.cwd = this.cwd;
    const startRes = await this.callRpc("thread/start", params);
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
  injectMessage(text) {
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
        input: [{ type: "text", text }]
      }
    };
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.log(`inject send failed: ${err.message}`);
      return false;
    }
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ClaudeThread closed"));
    }
    this.pending.clear();
  }
  openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.appServerUrl);
      let settled = false;
      ws.onopen = () => {
        if (settled)
          return;
        settled = true;
        this.ws = ws;
        this.attachHandlers(ws);
        resolve();
      };
      ws.onerror = (e) => {
        if (settled)
          return;
        settled = true;
        reject(new Error(`ws connect failed: ${e?.message ?? "unknown"}`));
      };
      ws.onclose = (e) => {
        if (!settled) {
          settled = true;
          reject(new Error(`ws closed during handshake (code=${e?.code})`));
          return;
        }
      };
    });
  }
  attachHandlers(ws) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      this.handlePayload(raw);
    };
    ws.onclose = () => {
      this.log(`ws closed (chatId=${this.chatId}, threadId=${this.threadId})`);
      this.ws = null;
      this.emit("close");
    };
    ws.onerror = (e) => {
      this.log(`ws error: ${e?.message ?? "unknown"}`);
      this.emit("error", e);
    };
  }
  handlePayload(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed.id === "number" && this.pending.has(parsed.id) && (parsed.result !== undefined || parsed.error !== undefined)) {
      const pending = this.pending.get(parsed.id);
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(parsed.error).slice(0, 200)}`));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    if (parsed.id !== undefined && typeof parsed.method === "string") {
      const tid = parsed.params?.threadId;
      if (tid && this.threadId && tid !== this.threadId)
        return;
      this.respondToServerRequest(parsed.id, parsed.method, parsed.params);
      return;
    }
    if (typeof parsed.method === "string" && parsed.id === undefined) {
      const tid = parsed.params?.threadId;
      if (tid && this.threadId && tid !== this.threadId) {
        return;
      }
      this.handleNotification(parsed.method, parsed.params ?? {});
    }
  }
  handleNotification(method, params) {
    switch (method) {
      case "turn/started": {
        if (!this.turnInProgress) {
          this.turnInProgress = true;
          this.emit("turnStarted");
        }
        break;
      }
      case "item/started": {
        const item = params?.item;
        if (item?.type === "agentMessage")
          this.agentMessageBuffers.set(item.id, []);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = params?.itemId;
        const delta = params?.delta;
        if (typeof itemId === "string") {
          const buf = this.agentMessageBuffers.get(itemId);
          if (buf && typeof delta === "string")
            buf.push(delta);
        }
        break;
      }
      case "item/completed": {
        const item = params?.item;
        if (item?.type === "agentMessage") {
          const content = this.extractContent(item);
          this.agentMessageBuffers.delete(item.id);
          if (content) {
            const bridgeMsg = {
              id: item.id,
              source: "codex",
              content,
              timestamp: Date.now()
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
  extractContent(item) {
    if (item.content?.length) {
      return item.content.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
    }
    return this.agentMessageBuffers.get(item.id)?.join("") ?? "";
  }
  callRpc(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("callRpc: ws not open"));
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
  respondToServerRequest(id, method, _params) {
    let result;
    let error;
    switch (method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "accept" };
        this.log(`auto-accepted ${method} (id=${id})`);
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "accept" };
        this.log(`auto-accepted ${method} (id=${id})`);
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        result = { decision: "approved" };
        this.log(`auto-approved ${method} (id=${id})`);
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {} };
        this.log(`auto-denied permission widening for ${method} (id=${id})`);
        break;
      default:
        error = {
          code: -32601,
          message: `ClaudeThread received unknown server request method '${method}' with no handler`
        };
        this.log(`unknown server request method: ${method} (id=${id}) \u2014 replying -32601`);
        break;
    }
    const payload = { jsonrpc: "2.0", id };
    if (result !== undefined)
      payload.result = result;
    if (error !== undefined)
      payload.error = error;
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (err) {
      this.log(`failed to send server-request response: ${err?.message ?? err}`);
    }
  }
  log(s) {
    const line = `[${new Date().toISOString()}] [ClaudeThread:${this.chatId}] ${s}
`;
    process.stderr.write(line);
    try {
      appendFileSync2(this.logFile, line);
    } catch {}
  }
}

// src/message-filter.ts
var MARKER_REGEX = /^\s*\[(IMPORTANT|STATUS|FYI)\]\s*/i;
function parseMarker(content) {
  const match = content.match(MARKER_REGEX);
  if (!match)
    return { marker: "untagged", body: content };
  return {
    marker: match[1].toLowerCase(),
    body: content.slice(match[0].length)
  };
}
function classifyMessage(content, mode) {
  if (mode === "full")
    return { action: "forward", marker: "untagged" };
  const { marker } = parseMarker(content);
  switch (marker) {
    case "important":
      return { action: "forward", marker };
    case "status":
      return { action: "buffer", marker };
    case "fyi":
      return { action: "drop", marker };
    case "untagged":
      return { action: "forward", marker };
  }
}
var BRIDGE_CONTRACT_REMINDER = `[Bridge Contract] When sending agentMessage, put the marker at the very start of the message:
- [IMPORTANT] for decisions, reviews, completions, blockers
- [STATUS] for progress updates
- [FYI] for background context
The marker MUST be the first text in the message (e.g. "[IMPORTANT] Task done", not "Task done [IMPORTANT]").
Keep agentMessage for high-value communication only.

[Git Operations \u2014 FORBIDDEN]
You MUST NOT execute any git write commands. This includes but is not limited to:
git commit, git push, git pull, git fetch, git checkout -b, git branch, git merge, git rebase, git cherry-pick, git tag, git stash.
These commands write to the .git directory, which is blocked by your sandbox. Attempting them will cause your session to hang indefinitely.
Read-only git commands (git status, git log, git diff, git show, git rev-parse) are allowed.
All git write operations must be delegated to Claude Code via agentMessage. Report what you changed and let Claude handle branching, committing, and pushing.

[Role Guidance for Codex]
- Your default role: Implementer, Executor, Verifier
- Analytical/review tasks: Independent Analysis & Convergence
- Implementation tasks: Architect -> Builder -> Critic
- Debugging tasks: Hypothesis -> Experiment -> Interpretation
- Do not blindly follow Claude - challenge with evidence when you disagree
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:"`;
var REPLY_REQUIRED_INSTRUCTION = `

[\u26A0\uFE0F REPLY REQUIRED] Claude has explicitly requested a reply. You MUST send an agentMessage with [IMPORTANT] marker containing your response. This is a mandatory requirement \u2014 do not skip or use [STATUS]/[FYI] markers for this reply.`;
class StatusBuffer {
  onFlush;
  buffer = [];
  flushTimer = null;
  flushThreshold;
  flushTimeoutMs;
  paused = false;
  constructor(onFlush, options) {
    this.onFlush = onFlush;
    this.flushThreshold = options?.flushThreshold ?? 3;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? 15000;
  }
  get size() {
    return this.buffer.length;
  }
  pause() {
    this.paused = true;
    this.clearTimer();
  }
  resume() {
    this.paused = false;
    if (this.buffer.length > 0) {
      this.resetTimer();
      if (this.buffer.length >= this.flushThreshold) {
        this.flush("threshold reached after resume");
      }
    }
  }
  add(message) {
    this.buffer.push(message);
    if (this.paused)
      return;
    this.resetTimer();
    if (this.buffer.length >= this.flushThreshold) {
      this.flush("threshold reached");
    }
  }
  flush(reason) {
    if (this.buffer.length === 0)
      return;
    this.clearTimer();
    const combined = this.buffer.map((m) => parseMarker(m.content).body).join(`
---
`);
    const summary = {
      id: `status_summary_${Date.now()}`,
      source: "codex",
      content: `[STATUS summary \u2014 ${this.buffer.length} update(s), flushed: ${reason}]
${combined}`,
      timestamp: Date.now()
    };
    this.onFlush(summary);
    this.buffer = [];
  }
  dispose() {
    this.clearTimer();
    this.buffer = [];
  }
  clearTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
  resetTimer() {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush("timeout");
    }, this.flushTimeoutMs);
  }
}

// src/tui-connection-state.ts
class TuiConnectionState {
  options;
  bridgeReady = false;
  tuiConnected = false;
  disconnectNotificationShown = false;
  disconnectNotificationTimer = null;
  constructor(options) {
    this.options = options;
  }
  canReply() {
    if (!this.bridgeReady)
      return false;
    return this.tuiConnected || this.disconnectNotificationTimer !== null;
  }
  snapshot() {
    return {
      bridgeReady: this.bridgeReady,
      tuiConnected: this.tuiConnected,
      disconnectNotificationShown: this.disconnectNotificationShown,
      hasPendingDisconnectNotification: this.disconnectNotificationTimer !== null
    };
  }
  markBridgeReady() {
    this.bridgeReady = true;
    this.disconnectNotificationShown = false;
    this.clearPendingDisconnectNotification("thread became ready");
  }
  handleTuiConnected(connId) {
    const reconnectingAfterNotice = this.disconnectNotificationShown && this.bridgeReady;
    this.tuiConnected = true;
    this.clearPendingDisconnectNotification(`TUI reconnected as conn #${connId}`);
    if (reconnectingAfterNotice) {
      this.disconnectNotificationShown = false;
      this.options.onReconnectAfterNotice(connId);
    }
  }
  handleTuiDisconnected(connId) {
    this.tuiConnected = false;
    if (!this.bridgeReady) {
      this.options.log?.(`Suppressing pre-ready TUI disconnect notification (conn #${connId})`);
      return;
    }
    this.scheduleDisconnectNotification(connId);
  }
  handleCodexExit() {
    this.bridgeReady = false;
    this.tuiConnected = false;
    this.disconnectNotificationShown = false;
    this.clearPendingDisconnectNotification("Codex process exited");
  }
  dispose(reason = "disposed") {
    this.clearPendingDisconnectNotification(reason);
  }
  clearPendingDisconnectNotification(reason) {
    if (!this.disconnectNotificationTimer)
      return;
    clearTimeout(this.disconnectNotificationTimer);
    this.disconnectNotificationTimer = null;
    if (reason) {
      this.options.log?.(`Cleared pending TUI disconnect notification (${reason})`);
    }
  }
  scheduleDisconnectNotification(connId) {
    this.clearPendingDisconnectNotification("rescheduled");
    this.disconnectNotificationTimer = setTimeout(() => {
      this.disconnectNotificationTimer = null;
      if (this.tuiConnected) {
        this.options.log?.(`Skipping TUI disconnect notification for conn #${connId} because TUI already reconnected`);
        return;
      }
      this.disconnectNotificationShown = true;
      this.options.log?.(`Codex TUI disconnect persisted past grace window (conn #${connId})`);
      this.options.onDisconnectPersisted(connId);
    }, this.options.disconnectGraceMs);
  }
}

// src/daemon-lifecycle.ts
import { spawn as spawn2, execFileSync } from "child_process";
import { existsSync as existsSync2, readFileSync, unlinkSync, writeFileSync, openSync, closeSync, constants } from "fs";
import { fileURLToPath } from "url";
var DAEMON_ENTRY = process.env.AGENTBRIDGE_DAEMON_ENTRY ?? "./daemon.ts";
var DAEMON_PATH = fileURLToPath(new URL(DAEMON_ENTRY, import.meta.url));

class DaemonLifecycle {
  stateDir;
  controlPort;
  log;
  constructor(opts) {
    this.stateDir = opts.stateDir;
    this.controlPort = opts.controlPort;
    this.log = opts.log;
  }
  get healthUrl() {
    return `http://127.0.0.1:${this.controlPort}/healthz`;
  }
  get readyUrl() {
    return `http://127.0.0.1:${this.controlPort}/readyz`;
  }
  get controlWsUrl() {
    return `ws://127.0.0.1:${this.controlPort}/ws`;
  }
  async ensureRunning() {
    if (await this.isHealthy()) {
      await this.waitForReady();
      return;
    }
    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        if (this.isDaemonProcess(existingPid)) {
          try {
            await this.waitForReady(12, 250);
            return;
          } catch {
            throw new Error(`Found existing daemon process ${existingPid}, but control port ${this.controlPort} never became ready.`);
          }
        }
        this.log(`Pid ${existingPid} is alive but not an AgentBridge daemon, removing stale pid file`);
      }
      this.removeStalePidFile();
    }
    const lockAcquired = this.acquireLock();
    if (!lockAcquired) {
      this.log("Another process is starting the daemon, waiting for readiness...");
      await this.waitForReady();
      return;
    }
    try {
      this.launch();
      await this.waitForReady();
    } finally {
      this.releaseLock();
    }
  }
  async isHealthy() {
    try {
      const response = await fetch(this.healthUrl);
      return response.ok;
    } catch {
      return false;
    }
  }
  async waitForHealthy(maxRetries = 40, delayMs = 250) {
    for (let attempt = 0;attempt < maxRetries; attempt++) {
      if (await this.isHealthy())
        return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon health on ${this.healthUrl}`);
  }
  async isReady() {
    try {
      const response = await fetch(this.readyUrl);
      return response.ok;
    } catch {
      return false;
    }
  }
  async waitForReady(maxRetries = 40, delayMs = 250) {
    for (let attempt = 0;attempt < maxRetries; attempt++) {
      if (await this.isReady())
        return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon readiness on ${this.readyUrl}`);
  }
  readStatus() {
    try {
      const raw = readFileSync(this.stateDir.statusFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  writeStatus(status) {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.statusFile, JSON.stringify(status, null, 2) + `
`, "utf-8");
  }
  readPid() {
    try {
      const raw = readFileSync(this.stateDir.pidFile, "utf-8").trim();
      if (!raw)
        return null;
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }
  writePid(pid) {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.pidFile, `${pid ?? process.pid}
`, "utf-8");
  }
  removePidFile() {
    try {
      unlinkSync(this.stateDir.pidFile);
    } catch {}
  }
  removeStatusFile() {
    try {
      unlinkSync(this.stateDir.statusFile);
    } catch {}
  }
  markKilled() {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.killedFile, `${Date.now()}
`, "utf-8");
  }
  clearKilled() {
    try {
      unlinkSync(this.stateDir.killedFile);
    } catch {}
  }
  wasKilled() {
    return existsSync2(this.stateDir.killedFile);
  }
  launch() {
    this.stateDir.ensure();
    this.log(`Launching detached daemon on control port ${this.controlPort}`);
    const daemonProc = spawn2(process.execPath, ["run", DAEMON_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTBRIDGE_CONTROL_PORT: String(this.controlPort),
        AGENTBRIDGE_STATE_DIR: this.stateDir.dir
      },
      detached: true,
      stdio: "ignore"
    });
    daemonProc.unref();
  }
  removeStalePidFile() {
    this.log("Removing stale pid file");
    this.removePidFile();
  }
  acquireLock(depth = 0) {
    if (depth > 1) {
      this.log("Lock acquisition failed after retry, proceeding without lock");
      return true;
    }
    this.stateDir.ensure();
    try {
      const fd = openSync(this.stateDir.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
`);
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const holderPid = Number.parseInt(readFileSync(this.stateDir.lockFile, "utf-8").trim(), 10);
          if (Number.isFinite(holderPid) && !isProcessAlive(holderPid)) {
            this.log(`Stale lock file from dead process ${holderPid}, removing`);
            this.releaseLock();
            return this.acquireLock(depth + 1);
          }
        } catch {
          this.log("Cannot read lock file, removing stale lock");
          this.releaseLock();
          return this.acquireLock(depth + 1);
        }
        return false;
      }
      this.log(`Warning: could not acquire startup lock: ${err.message}`);
      return true;
    }
  }
  releaseLock() {
    try {
      unlinkSync(this.stateDir.lockFile);
    } catch {}
  }
  async kill(gracefulTimeoutMs = 3000) {
    const pid = this.readPid();
    if (!pid) {
      this.log("No daemon pid file found");
      this.cleanup();
      return false;
    }
    if (!isProcessAlive(pid)) {
      this.log(`Daemon pid ${pid} is not alive, cleaning up stale files`);
      this.cleanup();
      return false;
    }
    if (!this.isDaemonProcess(pid)) {
      this.log(`Pid ${pid} is alive but is NOT an AgentBridge daemon \u2014 refusing to kill. Cleaning up stale pid file.`);
      this.cleanup();
      return false;
    }
    this.log(`Sending SIGTERM to daemon pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.cleanup();
      return false;
    }
    const deadline = Date.now() + gracefulTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        this.log(`Daemon pid ${pid} stopped gracefully`);
        this.cleanup();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.log(`Daemon pid ${pid} did not stop gracefully, sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    this.cleanup();
    return true;
  }
  isDaemonProcess(pid) {
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      return cmd.includes("daemon") && (cmd.includes("agentbridge") || cmd.includes("agent_bridge"));
    } catch {
      return false;
    }
  }
  cleanup() {
    this.removePidFile();
    this.removeStatusFile();
    this.releaseLock();
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/config-service.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, existsSync as existsSync3 } from "fs";
import { join as join2 } from "path";
var DEFAULT_CONFIG = {
  version: "1.0",
  codex: {
    appPort: 4500,
    proxyPort: 4501
  },
  turnCoordination: {
    attentionWindowSeconds: 15
  },
  idleShutdownSeconds: 30
};
var CONFIG_DIR = ".agentbridge";
var CONFIG_FILE = "config.json";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return fallback;
}
function normalizeConfig(raw) {
  if (!isRecord(raw))
    return null;
  const config = raw;
  const codex = isRecord(config.codex) ? config.codex : {};
  const daemon = isRecord(config.daemon) ? config.daemon : {};
  const turnCoordination = isRecord(config.turnCoordination) ? config.turnCoordination : {};
  return {
    version: typeof config.version === "string" ? config.version : DEFAULT_CONFIG.version,
    codex: {
      appPort: normalizeInteger(codex.appPort ?? daemon.port, DEFAULT_CONFIG.codex.appPort),
      proxyPort: normalizeInteger(codex.proxyPort ?? daemon.proxyPort, DEFAULT_CONFIG.codex.proxyPort)
    },
    turnCoordination: {
      attentionWindowSeconds: normalizeInteger(turnCoordination.attentionWindowSeconds, DEFAULT_CONFIG.turnCoordination.attentionWindowSeconds)
    },
    idleShutdownSeconds: normalizeInteger(config.idleShutdownSeconds, DEFAULT_CONFIG.idleShutdownSeconds)
  };
}

class ConfigService {
  configDir;
  configPath;
  constructor(projectRoot) {
    const root = projectRoot ?? process.cwd();
    this.configDir = join2(root, CONFIG_DIR);
    this.configPath = join2(this.configDir, CONFIG_FILE);
  }
  hasConfig() {
    return existsSync3(this.configPath);
  }
  load() {
    try {
      const raw = readFileSync2(this.configPath, "utf-8");
      return normalizeConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  loadOrDefault() {
    return this.load() ?? structuredClone(DEFAULT_CONFIG);
  }
  save(config) {
    this.ensureConfigDir();
    writeFileSync2(this.configPath, JSON.stringify(config, null, 2) + `
`, "utf-8");
  }
  initDefaults() {
    this.ensureConfigDir();
    const created = [];
    if (!existsSync3(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      created.push(this.configPath);
    }
    return created;
  }
  get configFilePath() {
    return this.configPath;
  }
  ensureConfigDir() {
    if (!existsSync3(this.configDir)) {
      mkdirSync2(this.configDir, { recursive: true });
    }
  }
}

// src/pair-registry.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, renameSync, mkdirSync as mkdirSync3, existsSync as existsSync4, unlinkSync as unlinkSync2 } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
var DEFAULT_PAIR_PORTS = { appPort: 4500, proxyPort: 4501 };
var STRIDE_BASE = 4510;
var STRIDE_STEP_DEFAULT = 10;
var STRIDE_MAX_DEFAULT = 20;
var MAX_PAIRS_DEFAULT = 8;
var PAIR_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function isValidPairName(name) {
  if (typeof name !== "string")
    return false;
  if (!PAIR_NAME_REGEX.test(name))
    return false;
  if (name === "." || name === "..")
    return false;
  return true;
}

class PairRegistry {
  entries = new Map;
  filePath;
  log;
  strideStep;
  strideMax;
  maxPairs;
  constructor(opts) {
    this.filePath = opts.filePath;
    this.log = opts.log ?? (() => {});
    this.strideStep = opts.strideStep ?? STRIDE_STEP_DEFAULT;
    this.strideMax = opts.strideMax ?? STRIDE_MAX_DEFAULT;
    this.maxPairs = opts.maxPairs ?? MAX_PAIRS_DEFAULT;
  }
  load() {
    this.entries.clear();
    if (!existsSync4(this.filePath)) {
      this.log(`[pair-registry] no registry file at ${this.filePath} \u2014 starting empty`);
      return;
    }
    let raw;
    try {
      raw = readFileSync3(this.filePath, "utf8");
    } catch (err) {
      this.log(`[pair-registry] failed to read ${this.filePath}: ${err?.message ?? err} \u2014 starting empty`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log(`[pair-registry] invalid JSON in ${this.filePath}: ${err?.message ?? err} \u2014 starting empty`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      this.log(`[pair-registry] unexpected registry shape (missing version/entries) \u2014 starting empty`);
      return;
    }
    for (const candidate of parsed.entries) {
      if (this.isValidEntry(candidate)) {
        this.entries.set(candidate.pairId, candidate);
      } else {
        this.log(`[pair-registry] dropping invalid entry: ${JSON.stringify(candidate)}`);
      }
    }
    this.log(`[pair-registry] loaded ${this.entries.size} entries from ${this.filePath}`);
  }
  isValidEntry(e) {
    return e !== null && typeof e === "object" && typeof e.pairId === "string" && isValidPairName(e.pairId) && typeof e.appPort === "number" && typeof e.proxyPort === "number" && Number.isInteger(e.appPort) && Number.isInteger(e.proxyPort) && e.appPort > 0 && e.proxyPort > 0 && e.appPort < 65536 && e.proxyPort < 65536 && typeof e.allocatedAt === "number";
  }
  save() {
    const dir = dirname(this.filePath);
    if (!existsSync4(dir))
      mkdirSync3(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(6).toString("hex")}`;
    const snapshot = {
      version: 1,
      entries: [...this.entries.values()]
    };
    try {
      writeFileSync3(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        if (existsSync4(tmp))
          unlinkSync2(tmp);
      } catch {}
      throw new Error(`[pair-registry] save failed: ${err?.message ?? err}`);
    }
  }
  get(pairId) {
    return this.entries.get(pairId) ?? null;
  }
  list() {
    return [...this.entries.values()];
  }
  has(pairId) {
    return this.entries.has(pairId);
  }
  allocate(pairId) {
    if (!isValidPairName(pairId)) {
      return {
        ok: false,
        error: {
          code: "INVALID_PAIR_NAME",
          message: `pair name "${pairId}" fails validation (regex ${PAIR_NAME_REGEX.source})`
        }
      };
    }
    const existing = this.entries.get(pairId);
    if (existing)
      return { ok: true, entry: existing };
    if (this.entries.size >= this.maxPairs) {
      return {
        ok: false,
        error: {
          code: "MAX_PAIRS",
          message: `pair registry is at the ${this.maxPairs}-entry limit; destroy an unused pair (--forget) before allocating a new one`
        }
      };
    }
    let appPort;
    let proxyPort;
    if (pairId === "default") {
      appPort = DEFAULT_PAIR_PORTS.appPort;
      proxyPort = DEFAULT_PAIR_PORTS.proxyPort;
      for (const other of this.entries.values()) {
        if (other.appPort === appPort || other.proxyPort === proxyPort) {
          return {
            ok: false,
            error: {
              code: "ALLOCATION_FAILED",
              message: `default pair's reserved ports (${appPort}, ${proxyPort}) collide with registry entry "${other.pairId}"`
            }
          };
        }
      }
    } else {
      const usedPorts = new Set;
      for (const e of this.entries.values()) {
        usedPorts.add(e.appPort);
        usedPorts.add(e.proxyPort);
      }
      usedPorts.add(DEFAULT_PAIR_PORTS.appPort);
      usedPorts.add(DEFAULT_PAIR_PORTS.proxyPort);
      let found = false;
      appPort = 0;
      proxyPort = 0;
      for (let i = 1;i <= this.strideMax; i++) {
        const candidateApp = STRIDE_BASE + this.strideStep * (i - 1);
        const candidateProxy = candidateApp + 1;
        if (!usedPorts.has(candidateApp) && !usedPorts.has(candidateProxy)) {
          appPort = candidateApp;
          proxyPort = candidateProxy;
          found = true;
          break;
        }
      }
      if (!found) {
        return {
          ok: false,
          error: {
            code: "ALLOCATION_FAILED",
            message: `no free stride within ${this.strideMax} positions starting at ${STRIDE_BASE} (step ${this.strideStep})`
          }
        };
      }
    }
    const entry = {
      pairId,
      appPort,
      proxyPort,
      allocatedAt: Date.now()
    };
    this.entries.set(pairId, entry);
    this.log(`[pair-registry] allocated pair="${pairId}" appPort=${appPort} proxyPort=${proxyPort}`);
    return { ok: true, entry };
  }
  remove(pairId) {
    if (!this.entries.has(pairId))
      return false;
    this.entries.delete(pairId);
    this.log(`[pair-registry] removed pair="${pairId}"`);
    return true;
  }
  size() {
    return this.entries.size;
  }
}

// src/control-protocol.ts
var CLOSE_CODE_REPLACED = 4001;

// src/daemon.ts
var stateDir = new StateDirResolver;
stateDir.ensure();
var configService = new ConfigService;
var config = configService.loadOrDefault();
var CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
var CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
var CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
var TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
var CLAUDE_DISCONNECT_GRACE_MS = 5000;
var CLAUDE_REAP_AFTER_MS = parseInt(process.env.AGENTBRIDGE_CLAUDE_REAP_MS ?? "600000", 10);
var PAIR_REAP_MS = parseInt(process.env.AGENTBRIDGE_PAIR_REAP_MS ?? "30000", 10);
var MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
var FILTER_MODE = process.env.AGENTBRIDGE_FILTER_MODE === "full" ? "full" : "filtered";
var IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
var ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);
var daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
var codex = new CodexAdapter({
  pairId: "default",
  appPort: CODEX_APP_PORT,
  proxyPort: CODEX_PROXY_PORT,
  logFile: stateDir.logFile
});
var attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;
var controlServer = null;
var nextControlClientId = 0;
var codexBootstrapped = false;
var shuttingDown = false;
var idleShutdownTimer = null;
var chats = new Map;
var proxyTuiSlot = null;
var tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    broadcastToAllClaudes(systemMessage("system_tui_disconnected", `\u26A0\uFE0F Codex TUI disconnected (conn #${connId}). Codex is still running in the background \u2014 reconnect the TUI to resume.`));
  },
  onReconnectAfterNotice: (connId) => {
    broadcastToAllClaudes(systemMessage("system_tui_reconnected", `\u2705 Codex TUI reconnected (conn #${connId}). Bridge restored.`));
  }
});
var defaultPairState = {
  pairId: "default",
  codex,
  tuiConnectionState,
  get proxyTuiSlot() {
    return proxyTuiSlot;
  },
  set proxyTuiSlot(v) {
    proxyTuiSlot = v;
  },
  handlerRefs: [],
  isLive: false
};
var pairs = new Map([["default", defaultPairState]]);
var pairRegistry = new PairRegistry({
  filePath: `${stateDir.dir}/pairs/registry.json`,
  log: (msg) => log(msg)
});
pairRegistry.load();
var registryWriteMutex = Promise.resolve();
async function runUnderRegistryMutex(fn) {
  const prev = registryWriteMutex;
  let release;
  registryWriteMutex = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release(undefined);
  }
}
runUnderRegistryMutex(async () => {
  if (!pairRegistry.has("default")) {
    const result = pairRegistry.allocate("default");
    if (result.ok) {
      try {
        pairRegistry.save();
      } catch (err) {
        log(`[pair-registry] failed to persist default entry: ${err?.message ?? err}`);
      }
    } else {
      log(`[pair-registry] failed to materialize default entry: ${result.error.code} \u2014 ${result.error.message}`);
    }
  }
});
function attachPairHandlers(pair) {
  if (pair.handlerRefs.length > 0) {
    log(`[pair=${pair.pairId}] attachPairHandlers called but ${pair.handlerRefs.length} handler(s) already attached \u2014 no-op`);
    return;
  }
  const on = (eventName, handler) => {
    pair.codex.on(eventName, handler);
    pair.handlerRefs.push({ eventName, handler });
  };
  const getPaired = () => {
    if (!pair.proxyTuiSlot?.pairedChatId)
      return null;
    return chats.get(pair.proxyTuiSlot.pairedChatId) ?? null;
  };
  on("ready", (threadId) => {
    pair.tuiConnectionState.markBridgeReady();
    log(`[pair=${pair.pairId}] Codex TUI thread ready: ${threadId} (bridge fully operational)`);
    if (pair.proxyTuiSlot) {
      pair.proxyTuiSlot.readiness = "ready";
      if (pair.proxyTuiSlot.pairedChatId) {
        const state = chats.get(pair.proxyTuiSlot.pairedChatId);
        if (state && !state.ready) {
          state.ready = true;
          emitToChat(state, systemMessage("system_pair_ready", `\u2705 Shared Codex TUI thread is now ready (threadId=${threadId}). Replies sent via the reply tool will appear in the right pane's TUI.`));
        }
      }
    }
  });
  on("tuiConnected", (connId, token = "") => {
    pair.tuiConnectionState.handleTuiConnected(connId);
    cancelIdleShutdown();
    log(`[pair=${pair.pairId}] Codex TUI connected (conn #${connId}, token=${token ? token.slice(0, 8) + "\u2026" : "<none>"})`);
    if (token && !pair.proxyTuiSlot) {
      pair.proxyTuiSlot = {
        token,
        pairedChatId: null,
        readiness: "not-ready",
        attachedAt: Date.now(),
        pairReapTimer: null
      };
      log(`[pair=${pair.pairId}] Proxy TUI slot allocated (token=${token.slice(0, 8)}\u2026)`);
    }
    broadcastStatus();
  });
  on("tuiDisconnected", (connId) => {
    pair.tuiConnectionState.handleTuiDisconnected(connId);
    log(`[pair=${pair.pairId}] Codex TUI disconnected (conn #${connId})`);
    if (pair.proxyTuiSlot) {
      const wasPairedChat = pair.proxyTuiSlot.pairedChatId;
      if (pair.proxyTuiSlot.pairReapTimer)
        clearTimeout(pair.proxyTuiSlot.pairReapTimer);
      pair.proxyTuiSlot = null;
      pair.codex.setPairedChat(null);
      if (wasPairedChat) {
        const state = chats.get(wasPairedChat);
        if (state) {
          log(`[pair=${pair.pairId}] Transitioning paired chat ${wasPairedChat} to isolated (TUI disconnect)`);
          transitionToIsolated(state, "Shared Codex TUI thread is gone");
        }
      }
    }
    broadcastStatus();
    scheduleIdleShutdown();
  });
  on("agentMessage", (msg) => {
    const paired = getPaired();
    if (!paired)
      return;
    log(`[${paired.chatId}] CodexAdapter \u2192 paired Claude (agentMessage, ${msg.content.length} chars)`);
    paired.pairedTurnSawAgentMessage = true;
    paired.replyReceivedDuringTurn = true;
    emitToChat(paired, msg);
  });
  on("userMessage", (payload) => {
    const paired = getPaired();
    if (!paired)
      return;
    if (!payload.content)
      return;
    log(`[${paired.chatId}] CodexAdapter \u2192 paired Claude (userMessage from TUI, ${payload.content.length} chars)`);
    paired.replyReceivedDuringTurn = true;
    emitToChat(paired, {
      id: payload.id ?? `tui_user_${Date.now()}`,
      source: "codex",
      content: `[IMPORTANT] Human typed in the paired Codex TUI:
${payload.content}`,
      timestamp: Date.now()
    });
  });
  on("turnStarted", () => {
    const paired = getPaired();
    if (!paired)
      return;
    paired.pairedTurnSawAgentMessage = false;
    emitToChat(paired, systemMessage("system_codex_turn_started", "[system] Codex turn started"));
  });
  on("turnCompleted", () => {
    const paired = getPaired();
    if (!paired)
      return;
    if (!paired.pairedTurnSawAgentMessage && paired.replyRequired) {
      log(`[${paired.chatId}] Codex turn completed with no agentMessage while replyRequired \u2014 surfacing as failure signal`);
      paired.replyReceivedDuringTurn = true;
      emitToChat(paired, systemMessage("system_codex_turn_completed_no_output", "[system] Codex turn completed without any agentMessage \u2014 likely a failure or empty response."));
    } else {
      emitToChat(paired, systemMessage("system_codex_turn_completed", "[system] Codex turn completed"));
    }
    paired.replyRequired = false;
    paired.replyReceivedDuringTurn = false;
  });
  on("errorItem", (payload) => {
    const paired = getPaired();
    if (!paired)
      return;
    paired.replyReceivedDuringTurn = true;
    emitToChat(paired, systemMessage("system_codex_error", `[error] ${payload.message ?? "(no message)"}${payload.code !== undefined ? ` (code ${payload.code})` : ""}`));
    paired.pairedTurnSawAgentMessage = true;
    paired.replyRequired = false;
    paired.replyReceivedDuringTurn = false;
  });
  on("sessionRestoreStart", () => {
    if (!pair.proxyTuiSlot)
      return;
    log(`[pair=${pair.pairId}] Shared Codex session restore started \u2014 flipping paired readiness to not-ready`);
    pair.proxyTuiSlot.readiness = "not-ready";
    const paired = getPaired();
    if (paired)
      paired.ready = false;
  });
  on("sessionRestoreEnd", (payload = {}) => {
    if (!pair.proxyTuiSlot)
      return;
    if (payload.ok === false) {
      log(`[pair=${pair.pairId}] Shared Codex session restore FAILED \u2014 keeping readiness=not-ready, awaiting TUI tear-down`);
      return;
    }
    log(`[pair=${pair.pairId}] Shared Codex session restore succeeded \u2014 flipping readiness back to ready`);
    pair.proxyTuiSlot.readiness = "ready";
    const paired = getPaired();
    if (paired) {
      paired.ready = true;
      emitToChat(paired, systemMessage("system_pair_restored", "\u2705 Shared Codex TUI session restored. Replies can flow again."));
    }
  });
  on("threadClosed", () => {
    const paired = getPaired();
    log(`[pair=${pair.pairId}] Codex emitted thread/closed`);
    if (pair.proxyTuiSlot) {
      const wasPairedChat = pair.proxyTuiSlot.pairedChatId;
      pair.proxyTuiSlot = null;
      pair.codex.setPairedChat(null);
      if (wasPairedChat && paired) {
        log(`[pair=${pair.pairId}] Transitioning paired chat ${wasPairedChat} to isolated (thread/closed)`);
        transitionToIsolated(paired, "Shared Codex thread closed");
      }
    }
  });
  on("error", (err) => {
    log(`[pair=${pair.pairId}] Codex error: ${err.message}`);
  });
  on("exit", (code) => {
    log(`[pair=${pair.pairId}] Codex app-server process exited (code ${code})`);
    codexBootstrapped = false;
    pair.isLive = false;
    pair.tuiConnectionState.handleCodexExit();
    broadcastToAllClaudes(systemMessage("system_codex_exit", `\u26A0\uFE0F Codex app-server exited (code ${code ?? "unknown"}). All ClaudeThread sessions terminated.`));
    for (const state of chats.values()) {
      try {
        state.thread.close();
      } catch {}
      state.ready = false;
    }
    broadcastStatus();
  });
}
function detachPairHandlers(pair) {
  for (const { eventName, handler } of pair.handlerRefs) {
    pair.codex.off(eventName, handler);
  }
  pair.handlerRefs = [];
}
attachPairHandlers(defaultPairState);
function getPairedChatState() {
  if (!proxyTuiSlot?.pairedChatId)
    return null;
  return chats.get(proxyTuiSlot.pairedChatId) ?? null;
}
function pairChat(state) {
  if (!proxyTuiSlot)
    return;
  if (proxyTuiSlot.pairedChatId)
    return;
  proxyTuiSlot.pairedChatId = state.chatId;
  state.paired = true;
  codex.setPairedChat(state.chatId);
  state.ready = proxyTuiSlot.readiness === "ready";
  log(`Paired chat ${state.chatId} with proxy TUI (readiness=${proxyTuiSlot.readiness})`);
  if (state.ready) {
    emitToChat(state, systemMessage("system_paired_ready", "\u2705 This Claude session is paired with the right-pane Codex TUI. Replies will appear there; user typing in the TUI will be forwarded to you with an [IMPORTANT] prefix."));
  } else {
    emitToChat(state, systemMessage("system_paired_provisioning", "\u2705 This Claude session is paired with the right-pane Codex TUI. Waiting for the shared thread to finish provisioning before replies can flow."));
  }
}
var ISOLATED_BOOTSTRAP_MAX_ATTEMPTS = parseInt(process.env.AGENTBRIDGE_ISOLATED_BOOTSTRAP_MAX_ATTEMPTS ?? "2", 10);
var ISOLATED_BOOTSTRAP_RETRY_DELAY_MS = parseInt(process.env.AGENTBRIDGE_ISOLATED_BOOTSTRAP_RETRY_DELAY_MS ?? "2000", 10);
function bootstrapIsolatedThread(state, attempt = 1) {
  state.thread.bootstrap().then((threadId) => {
    state.ready = true;
    emitToChat(state, systemMessage("system_isolated_ready", `\u2705 Fresh isolated Codex thread ready (threadId=${threadId}).`));
  }).catch((err) => {
    const errMsg = err?.message ?? String(err);
    log(`[${state.chatId}] Isolated bootstrap attempt ${attempt}/${ISOLATED_BOOTSTRAP_MAX_ATTEMPTS} failed: ${errMsg}`);
    if (attempt < ISOLATED_BOOTSTRAP_MAX_ATTEMPTS) {
      emitToChat(state, systemMessage("system_isolated_retry", `\u26A0\uFE0F Bootstrap of isolated Codex thread failed (attempt ${attempt}/${ISOLATED_BOOTSTRAP_MAX_ATTEMPTS}): ${errMsg}. Retrying in ${ISOLATED_BOOTSTRAP_RETRY_DELAY_MS}ms.`));
      setTimeout(() => {
        try {
          state.thread.close();
        } catch {}
        state.thread = new ClaudeThread({
          appServerUrl: codex.appServerUrl,
          chatId: state.chatId,
          logFile: stateDir.logFile,
          cwd: process.cwd()
        });
        wireClaudeThreadEvents(state);
        bootstrapIsolatedThread(state, attempt + 1);
      }, ISOLATED_BOOTSTRAP_RETRY_DELAY_MS);
    } else {
      emitToChat(state, systemMessage("system_isolated_failed", `\u274C Failed to bootstrap isolated Codex thread after ${ISOLATED_BOOTSTRAP_MAX_ATTEMPTS} attempts: ${errMsg}. Closing this chat \u2014 please reconnect Claude (close the window and re-attach) to start a fresh attempt.`));
      reapChatState(state, "isolated bootstrap exhausted");
    }
  });
}
function reapChatState(state, reason) {
  log(`Reaping chat state: chatId=${state.chatId} (${reason})`);
  if (state.ws) {
    try {
      state.ws.close(1011, `chat reaped: ${reason}`);
    } catch {}
    state.ws = null;
  }
  if (state.attentionWindowTimer)
    clearTimeout(state.attentionWindowTimer);
  if (state.disconnectTimer)
    clearTimeout(state.disconnectTimer);
  if (state.reaperTimer)
    clearTimeout(state.reaperTimer);
  try {
    state.statusBuffer.dispose();
  } catch {}
  try {
    state.thread.close();
  } catch {}
  chats.delete(state.chatId);
  broadcastStatus();
}
function transitionToIsolated(state, reason) {
  state.paired = false;
  state.homePairId = "default";
  state.replyRequired = false;
  state.replyReceivedDuringTurn = false;
  state.pairedTurnSawAgentMessage = false;
  emitToChat(state, systemMessage("system_pair_torn_down", `[system] ${reason}. Future replies will use a fresh isolated Codex thread (no prior shared-TUI context carried over).`));
  state.thread = new ClaudeThread({
    appServerUrl: codex.appServerUrl,
    chatId: state.chatId,
    logFile: stateDir.logFile,
    cwd: process.cwd()
  });
  state.ready = false;
  wireClaudeThreadEvents(state);
  bootstrapIsolatedThread(state);
}
function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz")
        return Response.json(currentStatus());
      if (url.pathname === "/readyz") {
        return Response.json(currentStatus(), { status: 200 });
      }
      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false, chatId: null } })) {
        return;
      }
      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960,
      sendPings: true,
      open: (ws) => {
        ws.data.clientId = ++nextControlClientId;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws, code, reason) => {
        const chatId = ws.data.chatId;
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, chatId=${chatId ?? "-"})`);
        if (chatId) {
          const state = chats.get(chatId);
          if (state && state.ws === ws) {
            detachClaudeWs(state, "frontend socket closed");
          }
        }
      },
      message: (ws, raw) => {
        handleControlMessage(ws, raw);
      }
    }
  });
}
function handleControlMessage(ws, raw) {
  let message;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }
  switch (message.type) {
    case "claude_connect":
      attachClaude(ws, message.chatId, message.pairId, message.requestId);
      return;
    case "claude_disconnect": {
      const chatId = message.chatId ?? ws.data.chatId;
      if (!chatId)
        return;
      const state = chats.get(chatId);
      if (state)
        detachClaudeWs(state, "frontend requested disconnect");
      return;
    }
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex":
      handleClaudeToCodex(ws, message);
      return;
    case "ensure_pair":
      handleEnsurePair(ws, message);
      return;
    case "destroy_pair":
      handleDestroyPair(ws, message);
      return;
    case "list_pairs":
      handleListPairs(ws, message);
      return;
  }
}
async function handleEnsurePair(ws, message) {
  const { requestId, pairId } = message;
  try {
    const pair = await ensurePair(pairId);
    sendProtocolMessage(ws, {
      type: "pair_ensured",
      requestId,
      pairId,
      appServerUrl: pair.codex.appServerUrl,
      proxyUrl: pair.codex.proxyUrl,
      isLive: true
    });
  } catch (err) {
    if (err instanceof PairError) {
      sendProtocolMessage(ws, {
        type: "pair_error",
        requestId,
        pairId,
        code: err.code,
        message: err.message,
        ...err.details ? { details: err.details } : {}
      });
      return;
    }
    log(`[ensure_pair=${pairId}] unexpected error: ${err?.stack ?? err?.message ?? err}`);
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "ALLOCATION_FAILED",
      message: `ensurePair("${pairId}") failed: ${err?.message ?? err}`
    });
  }
}
async function handleDestroyPair(ws, message) {
  const { requestId, pairId, forget, force } = message;
  if (!isValidPairName(pairId)) {
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "INVALID_PAIR_NAME",
      message: `pair name "${pairId}" fails validation`
    });
    return;
  }
  const pair = pairs.get(pairId);
  const inRegistry = pairRegistry.has(pairId);
  if (!pair && !inRegistry) {
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "PAIR_NOT_FOUND",
      message: `pair "${pairId}" not found (neither live nor registered)`
    });
    return;
  }
  if (pair?.proxyTuiSlot?.pairedChatId && !force) {
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "PAIR_BUSY_NOT_FORCED",
      message: `pair "${pairId}" has paired chat "${pair.proxyTuiSlot.pairedChatId}"; pass force:true to tear down anyway`
    });
    return;
  }
  let wasLive = false;
  if (pair?.isLive) {
    wasLive = true;
    try {
      await destroyPair(pairId);
    } catch (err) {
      log(`[destroy_pair=${pairId}] internal destroyPair threw: ${err?.message ?? err}`);
    }
  }
  let registryEntryRemoved = false;
  if (forget) {
    await runUnderRegistryMutex(async () => {
      if (pairRegistry.remove(pairId)) {
        registryEntryRemoved = true;
        try {
          pairRegistry.save();
        } catch (err) {
          log(`[destroy_pair=${pairId}] registry save failed: ${err?.message ?? err}`);
        }
      }
    });
  }
  sendProtocolMessage(ws, {
    type: "pair_destroyed",
    requestId,
    pairId,
    wasLive,
    registryEntryRemoved
  });
}
function handleListPairs(ws, message) {
  const seen = new Set;
  const result = [];
  for (const pair of pairs.values()) {
    seen.add(pair.pairId);
    result.push({
      pairId: pair.pairId,
      isLive: pair.isLive,
      appServerUrl: pair.codex.appServerUrl,
      proxyUrl: pair.codex.proxyUrl,
      tuiConnected: pair.tuiConnectionState.snapshot().tuiConnected,
      proxyTuiConnected: pair.proxyTuiSlot !== null,
      pairedChatId: pair.proxyTuiSlot?.pairedChatId ?? null,
      threadId: pair.codex.activeThreadId,
      attachedClaudes: [...chats.values()].filter((s) => s.homePairId === pair.pairId).map((s) => ({ chatId: s.chatId, paired: s.paired }))
    });
  }
  for (const entry of pairRegistry.list()) {
    if (seen.has(entry.pairId))
      continue;
    result.push({
      pairId: entry.pairId,
      isLive: false,
      appServerUrl: `ws://127.0.0.1:${entry.appPort}`,
      proxyUrl: `ws://127.0.0.1:${entry.proxyPort}`,
      tuiConnected: false,
      proxyTuiConnected: false,
      pairedChatId: null,
      threadId: null,
      attachedClaudes: []
    });
  }
  sendProtocolMessage(ws, {
    type: "pair_list",
    requestId: message.requestId,
    pairs: result
  });
}
async function attachClaude(ws, requestedChatId, requestedPairId, requestId) {
  const chatId = requestedChatId ?? `auto_${ws.data.clientId}_${Date.now()}`;
  ws.data.chatId = chatId;
  if (requestedPairId !== undefined) {
    if (!isValidPairName(requestedPairId)) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "INVALID_PAIR_NAME",
        message: `pair name "${requestedPairId}" fails validation`
      });
      return;
    }
    const targetPair2 = pairs.get(requestedPairId);
    if (!targetPair2?.isLive) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "PAIR_NOT_FOUND",
        message: `pair "${requestedPairId}" is not live; start it with abg codex --pair ${requestedPairId} --via-proxy first`
      });
      return;
    }
    if (!targetPair2.proxyTuiSlot) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "PAIR_NOT_FOUND",
        message: `pair "${requestedPairId}" has no proxy TUI connected yet; start \`abg codex --pair ${requestedPairId} --via-proxy\` first, then attach Claude`
      });
      return;
    }
    if (targetPair2.proxyTuiSlot.pairedChatId && targetPair2.proxyTuiSlot.pairedChatId !== chatId) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "PAIR_BUSY",
        message: `pair "${requestedPairId}" already has paired chat "${targetPair2.proxyTuiSlot.pairedChatId}"`
      });
      return;
    }
  }
  let state = chats.get(chatId);
  if (state) {
    if (state.ws && state.ws !== ws && state.ws.readyState !== WebSocket.CLOSED) {
      log(`Replacing prior WS for chatId=${chatId} (#${state.ws.data.clientId} \u2192 #${ws.data.clientId})`);
      try {
        state.ws.close(CLOSE_CODE_REPLACED, "replaced by newer connection for same chatId");
      } catch {}
    }
    state.ws = ws;
    ws.data.attached = true;
    clearDisconnectTimer(state, "claude resumed");
    clearReaperTimer(state, "claude resumed");
    cancelIdleShutdown();
    log(`Claude resumed chatId=${chatId} (#${ws.data.clientId})`);
    statusBufferFlushIfPaused(state, "claude resumed");
    flushBufferedMessages(state);
    sendStatus(ws);
    sendProtocolMessage(ws, {
      type: "claude_connect_result",
      requestId,
      ok: true,
      chatId,
      homePairId: state.homePairId,
      paired: state.paired
    });
    return;
  }
  state = createChatState(chatId);
  chats.set(chatId, state);
  state.ws = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`New Claude session attached: chatId=${chatId} (#${ws.data.clientId}, total=${chats.size}, requestedPair=${requestedPairId ?? "-"})`);
  sendStatus(ws);
  const targetPair = requestedPairId ? pairs.get(requestedPairId) : null;
  if (targetPair?.isLive && !targetPair.proxyTuiSlot?.pairedChatId && targetPair.proxyTuiSlot) {
    state.homePairId = requestedPairId;
    targetPair.proxyTuiSlot.pairedChatId = chatId;
    state.paired = true;
    targetPair.codex.setPairedChat(chatId);
    state.ready = targetPair.proxyTuiSlot.readiness === "ready";
    log(`[${chatId}] Paired with pair="${requestedPairId}" via explicit attach (readiness=${targetPair.proxyTuiSlot.readiness})`);
    emitToChat(state, systemMessage(state.ready ? "system_paired_ready" : "system_paired_provisioning", state.ready ? `\u2705 This Claude session is paired with the right-pane Codex TUI on pair "${requestedPairId}". Replies will appear there.` : `\u2705 This Claude session is paired with the right-pane Codex TUI on pair "${requestedPairId}". Waiting for shared-thread provisioning.`));
    sendProtocolMessage(ws, {
      type: "claude_connect_result",
      requestId,
      ok: true,
      chatId,
      homePairId: state.homePairId,
      paired: state.paired
    });
    broadcastStatus();
    return;
  }
  if (proxyTuiSlot && proxyTuiSlot.pairedChatId === null) {
    emitToChat(state, systemMessage("system_bridge_provisioning", "\u2705 AgentBridge daemon attached. Pairing with the right-pane Codex TUI for shared-thread mode..."));
    pairChat(state);
    broadcastStatus();
    sendProtocolMessage(ws, {
      type: "claude_connect_result",
      requestId,
      ok: true,
      chatId,
      homePairId: state.homePairId,
      paired: state.paired
    });
    return;
  }
  emitToChat(state, systemMessage("system_bridge_provisioning", "\u2705 AgentBridge daemon attached. Provisioning your dedicated Codex thread..."));
  sendProtocolMessage(ws, {
    type: "claude_connect_result",
    requestId,
    ok: true,
    chatId,
    homePairId: state.homePairId,
    paired: state.paired
  });
  try {
    const threadId = await state.thread.bootstrap();
    state.ready = true;
    log(`ClaudeThread ready: chatId=${chatId} threadId=${threadId}`);
    emitToChat(state, systemMessage("system_thread_ready", `\u2705 Your Codex thread is ready (threadId=${threadId}). You can now send messages via the reply tool.`));
    broadcastStatus();
  } catch (err) {
    log(`ClaudeThread bootstrap failed for chatId=${chatId}: ${err?.message ?? err}`);
    emitToChat(state, systemMessage("system_thread_failed", `\u274C Failed to provision Codex thread: ${err?.message ?? err}. Reconnect to retry.`));
  }
}
function createChatState(chatId) {
  const state = {
    chatId,
    homePairId: "default",
    ws: null,
    thread: new ClaudeThread({
      appServerUrl: codex.appServerUrl,
      chatId,
      logFile: stateDir.logFile,
      cwd: process.cwd()
    }),
    ready: false,
    paired: false,
    pairedTurnSawAgentMessage: false,
    inAttentionWindow: false,
    attentionWindowTimer: null,
    replyRequired: false,
    replyReceivedDuringTurn: false,
    bufferedMessages: [],
    statusBuffer: null,
    disconnectTimer: null,
    reaperTimer: null,
    lastAttachStatusSentTs: 0,
    onlineNoticeSent: false,
    nextSystemMessageId: 0
  };
  state.statusBuffer = new StatusBuffer((summary) => emitToChat(state, summary));
  wireClaudeThreadEvents(state);
  return state;
}
function wireClaudeThreadEvents(state) {
  const chatId = state.chatId;
  state.thread.on("agentMessage", (msg) => {
    if (msg.source !== "codex")
      return;
    const result = classifyMessage(msg.content, FILTER_MODE);
    if (state.replyRequired) {
      log(`[${chatId}] Codex \u2192 Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
      state.replyReceivedDuringTurn = true;
      if (state.statusBuffer.size > 0) {
        state.statusBuffer.flush("reply-required message arrived");
      }
      emitToChat(state, msg);
      return;
    }
    if (state.inAttentionWindow && result.marker === "status") {
      log(`[${chatId}] Codex \u2192 Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
      state.statusBuffer.add(msg);
      return;
    }
    log(`[${chatId}] Codex \u2192 Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
    switch (result.action) {
      case "forward":
        if (result.marker === "important" && state.statusBuffer.size > 0) {
          state.statusBuffer.flush("important message arrived");
        }
        emitToChat(state, msg);
        if (result.marker === "important")
          startAttentionWindow(state);
        break;
      case "buffer":
        state.statusBuffer.add(msg);
        break;
      case "drop":
        break;
    }
  });
  state.thread.on("turnStarted", () => {
    log(`[${chatId}] Codex turn started`);
    emitToChat(state, systemMessage("system_turn_started", "\u23F3 Codex is working on the current task. Wait for completion before sending a reply."));
  });
  state.thread.on("turnCompleted", () => {
    log(`[${chatId}] Codex turn completed`);
    state.statusBuffer.flush("turn completed");
    if (state.replyRequired && !state.replyReceivedDuringTurn) {
      log(`[${chatId}] \u26A0\uFE0F Reply was required but Codex did not send any agentMessage`);
      emitToChat(state, systemMessage("system_reply_missing", "\u26A0\uFE0F Codex completed the turn without sending a reply (require_reply was set)."));
    }
    state.replyRequired = false;
    state.replyReceivedDuringTurn = false;
    emitToChat(state, systemMessage("system_turn_completed", "\u2705 Codex finished the current turn. You can reply now if needed."));
    startAttentionWindow(state);
  });
  state.thread.on("close", () => {
    log(`[${chatId}] ClaudeThread WS closed`);
    state.ready = false;
  });
  state.thread.on("error", (err) => {
    log(`[${chatId}] ClaudeThread error: ${err?.message ?? err}`);
  });
}
function detachClaudeWs(state, reason) {
  if (!state.ws)
    return;
  log(`Claude WS detached: chatId=${state.chatId} (#${state.ws.data.clientId}, ${reason}, paired=${state.paired})`);
  state.ws = null;
  scheduleDisconnectTimer(state);
  scheduleReaperTimer(state);
  if (state.paired && proxyTuiSlot && proxyTuiSlot.pairedChatId === state.chatId) {
    if (proxyTuiSlot.pairReapTimer)
      clearTimeout(proxyTuiSlot.pairReapTimer);
    proxyTuiSlot.pairReapTimer = setTimeout(() => {
      if (!proxyTuiSlot)
        return;
      const currentState = chats.get(state.chatId);
      if (currentState?.ws) {
        log(`Paired Claude ${state.chatId} reconnected during grace; not clearing pair`);
        return;
      }
      log(`Paired Claude ${state.chatId} did not reconnect within ${PAIR_REAP_MS}ms \u2014 clearing pair slot and reaping chat state`);
      proxyTuiSlot.pairedChatId = null;
      proxyTuiSlot.pairReapTimer = null;
      codex.setPairedChat(null);
      if (currentState) {
        try {
          currentState.thread.close();
        } catch {}
        currentState.statusBuffer.dispose();
        if (currentState.attentionWindowTimer)
          clearTimeout(currentState.attentionWindowTimer);
        if (currentState.disconnectTimer)
          clearTimeout(currentState.disconnectTimer);
        if (currentState.reaperTimer)
          clearTimeout(currentState.reaperTimer);
        chats.delete(state.chatId);
        broadcastStatus();
      }
    }, PAIR_REAP_MS);
  }
  scheduleIdleShutdown();
}
function scheduleReaperTimer(state) {
  if (state.reaperTimer)
    clearTimeout(state.reaperTimer);
  state.reaperTimer = setTimeout(() => {
    state.reaperTimer = null;
    if (state.ws)
      return;
    log(`Reaping idle chat: chatId=${state.chatId} (no WS for ${CLAUDE_REAP_AFTER_MS}ms)`);
    try {
      state.thread.close();
    } catch {}
    state.statusBuffer.dispose();
    if (state.attentionWindowTimer)
      clearTimeout(state.attentionWindowTimer);
    chats.delete(state.chatId);
    broadcastStatus();
  }, CLAUDE_REAP_AFTER_MS);
}
function clearReaperTimer(state, _reason) {
  if (state.reaperTimer) {
    clearTimeout(state.reaperTimer);
    state.reaperTimer = null;
  }
}
function scheduleDisconnectTimer(state) {
  if (state.disconnectTimer)
    clearTimeout(state.disconnectTimer);
  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
  }, CLAUDE_DISCONNECT_GRACE_MS);
}
function clearDisconnectTimer(state, _reason) {
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
}
function statusBufferFlushIfPaused(state, reason) {
  if (state.statusBuffer.size > 0)
    state.statusBuffer.flush(reason);
}
function handleClaudeToCodex(ws, message) {
  const chatId = message.chatId ?? ws.data.chatId;
  if (!chatId) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "No chatId \u2014 claude_connect was never sent."
    });
  }
  const state = chats.get(chatId);
  if (!state) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: `Unknown chatId ${chatId}. Reattach via claude_connect.`
    });
  }
  if (message.message.source !== "claude") {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "Invalid message source"
    });
  }
  if (!state.ready) {
    let errorMsg;
    if (state.paired) {
      if (codex.isSessionRestoreInProgress) {
        errorMsg = "Restoring shared Codex TUI session, retry shortly.";
      } else if (proxyTuiSlot) {
        errorMsg = "Shared Codex TUI thread is still provisioning. Retry shortly.";
      } else {
        errorMsg = "Shared Codex TUI is no longer connected. Wait for transition to isolated mode.";
      }
    } else {
      errorMsg = "Your Codex thread is still provisioning. Wait for system_thread_ready.";
    }
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: errorMsg
    });
  }
  const requireReply = !!message.requireReply;
  let contentWithReminder = message.message.content + `

` + BRIDGE_CONTRACT_REMINDER;
  if (requireReply) {
    contentWithReminder += REPLY_REQUIRED_INSTRUCTION;
    state.replyRequired = true;
    state.replyReceivedDuringTurn = false;
    log(`[${chatId}] Reply required flag set`);
  }
  log(`[${chatId}] Forwarding Claude \u2192 Codex (${message.message.content.length} chars, requireReply=${requireReply}, paired=${state.paired})`);
  const injected = state.paired ? codex.injectMessage(contentWithReminder) : state.thread.injectMessage(contentWithReminder);
  if (!injected) {
    const reason = state.paired ? "Shared Codex TUI is busy with another turn. Retry." : state.thread.isTurnInProgress ? "Codex is busy executing a turn on your thread. Wait for it to finish." : "Injection failed: thread WS not connected.";
    if (requireReply) {
      state.replyRequired = false;
    }
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: reason
    });
  }
  clearAttentionWindow(state);
  sendProtocolMessage(ws, {
    type: "claude_to_codex_result",
    requestId: message.requestId,
    success: true
  });
}
function startAttentionWindow(state) {
  clearAttentionWindow(state);
  state.inAttentionWindow = true;
  state.statusBuffer.pause();
  log(`[${state.chatId}] Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  state.attentionWindowTimer = setTimeout(() => {
    state.attentionWindowTimer = null;
    state.inAttentionWindow = false;
    state.statusBuffer.resume();
    log(`[${state.chatId}] Attention window ended`);
  }, ATTENTION_WINDOW_MS);
}
function clearAttentionWindow(state) {
  if (state.attentionWindowTimer) {
    clearTimeout(state.attentionWindowTimer);
    state.attentionWindowTimer = null;
  }
  if (state.inAttentionWindow)
    state.statusBuffer.resume();
  state.inAttentionWindow = false;
}
function emitToChat(state, message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(state.ws, message, state.chatId))
      return;
    log(`[${state.chatId}] Send to Claude failed, buffering`);
  }
  state.bufferedMessages.push(message);
  if (state.bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = state.bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    state.bufferedMessages.splice(0, dropped);
    log(`[${state.chatId}] Message buffer overflow: dropped ${dropped} oldest`);
  }
}
function trySendBridgeMessage(ws, message, chatId) {
  try {
    const payload = { type: "codex_to_claude", chatId, message };
    const result = ws.send(JSON.stringify(payload));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}
function flushBufferedMessages(state) {
  if (!state.ws || state.bufferedMessages.length === 0)
    return;
  const messages = state.bufferedMessages.splice(0, state.bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(state.ws, message, state.chatId)) {
      const idx = messages.indexOf(message);
      state.bufferedMessages.unshift(...messages.slice(idx));
      log(`[${state.chatId}] Flush interrupted: re-buffered ${messages.length - idx} message(s)`);
      return;
    }
  }
}
function broadcastToAllClaudes(message) {
  for (const state of chats.values())
    emitToChat(state, message);
}
function sendStatus(ws) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}
function broadcastStatus() {
  for (const state of chats.values()) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN)
      sendStatus(state.ws);
  }
}
function sendProtocolMessage(ws, message) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    log(`Failed to send control message: ${err.message}`);
  }
}
function currentStatus() {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply() || codexBootstrapped,
    pid: process.pid,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    tuiConnected: snapshot.tuiConnected,
    proxyTuiConnected: proxyTuiSlot !== null,
    threadId: codex.activeThreadId,
    attachedClaudeCount: [...chats.values()].filter((s) => s.ws).length,
    queuedMessageCount: [...chats.values()].reduce((n, s) => n + s.bufferedMessages.length + s.statusBuffer.size, 0),
    pairs: [...pairs.values()].map((pair) => ({
      pairId: pair.pairId,
      isLive: pair.isLive,
      appServerUrl: pair.codex.appServerUrl,
      proxyUrl: pair.codex.proxyUrl,
      tuiConnected: pair.tuiConnectionState.snapshot().tuiConnected,
      proxyTuiConnected: pair.proxyTuiSlot !== null,
      pairedChatId: pair.proxyTuiSlot?.pairedChatId ?? null,
      threadId: pair.codex.activeThreadId,
      attachedClaudes: [...chats.values()].filter((s) => s.homePairId === pair.pairId).map((s) => ({ chatId: s.chatId, paired: s.paired }))
    }))
  };
}
function systemMessage(idPrefix, content) {
  return {
    id: `${idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: "codex",
    content,
    timestamp: Date.now()
  };
}
function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if ([...chats.values()].some((s) => s.ws !== null))
    return;
  if (tuiConnectionState.snapshot().tuiConnected)
    return;
  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if ([...chats.values()].some((s) => s.ws !== null) || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle \u2014 no clients connected");
  }, IDLE_SHUTDOWN_MS);
}
function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}
function writePidFile() {
  daemonLifecycle.writePid();
}
function removePidFile() {
  daemonLifecycle.removePidFile();
}
function writeStatusFile() {
  daemonLifecycle.writeStatus({
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid
  });
}
function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}
var ensurePairInFlight = new Map;
async function ensurePair(pairId) {
  if (!isValidPairName(pairId)) {
    throw new PairError("INVALID_PAIR_NAME", `pair name "${pairId}" fails validation`);
  }
  const existingFast = pairs.get(pairId);
  if (existingFast?.isLive)
    return existingFast;
  const inFlight = ensurePairInFlight.get(pairId);
  if (inFlight)
    return inFlight;
  const promise = ensurePairCore(pairId).finally(() => {
    ensurePairInFlight.delete(pairId);
  });
  ensurePairInFlight.set(pairId, promise);
  return promise;
}
async function ensurePairCore(pairId) {
  const existing = pairs.get(pairId);
  if (existing?.isLive)
    return existing;
  const entry = await runUnderRegistryMutex(async () => {
    if (pairRegistry.has(pairId))
      return pairRegistry.get(pairId);
    const result = pairRegistry.allocate(pairId);
    if (!result.ok) {
      throw new PairError(result.error.code, result.error.message);
    }
    try {
      pairRegistry.save();
    } catch (err) {
      log(`[pair-registry] ensurePair("${pairId}"): persist failed: ${err?.message ?? err}`);
    }
    return result.entry;
  });
  let pair = pairs.get(pairId);
  if (!pair) {
    const newCodex = new CodexAdapter({
      pairId,
      appPort: entry.appPort,
      proxyPort: entry.proxyPort,
      logFile: stateDir.logFile
    });
    const newTuiState = new TuiConnectionState({
      disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
      log,
      onDisconnectPersisted: (connId) => {
        broadcastToAllClaudes(systemMessage("system_tui_disconnected", `\u26A0\uFE0F Codex TUI disconnected (pair=${pairId}, conn #${connId}). Codex is still running in the background \u2014 reconnect the TUI to resume.`));
      },
      onReconnectAfterNotice: (connId) => {
        broadcastToAllClaudes(systemMessage("system_tui_reconnected", `\u2705 Codex TUI reconnected (pair=${pairId}, conn #${connId}). Bridge restored.`));
      }
    });
    pair = {
      pairId,
      codex: newCodex,
      tuiConnectionState: newTuiState,
      proxyTuiSlot: null,
      handlerRefs: [],
      isLive: false
    };
    pairs.set(pairId, pair);
    log(`[pair=${pairId}] constructed new PairState (appPort=${entry.appPort}, proxyPort=${entry.proxyPort})`);
  }
  if (pair.handlerRefs.length === 0) {
    attachPairHandlers(pair);
  }
  log(`[pair=${pair.pairId}] ensurePair: starting codex app-server (appPort=${pair.codex.appServerUrl}, proxyPort=${pair.codex.proxyUrl})`);
  try {
    await pair.codex.start();
  } catch (err) {
    const errCode = err?.code ?? "";
    const errMsg = err?.message ?? String(err);
    const looksLikePortBusy = errCode === "EADDRINUSE" || /EADDRINUSE/i.test(errMsg) || /address already in use/i.test(errMsg) || /port.*in use/i.test(errMsg);
    if (looksLikePortBusy) {
      let conflictPort;
      const portMatch = errMsg.match(/(?::|port[\s=]+|address[\s=]+[\w:.]+:)(\d{2,5})/i);
      if (portMatch) {
        const candidate = parseInt(portMatch[1], 10);
        if (Number.isFinite(candidate))
          conflictPort = candidate;
      }
      throw new PairError("PAIR_PORTS_BUSY", `pair "${pair.pairId}" ports (appPort=${pair.codex.appServerUrl}, proxyPort=${pair.codex.proxyUrl}) are held by another process: ${errMsg}`, { conflictPort });
    }
    throw err;
  }
  pair.isLive = true;
  return pair;
}

class PairError extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "PairError";
  }
}
async function destroyPair(pairId) {
  const pair = pairs.get(pairId);
  if (!pair)
    return;
  log(`[pair=${pair.pairId}] destroyPair: full teardown (isLive=${pair.isLive})`);
  if (pair.proxyTuiSlot?.pairReapTimer) {
    clearTimeout(pair.proxyTuiSlot.pairReapTimer);
    pair.proxyTuiSlot.pairReapTimer = null;
  }
  detachPairHandlers(pair);
  const pairedChatId = pair.proxyTuiSlot?.pairedChatId ?? null;
  if (pairedChatId) {
    const state = chats.get(pairedChatId);
    if (state) {
      log(`[pair=${pair.pairId}] destroyPair: transitioning paired chat "${pairedChatId}" to isolated`);
      transitionToIsolated(state, `Pair "${pair.pairId}" destroyed`);
    }
  }
  pair.proxyTuiSlot = null;
  try {
    pair.codex.stop();
  } catch (err) {
    log(`[pair=${pair.pairId}] destroyPair: codex.stop() threw \u2014 ${err?.message ?? err}`);
  }
  pair.isLive = false;
  if (pairId !== "default") {
    pairs.delete(pairId);
    log(`[pair=${pair.pairId}] destroyPair: removed from pairs Map`);
  }
  broadcastStatus();
}
async function bootCodex() {
  log("Starting AgentBridge daemon (multi-Claude variant)...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);
  try {
    await ensurePair("default");
    codexBootstrapped = true;
    writeStatusFile();
    broadcastStatus();
  } catch (err) {
    log(`Failed to start Codex: ${err.message}`);
    broadcastToAllClaudes(systemMessage("system_codex_start_failed", `\u274C AgentBridge failed to start Codex app-server: ${err.message}`));
    broadcastStatus();
  }
}
function shutdown(reason) {
  if (shuttingDown)
    return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  for (const state of chats.values()) {
    if (state.attentionWindowTimer)
      clearTimeout(state.attentionWindowTimer);
    if (state.disconnectTimer)
      clearTimeout(state.disconnectTimer);
    if (state.reaperTimer)
      clearTimeout(state.reaperTimer);
    state.statusBuffer.dispose();
    try {
      state.thread.close();
    } catch {}
  }
  chats.clear();
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  removePidFile();
  removeStatusFile();
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});
function log(msg) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}
`;
  process.stderr.write(line);
  try {
    appendFileSync3(stateDir.logFile, line);
  } catch {}
}
function startDaemon() {
  if (daemonLifecycle.wasKilled()) {
    log("Killed sentinel found \u2014 daemon was intentionally stopped. Exiting immediately.");
    process.exit(0);
  }
  writePidFile();
  startControlServer();
  bootCodex();
}
if (import.meta.main) {
  startDaemon();
}
var __testing = {
  get proxyTuiSlot() {
    return proxyTuiSlot;
  },
  setProxyTuiSlot(next) {
    proxyTuiSlot = next;
  },
  chats,
  codex,
  pairs,
  fns: {
    pairChat,
    transitionToIsolated,
    bootstrapIsolatedThread,
    getPairedChatState,
    createChatState,
    detachClaudeWs,
    emitToChat,
    attachPairHandlers,
    detachPairHandlers,
    ensurePair,
    destroyPair,
    handleEnsurePair,
    handleDestroyPair,
    handleListPairs,
    attachClaude
  },
  pairRegistry,
  runUnderRegistryMutex,
  config: {
    PAIR_REAP_MS,
    CLAUDE_REAP_AFTER_MS,
    ISOLATED_BOOTSTRAP_MAX_ATTEMPTS,
    ISOLATED_BOOTSTRAP_RETRY_DELAY_MS
  },
  reset() {
    if (proxyTuiSlot?.pairReapTimer) {
      clearTimeout(proxyTuiSlot.pairReapTimer);
    }
    for (const state of chats.values()) {
      if (state.attentionWindowTimer)
        clearTimeout(state.attentionWindowTimer);
      if (state.disconnectTimer)
        clearTimeout(state.disconnectTimer);
      if (state.reaperTimer)
        clearTimeout(state.reaperTimer);
      try {
        state.statusBuffer.dispose();
      } catch {}
      try {
        state.thread.close();
      } catch {}
    }
    chats.clear();
    proxyTuiSlot = null;
    try {
      codex.setPairedChat(null);
    } catch {}
  },
  reapChatState
};
export {
  __testing
};
