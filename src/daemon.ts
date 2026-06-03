#!/usr/bin/env bun

import type { ServerWebSocket } from "bun";
import { daemonStatusBuildInfo } from "./build-info";
import { CodexAdapter } from "./codex-adapter";
import { validateClaudeClientIdentity } from "./daemon-identity";
import {
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "./message-filter";
import { TuiConnectionState } from "./tui-connection-state";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
} from "./control-protocol";
import { parsePositiveIntEnv } from "./env-utils";
import { ReplyRequiredTracker } from "./reply-required-tracker";
import { persistCurrentThreadWithRolloutRetry } from "./thread-state";
import { appendRotatingLog } from "./rotating-log";
import { buildTurnAbortedNotice } from "./turn-notices";
import { formatWaitingForCodexTuiMessage } from "./waiting-message";
import { PAIR_BASE_PORT, PAIR_SLOT_STRIDE } from "./pair-registry";
import type {
  ControlClientIdentity,
  ControlClientMessage,
  ControlServerMessage,
  DaemonStatus,
} from "./control-protocol";
import type { BridgeMessage } from "./types";
import { probeLiveness as probeLivenessImpl } from "./liveness-probe";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
  /** Wall-clock of the last pong (used only for the contest diagnostic log). */
  lastPongAt: number;
  /** Monotonic pong counter — the liveness probe's source of truth (see liveness-probe.ts). */
  pongCount: number;
  identity?: ControlClientIdentity;
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
// Bootstrap-readiness watchdog: if the Codex layer never becomes ready within this
// window the daemon self-exits to release its control port (prevents the
// healthz-200/readyz-503 zombie). Default 45s is deliberately > the worst-case
// bootCodex retry budget (CODEX_BOOT_RETRIES+1 attempts × ~10s codex.start internal
// timeout + 1s/2s backoff ≈ 33s) so it never cuts off a legitimately-retrying boot.
const BOOTSTRAP_TIMEOUT_MS = parsePositiveIntEnv("AGENTBRIDGE_BOOTSTRAP_TIMEOUT_MS", 45000);
// In-daemon bounded retries for a transient Codex bootstrap failure (e.g. a just-killed
// codex's port not yet released). After these, the daemon self-exits — further
// replacement is owned by the lifecycle (ensureRunning), not by retrying forever here.
const CODEX_BOOT_RETRIES = parsePositiveIntEnv("AGENTBRIDGE_CODEX_BOOT_RETRIES", 2);
const ALLOW_IDENTITYLESS_CLIENT = process.env.AGENTBRIDGE_COMPAT_IDENTITYLESS === "1";

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
const replyTracker = new ReplyRequiredTracker();
let shuttingDown = false;
let bootDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastAttachStatusSentTs = 0;
const ATTACH_STATUS_COOLDOWN_MS = 30_000; // Don't re-send status on rapid reattach

