#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { CodexAdapter } from "./codex-adapter";
import {
  BRIDGE_CONTRACT_REMINDER,
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "./message-filter";
import { TuiConnectionState } from "./tui-connection-state";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";
import type { BridgeMessage } from "./types";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
const CLAUDE_DISCONNECT_GRACE_MS = 5_000;
const MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
const FILTER_MODE: FilterMode =
  (process.env.AGENTBRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
const ATTENTION_WINDOW_MS = parseInt(process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

const codex = new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile);
const attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;

let controlServer: ReturnType<typeof Bun.serve> | null = null;
let attachedClaude: ServerWebSocket<ControlSocketData> | null = null;
let nextControlClientId = 0;
let nextSystemMessageId = 0;
let codexBootstrapped = false;
let attentionWindowTimer: ReturnType<typeof setTimeout> | null = null;
let inAttentionWindow = false;
let replyRequired = false;
let replyReceivedDuringTurn = false;
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let claudeOnlineNoticeSent = false;
let claudeOfflineNoticeShown = false;
let codexCollaborationKickoffSent = false;
let lastAttachStatusSentTs = 0;
const ATTACH_STATUS_COOLDOWN_MS = 30_000; // Don't re-send status on rapid reattach

const bufferedMessages: BridgeMessage[] = [];

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    emitToClaude(
      systemMessage(
        "system_tui_disconnected",
        `⚠️ Codex TUI disconnected (conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    emitToClaude(
      systemMessage(
        "system_tui_reconnected",
        `✅ Codex TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`,
      ),
    );
    codex.injectMessage("✅ Claude Code is still online, bridge restored. Bidirectional communication can continue.");
  },
});

const statusBuffer = new StatusBuffer((summary) => emitToClaude(summary));

codex.on("turnStarted", () => {
  log("Codex turn started");
  emitToClaude(
    systemMessage(
      "system_turn_started",
      "⏳ Codex is working on the current task. Wait for completion before sending a reply.",
    ),
  );
});

codex.on("agentMessage", (msg: BridgeMessage) => {
  if (msg.source !== "codex") return;
  const result = classifyMessage(msg.content, FILTER_MODE);

  // When replyRequired is active, force-forward ALL messages regardless of marker
  if (replyRequired) {
    log(`Codex → Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
    replyReceivedDuringTurn = true;
    if (statusBuffer.size > 0) {
      statusBuffer.flush("reply-required message arrived");
    }
    emitToClaude(msg);
    return;
  }

  // During attention window, suppress STATUS to give Claude space to respond
  if (inAttentionWindow && result.marker === "status") {
    log(`Codex → Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(msg);
    return;
  }

  log(`Codex → Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
  switch (result.action) {
    case "forward":
      if (result.marker === "important" && statusBuffer.size > 0) {
        statusBuffer.flush("important message arrived");
      }
      emitToClaude(msg);
      // IMPORTANT message — give Claude an attention window to respond
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

  // Check if reply was required but Codex didn't send any agentMessage
  if (replyRequired && !replyReceivedDuringTurn) {
    log("⚠️ Reply was required but Codex did not send any agentMessage");
    emitToClaude(
      systemMessage(
        "system_reply_missing",
        "⚠️ Codex completed the turn without sending a reply (require_reply was set). Codex may not have generated an agentMessage. You may want to retry or rephrase.",
      ),
    );
  }

  // Reset reply-required state
  replyRequired = false;
  replyReceivedDuringTurn = false;

  emitToClaude(
    systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
    ),
  );
  startAttentionWindow();

  // Retry Claude-online notice if it was deferred while the turn was in progress.
  if (attachedClaude && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});

codex.on("ready", (threadId: string) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex ready — thread ${threadId}`);
  log("Bridge fully operational");

  emitToClaude(
    systemMessage("system_ready", currentReadyMessage()),
  );

  if (attachedClaude && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});

codex.on("tuiConnected", (connId: number) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`Codex TUI connected (conn #${connId})`);
  broadcastStatus();
});

codex.on("tuiDisconnected", (connId: number) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`Codex TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});

codex.on("error", (err: Error) => {
  log(`Codex error: ${err.message}`);
});

codex.on("exit", (code: number | null) => {
  log(`Codex process exited (code ${code})`);
  codexBootstrapped = false;
  statusBuffer.flush("codex exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  claudeOnlineNoticeSent = false;
  claudeOfflineNoticeShown = false;
  emitToClaude(
    systemMessage(
      "system_codex_exit",
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the Codex side needs to be restarted.`,
    ),
  );
  broadcastStatus();
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

      if (url.pathname === "/ws" && server.upgrade(req, { data: { clientId: 0, attached: false } })) {
        return undefined;
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960, // 16 minutes — prevent premature idle disconnects
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>, code: number, reason: string) => {
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, wasAttached=${attachedClaude === ws})`);
        if (attachedClaude === ws) {
          detachClaude(ws, "frontend socket closed");
        }
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, raw);
      },
    },
  });
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      attachClaude(ws);
      return;
    case "claude_disconnect":
      detachClaude(ws, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex": {
      if (message.message.source !== "claude") {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source",
        });
        return;
      }

      if (!tuiConnectionState.canReply()) {
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Codex is not ready. Wait for TUI to connect and create a thread.",
        });
        return;
      }

      const requireReply = !!message.requireReply;
      let contentWithReminder = message.message.content + "\n\n" + BRIDGE_CONTRACT_REMINDER;
      if (requireReply) {
        contentWithReminder += REPLY_REQUIRED_INSTRUCTION;
        replyRequired = true;
        replyReceivedDuringTurn = false;
        log(`Reply required flag set for this message`);
      }
      log(`Forwarding Claude → Codex (${message.message.content.length} chars, requireReply=${requireReply})`);
      const injected = codex.injectMessage(contentWithReminder);
      if (!injected) {
        const reason = codex.turnInProgress
          ? "Codex is busy executing a turn. Wait for it to finish before sending another message."
          : "Injection failed: no active thread or WebSocket not connected.";
        log(`Injection rejected: ${reason}`);
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: reason,
        });
        return;
      }
      clearAttentionWindow(); // Claude successfully replied, end attention window
      sendProtocolMessage(ws, {
        type: "claude_to_codex_result",
        requestId: message.requestId,
        success: true,
      });
      return;
    }
  }
}

function attachClaude(ws: ServerWebSocket<ControlSocketData>) {
  if (attachedClaude && attachedClaude !== ws && attachedClaude.readyState !== WebSocket.CLOSED) {
    // Reject the new connection — don't disrupt the existing active session.
    // Check !== CLOSED (not === OPEN) so that CLOSING state is also treated as
    // "slot occupied", preventing a race where a new session slips in before
    // the old one finishes its close handshake.
    log(`Rejecting Claude frontend #${ws.data.clientId} — another session (#${attachedClaude.data.clientId}) is already attached (readyState=${attachedClaude.readyState})`);
    ws.close(CLOSE_CODE_REPLACED, "another Claude session is already connected");
    return;
  }

  clearPendingClaudeDisconnect("Claude frontend attached");
  attachedClaude = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`Claude frontend attached (#${ws.data.clientId})`);

  statusBuffer.flush("claude reconnected");
  sendStatus(ws);

  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;

  if (bufferedMessages.length > 0) {
    flushBufferedMessages(ws);
  } else if (!isRapidReattach) {
    // Only send status messages if this is not a rapid reattach (avoid flooding Claude)
    if (tuiConnectionState.canReply()) {
      sendBridgeMessage(ws, systemMessage("system_ready", currentReadyMessage()));
    } else if (codexBootstrapped) {
      sendBridgeMessage(ws, systemMessage("system_waiting", currentWaitingMessage()));
    }
  }

  lastAttachStatusSentTs = now;

  if (tuiConnectionState.canReply() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
}

function detachClaude(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  if (attachedClaude !== ws) return;

  attachedClaude = null;
  ws.data.attached = false;
  log(`Claude frontend detached (#${ws.data.clientId}, ${reason})`);

  scheduleClaudeDisconnectNotification(ws.data.clientId);

  scheduleIdleShutdown();
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
  if (attachedClaude) return; // still has a client

  const snapshot = tuiConnectionState.snapshot();
  if (snapshot.tuiConnected) return; // TUI still connected

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    // Re-check before shutting down
    if (attachedClaude || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle — no clients connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

function clearPendingClaudeDisconnect(reason?: string) {
  if (!claudeDisconnectTimer) return;
  clearTimeout(claudeDisconnectTimer);
  claudeDisconnectTimer = null;
  if (reason) {
    log(`Cleared pending Claude disconnect notification (${reason})`);
  }
}

function scheduleClaudeDisconnectNotification(clientId: number) {
  clearPendingClaudeDisconnect("rescheduled");
  claudeDisconnectTimer = setTimeout(() => {
    claudeDisconnectTimer = null;

    if (attachedClaude) {
      log(
        `Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`,
      );
      return;
    }

    if (!tuiConnectionState.canReply()) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Codex cannot reply`,
      );
      return;
    }

    if (!claudeOnlineNoticeSent) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Claude was never announced online`,
      );
      return;
    }

    codex.injectMessage(
      "⚠️ Claude Code went offline. AgentBridge is still running in the background; it will reconnect automatically when Claude reopens.",
    );
    claudeOnlineNoticeSent = false;
    claudeOfflineNoticeShown = true;
    log(`Claude disconnect persisted past grace window (client #${clientId})`);
  }, CLAUDE_DISCONNECT_GRACE_MS);
}

function emitToClaude(message: BridgeMessage) {
  if (attachedClaude && attachedClaude.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(attachedClaude, message)) return;
    // Send failed — fall through to buffer
    log("Send to Claude failed, buffering message for retry on reconnect");
  }

  bufferedMessages.push(message);
  if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    bufferedMessages.splice(0, dropped);
    log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
  }
}

function trySendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage): boolean {
  try {
    const result = ws.send(JSON.stringify({ type: "codex_to_claude", message } satisfies ControlServerMessage));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(ws: ServerWebSocket<ControlSocketData>) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(ws, message)) {
      // Re-buffer this and all remaining messages on failure
      const failedIndex = messages.indexOf(message);
      const remaining = messages.slice(failedIndex);
      bufferedMessages.unshift(...remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}

function sendBridgeMessage(ws: ServerWebSocket<ControlSocketData>, message: BridgeMessage) {
  trySendBridgeMessage(ws, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  if (!attachedClaude) return;
  sendStatus(attachedClaude);
}

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply(),
    tuiConnected: snapshot.tuiConnected,
    threadId: codex.activeThreadId,
    queuedMessageCount: bufferedMessages.length + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
  };
}

function currentWaitingMessage() {
  return `⏳ Waiting for Codex TUI to connect. Run in another terminal:\n${attachCmd}`;
}

function currentReadyMessage() {
  return `✅ Codex TUI connected (${codex.activeThreadId}). Bridge ready.`;
}

function notifyCodexClaudeOnline(): boolean {
  const message = !codexCollaborationKickoffSent
    ? [
        "🤝 Claude Code has connected via AgentBridge.",
        "You are now in a multi-agent collaboration session.",
        "When you receive a complex task, propose a division of labor to Claude.",
        "Claude can send you messages — they will appear as injected user messages.",
        "Respond naturally and Claude will receive your output via AgentBridge.",
      ].join("\n")
    : "✅ AgentBridge connected to Claude Code.";

  const delivered = codex.injectMessage(message);
  if (!delivered) {
    log("Deferred Claude-online notice to Codex — will retry after current turn completes");
    return false;
  }

  claudeOnlineNoticeSent = true;
  claudeOfflineNoticeShown = false;
  codexCollaborationKickoffSent = true;
  return true;
}

function shouldNotifyCodexClaudeOnline() {
  return !claudeOnlineNoticeSent || claudeOfflineNoticeShown;
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source: "codex",
    content,
    timestamp: Date.now(),
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
  });
}

function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}

async function bootCodex() {
  log("Starting AgentBridge daemon...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);

  try {
    await codex.start();
    codexBootstrapped = true;
    writeStatusFile();

    emitToClaude(systemMessage("system_waiting", currentWaitingMessage()));
    broadcastStatus();
  } catch (err: any) {
    log(`Failed to start Codex: ${err.message}`);
    emitToClaude(
      systemMessage(
        "system_codex_start_failed",
        `❌ AgentBridge failed to start Codex app-server: ${err.message}`,
      ),
    );
    broadcastStatus();
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  clearPendingClaudeDisconnect(`daemon shutdown (${reason})`);
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { removePidFile(); removeStatusFile(); });
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(stateDir.logFile, line);
  } catch {}
}

// Refuse to start if user intentionally killed the daemon.
// This prevents stale auto-reconnect loops from relaunching us.
// Only `agentbridge codex` / `ensureRunning` clears the sentinel before launching.
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found — daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}

writePidFile();
startControlServer();
void bootCodex();
