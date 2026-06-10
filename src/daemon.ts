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
import { ConfigService, applyBudgetEnvOverrides } from "./config-service";
import { BudgetCoordinator } from "./budget/budget-coordinator";
import { createQuotaSource } from "./budget/quota-source";
import {
  CLOSE_CODE_REPLACED,
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PROBE_IN_PROGRESS,
} from "./control-protocol";
import { parsePositiveIntEnv } from "./env-utils";
import { isAllowedWsUpgrade, wsOriginRejectedResponse } from "./ws-origin-guard";
import { ReplyRequiredTracker } from "./reply-required-tracker";
import { persistCurrentThreadWithRolloutRetry } from "./thread-state";
import { createProcessLogger } from "./process-log";
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
  /**
   * Bridge messages ws.send() returned -1 for: enqueued in Bun's socket buffer
   * under backpressure, NOT yet on the wire. Bun discards that buffer if the
   * socket closes before `drain` fires, so these are re-buffered at detach for
   * redelivery on reconnect (at-least-once: a pre-close partial flush can
   * produce a duplicate; silent loss cannot).
   */
  pendingBackpressure: BridgeMessage[];
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();
const processLogger = createProcessLogger({ component: "AgentBridgeDaemon", logFile: stateDir.logFile });

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
// Budget coordination config: file config normalized + AGENTBRIDGE_BUDGET_* env overlay.
const BUDGET_CONFIG = applyBudgetEnvOverrides(config.budget);

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

// --- Budget coordination (plan v2.3 P1) ---
// Constructed lazily on the first codex "ready" and kept for the daemon's lifetime.
// The coordinator owns polling/dedup/pause-hysteresis; the daemon owns the
// claude_to_codex pause gate and snapshot exposure via DaemonStatus.budget.
let budgetCoordinator: BudgetCoordinator | null = null;
let budgetStatusTimer: ReturnType<typeof setInterval> | null = null;

function ensureBudgetCoordinatorStarted() {
  if (!BUDGET_CONFIG.enabled) return;
  if (!budgetCoordinator) {
    // One effective-config line so clamped/overridden values are observable
    // (config normalization itself is silent by design).
    log(
      `Budget coordinator config: pollSeconds=${BUDGET_CONFIG.pollSeconds} pauseAt=${BUDGET_CONFIG.pauseAt} ` +
      `resumeBelow=${BUDGET_CONFIG.resumeBelow} syncDriftPct=${BUDGET_CONFIG.syncDriftPct} ` +
      `parallel=${BUDGET_CONFIG.parallel.minRemainingPct}%/${BUDGET_CONFIG.parallel.timeWindowSec}s ` +
      `codexTierControl=${BUDGET_CONFIG.codexTierControl} ` +
      // Normalization degrades tier control to false when the sticky-restore
      // point is missing; surface that state so the degrade is diagnosable.
      `codexTiersFull=${BUDGET_CONFIG.codexTiers.full ? "configured" : "missing"}`,
    );
    budgetCoordinator = new BudgetCoordinator({
      source: createQuotaSource({ log }),
      config: BUDGET_CONFIG,
      emit: (id, content) => {
        emitToClaude(systemMessage(id, content));
        // Defer one microtask: the coordinator writes latestSnapshot AFTER its
        // applyState() callbacks return, so an immediate broadcast would push
        // the previous poll's snapshot on directive edges.
        queueMicrotask(() => broadcastStatus());
      },
      onPauseChange: (paused) => {
        // v2.4: paused = R4 intervention active (handoff OR pause); the reply
        // gate itself is side-aware and may stay open during a Claude handoff.
        log(
          `Budget intervention ${paused ? "ACTIVE" : "CLEARED"} ` +
          `(gate ${budgetCoordinator?.isGateClosed() ? "CLOSED" : "OPEN"})`,
        );
        queueMicrotask(() => broadcastStatus());
      },
      log,
    });
  }
  void budgetCoordinator.start();
  // Keep DaemonStatus.budget (and the bridge's get_budget cache) fresh between
  // directives: snapshots change every poll even when no directive fires.
  if (!budgetStatusTimer) {
    budgetStatusTimer = setInterval(() => broadcastStatus(), BUDGET_CONFIG.pollSeconds * 1000);
    budgetStatusTimer.unref?.();
  }
}