// Liveness probe used by challenge-on-contest admission. Issue #68: OS may never
// surface FIN on a half-open TCP, so readyState alone can't tell us the old peer
// is gone. When a new frontend arrives while a socket is still OPEN, we ping the
// old peer; if no pong within this window, we evict it and accept the new one.
const LIVENESS_PROBE_TIMEOUT_MS = parsePositiveIntEnv(
  "AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS",
  3000,
  log,
);
const LIVENESS_PROBE_POLL_MS = 50;
let challengeInProgress = false;

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
    // No status notice injected into Codex: runtime online/offline/reconnect events
    // can only go through turn/start, which pollutes the Codex thread/title and can
    // trigger spurious responses (see the kickoff removal). Codex resumes normally
    // on the next real Claude message.
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

  // When require_reply is armed, force-forward ALL messages regardless of marker
  if (replyTracker.isArmed) {
    log(`Codex → Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
    replyTracker.noteForwarded();
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

  // Check if reply was required but Codex didn't send any agentMessage, then
  // clear the reply-required state.
  const { warnReplyMissing } = replyTracker.consumeOnTurnComplete();
  if (warnReplyMissing) {
    log("⚠️ Reply was required but Codex did not send any agentMessage");
    emitToClaude(
      systemMessage(
        "system_reply_missing",
        "⚠️ Codex completed the turn without sending a reply (require_reply was set). Codex may not have generated an agentMessage. You may want to retry or rephrase.",
      ),
    );
  }

  emitToClaude(
    systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
    ),
  );
  startAttentionWindow();
});

codex.on("turnAborted", (reason: string) => {
  // A turn ended without a normal turn/completed (app-server close / reconnect /
  // stop). Clear the require_reply tracker so its armed state cannot be inherited
  // by a later, unrelated turn (force-forward leak + misattributed warning).
  log(`Codex turn aborted (${reason}) — clearing reply-required state`);
  const replyWasRequired = replyTracker.isArmed;
  replyTracker.reset();

  // Surface the abnormal ending to Claude so a turn that emitted "⏳ Codex is
  // working" always gets a matching close signal (symmetric with the
  // turn-completed / turn-stalled notices). Stays silent on intentional teardown.
  const notice = buildTurnAbortedNotice(reason, replyWasRequired);
  if (notice) {
    emitToClaude(systemMessage("system_turn_aborted", notice));
  }
});

codex.on("turnStalled", (event: { turnId: string; inactivityMs: number }) => {
  log(`Codex turn stalled (${event.turnId}, inactivity ${event.inactivityMs}ms)`);
  emitToClaude(
    systemMessage(
      "system_turn_stalled",
      `⚠️ Codex has been silent for ${event.inactivityMs}ms while a turn is still in progress. AgentBridge is keeping the turn busy and will not send a fake completion; wait for Codex to finish or reconnect the TUI if it is stuck.`,
    ),
  );
});

codex.on("ready", (threadId: string) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex ready — thread ${threadId}`);
  log("Bridge fully operational");

  emitToClaude(
    systemMessage("system_ready", currentReadyMessage()),
  );
});

codex.on("threadChanged", (event: { threadId: string; previousThreadId: string | null; reason: string }) => {
  broadcastStatus();
  void persistCurrentThreadWithRolloutRetry(
    {
      stateDir,
      pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
      pairName: process.env.AGENTBRIDGE_PAIR_NAME,
      cwd: process.cwd(),
    },
    event.threadId,
    event.reason,
    {
      log,
      // Abandon this loop the moment a newer thread switch supersedes it, so a
      // lingering retry cannot clobber current-thread.json with an abandoned
      // threadId (which would auto-resume the wrong thread or break resume).
      shouldContinue: () => codex.activeThreadId === event.threadId,
    },
  ).catch((err) => {
    log(`Failed to persist current thread ${event.threadId}: ${err?.message ?? err}`);
  });
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
  replyTracker.reset(); // any in-flight require_reply turn is gone with the process
  statusBuffer.flush("codex exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  emitToClaude(
    systemMessage(
      "system_codex_exit",
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running, but the Codex side needs to be restarted.`,
    ),
  );
  broadcastStatus();
  // Codex died after a successful boot (a dead proc is not auto-respawned). Re-arm
  // the readiness watchdog so that if it does not come back and no TUI is using us,
  // the daemon self-exits instead of lingering as a healthz-200/readyz-503 zombie.
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
        return undefined;
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960, // 16 minutes — prevent premature idle disconnects
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        ws.data.lastPongAt = Date.now();
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
      pong: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.lastPongAt = Date.now();
        ws.data.pongCount++;
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
      const admission = validateClaudeClientIdentity({
        expectedPairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
        daemonCwd: process.cwd(),
        identity: message.identity,
        allowIdentityless: ALLOW_IDENTITYLESS_CLIENT,
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
      // The static bridge contract (markers / git-forbidden / role guidance) now
      // lives in AGENTS.md (injected by `abg init`), so it is no longer appended to
      // every message — appending it polluted every Codex turn and the thread title.
      // Only the DYNAMIC reply-required instruction is appended, on demand.
      let contentToSend = message.message.content;
      if (requireReply) {
        contentToSend += REPLY_REQUIRED_INSTRUCTION;
      }
      log(`Forwarding Claude → Codex (${message.message.content.length} chars, requireReply=${requireReply})`);
      const injected = codex.injectMessage(contentToSend);
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
      // Arm reply-required tracking ONLY after a successful injection: a turn has
      // now started, so turnCompleted will reset it. Arming before this guard
      // (on a rejected injection, e.g. Codex busy) would strand the flag on an
      // unrelated in-flight turn and silently lose this require_reply request.
      if (requireReply) {
        replyTracker.arm();
        log(`Reply required flag set for this message`);
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

async function attachClaude(ws: ServerWebSocket<ControlSocketData>, identity?: ControlClientIdentity) {
  const occupant = attachedClaude;
  if (occupant && occupant !== ws && occupant.readyState !== WebSocket.CLOSED) {
    // Slot is occupied by another socket that hasn't yet shown us FIN.
    // Issue #68: OS may never surface a FIN for a crashed peer, so readyState
    // stays OPEN forever. Probe the incumbent with a ping before rejecting.
    const msSincePong = Date.now() - occupant.data.lastPongAt;
    log(
      `Claude frontend contest: new=#${ws.data.clientId}, incumbent=#${occupant.data.clientId} ` +
      `(readyState=${occupant.readyState}, msSincePong=${msSincePong})`,
    );

    if (challengeInProgress) {
      log(
        `Rejecting Claude frontend #${ws.data.clientId} — another liveness probe already in flight`,
      );
      ws.close(
        CLOSE_CODE_PROBE_IN_PROGRESS,
        "liveness probe in progress, retry shortly",
      );
      return;
    }

    challengeInProgress = true;
    let incumbentAlive = false;
    try {
      incumbentAlive = await probeLiveness(occupant, LIVENESS_PROBE_TIMEOUT_MS);
    } finally {
      challengeInProgress = false;
    }

    // Slot may have cleared during the probe (real close fired, or the new ws
    // left). Re-read state before committing a decision.
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      log(`Contestant #${ws.data.clientId} disappeared during probe — aborting`);
      if (!incumbentAlive) {
        evictStale(occupant, "contestant gone but probe still failed");
      }
      return;
    }

    if (incumbentAlive) {
      log(
        `Rejecting Claude frontend #${ws.data.clientId} — incumbent #${occupant.data.clientId} responded to liveness probe`,
      );
      ws.close(CLOSE_CODE_REPLACED, "another Claude session is already connected");
      return;
    }

    evictStale(occupant, `liveness probe timed out after ${LIVENESS_PROBE_TIMEOUT_MS}ms`);
    // Fall through to accept path below.
  }

  if (attachedClaude && attachedClaude !== ws && attachedClaude.readyState !== WebSocket.CLOSED) {
    // Another contestant may have raced in between the probe and here. Reject.
    log(
      `Rejecting Claude frontend #${ws.data.clientId} — slot re-acquired by #${attachedClaude.data.clientId} after probe`,
    );
    ws.close(CLOSE_CODE_REPLACED, "another Claude session is already connected");
    return;
  }

  clearPendingClaudeDisconnect("Claude frontend attached");
  ws.data.identity = identity;
  attachedClaude = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(
    `Claude frontend attached (#${ws.data.clientId}, pair=${identity?.pairId ?? "<none>"}, cwd=${identity?.cwd ?? "<unknown>"})`,
  );

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
}

