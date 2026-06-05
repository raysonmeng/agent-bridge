#!/usr/bin/env bun
// @bun

// src/build-info.ts
function defineString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function defineBundle(value) {
  if (value === "source" || value === "dist" || value === "plugin")
    return value;
  return import.meta.url.endsWith(".ts") ? "source" : "dist";
}
function defineNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
var BUILD_INFO = Object.freeze({
  version: defineString("0.1.6", "0.0.0-source"),
  commit: defineString("33d46d8", "source"),
  bundle: defineBundle("plugin"),
  contractVersion: defineNumber(1, 1)
});
function daemonStatusBuildInfo() {
  return { ...BUILD_INFO };
}
function sameRuntimeContract(a, b) {
  if (!a || !b)
    return false;
  return a.version === b.version && a.commit === b.commit && a.contractVersion === b.contractVersion;
}
function formatBuildInfo(build) {
  if (!build)
    return "<unknown>";
  return `${build.version}/${build.commit}/${build.bundle}/contract-v${build.contractVersion}`;
}

// src/codex-adapter.ts
import { spawn, execSync } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";

// src/state-dir.ts
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

class StateDirResolver {
  stateDir;
  static platformBaseDir() {
    if (platform() === "darwin") {
      return join(homedir(), "Library", "Application Support", "AgentBridge");
    }
    const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(xdgState, "agentbridge");
  }
  constructor(envOverride) {
    const override = envOverride ?? process.env.AGENTBRIDGE_STATE_DIR;
    this.stateDir = override && override.length > 0 ? override : StateDirResolver.platformBaseDir();
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
  get currentThreadFile() {
    return join(this.stateDir, "current-thread.json");
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
  get updateCheckFile() {
    return join(this.stateDir, "update-check.json");
  }
}

// src/rotating-log.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, renameSync, statSync, unlinkSync } from "fs";
import { dirname } from "path";
var DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
var DEFAULT_KEEP = 3;
function appendRotatingLog(path, content, options = {}) {
  const maxBytes = options.maxBytes ?? positiveIntFromEnv("AGENTBRIDGE_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
  const keep = options.keep ?? positiveIntFromEnv("AGENTBRIDGE_LOG_ROTATE_KEEP", DEFAULT_KEEP);
  mkdirSync2(dirname(path), { recursive: true });
  rotateIfNeeded(path, Buffer.byteLength(content), maxBytes, keep);
  appendFileSync(path, content, "utf-8");
}
function positiveIntFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value)
    return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function rotateIfNeeded(path, incomingBytes, maxBytes, keep) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || keep <= 0)
    return;
  if (!existsSync2(path))
    return;
  const size = statSync(path).size;
  if (size + incomingBytes <= maxBytes)
    return;
  for (let index = keep;index >= 1; index--) {
    const current = `${path}.${index}`;
    const next = `${path}.${index + 1}`;
    if (!existsSync2(current))
      continue;
    if (index === keep) {
      unlinkSync(current);
    } else {
      renameSync(current, next);
    }
  }
  renameSync(path, `${path}.1`);
}

// src/process-log.ts
var stderrStates = new WeakMap;
function createProcessLogger(options) {
  let fatalInProgress = false;
  const stderr = options.stderr ?? process.stderr;
  const stderrState = stateForStderr(stderr);
  const write = (message) => {
    const line = `[${new Date().toISOString()}] [${options.component}] ${message}
`;
    if (options.logFile) {
      try {
        appendRotatingLog(options.logFile, line);
      } catch {}
    }
    if (!stderrState.enabled)
      return;
    try {
      stderr.write(line);
    } catch (error) {
      if (error?.code === "EPIPE")
        stderrState.enabled = false;
    }
  };
  return {
    log: write,
    fatal(label, error) {
      if (fatalInProgress)
        return;
      fatalInProgress = true;
      try {
        write(`${label}: ${safeFormatError(error)}`);
      } finally {
        fatalInProgress = false;
      }
    }
  };
}
function stateForStderr(stderr) {
  const key = stderr;
  let state = stderrStates.get(key);
  if (state)
    return state;
  state = { enabled: true };
  stderrStates.set(key, state);
  if (typeof stderr.on === "function") {
    stderr.on("error", (error) => {
      if (error?.code === "EPIPE") {
        state.enabled = false;
        return;
      }
      setTimeout(() => {
        throw error;
      }, 0);
    });
  }
  return state;
}
function safeFormatError(error) {
  try {
    return formatError(error);
  } catch {
    return "<failed to format error>";
  }
}
function formatError(error) {
  if (error instanceof Error)
    return error.stack ?? error.message;
  if (typeof error === "object" && error !== null && "stack" in error) {
    return String(error.stack);
  }
  return String(error);
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
  "item/completed"
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

// src/codex-transport.ts
import { createServer, connect } from "net";
import { spawnSync } from "child_process";
import { mkdirSync as mkdirSync3, rmSync, chmodSync } from "fs";
import { join as join2 } from "path";
import { tmpdir } from "os";
var CODEX_TRANSPORT_ENV = "AGENTBRIDGE_CODEX_TRANSPORT";
var HEADER_SEP = `\r
\r
`;
var EXTENSIONS_HEADER_RE = /^sec-websocket-extensions:/i;
var MAX_UPGRADE_HEADER_BYTES = 64 * 1024;
function parseTransportMode(raw) {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "ws":
      return "ws";
    case "unix":
      return "unix";
    case "auto":
    case "":
      return "auto";
    default:
      return "auto";
  }
}
function probeCodexWsSupport(runHelp = defaultRunCodexAppServerHelp) {
  const help = runHelp();
  if (help === null)
    return true;
  return help.includes("ws://");
}
function defaultRunCodexAppServerHelp() {
  try {
    const res = spawnSync("codex", ["app-server", "--help"], {
      encoding: "utf-8",
      timeout: 5000
    });
    if (res.error || typeof res.stdout !== "string")
      return null;
    return res.stdout + (res.stderr ?? "");
  } catch {
    return null;
  }
}
function resolveCodexTransport(mode, runHelp = defaultRunCodexAppServerHelp) {
  if (mode === "ws")
    return "ws";
  if (mode === "unix")
    return "unix";
  return probeCodexWsSupport(runHelp) ? "ws" : "unix";
}
function codexSocketPath(appPort, baseTmpDir = tmpdir()) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = join2(baseTmpDir, `agentbridge-${uid}`);
  const path = join2(dir, `codex-${appPort}.sock`);
  if (path.length >= 104) {
    throw new Error(`Codex unix socket path is too long for the platform (${path.length} >= 104): ${path}. ` + `Set a shorter TMPDIR or use ${CODEX_TRANSPORT_ENV}=ws.`);
  }
  return path;
}
function ensureSocketDir(socketPath) {
  const dir = socketPath.slice(0, socketPath.lastIndexOf("/"));
  if (!dir)
    return;
  mkdirSync3(dir, { recursive: true, mode: 448 });
  try {
    chmodSync(dir, 448);
  } catch (err) {
    throw new Error(`Refusing to use Codex socket dir ${dir}: cannot enforce 0700 perms ` + `(${err.message}). Remove it or set a private TMPDIR.`);
  }
}
function removeSocketFile(socketPath) {
  try {
    rmSync(socketPath, { force: true });
  } catch {}
}
function codexListenArg(transport, appPort, socketPath) {
  return transport === "unix" ? `unix://${socketPath}` : `ws://127.0.0.1:${appPort}`;
}
function stripWebSocketExtensions(headerBlock) {
  return headerBlock.split(`\r
`).filter((line) => !EXTENSIONS_HEADER_RE.test(line)).join(`\r
`);
}

