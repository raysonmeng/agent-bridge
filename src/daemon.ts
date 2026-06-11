#!/usr/bin/env bun

import type { ServerWebSocket } from "bun";
import { rmSync } from "node:fs";
import { daemonStatusBuildInfo } from "./build-info";
import { CodexAdapter } from "./codex-adapter";
import { validateClaudeClientIdentity, evaluateInjectionAttachGuard } from "./daemon-identity";
import {
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  routeCodexMessage,
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
import {
  generateControlToken,
  resolveControlTokenPath,
  writeControlToken,
} from "./control-token";
import { IdempotencyTracker, type IdempotencyDuplicate } from "./idempotency-tracker";
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
import { BoundedMessageBuffer } from "./delivery-buffer";

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
  pendingBackpressure: BoundedMessageBuffer;
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const processLogger = createProcessLogger({ component: "AgentBridgeDaemon", logFile: stateDir.logFile });

// Control-port capability token (arch-review P1 #283). Generated fresh on every
// daemon start and written 0600 to the pair's state dir BEFORE the control server
// accepts any socket, so a legitimate same-machine frontend can read it and echo
// it in `claude_connect`. A write/chmod failure degrades the token layer to OFF
// (null) — the attach-convergence guard + Origin guard still apply — rather than
// bricking the daemon. Per-pair isolation is automatic: each pair has its own
// state dir, hence its own token.
const controlTokenPath = resolveControlTokenPath(stateDir.dir);
let controlToken: string | null = null;
try {
  controlToken = generateControlToken();
  writeControlToken(controlTokenPath, controlToken);
} catch (err: any) {
  controlToken = null;
  processLogger.log(
    `Failed to write control token (${controlTokenPath}): ${err?.message ?? err} — ` +
    `token layer DISABLED for this daemon (attach guard + Origin guard still active)`,
  );
}
const configService = new ConfigService();
// Thread the daemon logger so a corrupt config.json fails loud (to log + stderr)
// instead of silently reverting custom budget/idle thresholds to defaults.
const config = configService.loadOrDefault(processLogger.log);

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
// --- Protocol v2 PR B state ---
// Idempotency machine: (threadId, idempotencyKey) → accepted → started → terminal.
const idempotencyTracker = new IdempotencyTracker();
// Correlation from a bridge injection's negative JSON-RPC id back to the
// originating claude_to_codex request (turn_started ACK + idempotency started).
const pendingTurnStarts = new Map<
  number,
  { requestId: string; idempotencyKey?: string; threadId: string }
>();
// Transport-accepted steers awaiting their JSON-RPC verdict, keyed by the
// bridge request id the adapter assigned (steerAccepted/steerFailed echo that
// id). Keying by id — instead of a FIFO that assumes responses arrive in send
// order — means a LOST or out-of-order steer response can never strand a
// dispatch onto the wrong turn (PR B #3). Each entry ties together the steer's
// reply expectation (armed ONLY once the steer is accepted — contract: "armed
// since steer accepted") and its idempotency key, so steerFailed /
// turnTrackingReset clean up BOTH together (PR B #2).
interface PendingSteerDispatch {
  requireReply: boolean;
  idempotencyKey?: string;
  threadId?: string;
}
const pendingSteerDispatches = new Map<number, PendingSteerDispatch>();
// Advisory retry hint for busy_reject results: no honest turn-end estimate
// exists, so this is a suggested poll interval, not a promise.
const BUSY_RETRY_ADVISORY_MS = 15_000;
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

// Module-level delivery backlog: messages that could not be sent while Claude
// was detached / a send failed, awaiting the next attach or drain.
const bufferedMessages = new BoundedMessageBuffer({
  cap: MAX_BUFFERED_MESSAGES,
  overflowLabel: "Message buffer overflow",
  log,
});

// Per-socket backpressure tracker (ws.send returned -1): bounded the same way
// so a never-draining socket can't accumulate unboundedly. Distinct overflow
// label/noun keeps the log line bit-exact with the prior inline code.
function createPendingBackpressureBuffer(): BoundedMessageBuffer {
  return new BoundedMessageBuffer({
    cap: MAX_BUFFERED_MESSAGES,
    overflowLabel: "Backpressure overflow",
    overflowNoun: "tracked message(s)",
    log,
  });
}

// --- Budget coordination (plan v2.3 P1) ---
// Constructed lazily on the first codex "ready" and kept for the daemon's lifetime.
// The coordinator owns polling/dedup/pause-hysteresis; the daemon owns the
// claude_to_codex pause gate and snapshot exposure via DaemonStatus.budget.
let budgetCoordinator: BudgetCoordinator | null = null;

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
      },
      onPauseChange: (paused) => {
        // v2.4: paused = R4 intervention active (handoff OR pause); the reply
        // gate itself is side-aware and may stay open during a Claude handoff.
        log(
          `Budget intervention ${paused ? "ACTIVE" : "CLEARED"} ` +
          `(gate ${budgetCoordinator?.isGateClosed() ? "CLOSED" : "OPEN"})`,
        );
      },
      onSnapshot: () => broadcastStatus(),
      log,
    });
  }
  void budgetCoordinator.start();
}