function detachClaude(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  if (attachedClaude !== ws) return;

  attachedClaude = null;
  ws.data.attached = false;
  log(`Claude frontend detached (#${ws.data.clientId}, ${reason})`);

  scheduleClaudeDisconnectNotification(ws.data.clientId);

  scheduleIdleShutdown();
}

/**
 * Answer a non-attaching `probe_incumbent` request: does this daemon currently
 * have a LIVE Claude frontend attached? The asking socket (`ws`) is the CLI's
 * throwaway control connection — it never attaches, so it can never be the
 * occupant and probing it has no side effect on admission.
 *
 * Semantics mirror the challenge-on-contest path (issue #68):
 *   - no occupant / closed occupant            → { connected:false, alive:false }
 *   - a real contest probe already in flight    → { connected:true,  alive:true } (defer)
 *   - otherwise actively ping the incumbent      → alive = pong observed in time
 * A half-open dead incumbent reports connected:true, alive:false, telling the CLI
 * it is safe to launch and let admission evict the stale frontend.
 */
async function handleProbeIncumbent(ws: ServerWebSocket<ControlSocketData>) {
  const occupant = attachedClaude;
  log(`probe_incumbent from #${ws.data.clientId}: occupant=${occupant ? "#" + occupant.data.clientId : "none"} readyState=${occupant?.readyState}`);
  if (!occupant || occupant === ws || occupant.readyState !== WebSocket.OPEN) {
    sendProtocolMessage(ws, { type: "incumbent_status", connected: false, alive: false });
    return;
  }
  // A real challenge-on-contest decision is already running — defer to it (report
  // live so the CLI guard errs on the safe side and does not race the admission).
  if (challengeInProgress) {
    sendProtocolMessage(ws, { type: "incumbent_status", connected: true, alive: true });
    return;
  }
  // Deliberately do NOT set challengeInProgress here: this is a read-only probe,
  // not a contest. Setting it would make a genuine concurrent claude_connect get
  // bounced with CLOSE_CODE_PROBE_IN_PROGRESS (a ~3s reconnect delay) even though
  // the probing socket never intends to attach. A real contest that races this
  // probe just runs its own ping concurrently — harmless (ping is idempotent).
  const alive = await probeLiveness(occupant, LIVENESS_PROBE_TIMEOUT_MS);
  // The probe awaited; re-read state in case the incumbent closed meanwhile.
  const stillConnected = attachedClaude === occupant && occupant.readyState === WebSocket.OPEN;
  log(`probe_incumbent reply to #${ws.data.clientId}: connected=${stillConnected} alive=${stillConnected && alive}`);
  sendProtocolMessage(ws, {
    type: "incumbent_status",
    connected: stillConnected,
    alive: stillConnected && alive,
  });
}