class TcpToUnixRelay {
  tcpHost;
  tcpPort;
  unixPath;
  log;
  server = null;
  pairs = new Set;
  constructor(tcpHost, tcpPort, unixPath, log = () => {}) {
    this.tcpHost = tcpHost;
    this.tcpPort = tcpPort;
    this.unixPath = unixPath;
    this.log = log;
  }
  start() {
    return new Promise((resolve, reject) => {
      const server = createServer((tcp) => this.handleConnection(tcp));
      const onListenError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onListenError);
        server.on("error", (err) => this.log(`relay server error: ${err.message}`));
        this.server = server;
        resolve();
      };
      server.once("error", onListenError);
      server.once("listening", onListening);
      server.listen(this.tcpPort, this.tcpHost);
    });
  }
  handleConnection(tcp) {
    const unix = connect(this.unixPath);
    const pair = { tcp, unix };
    this.pairs.add(pair);
    let closed = false;
    const teardown = () => {
      if (closed)
        return;
      closed = true;
      this.pairs.delete(pair);
      tcp.destroy();
      unix.destroy();
    };
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf(HEADER_SEP);
      if (sep === -1) {
        if (head.length > MAX_UPGRADE_HEADER_BYTES) {
          tcp.removeListener("data", onData);
          unix.write(head);
          head = Buffer.alloc(0);
          tcp.pipe(unix);
        }
        return;
      }
      tcp.removeListener("data", onData);
      const headers = head.subarray(0, sep).toString("utf8");
      const rest = head.subarray(sep + HEADER_SEP.length);
      unix.write(stripWebSocketExtensions(headers) + HEADER_SEP);
      head = Buffer.alloc(0);
      if (rest.length)
        tcp.unshift(rest);
      tcp.pipe(unix);
    };
    tcp.on("data", onData);
    unix.pipe(tcp);
    tcp.on("error", (e) => {
      this.log(`relay tcp error: ${e.message}`);
      teardown();
    });
    unix.on("error", (e) => {
      this.log(`relay unix error: ${e.message}`);
      teardown();
    });
    tcp.on("close", teardown);
    unix.on("close", teardown);
  }
  get connectionCount() {
    return this.pairs.size;
  }
  get port() {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : this.tcpPort;
  }
  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const { tcp, unix } of this.pairs) {
      tcp.destroy();
      unix.destroy();
    }
    this.pairs.clear();
  }
}
async function waitForUnixWsReady(socketPath, maxRetries = 40, delayMs = 250) {
  for (let i = 0;i < maxRetries; i++) {
    if (await attemptUnixWsUpgrade(socketPath))
      return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Codex unix app-server at ${socketPath} did not become ready`);
}
function attemptUnixWsUpgrade(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled)
        return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    const socket = connect(socketPath, () => {
      socket.write(`GET / HTTP/1.1\r
Host: localhost\r
Upgrade: websocket\r
Connection: Upgrade\r
` + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r
Sec-WebSocket-Version: 13\r
\r
`);
    });
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes(`\r
`))
        done(buf.startsWith("HTTP/1.1 101"));
    });
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

// src/turn-notices.ts
var ADAPTER_DISCONNECT_REASON = "adapter disconnect";
var APP_SERVER_RECONNECT_NEW_TUI_REASON = "app-server reconnect for new TUI session";
var SILENT_ABORT_REASONS = new Set([
  ADAPTER_DISCONNECT_REASON,
  APP_SERVER_RECONNECT_NEW_TUI_REASON
]);
function buildTurnAbortedNotice(reason, replyWasRequired) {
  if (SILENT_ABORT_REASONS.has(reason))
    return null;
  const tail = replyWasRequired ? " A reply you were waiting on will NOT arrive \u2014 retry your last message, or wait for the Codex TUI to reconnect." : " If you were waiting on a reply it will not arrive; retry, or wait for the Codex TUI to reconnect.";
  return `\u26A0\uFE0F Codex's current turn ended without completing (${reason}). ` + "This usually means Codex hit an error (e.g. a rate limit / 429), the app-server connection dropped, or the turn was interrupted." + tail;
}