function stopBudgetCoordinator() {
  budgetCoordinator?.stop();
  if (budgetStatusTimer) {
    clearInterval(budgetStatusTimer);
    budgetStatusTimer = null;
  }
}

function budgetPauseGateError(): string {
  // The gate only closes when the CODEX side is exhausted (pauseSide codex/both,
  // v2.4 side-aware semantics) — the error wording reflects that, and the
  // resume estimate is advisory only (an early weekly refresh releases sooner).
  const snapshot = budgetCoordinator?.getSnapshot() ?? null;
  const reason = snapshot?.pauseReason ?? "Codex 侧额度接近耗尽";
  const resumeAt = snapshot?.resumeAfterEpoch
    ? new Date(snapshot.resumeAfterEpoch * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")
    : null;
  const sideHint = snapshot?.pauseSide === "both"
    ? "双侧额度均已耗尽，请写 checkpoint 等待刷新"
    : "你可继续 solo 推进可独立部分，并写 checkpoint 标注分工断点";
  return (
    `预算暂停（闸门关闭），已拒绝转发：${reason}。` +
    `Codex 侧 gateUtil 低于 ${BUDGET_CONFIG.resumeBelow}% 后闸门自动放开` +
    (resumeAt ? `（预计恢复 ${resumeAt}，以实测为准；提前刷新会更早解除）` : "") +
    `。收到 RESUME 通知前请勿重试向 Codex 发送 reply；${sideHint}。`
  );
}

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

// Turn-transition status refreshes are OBSERVABILITY writes (issue #102) —
// a disk/permission failure there must never break core turn handling, so
// they go through this catcher (boot-path writes keep strict semantics).
function tryWriteStatusFile(reason: string) {
  try {
    writeStatusFile();
  } catch (err: any) {
    log(`status file write failed (${reason}): ${err?.message ?? err}`);
  }
}

// Single funnel for status persistence (#102 + protocol v2 PR A): EVERY turn
// phase transition — including stalled and the stalled→running resume that has
// no dedicated event — refreshes status.json and pushes a live status update,
// so /healthz, status.json and the control status stream cannot drift.
codex.on("turnPhaseChanged", ({ phase, previous }: { phase: string; previous: string }) => {
  log(`Codex turn phase: ${previous} → ${phase}`);
  tryWriteStatusFile(`turnPhase:${phase}`);
  broadcastStatus();
});

// A steer is transport-accepted at send time; a later JSON-RPC rejection
// (Review/Compact turns are not steerable; the turn may have ended in the race
// window) means Claude's mid-turn message did NOT reach Codex — say so
// explicitly instead of letting Claude assume it landed.
codex.on("steerFailed", (reason: string) => {
  log(`Steer rejected by app-server: ${reason}`);
  // Branch the advice on the live turn state (same reasoning as the sync
  // steer-failure path): while the turn still runs (e.g. ActiveTurnNotSteerable
  // on a Review/Compact turn), "resend as a normal reply" just bounces off the
  // busy guard, whose error suggests steer again — an advice ping-pong.
  const advice = codex.turnInProgress
    ? "wait for it to finish (✅), then send normally"
    : "the turn has ended — resend as a normal reply";
  emitToClaude(
    systemMessage(
      "system_steer_failed",
      `⚠️ Your steer message did NOT reach Codex (${reason}). The original turn continues unaffected — ${advice}.`,
    ),
  );
});

codex.on("steerAccepted", () => {
  log("Steer accepted by app-server");
});

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
  // A fresh codex (and its fresh thread) runs at its own defaults — stale
  // delivered-tier bookkeeping would suppress the next legitimate override.
  budgetCoordinator?.resetAppliedTier();
  ensureBudgetCoordinatorStarted();
});