async function probeLiveness(
  ws: ServerWebSocket<ControlSocketData>,
  timeoutMs: number,
): Promise<boolean> {
  return probeLivenessImpl(
    {
      get readyState() { return ws.readyState; },
      get pongCount() { return ws.data.pongCount; },
      ping: () => { ws.ping(); },
    },
    { timeoutMs, pollMs: LIVENESS_PROBE_POLL_MS },
  );
}

/**
 * Evict the incumbent Claude frontend so a newer session can take over.
 * Sends CLOSE_CODE_EVICTED_STALE (4002) and releases the slot so the next
 * attachClaude call can accept a contestant.
 *
 * detachClaude arms a 5s grace timer that pings Codex with "Claude went
 * offline" if nobody re-attaches in that window. For the *handoff* eviction
 * path (a new frontend is about to attach in the same JS task), attachClaude
 * cancels that timer at the "Claude frontend attached" step before any
 * 5s window can elapse. For the *cleanup* eviction path (no replacement —
 * contestant disappeared mid-probe), letting the timer fire is the correct
 * behavior: Codex genuinely has no Claude attached.
 */
function evictStale(ws: ServerWebSocket<ControlSocketData>, reason: string) {
  log(`Evicting stale Claude frontend #${ws.data.clientId}: ${reason}`);
  if (attachedClaude === ws) {
    detachClaude(ws, `evicted: ${reason}`);
  }
  try {
    ws.close(CLOSE_CODE_EVICTED_STALE, "stale frontend evicted by newer session");
  } catch (err: any) {
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

    // Runtime offline events are no longer injected into Codex: the only channel
    // (turn/start) pollutes the Codex thread/title and can trigger spurious
    // responses. Logged for ops; Codex simply receives no further messages until
    // Claude reconnects (the static collaboration context lives in AGENTS.md).
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
    // Pair identity so ensureRunning() can detect a foreign daemon squatting this
    // control port (wrong pairId) and replace it instead of reusing it. null in
    // legacy/manual single-pair mode (no pairId enforcement there).
    pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
    cwd: process.cwd(),
    stateDir: stateDir.dir,
    build: daemonStatusBuildInfo(),
  };
}

function currentWaitingMessage() {
  // Surface the pair identity so a user whose Codex is attached elsewhere can
  // see WHY it isn't connecting here: a Codex started from a different cwd is a
  // different pair and will never attach to this daemon (the #1 pairing pitfall).
  const pairId = process.env.AGENTBRIDGE_PAIR_ID ?? null;
  const offset = CODEX_PROXY_PORT - PAIR_BASE_PORT - 1;
  const slot =
    pairId !== null && offset >= 0 && offset % PAIR_SLOT_STRIDE === 0
      ? offset / PAIR_SLOT_STRIDE
      : null;
  return formatWaitingForCodexTuiMessage({
    attachCmd,
    cwd: process.cwd(),
    pairId,
    pairName: process.env.AGENTBRIDGE_PAIR_NAME ?? null,
    slot,
    proxyUrl: codex.proxyUrl,
  });
}

function currentReadyMessage() {
  return `✅ Codex TUI connected (${codex.activeThreadId}). Bridge ready.`;
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
    // Pair identity for diagnostics (null in legacy/manual single-pair mode).
    pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
    cwd: process.cwd(),
    stateDir: stateDir.dir,
    build: daemonStatusBuildInfo(),
  });
}