// src/codex-adapter.ts
class CodexAdapter extends EventEmitter {
  static RESPONSE_TRACKING_TTL_MS = 30000;
  proc = null;
  appServerPid = null;
  appServerWs = null;
  tuiWs = null;
  proxyServer = null;
  transport = "ws";
  socketPath = null;
  relay = null;
  threadId = null;
  nextInjectionId = -1;
  appPort;
  proxyPort;
  logFile;
  logger;
  tuiConnId = 0;
  connIdCounter = 0;
  secondaryConnections = new Map;
  agentMessageBuffers = new Map;
  pendingRequests = new Map;
  activeTurnIds = new Set;
  turnInProgress = false;
  turnWatchdogs = new Map;
  stalledTurnIds = new Set;
  threadSwitchSeq = 0;
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
  constructor(appPort = 4500, proxyPort = 4501, logFile = new StateDirResolver().logFile) {
    super();
    this.appPort = appPort;
    this.proxyPort = proxyPort;
    this.logFile = logFile;
    this.logger = createProcessLogger({ component: "CodexAdapter", logFile: this.logFile });
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
    this.resolveTransport();
    const listen = codexListenArg(this.transport, this.appPort, this.socketPath ?? "");
    if (this.transport === "unix" && this.socketPath) {
      ensureSocketDir(this.socketPath);
      removeSocketFile(this.socketPath);
    }
    this.log(`Spawning codex app-server (transport=${this.transport}) --listen ${listen}`);
    this.proc = spawn("codex", ["app-server", "--listen", listen], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.appServerPid = this.proc.pid ?? null;
    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("exit", (code) => {
      this.appServerPid = null;
      this.emit("exit", code);
    });
    const stderrRl = createInterface({ input: this.proc.stderr });
    stderrRl.on("line", (l) => this.log(`[codex-server] ${l}`));
    const stdoutRl = createInterface({ input: this.proc.stdout });
    stdoutRl.on("line", (l) => this.log(`[codex-stdout] ${l}`));
    if (this.transport === "unix" && this.socketPath) {
      await waitForUnixWsReady(this.socketPath);
      this.relay = new TcpToUnixRelay("127.0.0.1", this.appPort, this.socketPath, (m) => this.log(`[relay] ${m}`));
      await this.relay.start();
      this.log(`Transport relay ready: ws://127.0.0.1:${this.appPort} \u2192 unix://${this.socketPath}`);
    } else {
      await this.waitForHealthy();
    }
    await this.connectToAppServer();
    this.startProxy();
    this.log(`Proxy ready on ${this.proxyUrl}`);
  }
  resolveTransport() {
    const mode = parseTransportMode(process.env[CODEX_TRANSPORT_ENV]);
    this.transport = resolveCodexTransport(mode);
    this.socketPath = this.transport === "unix" ? codexSocketPath(this.appPort) : null;
    this.log(`Codex transport mode=${mode} resolved=${this.transport}`);
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
    if (this.relay) {
      this.relay.stop();
      this.relay = null;
    }
    if (this.socketPath)
      removeSocketFile(this.socketPath);
    this.clearResponseTrackingState();
    this.resetTurnState(ADAPTER_DISCONNECT_REASON);
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
  forceKillAppServerSync() {
    const pid = this.appServerPid;
    if (pid === null)
      return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
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
        params: { threadId: this.threadId, input: [{ type: "text", text }] }
      }));
      return true;
    } catch (err) {
      this.untrackBridgeRequestId(requestId);
      this.log(`Injection send failed: ${err.message}`);
      return false;
    }
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
    this.resetTurnState(APP_SERVER_RECONNECT_NEW_TUI_REASON);
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
    this.resetTurnState("app-server connection closed");
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
    }
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
        self.log(`HTTP ${req.method} ${url.pathname} (upgrade=${isUpgrade})`);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          return fetch(`http://127.0.0.1:${self.appPort}${url.pathname}`);
        }
        if (server.upgrade(req, { data: { connId: 0 } }))
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
      this.log(`Secondary TUI connected (conn #${connId}, primary is #${this.tuiConnId})`);
      this.setupSecondaryConnection(ws, connId);
      return;
    }
    const previousConnId = this.tuiConnId > 0 ? this.tuiConnId : null;
    this.tuiConnId = connId;
    this.tuiWs = ws;
    this.threadId = null;
    this.log(`TUI connected (conn #${this.tuiConnId})`);
    this.emit("tuiConnected", this.tuiConnId);
    if (previousConnId !== null) {
      this.retireConnectionState(previousConnId);
    }
  }
  setupSecondaryConnection(ws, connId) {
    const appWs = new WebSocket(this.appServerUrl);
    const entry = {
      tuiWs: ws,
      appServerWs: appWs,
      buffer: [],
      initialized: false,
      initializationReplayed: false
    };
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
      const method = this.detectJsonMethod(data);
      if (method === "initialize" || method === "initialized") {
        secondary.initialized = true;
      } else if (!secondary.initialized) {
        this.ensureSecondaryInitialized(secondary, connId);
      }
      this.sendOrBufferSecondary(secondary, data);
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
  detectJsonMethod(raw) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.method === "string" ? parsed.method : undefined;
    } catch {
      return;
    }
  }
  ensureSecondaryInitialized(secondary, connId) {
    if (secondary.initializationReplayed)
      return;
    secondary.initializationReplayed = true;
    if (!this.lastInitializeRaw) {
      this.log(`Secondary conn #${connId}: no cached initialize available before first non-initialize request`);
      return;
    }
    this.log(`Secondary conn #${connId}: replaying cached initialize before picker request`);
    this.sendOrBufferSecondary(secondary, this.lastInitializeRaw);
    if (this.lastInitializedRaw) {
      this.sendOrBufferSecondary(secondary, this.lastInitializedRaw);
    }
    secondary.initialized = true;
  }
  sendOrBufferSecondary(secondary, raw) {
    if (secondary.appServerWs && secondary.appServerWs.readyState === WebSocket.OPEN) {
      try {
        secondary.appServerWs.send(raw);
      } catch {}
    } else {
      secondary.buffer.push(raw);
    }
  }
  handleAppServerPayload(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        this.refreshTurnWatchdogs();
      }
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
        this.emit("turnAborted", `injected turn/start rejected: ${parsed.error.message ?? "unknown error"}`);
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
      case "turn/started":
        this.markTurnStarted(params?.turn?.id);
        break;
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
        }
        break;
      }
      case "turn/completed": {
        const wasInProgress = this.turnInProgress;
        this.markTurnCompleted(params?.turn?.id);
        if (wasInProgress && !this.turnInProgress) {
          this.emit("turnCompleted");
        }
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
    if (method === "thread/start" || method === "thread/resume") {
      pending.threadSwitchSeq = ++this.threadSwitchSeq;
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
        if (!this.isLatestThreadSwitch(pending)) {
          this.log(`Ignoring stale thread/start response ${key} (seq=${pending.threadSwitchSeq} < latest=${this.threadSwitchSeq})`);
          break;
        }
        const threadId = message?.result?.thread?.id;
        if (typeof threadId === "string" && threadId.length > 0) {
          this.setActiveThreadId(threadId, `thread/start response ${key}`);
        }
        this.dropOrphanPendingRequests(`thread/start (new session)`);
        break;
      }
      case "thread/resume": {
        if (!this.isLatestThreadSwitch(pending)) {
          this.log(`Ignoring stale thread/resume response ${key} (seq=${pending.threadSwitchSeq} < latest=${this.threadSwitchSeq})`);
          break;
        }
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
          if (this.threadId === null || this.threadId === pending.threadId) {
            this.setActiveThreadId(pending.threadId, `turn/start response ${key}`);
          } else {
            this.log(`Ignoring turn/start response ${key} threadId=${pending.threadId} (active thread is ${this.threadId})`);
          }
        }
        break;
    }
  }
  isLatestThreadSwitch(pending) {
    return pending.threadSwitchSeq === this.threadSwitchSeq;
  }
  setActiveThreadId(threadId, reason) {
    if (this.threadId === threadId)
      return;
    const previousThreadId = this.threadId;
    this.threadId = threadId;
    this.emit("threadChanged", { threadId, previousThreadId, reason });
    if (previousThreadId) {
      this.log(`Active thread changed: ${previousThreadId} \u2192 ${threadId} (${reason})`);
      return;
    }
    this.log(`Thread detected: ${threadId} (${reason})`);
    this.emit("ready", threadId);
  }
  markTurnStarted(turnId) {
    const wasInProgress = this.turnInProgress;
    const turnKey = typeof turnId === "string" && turnId.length > 0 ? turnId : `unknown:${Date.now()}`;
    this.activeTurnIds.add(turnKey);
    this.stalledTurnIds.delete(turnKey);
    this.scheduleTurnWatchdog(turnKey);
    this.turnInProgress = this.activeTurnIds.size > 0;
    if (!wasInProgress && this.turnInProgress) {
      this.emit("turnStarted");
    }
  }
  markTurnCompleted(turnId) {
    if (typeof turnId === "string" && turnId.length > 0) {
      this.activeTurnIds.delete(turnId);
      this.clearTurnWatchdog(turnId);
      this.stalledTurnIds.delete(turnId);
    } else {
      this.activeTurnIds.clear();
      this.clearAllTurnWatchdogs();
      this.stalledTurnIds.clear();
    }
    this.turnInProgress = this.activeTurnIds.size > 0;
  }
  turnWatchdogMs() {
    const v = Number(process.env.AGENTBRIDGE_TURN_WATCHDOG_MS);
    return Number.isFinite(v) && v > 0 ? v : 300000;
  }
  scheduleTurnWatchdog(turnKey) {
    this.clearTurnWatchdog(turnKey);
    const timer = setTimeout(() => {
      if (!this.activeTurnIds.has(turnKey))
        return;
      this.log(`WARNING: turn ${turnKey} watchdog fired after ${this.turnWatchdogMs()}ms of inactivity \u2014 ` + `marking stalled but keeping Codex busy until a real completion or reconnect`);
      this.markTurnStalled(turnKey);
    }, this.turnWatchdogMs());
    timer.unref?.();
    this.turnWatchdogs.set(turnKey, timer);
  }
  clearTurnWatchdog(turnKey) {
    const timer = this.turnWatchdogs.get(turnKey);
    if (timer) {
      clearTimeout(timer);
      this.turnWatchdogs.delete(turnKey);
    }
  }
  clearAllTurnWatchdogs() {
    for (const timer of this.turnWatchdogs.values())
      clearTimeout(timer);
    this.turnWatchdogs.clear();
  }
  refreshTurnWatchdogs() {
    if (this.turnWatchdogs.size === 0)
      return;
    for (const turnKey of [...this.turnWatchdogs.keys()]) {
      this.scheduleTurnWatchdog(turnKey);
    }
  }
  markTurnStalled(turnKey) {
    if (!this.activeTurnIds.has(turnKey))
      return;
    this.turnInProgress = true;
    if (this.stalledTurnIds.has(turnKey))
      return;
    this.stalledTurnIds.add(turnKey);
    this.emit("turnStalled", {
      turnId: turnKey,
      inactivityMs: this.turnWatchdogMs()
    });
  }
  resetTurnState(reason, emitCompleted = false) {
    const wasInProgress = this.turnInProgress;
    this.activeTurnIds.clear();
    this.clearAllTurnWatchdogs();
    this.stalledTurnIds.clear();
    this.turnInProgress = false;
    if (wasInProgress) {
      if (emitCompleted) {
        this.emit("turnCompleted");
      } else {
        this.emit("turnAborted", reason);
      }
      this.log(`Turn state reset (${reason})`);
    }
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
    this.logger.log(msg);
  }
}