codex.on("threadChanged", (event: { threadId: string; previousThreadId: string | null; reason: string }) => {
  // Tier overrides are sticky PER THREAD — the new thread runs at defaults.
  budgetCoordinator?.resetAppliedTier();
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
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). AgentBridge daemon is still running. ` +
        `Restart the Codex side (\`agentbridge codex\`); if it does not come back within ` +
        `${Math.round(BOOTSTRAP_TIMEOUT_MS / 1000)}s the daemon will self-replace so the next launch starts clean.`,
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

      if (url.pathname === "/ws") {
        // CSWSH guard: reject any WS upgrade carrying an Origin header (browser
        // page) before upgrading. The legitimate CLI client (daemon-client.ts)
        // uses the Bun global WebSocket and sends no Origin — empirically
        // verified, see ws-origin-guard.ts. GET endpoints above are not gated.
        if (!isAllowedWsUpgrade(req)) {
          log("Rejected WS upgrade on control port: Origin header present (possible CSWSH)");
          return wsOriginRejectedResponse();
        }
        if (server.upgrade(req, { data: { clientId: 0, attached: false, lastPongAt: Date.now(), pongCount: 0, pendingBackpressure: [] } })) {
          return undefined;
        }
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960, // 16 minutes — prevent premature idle disconnects
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        ws.data.lastPongAt = Date.now();
        ws.data.pendingBackpressure = [];
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
      drain: (ws: ServerWebSocket<ControlSocketData>) => {
        // Backpressure released. Confirm tracked messages as delivered only
        // when the socket buffer is fully empty — after a partial drain the
        // tail can still be lost on close, and a duplicate beats silent loss.
        // No attachedClaude guard needed: only the attached socket ever
        // accrues pendingBackpressure (every bridge-message send targets
        // attachedClaude) and detachClaude drains the array synchronously,
        // so a detached socket is always empty here. A drain with an empty
        // OS buffer means the bytes reached the transport — the same
        // delivery guarantee a plain successful send has.
        if (ws.data.pendingBackpressure.length > 0 && ws.getBufferedAmount() === 0) {
          ws.data.pendingBackpressure = [];
        }
        // Deliver anything that buffered while the socket was congested
        // instead of waiting for the next reattach.
        if (ws === attachedClaude && bufferedMessages.length > 0) {
          flushBufferedMessages(ws);
        }
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

      // Budget pause gate (plan v2.4 side-aware R4): the gate protects the
      // TARGET side's quota, so it closes only when the Codex side is exhausted
      // (gateClosed = pauseSide codex/both). A Claude-only handoff keeps the
      // gate OPEN so the baton reply can reach Codex. Same rejection shape as
      // the busy-guard below.
      if (budgetCoordinator?.isGateClosed()) {
        const reason = budgetPauseGateError();
        log(`Injection rejected by budget pause gate`);
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: reason,
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
      // Budget tier overrides (P4/R5) piggyback on this user-initiated turn —
      // never injected standalone. Delivery is confirmed back to the coordinator
      // so the pending override is sent at most once per tier change.
      const tierOverrides = BUDGET_CONFIG.codexTierControl
        ? budgetCoordinator?.getCodexTurnOverrides() ?? undefined
        : undefined;
      // Busy-turn policy (protocol v2 B0): when a turn is running and the
      // caller opted into "steer", feed the message INTO the running turn via
      // turn/steer instead of rejecting — Codex integrates it mid-turn without
      // losing work. Framed explicitly so Codex can distinguish it from the
      // original task instructions (design consensus with Codex).
      if (codex.turnInProgress && message.onBusy === "steer") {
        if (requireReply) {
          // B0 limitation (explicit, not silent): require_reply semantics for
          // steer ("a NEW agentMessage after steer-accept, before terminal")
          // need the PR B state machine. Reject loudly instead of mis-arming
          // the tracker on the already-running turn.
          sendProtocolMessage(ws, {
            type: "claude_to_codex_result",
            requestId: message.requestId,
            success: false,
            error: "require_reply is not supported together with on_busy=\"steer\" yet. Send the steer without require_reply, or wait for the turn to finish.",
          });
          return;
        }
        const steerContent =
          "[STEER from Claude]\n" +
          "Mid-turn update for the current Codex turn. Integrate if relevant; do not restart work unless explicitly requested.\n\n" +
          message.message.content;
        const steered = codex.steerMessage(steerContent);
        log(`Steer ${steered ? "transport-accepted" : "failed"} (${message.message.content.length} chars)`);
        if (steered) {
          // An IMPORTANT message forwarded mid-turn opens an attention window;
          // a steer is exactly Claude responding to it — close the window like
          // the inject path does, so status buffering resumes promptly.
          clearAttentionWindow();
        }
        // "Retry as a normal reply" is only good advice when the turn actually
        // ended — while it is still running, a normal reply just bounces off
        // the busy guard, whose error suggests steer again: an advice
        // ping-pong. Branch on the live turn state. (The "ended" branch is
        // defensive: in the current synchronous flow turnInProgress was true
        // at dispatch and nothing async runs before this re-read.)
        const steerFailureAdvice = codex.turnInProgress
          ? "Steer failed: the running turn cannot be steered right now — wait for it to finish (✅), then send normally."
          : "Steer failed: the turn may have just ended or the connection dropped — retry as a normal reply.";
        sendProtocolMessage(ws, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: steered,
          error: steered ? undefined : steerFailureAdvice,
        });
        return;
      }

      const injected = codex.injectMessage(contentToSend, tierOverrides);
      if (!injected) {
        const reason = codex.turnInProgress
          ? "Codex is busy executing a turn. Options: wait for it to finish, or retry with on_busy=\"steer\" to feed this message into the running turn without interrupting it."
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
      if (tierOverrides) {
        budgetCoordinator?.notifyOverridesDelivered();
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

  // Drain the older backlog BEFORE the status buffer's fresher summary — the
  // reverse order delivered events out of timeline (summary first, then the
  // pre-disconnect messages it summarizes).
  const hadBacklog = bufferedMessages.length > 0;
  if (hadBacklog) {
    flushBufferedMessages(ws);
  }
  statusBuffer.flush("claude reconnected");
  sendStatus(ws);

  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;

  if (!hadBacklog && !isRapidReattach) {
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

  // Messages enqueued under backpressure never got a drain confirmation; Bun
  // drops its socket buffer on close, so without this they would be lost.
  // Prepend (they predate anything buffered after the send started failing)
  // and re-apply the cap.
  if (ws.data.pendingBackpressure.length > 0) {
    bufferedMessages.unshift(...ws.data.pendingBackpressure);
    log(
      `Re-buffered ${ws.data.pendingBackpressure.length} backpressured message(s) for redelivery on reconnect`,
    );
    ws.data.pendingBackpressure = [];
    if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
      const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
      bufferedMessages.splice(0, dropped);
      log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
    }
  }

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
  tryWriteStatusFile("attentionWindowStarted"); // keep status.json in step with /healthz (PR A)
  attentionWindowTimer = setTimeout(() => {
    attentionWindowTimer = null;
    inAttentionWindow = false;
    statusBuffer.resume();
    log("Attention window ended");
    tryWriteStatusFile("attentionWindowEnded");
  }, ATTENTION_WINDOW_MS);
}

function clearAttentionWindow() {
  if (attentionWindowTimer) {
    clearTimeout(attentionWindowTimer);
    attentionWindowTimer = null;
  }
  if (inAttentionWindow) {
    statusBuffer.resume();
    inAttentionWindow = false;
    tryWriteStatusFile("attentionWindowCleared");
  }
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
    // Bun semantics: -1 = backpressure, the message IS enqueued and will be
    // delivered once the socket drains — treating it as failure re-buffered an
    // already-queued message and delivered it twice. Only 0 (dropped) fails.
    if (typeof result === "number" && result === 0) {
      log("Bridge message send returned 0 (dropped)");
      return false;
    }
    if (typeof result === "number" && result === -1) {
      // Enqueued but not on the wire: Bun owns the bytes until `drain`
      // confirms delivery, and drops them if the socket closes first. Track
      // the message so detachClaude can re-buffer it for the next attach.
      // Same cap as bufferedMessages — a never-draining socket must not
      // accumulate unboundedly (bounded, logged loss beats OOM).
      ws.data.pendingBackpressure.push(message);
      if (ws.data.pendingBackpressure.length > MAX_BUFFERED_MESSAGES) {
        const dropped = ws.data.pendingBackpressure.length - MAX_BUFFERED_MESSAGES;
        ws.data.pendingBackpressure.splice(0, dropped);
        log(`Backpressure overflow: dropped ${dropped} oldest tracked message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
      }
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(ws: ServerWebSocket<ControlSocketData>) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (let i = 0; i < messages.length; i++) {
    if (!trySendBridgeMessage(ws, messages[i]!)) {
      // Re-buffer this and all remaining messages on failure. Positional index,
      // not indexOf: identity lookup breaks the count if a message object is
      // ever enqueued twice.
      const remaining = messages.slice(i);
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
    const result = ws.send(JSON.stringify(message));
    // Control responses are request-scoped: re-sending them to a future socket
    // would be wrong (the client's pending request has already timed out), so
    // a dropped send is not retried — but it must not be silent. A dropped
    // `claude_to_codex_result` is the trail for "Claude saw a timeout but the
    // turn WAS injected" reports.
    if (typeof result === "number" && result === 0) {
      log(`Control message dropped (socket closed): type=${message.type}`);
    }
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
    // Includes messages enqueued in Bun's socket buffer awaiting drain
    // confirmation — without them a diagnosis can read "0 queued" while
    // unconfirmed messages still sit in the socket.
    queuedMessageCount:
      bufferedMessages.length + statusBuffer.size + (attachedClaude?.data.pendingBackpressure.length ?? 0),
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
    budget: budgetCoordinator?.getSnapshot() ?? undefined,
    // COMPAT mapping (= turnPhase ∈ {running, stalled}); new consumers read
    // turnPhase. attentionWindowActive is the routing axis, NOT a turn phase.
    turnInProgress: codex.turnInProgress,
    turnPhase: codex.turnPhase,
    attentionWindowActive: inAttentionWindow,
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
    // Refreshed on every turn-phase transition (the unified turnPhaseChanged
    // handler calls tryWriteStatusFile) so the TUI wrapper reads an up-to-date
    // value at exit time: exit_0_during_turn vs exit_0_idle (issue #102).
    turnInProgress: codex.turnInProgress,
    // Same fields as /healthz (currentStatus) — the two payloads must not
    // drift (protocol v2 PR A). Attention transitions also refresh this file.
    turnPhase: codex.turnPhase,
    attentionWindowActive: inAttentionWindow,
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
    // An attached Claude frontend deserves a why before the socket drops: without
    // this notice the self-exit looks like a random daemon crash from its side
    // (it only sees "control connection lost" + a reconnect loop).
    if (attachedClaude) {
      emitToClaude(
        systemMessage(
          "system_daemon_self_replace",
          "⚠️ Codex did not become ready within the bootstrap deadline — the AgentBridge daemon is restarting itself to release a clean slot. The bridge will reconnect automatically.",
        ),
      );
    }
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
      // Arm the idle countdown for the launched-but-never-used case: without
      // this, a daemon whose launcher dies before any client attaches has no
      // detach event to arm it and lives (with its codex app-server) forever.
      // scheduleIdleShutdown returns early (arms nothing) if a client is
      // already attached.
      scheduleIdleShutdown();
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
  stopBudgetCoordinator();
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
  processLogger.fatal("UNCAUGHT EXCEPTION", err);
});
process.on("unhandledRejection", (reason: any) => {
  processLogger.fatal("UNHANDLED REJECTION", reason);
});

function log(msg: string) {
  processLogger.log(msg);
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