function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}

/**
 * Arm the bootstrap-readiness watchdog. If the Codex layer is not ready within
 * BOOTSTRAP_TIMEOUT_MS (and no TUI is actively using us), self-exit to release the
 * control port. This is the ONLY backstop for the case where codex.start() HANGS
 * (never resolves/rejects), so bootCodex's retry/self-exit never runs — without it
 * the process lingers as a healthz-200/readyz-503 zombie and ensureRunning() keeps
 * reusing it. bootCodex clears it on success; codex 'exit' re-arms it.
 */
function armBootDeadline() {
  // The deadline is an ABSOLUTE start-up window — not a recurring idle timer. If a
  // timer is already armed, leave it alone: re-arming on every codex 'exit' would let
  // a codex crash-loop keep the daemon alive past BOOTSTRAP_TIMEOUT_MS forever. Only
  // the very first call (right after writePidFile/startControlServer) sets the timer;
  // subsequent 'exit' events must not extend the deadline.
  if (bootDeadlineTimer) return;
  bootDeadlineTimer = setTimeout(() => {
    bootDeadlineTimer = null;
    if (codexBootstrapped) return; // became ready in time — nothing to do
    if (tuiConnectionState.snapshot().tuiConnected) return; // a TUI is actively using it
    log(`Codex not ready within bootstrap deadline (${BOOTSTRAP_TIMEOUT_MS}ms) — self-exiting to release control port`);
    shutdown("codex not ready within bootstrap deadline", 1);
  }, BOOTSTRAP_TIMEOUT_MS);
  // Don't let the watchdog itself keep the event loop alive.
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

  for (let attempt = 0; attempt <= CODEX_BOOT_RETRIES; attempt++) {
    try {
      await codex.start();
      codexBootstrapped = true;
      clearBootDeadline(); // codex up — cancel the self-exit watchdog
      writeStatusFile();
      emitToClaude(systemMessage("system_waiting", currentWaitingMessage()));
      broadcastStatus();
      return;
    } catch (err: any) {
      const attemptsLeft = CODEX_BOOT_RETRIES - attempt;
      log(`Failed to start Codex (attempt ${attempt + 1}/${CODEX_BOOT_RETRIES + 1}): ${err.message}`);
      if (attemptsLeft > 0) {
        const backoffMs = 1000 * (attempt + 1); // 1s, 2s, … — covers transient failures (e.g. a just-killed codex's port not yet released)
        log(`Retrying Codex bootstrap in ${backoffMs}ms (${attemptsLeft} attempt(s) left)...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        if (shuttingDown) return; // a deadline/signal fired during backoff
        continue;
      }
      // Retries exhausted: notify Claude, then SELF-EXIT to release the control port.
      // Staying alive here is exactly what created the healthz-200/readyz-503 zombie
      // that ensureRunning() then reused. Releasing the port lets the next
      // ensureRunning() launch a clean daemon. Replacement beyond this is owned by the
      // lifecycle, not by retrying forever in-process.
      emitToClaude(
        systemMessage(
          "system_codex_start_failed",
          `❌ AgentBridge failed to start Codex app-server after ${CODEX_BOOT_RETRIES + 1} attempts: ${err.message}`,
        ),
      );
      broadcastStatus();
      shutdown("codex bootstrap failed", 1);
      return; // shutdown() calls process.exit; explicit return also makes the
      // "shutdown ⇒ stop" intent clear and guards the already-shutting-down path.
    }
  }
}

function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
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
  // Guarantee the app-server child cannot outlive the daemon: shutdown() calls
  // process.exit() immediately after codex.stop(), which destroys stop()'s async
  // SIGKILL fallback timer before it can fire. This synchronous last gasp kills
  // the app-server even if it ignored/was slow on SIGTERM — preventing an orphan
  // that holds the pair's port and blocks the next launch.
  codex.forceKillAppServerSync();
  removePidFile();
  removeStatusFile();
});
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
    appendRotatingLog(stateDir.logFile, line);
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
// Arm the readiness watchdog BEFORE bootCodex: if codex.start() hangs (never
// resolves/rejects), bootCodex's retry/self-exit never runs, so this deadline is
// the only thing that releases the control port. bootCodex clears it on success.
armBootDeadline();
void bootCodex();