// src/control-protocol.ts
var CLOSE_CODE_REPLACED = 4001;
var CLOSE_CODE_EVICTED_STALE = 4002;
var CLOSE_CODE_PROBE_IN_PROGRESS = 4003;
var CLOSE_CODE_PAIR_MISMATCH = 4004;

// src/daemon-identity.ts
function validateClaudeClientIdentity(input) {
  if (!input.expectedPairId)
    return { ok: true };
  if (!input.identity) {
    return input.allowIdentityless ? { ok: true } : { ok: false, closeCode: CLOSE_CODE_PAIR_MISMATCH, reason: "missing client identity" };
  }
  if (input.identity.pairId !== input.expectedPairId) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `pair mismatch: expected ${input.expectedPairId}, got ${input.identity.pairId ?? "<none>"}`
    };
  }
  if (!input.identity.cwd || input.identity.cwd !== input.daemonCwd) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `cwd mismatch: expected ${input.daemonCwd}, got ${input.identity.cwd ?? "<none>"}`
    };
  }
  return { ok: true };
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
import { existsSync as existsSync3, readFileSync, unlinkSync as unlinkSync2, writeFileSync, openSync, closeSync, constants } from "fs";
import { fileURLToPath } from "url";

// src/env-utils.ts
function parsePositiveIntEnv(name, fallback, log = () => {}, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === "")
    return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    log(`Invalid ${name}=${JSON.stringify(raw)} (must be a positive integer within ` + `Number.MAX_SAFE_INTEGER); falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

// src/daemon-lifecycle.ts
var DEFAULT_DAEMON_ENTRY = import.meta.url.endsWith(".ts") ? "./daemon.ts" : "./daemon.js";
var DAEMON_ENTRY = process.env.AGENTBRIDGE_DAEMON_ENTRY || DEFAULT_DAEMON_ENTRY;
var DAEMON_PATH = fileURLToPath(new URL(DAEMON_ENTRY, import.meta.url));
var REUSE_READY_RETRIES = parsePositiveIntEnv("AGENTBRIDGE_REUSE_READY_RETRIES", 12);
var REUSE_READY_DELAY_MS = 250;
var HEALTH_FETCH_TIMEOUT_MS = 500;

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
  get expectedPairId() {
    return process.env.AGENTBRIDGE_PAIR_ID || null;
  }
  async fetchStatus() {
    try {
      const response = await fetchWithTimeout(this.healthUrl);
      if (!response.ok)
        return null;
      return await response.json();
    } catch {
      return null;
    }
  }
  isForeignDaemon(status) {
    const expected = this.expectedPairId;
    if (!expected)
      return false;
    if (!status)
      return false;
    const reported = status.pairId;
    if (reported == null)
      return true;
    return reported !== expected;
  }
  isBuildDrifted(status) {
    if (process.env.AGENTBRIDGE_ALLOW_BUILD_DRIFT === "1")
      return false;
    const runtime = status?.build;
    if (!runtime)
      return true;
    return !sameRuntimeContract(runtime, BUILD_INFO);
  }
  async ensureRunning() {
    if (await this.isHealthy()) {
      const status = await this.fetchStatus();
      if (this.isForeignDaemon(status)) {
        this.log(`Control port ${this.controlPort} held by a daemon for pair ${status?.pairId ?? "<none>"}, ` + `but this pair is ${this.expectedPairId} \u2014 replacing foreign daemon`);
        await this.replaceUnhealthyDaemon(status?.pid);
        return;
      }
      if (this.isBuildDrifted(status)) {
        this.log(`Daemon on control port ${this.controlPort} is running build ${formatBuildInfo(status?.build)} ` + `but launcher is ${formatBuildInfo(BUILD_INFO)} \u2014 replacing drifted daemon`);
        await this.replaceUnhealthyDaemon(status?.pid);
        return;
      }
      try {
        await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
        return;
      } catch {
        this.log(`Daemon on control port ${this.controlPort} is healthy but not ready within reuse window \u2014 replacing`);
        await this.replaceUnhealthyDaemon(status?.pid);
        return;
      }
    }
    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        if (this.isDaemonProcess(existingPid)) {
          try {
            await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
            return;
          } catch {
            this.log(`Existing daemon process ${existingPid} never became ready \u2014 replacing`);
            await this.replaceUnhealthyDaemon(existingPid);
            return;
          }
        }
        this.log(`Pid ${existingPid} is alive but not an AgentBridge daemon, removing stale pid file`);
      }
      this.removeStalePidFile();
    }
    await this.withStartupLockStrict(async (locked) => {
      if (!locked) {
        this.log("Another process holds the startup lock, waiting for readiness+identity...");
        await this.waitForReadyAndOurs();
        return;
      }
      if (await this.isHealthy()) {
        const status = await this.fetchStatus();
        if (this.isForeignDaemon(status) || this.isBuildDrifted(status)) {
          this.log(`Daemon on control port ${this.controlPort} is not reusable under startup lock ` + `(pair=${status?.pairId ?? "<none>"}, build=${formatBuildInfo(status?.build)}) \u2014 replacing`);
          await this.kill(3000, status?.pid);
        } else {
          try {
            await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
            return;
          } catch {
            this.log(`Daemon on control port ${this.controlPort} is healthy but not ready under startup lock \u2014 replacing`);
            await this.kill(3000, status?.pid);
          }
        }
      }
      this.launch();
      await this.waitForReady();
    });
  }
  async isHealthy() {
    try {
      const response = await fetchWithTimeout(this.healthUrl);
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
      const response = await fetchWithTimeout(this.readyUrl);
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
  async waitForReadyAndOurs(maxRetries = 40, delayMs = 250) {
    for (let attempt = 0;attempt < maxRetries; attempt++) {
      if (await this.isReady()) {
        const status = await this.fetchStatus();
        if (!this.isForeignDaemon(status) && !this.isBuildDrifted(status))
          return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon readiness+identity on ${this.readyUrl} (control port ${this.controlPort})`);
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
      unlinkSync2(this.stateDir.pidFile);
    } catch {}
  }
  removeStatusFile() {
    try {
      unlinkSync2(this.stateDir.statusFile);
    } catch {}
  }
  markKilled() {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.killedFile, `${Date.now()}
`, "utf-8");
  }
  clearKilled() {
    try {
      unlinkSync2(this.stateDir.killedFile);
    } catch {}
  }
  wasKilled() {
    return existsSync3(this.stateDir.killedFile);
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
  async replaceUnhealthyDaemon(statusPid) {
    await this.withStartupLockStrict(async (locked) => {
      if (!locked) {
        this.log("Another process holds the startup lock, waiting for readiness+identity...");
        await this.waitForReadyAndOurs();
        return;
      }
      if (await this.isHealthy()) {
        const status = await this.fetchStatus();
        if (!this.isForeignDaemon(status) && !this.isBuildDrifted(status)) {
          try {
            await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
            return;
          } catch {}
        }
      }
      this.log(`Killing unhealthy daemon on control port ${this.controlPort} and relaunching`);
      await this.kill(3000, statusPid);
      this.launch();
      await this.waitForReady();
    });
  }
  async withStartupLockStrict(fn) {
    const locked = this.acquireLockStrict();
    try {
      return await fn(locked);
    } finally {
      if (locked)
        this.releaseLock();
    }
  }
  acquireLockStrict(reclaimed = false) {
    this.stateDir.ensure();
    try {
      const fd = openSync(this.stateDir.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}
`);
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        if (reclaimed)
          return false;
        try {
          const holderPid = Number.parseInt(readFileSync(this.stateDir.lockFile, "utf-8").trim(), 10);
          if (Number.isFinite(holderPid) && !isProcessAlive(holderPid)) {
            this.log(`Stale startup lock from dead process ${holderPid}, reclaiming`);
            this.releaseLock();
            return this.acquireLockStrict(true);
          }
        } catch {
          return false;
        }
        return false;
      }
      this.log(`Could not acquire strict startup lock: ${err.message}`);
      return false;
    }
  }
  releaseLock() {
    try {
      unlinkSync2(this.stateDir.lockFile);
    } catch {}
  }
  async kill(gracefulTimeoutMs = 3000, pidOverride) {
    const pid = pidOverride ?? this.readPid();
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
      const hasDaemonEntry = /(?:^|[\s/\\])[\w.-]*-?daemon\.(?:ts|js)(?:\s|$)/.test(cmd);
      const hasAgentbridge = cmd.includes("agentbridge") || cmd.includes("agent_bridge");
      return hasDaemonEntry && hasAgentbridge;
    } catch {
      return false;
    }
  }
  cleanup() {
    this.removePidFile();
    this.removeStatusFile();
  }
}
async function fetchWithTimeout(url, timeoutMs = HEALTH_FETCH_TIMEOUT_MS) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
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
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync4, existsSync as existsSync4 } from "fs";
import { join as join3 } from "path";
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
    this.configDir = join3(root, CONFIG_DIR);
    this.configPath = join3(this.configDir, CONFIG_FILE);
  }
  hasConfig() {
    return existsSync4(this.configPath);
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
    if (!existsSync4(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      created.push(this.configPath);
    }
    return created;
  }
  get configFilePath() {
    return this.configPath;
  }
  ensureConfigDir() {
    if (!existsSync4(this.configDir)) {
      mkdirSync4(this.configDir, { recursive: true });
    }
  }
}

// src/reply-required-tracker.ts
class ReplyRequiredTracker {
  armed = false;
  forwardedDuringTurn = false;
  get isArmed() {
    return this.armed;
  }
  arm() {
    this.armed = true;
    this.forwardedDuringTurn = false;
  }
  noteForwarded() {
    if (this.armed)
      this.forwardedDuringTurn = true;
  }
  consumeOnTurnComplete() {
    const warnReplyMissing = this.armed && !this.forwardedDuringTurn;
    this.reset();
    return { warnReplyMissing };
  }
  reset() {
    this.armed = false;
    this.forwardedDuringTurn = false;
  }
}

// src/thread-state.ts
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync5,
  readdirSync,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  writeFileSync as writeFileSync3
} from "fs";
import { homedir as homedir2 } from "os";
import { basename, dirname as dirname2, join as join4 } from "path";
function nowIso() {
  return new Date().toISOString();
}
function threadTag(identity) {
  const name = identity.pairName ?? identity.pairId ?? "manual";
  return `abg:${name}:${identity.cwd}`;
}
function codexHome(env = process.env) {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join4(homedir2(), ".codex");
}
function atomicWriteJson(path, value) {
  mkdirSync5(dirname2(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync3(tmp, JSON.stringify(value, null, 2) + `
`, "utf-8");
  renameSync2(tmp, path);
}
function readRawCurrentThread(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync3(stateDir.currentThreadFile, "utf-8"));
    if (parsed?.version === 1 && typeof parsed.threadId === "string" && parsed.threadId.length > 0 && (parsed.status === "pending" || parsed.status === "current") && typeof parsed.cwd === "string") {
      return parsed;
    }
  } catch {}
  return null;
}
function findCodexRolloutFile(threadId, env = process.env, maxEntries = 20000) {
  const sessionsDir = join4(codexHome(env), "sessions");
  if (!threadId || !existsSync5(sessionsDir))
    return null;
  const exactName = `rollout-${threadId}.jsonl`;
  const stack = [sessionsDir];
  let visited = 0;
  while (stack.length > 0 && visited < maxEntries) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      const path = join4(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile())
        continue;
      const name = basename(entry.name);
      if (name === exactName || name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(threadId)) {
        return path;
      }
    }
  }
  return null;
}
function writePendingCurrentThread(identity, threadId, reason) {
  const state = {
    version: 1,
    status: "pending",
    pairId: identity.pairId,
    pairName: identity.pairName,
    cwd: identity.cwd,
    threadId,
    updatedAt: nowIso(),
    reason,
    tag: threadTag(identity)
  };
  atomicWriteJson(identity.stateDir.currentThreadFile, state);
  return state;
}
function promoteCurrentThreadIfRolloutExists(identity, threadId, reason, env = process.env) {
  const rolloutPath = findCodexRolloutFile(threadId, env);
  const state = {
    version: 1,
    status: rolloutPath ? "current" : "pending",
    pairId: identity.pairId,
    pairName: identity.pairName,
    cwd: identity.cwd,
    threadId,
    updatedAt: nowIso(),
    reason,
    tag: threadTag(identity),
    ...rolloutPath ? { rolloutPath, rolloutVerifiedAt: nowIso() } : {}
  };
  atomicWriteJson(identity.stateDir.currentThreadFile, state);
  return state;
}
async function persistCurrentThreadWithRolloutRetry(identity, threadId, reason, options = {}) {
  const env = options.env ?? process.env;
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 250;
  const shouldContinue = options.shouldContinue ?? (() => true);
  if (!shouldContinue())
    return null;
  writePendingCurrentThread(identity, threadId, reason);
  for (let attempt = 1;attempt <= attempts; attempt++) {
    if (!shouldContinue()) {
      options.log?.(`Abandoned current-thread persistence for ${threadId}: a newer thread became active`);
      return null;
    }
    const state = promoteCurrentThreadIfRolloutExists(identity, threadId, reason, env);
    if (state.status === "current") {
      options.log?.(`Current Codex thread persisted: ${threadId} (${state.rolloutPath})`);
      return state;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (!shouldContinue())
    return null;
  options.log?.(`Current Codex thread left pending because no rollout file was found: ${threadId}`);
  return readRawCurrentThread(identity.stateDir) ?? writePendingCurrentThread(identity, threadId, reason);
}

// src/waiting-message.ts
function formatWaitingForCodexTuiMessage(options) {
  const pairName = options.pairName ?? "unknown";
  const pairId = options.pairId ?? "manual";
  const slot = options.slot === null || options.slot === undefined ? "manual" : String(options.slot);
  return [
    "\u23F3 Waiting for Codex TUI to connect.",
    `Current pair: cwd=${options.cwd} pair=${pairName} pairId=${pairId} slot=${slot} proxy=${options.proxyUrl}`,
    "If Codex was started from a different cwd, it belongs to another pair and will not attach here.",
    "Run in another terminal:",
    options.attachCmd,
    "For diagnostics: abg doctor"
  ].join(`
`);
}

// src/pair-registry.ts
var PAIR_BASE_PORT = 4500;
var PAIR_SLOT_STRIDE = 10;
var MAX_PAIR_SLOT = Math.floor((65535 - 2 - PAIR_BASE_PORT) / PAIR_SLOT_STRIDE);

// src/liveness-probe.ts
var OPEN = 1;
async function probeLiveness(target, options) {
  const {
    timeoutMs,
    pollMs = 50,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = options;
  if (target.readyState !== OPEN)
    return false;
  const baseline = target.pongCount;
  try {
    target.ping();
  } catch {
    return false;
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (target.pongCount > baseline)
      return true;
    if (target.readyState !== OPEN)
      return false;
    await sleep(pollMs);
  }
  return target.pongCount > baseline;
}

// src/daemon.ts
var stateDir = new StateDirResolver;
stateDir.ensure();
var configService = new ConfigService;
var config = configService.loadOrDefault();
var processLogger = createProcessLogger({ component: "AgentBridgeDaemon", logFile: stateDir.logFile });
var CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
var CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
var CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
var TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
var CLAUDE_DISCONNECT_GRACE_MS = 5000;
var MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
var FILTER_MODE = process.env.AGENTBRIDGE_FILTER_MODE === "full" ? "full" : "filtered";
var IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
var ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);
var BOOTSTRAP_TIMEOUT_MS = parsePositiveIntEnv("AGENTBRIDGE_BOOTSTRAP_TIMEOUT_MS", 45000);
var CODEX_BOOT_RETRIES = parsePositiveIntEnv("AGENTBRIDGE_CODEX_BOOT_RETRIES", 2);
var ALLOW_IDENTITYLESS_CLIENT = process.env.AGENTBRIDGE_COMPAT_IDENTITYLESS === "1";
var daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
var codex = new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile);
var attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;
var controlServer = null;
var attachedClaude = null;
var nextControlClientId = 0;
var nextSystemMessageId = 0;
var codexBootstrapped = false;
var attentionWindowTimer = null;
var inAttentionWindow = false;
var replyTracker = new ReplyRequiredTracker;
var shuttingDown = false;
var bootDeadlineTimer = null;
var idleShutdownTimer = null;
var claudeDisconnectTimer = null;
var lastAttachStatusSentTs = 0;
var ATTACH_STATUS_COOLDOWN_MS = 30000;
var LIVENESS_PROBE_TIMEOUT_MS = parsePositiveIntEnv("AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS", 3000, log);
var LIVENESS_PROBE_POLL_MS = 50;
var challengeInProgress = false;
var bufferedMessages = [];
var tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    emitToClaude(systemMessage("system_tui_disconnected", `\u26A0\uFE0F Codex TUI disconnected (conn #${connId}). Codex is still running in the background \u2014 reconnect the TUI to resume.`));
  },
  onReconnectAfterNotice: (connId) => {
    emitToClaude(systemMessage("system_tui_reconnected", `\u2705 Codex TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`));
  }
});
var statusBuffer = new StatusBuffer((summary) => emitToClaude(summary));
codex.on("turnStarted", () => {
  log("Codex turn started");
  emitToClaude(systemMessage("system_turn_started", "\u23F3 Codex is working on the current task. Wait for completion before sending a reply."));
});
codex.on("agentMessage", (msg) => {
  if (msg.source !== "codex")
    return;
  const result = classifyMessage(msg.content, FILTER_MODE);
  if (replyTracker.isArmed) {
    log(`Codex \u2192 Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
    replyTracker.noteForwarded();
    if (statusBuffer.size > 0) {
      statusBuffer.flush("reply-required message arrived");
    }
    emitToClaude(msg);
    return;
  }
  if (inAttentionWindow && result.marker === "status") {
    log(`Codex \u2192 Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(msg);
    return;
  }
  log(`Codex \u2192 Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
  switch (result.action) {
    case "forward":
      if (result.marker === "important" && statusBuffer.size > 0) {
        statusBuffer.flush("important message arrived");
      }
      emitToClaude(msg);
      if (result.marker === "important") {
        startAttentionWindow();
      }
      break;
    case "buffer":
      statusBuffer.add(msg);
      break;
    case "drop":
      break;
  }
});
codex.on("turnCompleted", () => {
  log("Codex turn completed");
  statusBuffer.flush("turn completed");
  const { warnReplyMissing } = replyTracker.consumeOnTurnComplete();
  if (warnReplyMissing) {
    log("\u26A0\uFE0F Reply was required but Codex did not send any agentMessage");
    emitToClaude(systemMessage("system_reply_missing", "\u26A0\uFE0F Codex completed the turn without sending a reply (require_reply was set). Codex may not have generated an agentMessage. You may want to retry or rephrase."));
  }
  emitToClaude(systemMessage("system_turn_completed", "\u2705 Codex finished the current turn. You can reply now if needed."));
  startAttentionWindow();
});
codex.on("turnAborted", (reason) => {
  log(`Codex turn aborted (${reason}) \u2014 clearing reply-required state`);
  const replyWasRequired = replyTracker.isArmed;
  replyTracker.reset();
  const notice = buildTurnAbortedNotice(reason, replyWasRequired);
  if (notice) {
    emitToClaude(systemMessage("system_turn_aborted", notice));
  }
});
codex.on("turnStalled", (event) => {
  log(`Codex turn stalled (${event.turnId}, inactivity ${event.inactivityMs}ms)`);
  emitToClaude(systemMessage("system_turn_stalled", `\u26A0\uFE0F Codex has been silent for ${event.inactivityMs}ms while a turn is still in progress. AgentBridge is keeping the turn busy and will not send a fake completion; wait for Codex to finish or reconnect the TUI if it is stuck.`));
});
codex.on("ready", (threadId) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex ready \u2014 thread ${threadId}`);
  log("Bridge fully operational");
  emitToClaude(systemMessage("system_ready", currentReadyMessage()));
});
codex.on("threadChanged", (event) => {
  broadcastStatus();
  persistCurrentThreadWithRolloutRetry({
    stateDir,
    pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
    pairName: process.env.AGENTBRIDGE_PAIR_NAME,
    cwd: process.cwd()
  }, event.threadId, event.reason, {
    log,
    shouldContinue: () => codex.activeThreadId === event.threadId
  }).catch((err) => {
    log(`Failed to persist current thread ${event.threadId}: ${err?.message ?? err}`);
  });
});
codex.on("tuiConnected", (connId) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`Codex TUI connected (conn #${connId})`);
  broadcastStatus();
});
codex.on("tuiDisconnected", (connId) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`Codex TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});
codex.on("error", (err) => {
  log(`Codex error: ${err.message}`);
});
codex.on("exit", (code) => {
  log(`Codex process exited (code ${code})`);
  codexBootstrapped = false;
  replyTracker.reset();
  statusBuffer.flush("codex exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  emitToClaude(systemMessage("system_codex_exit", `\u26A0\uFE0F Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the Codex side needs to be restarted.`));
  broadcastStatus();
  armBootDeadline();
});
function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Response.json(currentStatus());
      }
      if (url.pathname === "/readyz") {
        return Response.json(currentStatus(), { status: codexBootstrapped ? 200 : 503 });
      }
      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false, lastPongAt: Date.now(), pongCount: 0 } })) {
        return;
      }
      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960,
      sendPings: true,
      open: (ws) => {
        ws.data.clientId = ++nextControlClientId;
        ws.data.lastPongAt = Date.now();
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws, code, reason) => {
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, wasAttached=${attachedClaude === ws})`);
        if (attachedClaude === ws) {
          detachClaude(ws, "frontend socket closed");
        }
      },
      message: (ws, raw) => {
        handleControlMessage(ws, raw);
      },
      pong: (ws) => {
        ws.data.lastPongAt = Date.now();
        ws.data.pongCount++;
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
      const admission = validateClaudeClientIdentity({
        expectedPairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
        daemonCwd: process.cwd(),
        identity: message.identity,
        allowIdentityless: ALLOW_IDENTITYLESS_CLIENT
      });
      if (!admission.ok) {
        log(`Rejecting Claude frontend #${ws.data.clientId}: ${admission.reason}`);
        ws.close(admission.closeCode, admission.reason);
        return;
      }
      attachClaude(ws, message.identity).catch((err) => {
        log(`attachClaude threw for #${ws.data.clientId}: ${err?.message ?? err}`);
      });
      return;
    case "claude_disconnect":
      detachClaude(ws, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(ws);
      return;
    case "probe_incumbent":
      handleProbeIncumbent(ws).catch((err) => {
        log(`handleProbeIncumbent threw for #${ws.data.clientId}: ${err?.message ?? err}`);
      });
      return;
    case "claude_to_codex": {
      if (message.message.source !== "claude") {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source"
        });
        return;
      }
      if (!tuiConnectionState.canReply()) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Codex is not ready. Wait for TUI to connect and create a thread."
        });
        return;
      }
      const requireReply = !!message.requireReply;
      let contentToSend = message.message.content;
      if (requireReply) {
        contentToSend += REPLY_REQUIRED_INSTRUCTION;
      }
      log(`Forwarding Claude \u2192 Codex (${message.message.content.length} chars, requireReply=${requireReply})`);
      const injected = codex.injectMessage(contentToSend);
      if (!injected) {
        const reason = codex.turnInProgress ? "Codex is busy executing a turn. Wait for it to finish before sending another message." : "Injection failed: no active thread or WebSocket not connected.";
        log(`Injection rejected: ${reason}`);
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: reason
        });
        return;
      }
      if (requireReply) {
        replyTracker.arm();
        log(`Reply required flag set for this message`);
      }
      clearAttentionWindow();
      sendProtocolMessage(ws, {
        type: "claude_to_codex_result",
        requestId: message.requestId,
        success: true
      });
      return;
    }
  }
}
async function attachClaude(ws, identity) {
  const occupant = attachedClaude;
  if (occupant && occupant !== ws && occupant.readyState !== WebSocket.CLOSED) {
    const msSincePong = Date.now() - occupant.data.lastPongAt;
    log(`Claude frontend contest: new=#${ws.data.clientId}, incumbent=#${occupant.data.clientId} ` + `(readyState=${occupant.readyState}, msSincePong=${msSincePong})`);
    if (challengeInProgress) {
      log(`Rejecting Claude frontend #${ws.data.clientId} \u2014 another liveness probe already in flight`);
      ws.close(CLOSE_CODE_PROBE_IN_PROGRESS, "liveness probe in progress, retry shortly");
      return;
    }
    challengeInProgress = true;
    let incumbentAlive = false;
    try {
      incumbentAlive = await probeLiveness2(occupant, LIVENESS_PROBE_TIMEOUT_MS);
    } finally {
      challengeInProgress = false;
    }
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      log(`Contestant #${ws.data.clientId} disappeared during probe \u2014 aborting`);
      if (!incumbentAlive) {
        evictStale(occupant, "contestant gone but probe still failed");
      }
      return;
    }
    if (incumbentAlive) {
      log(`Rejecting Claude frontend #${ws.data.clientId} \u2014 incumbent #${occupant.data.clientId} responded to liveness probe`);
      ws.close(CLOSE_CODE_REPLACED, "another Claude session is already connected");
      return;
    }
    evictStale(occupant, `liveness probe timed out after ${LIVENESS_PROBE_TIMEOUT_MS}ms`);
  }
  if (attachedClaude && attachedClaude !== ws && attachedClaude.readyState !== WebSocket.CLOSED) {
    log(`Rejecting Claude frontend #${ws.data.clientId} \u2014 slot re-acquired by #${attachedClaude.data.clientId} after probe`);
    ws.close(CLOSE_CODE_REPLACED, "another Claude session is already connected");
    return;
  }
  clearPendingClaudeDisconnect("Claude frontend attached");
  ws.data.identity = identity;
  attachedClaude = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`Claude frontend attached (#${ws.data.clientId}, pair=${identity?.pairId ?? "<none>"}, cwd=${identity?.cwd ?? "<unknown>"})`);
  statusBuffer.flush("claude reconnected");
  sendStatus(ws);
  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;
  if (bufferedMessages.length > 0) {
    flushBufferedMessages(ws);
  } else if (!isRapidReattach) {
    if (tuiConnectionState.canReply()) {
      sendBridgeMessage(ws, systemMessage("system_ready", currentReadyMessage()));
    } else if (codexBootstrapped) {
      sendBridgeMessage(ws, systemMessage("system_waiting", currentWaitingMessage()));
    }
  }
  lastAttachStatusSentTs = now;
}
function detachClaude(ws, reason) {
  if (attachedClaude !== ws)
    return;
  attachedClaude = null;
  ws.data.attached = false;
  log(`Claude frontend detached (#${ws.data.clientId}, ${reason})`);
  scheduleClaudeDisconnectNotification(ws.data.clientId);
  scheduleIdleShutdown();
}
async function handleProbeIncumbent(ws) {
  const occupant = attachedClaude;
  log(`probe_incumbent from #${ws.data.clientId}: occupant=${occupant ? "#" + occupant.data.clientId : "none"} readyState=${occupant?.readyState}`);
  if (!occupant || occupant === ws || occupant.readyState !== WebSocket.OPEN) {
    sendProtocolMessage(ws, { type: "incumbent_status", connected: false, alive: false });
    return;
  }
  if (challengeInProgress) {
    sendProtocolMessage(ws, { type: "incumbent_status", connected: true, alive: true });
    return;
  }
  const alive = await probeLiveness2(occupant, LIVENESS_PROBE_TIMEOUT_MS);
  const stillConnected = attachedClaude === occupant && occupant.readyState === WebSocket.OPEN;
  log(`probe_incumbent reply to #${ws.data.clientId}: connected=${stillConnected} alive=${stillConnected && alive}`);
  sendProtocolMessage(ws, {
    type: "incumbent_status",
    connected: stillConnected,
    alive: stillConnected && alive
  });
}
async function probeLiveness2(ws, timeoutMs) {
  return probeLiveness({
    get readyState() {
      return ws.readyState;
    },
    get pongCount() {
      return ws.data.pongCount;
    },
    ping: () => {
      ws.ping();
    }
  }, { timeoutMs, pollMs: LIVENESS_PROBE_POLL_MS });
}
function evictStale(ws, reason) {
  log(`Evicting stale Claude frontend #${ws.data.clientId}: ${reason}`);
  if (attachedClaude === ws) {
    detachClaude(ws, `evicted: ${reason}`);
  }
  try {
    ws.close(CLOSE_CODE_EVICTED_STALE, "stale frontend evicted by newer session");
  } catch (err) {
    log(`Evict close threw on #${ws.data.clientId}: ${err.message}`);
  }
}
function startAttentionWindow() {
  clearAttentionWindow();
  inAttentionWindow = true;
  statusBuffer.pause();
  log(`Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  attentionWindowTimer = setTimeout(() => {
    attentionWindowTimer = null;
    inAttentionWindow = false;
    statusBuffer.resume();
    log("Attention window ended");
  }, ATTENTION_WINDOW_MS);
}
function clearAttentionWindow() {
  if (attentionWindowTimer) {
    clearTimeout(attentionWindowTimer);
    attentionWindowTimer = null;
  }
  if (inAttentionWindow) {
    statusBuffer.resume();
  }
  inAttentionWindow = false;
}
function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (attachedClaude)
    return;
  const snapshot = tuiConnectionState.snapshot();
  if (snapshot.tuiConnected)
    return;
  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if (attachedClaude || tuiConnectionState.snapshot().tuiConnected) {
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
function clearPendingClaudeDisconnect(reason) {
  if (!claudeDisconnectTimer)
    return;
  clearTimeout(claudeDisconnectTimer);
  claudeDisconnectTimer = null;
  if (reason) {
    log(`Cleared pending Claude disconnect notification (${reason})`);
  }
}
function scheduleClaudeDisconnectNotification(clientId) {
  clearPendingClaudeDisconnect("rescheduled");
  claudeDisconnectTimer = setTimeout(() => {
    claudeDisconnectTimer = null;
    if (attachedClaude) {
      log(`Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`);
      return;
    }
    log(`Claude disconnect persisted past grace window (client #${clientId})`);
  }, CLAUDE_DISCONNECT_GRACE_MS);
}
function emitToClaude(message) {
  if (attachedClaude && attachedClaude.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(attachedClaude, message))
      return;
    log("Send to Claude failed, buffering message for retry on reconnect");
  }
  bufferedMessages.push(message);
  if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    bufferedMessages.splice(0, dropped);
    log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
  }
}
function trySendBridgeMessage(ws, message) {
  try {
    const result = ws.send(JSON.stringify({ type: "codex_to_claude", message }));
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
function flushBufferedMessages(ws) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(ws, message)) {
      const failedIndex = messages.indexOf(message);
      const remaining = messages.slice(failedIndex);
      bufferedMessages.unshift(...remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}
function sendBridgeMessage(ws, message) {
  trySendBridgeMessage(ws, message);
}
function sendStatus(ws) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}
function broadcastStatus() {
  if (!attachedClaude)
    return;
  sendStatus(attachedClaude);
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
    bridgeReady: tuiConnectionState.canReply(),
    tuiConnected: snapshot.tuiConnected,
    threadId: codex.activeThreadId,
    queuedMessageCount: bufferedMessages.length + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
    pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
    cwd: process.cwd(),
    stateDir: stateDir.dir,
    build: daemonStatusBuildInfo()
  };
}
function currentWaitingMessage() {
  const pairId = process.env.AGENTBRIDGE_PAIR_ID ?? null;
  const offset = CODEX_PROXY_PORT - PAIR_BASE_PORT - 1;
  const slot = pairId !== null && offset >= 0 && offset % PAIR_SLOT_STRIDE === 0 ? offset / PAIR_SLOT_STRIDE : null;
  return formatWaitingForCodexTuiMessage({
    attachCmd,
    cwd: process.cwd(),
    pairId,
    pairName: process.env.AGENTBRIDGE_PAIR_NAME ?? null,
    slot,
    proxyUrl: codex.proxyUrl
  });
}
function currentReadyMessage() {
  return `\u2705 Codex TUI connected (${codex.activeThreadId}). Bridge ready.`;
}
function systemMessage(idPrefix, content) {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content,
    timestamp: Date.now()
  };
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
    pid: process.pid,
    pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
    cwd: process.cwd(),
    stateDir: stateDir.dir,
    build: daemonStatusBuildInfo()
  });
}
function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}
function armBootDeadline() {
  if (bootDeadlineTimer)
    return;
  bootDeadlineTimer = setTimeout(() => {
    bootDeadlineTimer = null;
    if (codexBootstrapped)
      return;
    if (tuiConnectionState.snapshot().tuiConnected)
      return;
    log(`Codex not ready within bootstrap deadline (${BOOTSTRAP_TIMEOUT_MS}ms) \u2014 self-exiting to release control port`);
    shutdown("codex not ready within bootstrap deadline", 1);
  }, BOOTSTRAP_TIMEOUT_MS);
  bootDeadlineTimer.unref?.();
}
function clearBootDeadline() {
  if (bootDeadlineTimer) {
    clearTimeout(bootDeadlineTimer);
    bootDeadlineTimer = null;
  }
}
async function bootCodex() {
  log("Starting AgentBridge daemon...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);
  for (let attempt = 0;attempt <= CODEX_BOOT_RETRIES; attempt++) {
    try {
      await codex.start();
      codexBootstrapped = true;
      clearBootDeadline();
      writeStatusFile();
      emitToClaude(systemMessage("system_waiting", currentWaitingMessage()));
      broadcastStatus();
      return;
    } catch (err) {
      const attemptsLeft = CODEX_BOOT_RETRIES - attempt;
      log(`Failed to start Codex (attempt ${attempt + 1}/${CODEX_BOOT_RETRIES + 1}): ${err.message}`);
      if (attemptsLeft > 0) {
        const backoffMs = 1000 * (attempt + 1);
        log(`Retrying Codex bootstrap in ${backoffMs}ms (${attemptsLeft} attempt(s) left)...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        if (shuttingDown)
          return;
        continue;
      }
      emitToClaude(systemMessage("system_codex_start_failed", `\u274C AgentBridge failed to start Codex app-server after ${CODEX_BOOT_RETRIES + 1} attempts: ${err.message}`));
      broadcastStatus();
      shutdown("codex bootstrap failed", 1);
      return;
    }
  }
}
function shutdown(reason, exitCode = 0) {
  if (shuttingDown)
    return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  clearBootDeadline();
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  clearPendingClaudeDisconnect(`daemon shutdown (${reason})`);
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  codex.forceKillAppServerSync();
  removePidFile();
  removeStatusFile();
});
process.on("uncaughtException", (err) => {
  processLogger.fatal("UNCAUGHT EXCEPTION", err);
});
process.on("unhandledRejection", (reason) => {
  processLogger.fatal("UNHANDLED REJECTION", reason);
});
function log(msg) {
  processLogger.log(msg);
}
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found \u2014 daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}
writePidFile();
startControlServer();
armBootDeadline();
bootCodex();