function stopBudgetCoordinator() {
  budgetCoordinator?.stop();
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
codex.on("steerFailed", ({ requestId, reason }: { requestId: number; reason: string }) => {
  log(`Steer rejected by app-server: ${reason}`);
  // Correlate the verdict to its dispatch by id (not FIFO) so a lost/reordered
  // response cannot mis-consume a later dispatch.
  const dispatch = pendingSteerDispatches.get(requestId);
  pendingSteerDispatches.delete(requestId);
  // The steer never reached Codex — its requireReply expectation (if any) must
  // not arm (handled by NOT calling replyTracker.arm() here), AND its
  // idempotency key must be RELEASED (PR B #2): the key was accept()+markStarted
  // bound to the still-running ORIGINAL turn at dispatch, so without this it
  // would strand in `started` until that turn terminates and a legitimate
  // same-key retry would wrongly get duplicate_in_flight. Release mirrors the
  // interrupt-failure path. release() is a no-op if the turn already terminated
  // and tombstoned the key (terminal entries are preserved).
  if (dispatch?.idempotencyKey && dispatch.threadId) {
    idempotencyTracker.release(dispatch.threadId, dispatch.idempotencyKey);
    log(`Released idempotency key after steer failure (request ${requestId}) — same key is retryable again`);
  }
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

codex.on("steerAccepted", ({ requestId }: { requestId: number }) => {
  log("Steer accepted by app-server");
  // require_reply × steer (PR B): the expectation arms only NOW — "a NEW
  // forwarded agentMessage after steer-accept and before the turn's terminal
  // counts as the reply". Arming at dispatch would mis-attribute pre-steer
  // chatter of the running turn as the reply. Correlate by id so a lost/reordered
  // response cannot mis-arm against the wrong dispatch (PR B #3).
  const dispatch = pendingSteerDispatches.get(requestId);
  pendingSteerDispatches.delete(requestId);
  if (dispatch?.requireReply) {
    replyTracker.arm();
    log("Reply required armed on steer-accept (steer-scoped expectation)");
  }
  // The idempotency key stays bound (accept()+markStarted at dispatch) to the
  // turn the steer joined; that turn's terminal boundary (turnIdCompleted /
  // turnTrackingReset) terminates it. Nothing to release on the success path.
});

// --- Protocol v2 PR B: turn_started ACK + idempotency terminal wiring ---

codex.on("bridgeTurnStarted", ({ requestId, turnId }: { requestId: number; turnId: string }) => {
  const pending = pendingTurnStarts.get(requestId);
  if (!pending) {
    // Possible after a turnTrackingReset cleared the map while the response
    // was in flight — the reset already terminated the idempotency keys.
    log(`bridgeTurnStarted for unknown injection ${requestId} (turn ${turnId}) — correlation dropped`);
    return;
  }
  pendingTurnStarts.delete(requestId);
  log(`Bridge turn started: injection ${requestId} → turn ${turnId} (request ${pending.requestId})`);
  if (pending.idempotencyKey) {
    idempotencyTracker.markStarted(pending.threadId, pending.idempotencyKey, turnId);
  }
  if (attachedClaude) {
    sendProtocolMessage(attachedClaude, {
      type: "turn_started",
      requestId: pending.requestId,
      ...(pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : {}),
      threadId: pending.threadId,
      turnId,
    });
  }
});

codex.on("bridgeTurnRejected", ({ requestId, error }: { requestId: number; error: string }) => {
  const pending = pendingTurnStarts.get(requestId);
  if (!pending) return;
  pendingTurnStarts.delete(requestId);
  log(`Bridge turn rejected before start: injection ${requestId} (request ${pending.requestId}): ${error}`);
  if (pending.idempotencyKey) {
    // Contract: a bridge-originated JSON-RPC error BEFORE started → rejected.
    idempotencyTracker.markRejected(pending.threadId, pending.idempotencyKey);
  }
});

codex.on("turnIdCompleted", (turnId: string | null) => {
  // turn/completed terminates the key whose started.turnId matches (null =
  // the notification carried no id and ALL active turns were cleared). Scope
  // the null case to the active thread so a null completion can never reach a
  // different thread's started keys (consistent with terminateThread;
  // single-thread-per-pair makes this benign today but explicit + future-proof).
  idempotencyTracker.completeTurn(turnId, codex.activeThreadId ?? undefined);
});

codex.on("turnTrackingReset", (reason: string) => {
  // app-server close / reconnect / stop: every pending/running idempotency key
  // is now unresolvable (responses for in-flight bridge requests will never
  // arrive), and per-injection correlation state is stale.
  // terminateAll already tombstones every steer-bound idempotency key as
  // `aborted` (so a same-key retry is told duplicate_terminal(aborted), not
  // stranded), so dropping the dispatch entries here is enough to clean up the
  // steer-scoped reply expectation + key correlation together (PR B #2/#3): a
  // never-delivered steer response can no longer orphan either.
  idempotencyTracker.terminateAll("aborted");
  if (pendingTurnStarts.size > 0) {
    log(`Cleared ${pendingTurnStarts.size} pending turn-start correlation(s) on turn tracking reset (${reason})`);
  }
  if (pendingSteerDispatches.size > 0) {
    log(`Cleared ${pendingSteerDispatches.size} pending steer dispatch(es) on turn tracking reset (${reason})`);
  }
  pendingTurnStarts.clear();
  pendingSteerDispatches.clear();
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
  const route = routeCodexMessage(msg.content, {
    mode: FILTER_MODE,
    replyArmed: replyTracker.isArmed,
    inAttentionWindow,
  });

  log(`Codex → Claude [${route.marker}/${route.reason}] (${msg.content.length} chars)`);

  if (route.noteReplyForwarded) {
    replyTracker.noteForwarded();
  }

  if (route.flushStatusBuffer) {
    statusBuffer.flush(route.noteReplyForwarded ? "reply-required message arrived" : "important message arrived");
  }

  switch (route.action) {
    case "forward":
      emitToClaude(msg);
      if (route.startAttentionWindow) {
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
  // The process is gone — every pending/running idempotency key is terminal,
  // and per-injection correlation can never resolve (PR B).
  idempotencyTracker.terminateAll("aborted");
  pendingTurnStarts.clear();
  pendingSteerDispatches.clear();
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
        if (server.upgrade(req, { data: { clientId: 0, attached: false, lastPongAt: Date.now(), pongCount: 0, pendingBackpressure: createPendingBackpressureBuffer() } })) {
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
        ws.data.pendingBackpressure = createPendingBackpressureBuffer();
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
          ws.data.pendingBackpressure.clear();
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
        expectedControlToken: controlToken,
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
      // The handler is async only on the interrupt path (terminal-boundary
      // wait); steer/inject paths run synchronously to the first result.
      handleClaudeToCodex(ws, message).catch((err: any) => {
        log(`handleClaudeToCodex threw for request ${message.requestId}: ${err?.message ?? err}`);
        sendClaudeToCodexResult(ws, message.requestId, {
          success: false,
          code: "internal_error",
          error: `Internal bridge error: ${err?.message ?? err}`,
        });
      });
      return;
    }
  }
}

/**
 * Single funnel for claude_to_codex_result (protocol v2 PR B structured
 * result): legacy success/error stay populated, and every result also carries
 * ok (mirror of success), the machine-readable code on failure, the live
 * turnPhase at result time, and an advisory retryAfterMs where meaningful.
 */
function sendClaudeToCodexResult(
  ws: ServerWebSocket<ControlSocketData>,
  requestId: string,
  opts: { success: boolean; error?: string; code?: string; retryAfterMs?: number },
) {
  sendProtocolMessage(ws, {
    type: "claude_to_codex_result",
    requestId,
    success: opts.success,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    ok: opts.success,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    phase: codex.turnPhase,
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
  });
}

function describeDuplicate(dup: Extract<IdempotencyDuplicate, { duplicate: true }>): string {
  if (dup.code === "duplicate_terminal") {
    const outcome = dup.state.phase === "terminal" ? dup.state.outcome : "unknown";
    return (
      `Duplicate idempotency_key: the original message already reached a terminal state (${outcome}) ` +
      `and was NOT re-injected. Use a fresh key to send a genuinely new message.`
    );
  }
  const detail = dup.state.phase === "started"
    ? `already running as turn ${dup.state.turnId}`
    : "still in flight";
  return (
    `Duplicate idempotency_key: a message with this key is ${detail} — NOT re-injected. ` +
    `Wait for its outcome, or use a fresh key for a genuinely new message.`
  );
}

/**
 * Wait for the interrupt's terminal boundary, racing the adapter's
 * interruptFailed signal: an app-server rejection ("expected active turn id X
 * but found Y" / "no active turn to interrupt") means the ORIGINAL turn keeps
 * running and waiting out the timeout would only delay the loud failure.
 */
function waitForInterruptOutcome(
  turnIds: string[],
): Promise<{ ok: true } | { ok: false; code: "interrupt_timeout" | "interrupt_rejected"; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    // Recommend #4: abort the inner terminal wait the moment interruptFailed
    // wins so its listeners + timer are torn down promptly instead of leaking
    // until the (clamped) interrupt budget elapses.
    const abort = new AbortController();
    const finish = (
      result: { ok: true } | { ok: false; code: "interrupt_timeout" | "interrupt_rejected"; reason?: string },
    ) => {
      if (settled) return;
      settled = true;
      codex.off("interruptFailed", onFailed);
      abort.abort();
      resolve(result);
    };
    const onFailed = (reason: string) => finish({ ok: false, code: "interrupt_rejected", reason });
    codex.on("interruptFailed", onFailed);
    codex.waitForTurnsTerminal(turnIds, undefined, abort.signal).then((result) => {
      if (result.ok) {
        finish({ ok: true });
      } else if (result.code === "interrupt_timeout") {
        finish({ ok: false, code: "interrupt_timeout" });
      }
      // result.code === "interrupt_aborted" → interruptFailed already settled
      // this outcome; discard (the settled guard would drop it anyway).
    });
  });
}

async function handleClaudeToCodex(
  ws: ServerWebSocket<ControlSocketData>,
  message: Extract<ControlClientMessage, { type: "claude_to_codex" }>,
): Promise<void> {
  // Attach-convergence guard (arch-review P1 #283, defense layer 1). ONLY the
  // socket that passed `claude_connect` admission (and thus the pair/cwd + token
  // gate) and currently holds the attach slot may inject a turn into Codex. A
  // socket that connected to /ws but never attached — or one that lost the slot
  // to a newer session — is rejected here, BEFORE any thread/budget reasoning.
  // This cannot misfire on the normal reply path: the bridge sends every
  // claude_to_codex over the same socket it attached with, so attachedClaude===ws
  // holds for every legitimate reply (verified against the attach/detach
  // lifecycle: attachClaude sets attachedClaude=ws, detachClaude/eviction clear
  // it, and a replaced socket is closed). Decision extracted to a pure helper so
  // it is unit-testable without a live WebSocket.
  const attachGuard = evaluateInjectionAttachGuard(attachedClaude, ws);
  if (!attachGuard.allowed) {
    log(
      `Rejecting claude_to_codex from non-attached socket #${ws.data.clientId} ` +
      `(request ${message.requestId}, attached=${attachedClaude ? "#" + attachedClaude.data.clientId : "none"})`,
    );
    sendClaudeToCodexResult(ws, message.requestId, {
      success: false,
      code: attachGuard.code,
      error: attachGuard.reason,
    });
    return;
  }

  if (message.message.source !== "claude") {
    sendClaudeToCodexResult(ws, message.requestId, {
      success: false,
      code: "invalid_source",
      error: "Invalid message source",
    });
    return;
  }

  // Idempotency duplicate guard (PR B): a key already tracked in ANY state
  // (live or unexpired tombstone) is answered with the original-outcome code
  // instead of re-injecting. Messages without a key bypass the machine.
  // NOTE: a key is REGISTERED only when a wire attempt actually happens (see
  // idempotency-tracker.ts header) — pre-wire rejections below stay retryable
  // with the same key on purpose.
  const idempotencyKey =
    typeof message.idempotencyKey === "string" && message.idempotencyKey.length > 0
      ? message.idempotencyKey
      : undefined;
  if (idempotencyKey && codex.activeThreadId) {
    const dup = idempotencyTracker.check(codex.activeThreadId, idempotencyKey);
    if (dup.duplicate) {
      log(`Rejected duplicate idempotency key (${dup.code})`);
      sendClaudeToCodexResult(ws, message.requestId, {
        success: false,
        code: dup.code,
        error: describeDuplicate(dup),
      });
      return;
    }
  }

  if (!tuiConnectionState.canReply()) {
    sendClaudeToCodexResult(ws, message.requestId, {
      success: false,
      code: "no_thread",
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
    const resumeAfterEpoch = budgetCoordinator?.getSnapshot()?.resumeAfterEpoch ?? null;
    const retryAfterMs = resumeAfterEpoch !== null
      ? Math.max(0, resumeAfterEpoch * 1000 - Date.now())
      : undefined;
    sendClaudeToCodexResult(ws, message.requestId, {
      success: false,
      code: "budget_paused",
      error: reason,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
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
    // require_reply × steer (PR B): allowed — the steer body carries the
    // reply-required instruction and the daemon arms the expectation when
    // the app-server ACCEPTS the steer (steerAccepted handler), so any new
    // forwarded agentMessage before the turn's terminal counts as the reply.
    const steerContent =
      "[STEER from Claude]\n" +
      "Mid-turn update for the current Codex turn. Integrate if relevant; do not restart work unless explicitly requested.\n\n" +
      contentToSend;
    // Read the steer target BEFORE dispatch so an idempotency key can be
    // bound to the turn this steer joins (started(turnId)).
    const steerTurnId = codex.steerableTurnId;
    const steerThreadId = codex.activeThreadId;
    const steerRequestId = codex.steerMessage(steerContent);
    const steered = steerRequestId !== null;
    log(`Steer ${steered ? "transport-accepted" : "failed"} (${message.message.content.length} chars, requireReply=${requireReply})`);
    if (steered) {
      // An IMPORTANT message forwarded mid-turn opens an attention window;
      // a steer is exactly Claude responding to it — close the window like
      // the inject path does, so status buffering resumes promptly.
      clearAttentionWindow();
      // Key the dispatch by the bridge request id so steerAccepted/steerFailed
      // correlate to THIS dispatch by id (PR B #3). Carry the idempotency key +
      // thread so steerFailed can release the key and turnTrackingReset can
      // clean both up together (PR B #2).
      pendingSteerDispatches.set(steerRequestId, {
        requireReply,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(steerThreadId ? { threadId: steerThreadId } : {}),
      });
      if (idempotencyKey && steerThreadId) {
        idempotencyTracker.accept(steerThreadId, idempotencyKey);
        if (steerTurnId) {
          // The key lives and dies with the turn the steer joined: the
          // turn's terminal boundary (turnIdCompleted / turnTrackingReset)
          // terminates it, so it can never strand in accepted/started. If the
          // app-server later REJECTS the steer, steerFailed releases the key.
          idempotencyTracker.markStarted(steerThreadId, idempotencyKey, steerTurnId);
        }
      }
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
    sendClaudeToCodexResult(ws, message.requestId, {
      success: steered,
      ...(steered ? {} : { code: "steer_failed", error: steerFailureAdvice }),
    });
    return;
  }

  // Busy-turn policy "interrupt" (protocol v2 PR B): terminate ALL active
  // turns, wait for the terminal boundary, then inject this message as a
  // NORMAL new turn (the shared injection block below — tier overrides,
  // require_reply arming and attention-window close all apply unchanged).
  // Race degradation mirrors steer: if the turn ended between the caller's
  // decision and this dispatch, fall straight through to normal injection.
  if (codex.turnInProgress && message.onBusy === "interrupt") {
    // Register the key BEFORE the async wait so a concurrent retry with the
    // same key during the window is answered duplicate_in_flight instead of
    // double-interrupting/double-injecting. Released on every failure exit —
    // nothing was injected, so the same key must stay retryable. (Corner
    // race: if the app-server CLOSES during the wait, turnTrackingReset
    // terminates this key as `aborted` and release() preserves the tombstone
    // — semantically honest: the attempt aborted mid-flight, and a retry is
    // told duplicate_terminal(aborted) so it knows to use a fresh key.)
    const interruptThreadId = codex.activeThreadId;
    if (idempotencyKey && interruptThreadId) {
      idempotencyTracker.accept(interruptThreadId, idempotencyKey);
    }
    const releaseInterruptKey = () => {
      if (idempotencyKey && interruptThreadId) {
        idempotencyTracker.release(interruptThreadId, idempotencyKey);
      }
    };

    const interrupted = codex.interruptActiveTurns();
    if (!interrupted.ok) {
      releaseInterruptKey();
      log(`Interrupt unavailable: ${interrupted.error}`);
      sendClaudeToCodexResult(ws, message.requestId, {
        success: false,
        code: interrupted.code,
        error:
          `Interrupt failed (${interrupted.error}). The original turn keeps running — ` +
          `your message was NOT injected. Wait for ✅, or retry with on_busy="steer".`,
      });
      return;
    }

    log(`Interrupt dispatched for turn(s) ${interrupted.turnIds.join(", ")} — waiting for terminal boundary`);
    const outcome = await waitForInterruptOutcome(interrupted.turnIds);
    if (!outcome.ok) {
      releaseInterruptKey();
      const error = outcome.code === "interrupt_rejected"
        ? `Interrupt was rejected by the app-server (${outcome.reason ?? "unknown reason"}). ` +
          `The original turn keeps running — your message was NOT injected. ` +
          `Wait for ✅, or retry with on_busy="steer".`
        : `Interrupt did not reach a terminal boundary in time. The turn MAY still be running — ` +
          `do not assume it stopped. Your message was NOT injected (this avoids a double-turn race); ` +
          `check for ✅/⚠️ notices before retrying.`;
      log(`Interrupt failed (${outcome.code})`);
      sendClaudeToCodexResult(ws, message.requestId, {
        success: false,
        code: outcome.code,
        error,
      });
      return;
    }
    log("Interrupt reached terminal boundary — injecting the message as a new turn");
    // Defensive: if the active thread changed during the wait, the upfront
    // accept() would strand under the old thread — release it; the shared
    // injection block re-registers under the thread it actually injects into.
    if (interruptThreadId && codex.activeThreadId !== interruptThreadId) {
      releaseInterruptKey();
    }
    // Fall through to the shared injection block.
  }

  const injectThreadId = codex.activeThreadId;
  const injectionId = codex.injectMessage(contentToSend, tierOverrides);
  if (injectionId === null) {
    // No wire attempt happened — any upfront interrupt-path accept() must not
    // block a retry with the same key.
    if (idempotencyKey && injectThreadId) {
      idempotencyTracker.release(injectThreadId, idempotencyKey);
    }
    const busy = codex.turnInProgress;
    const reason = busy
      ? "Codex is busy executing a turn. Options: wait for it to finish, retry with on_busy=\"steer\" to feed this message into the running turn without interrupting it, or retry with on_busy=\"interrupt\" to stop the current turn and start a new one with this message."
      : "Injection failed: no active thread or WebSocket not connected.";
    log(`Injection rejected: ${reason}`);
    sendClaudeToCodexResult(ws, message.requestId, {
      success: false,
      code: busy ? "busy_reject" : "no_thread",
      error: reason,
      ...(busy ? { retryAfterMs: BUSY_RETRY_ADVISORY_MS } : {}),
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
  // turn_started ACK correlation (PR B): remember which control request this
  // injection belongs to so bridgeTurnStarted/bridgeTurnRejected can emit the
  // turn_started event / drive the idempotency machine. injectMessage only
  // succeeds with an active thread, so injectThreadId is non-null here.
  if (injectThreadId) {
    if (idempotencyKey) {
      idempotencyTracker.accept(injectThreadId, idempotencyKey); // no-op if the interrupt path already accepted
    }
    pendingTurnStarts.set(injectionId, {
      requestId: message.requestId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      threadId: injectThreadId,
    });
  }
  sendClaudeToCodexResult(ws, message.requestId, { success: true });
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
    const reBuffered = ws.data.pendingBackpressure.drainAll();
    log(
      `Re-buffered ${reBuffered.length} backpressured message(s) for redelivery on reconnect`,
    );
    bufferedMessages.unshiftMany(reBuffered);
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
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(ws: ServerWebSocket<ControlSocketData>) {
  const messages = bufferedMessages.drainAll();
  for (let i = 0; i < messages.length; i++) {
    if (!trySendBridgeMessage(ws, messages[i]!)) {
      // Re-buffer this and all remaining messages on failure. Positional index,
      // not indexOf: identity lookup breaks the count if a message object is
      // ever enqueued twice. The buffer is empty here (just drained, and
      // trySend only touches pendingBackpressure), so re-applying the cap on
      // prepend is a provable no-op — count is preserved bit-exactly.
      const remaining = messages.slice(i);
      bufferedMessages.unshiftMany(remaining);
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
    // P1 #5: captured Codex app-server identity (version/platform) so /healthz +
    // `abg doctor` can surface protocol drift. null until the first initialize.
    appServerInfo: codex.capturedAppServerInfo,
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
    // P1 #5: keep app-server identity in step with /healthz so status.json and
    // the control status stream cannot drift on this field either.
    appServerInfo: codex.capturedAppServerInfo,
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
  idempotencyTracker.dispose();
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  clearPendingClaudeDisconnect(`daemon shutdown (${reason})`);
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  removeControlToken();
  process.exit(exitCode);
}

/**
 * Best-effort removal of the control-token file. The token is a per-start
 * secret; leaving a stale file behind would let a NEXT daemon's pre-write window
 * (or a crashed daemon) expose an old token, and a same-version restart writes a
 * fresh one anyway. Never throws — removal failure must not block shutdown.
 */
function removeControlToken() {
  try {
    rmSync(controlTokenPath, { force: true });
  } catch {}
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
  removeControlToken();
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
