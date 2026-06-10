#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { ClaudeAdapter } from "./claude-adapter";
import { BUILD_INFO } from "./build-info";
import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import { disabledReplyError, type BridgeDisabledReason } from "./bridge-disabled-state";
import { guardAgentBridgeEnv, normalizeEnvGuardMode } from "./env-guard";
import { pairScopedCommand } from "./pair-command";
import { appendTraceEvent, pickRelevantEnv } from "./trace-log";
import { createProcessLogger } from "./process-log";
import {
  CLOSE_CODE_EVICTED_STALE,
  CLOSE_CODE_PAIR_MISMATCH,
  CLOSE_CODE_PROBE_IN_PROGRESS,
} from "./control-protocol";
import type { ControlClientIdentity } from "./control-protocol";
import type { BridgeMessage } from "./types";

const originalEnv = { ...process.env };
const bootstrapLogger = createProcessLogger({ component: "AgentBridgeFrontend" });
const envGuardResult = guardAgentBridgeEnv({
  cwd: process.cwd(),
  env: process.env,
  mode: normalizeEnvGuardMode(process.env.AGENTBRIDGE_ENV_GUARD),
  allowStrict: false,
  log: bootstrapLogger.log,
});

const stateDir = new StateDirResolver();
stateDir.ensure();
const processLogger = createProcessLogger({ component: "AgentBridgeFrontend", logFile: stateDir.logFile });
const configService = new ConfigService();
// Thread the frontend logger so a corrupt config.json fails loud (to log +
// stderr) instead of silently reverting custom thresholds to defaults.
const config = configService.loadOrDefault(processLogger.log);

const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
const CONTROL_WS_URL = daemonLifecycle.controlWsUrl;

const claude = new ClaudeAdapter(stateDir.logFile);
const daemonClient = new DaemonClient(CONTROL_WS_URL, { identity: currentClientIdentity() });

let shuttingDown = false;
let daemonDisabled = false;
let daemonDisabledReason: BridgeDisabledReason | null = null;

// --- TUI kickoff tracking ---
let hasSeenTuiConnect = false;
let previousTuiConnected = false;

// --- Notification throttling for reconnect loops ---
const RECONNECT_NOTIFY_COOLDOWN_MS = 30_000; // Only notify once per 30s window
const DISABLED_RECOVERY_INTERVAL_MS = 5_000;
let lastDisconnectNotifyTs = 0;
let lastReconnectNotifyTs = 0;
let disabledRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let disabledRecoveryInFlight = false;
let disabledRecoveryAttempts = 0;

const DISABLED_RECOVERY_MAX_ATTEMPTS = 6;
const DISABLED_RECOVERY_CONFIRM_TIMEOUT_MS = 1000;

// Tracing is opt-in (default off) and must never write a full env snapshot —
// bridge.ts runs on every Claude Code session, so an ungated full-env dump would
// leak DATABASE_URL/*_DSN-style secrets to a local trace file on every start.
if (process.env.AGENTBRIDGE_TRACE === "1") {
  try {
    appendTraceEvent({
      cwd: process.cwd(),
      event: "bridge.start",
      pid: process.pid,
      argv: process.argv,
      env: process.env,
      data: {
        originalEnv: pickRelevantEnv(originalEnv),
        effectiveEnv: pickRelevantEnv(process.env),
        envGuardAction: envGuardResult.action,
        pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
        pairName: process.env.AGENTBRIDGE_PAIR_NAME ?? null,
        stateDir: stateDir.dir,
        controlPort: CONTROL_PORT,
        build: BUILD_INFO,
      },
    });
  } catch {
    // Trace logging must never break MCP startup.
  }
}

claude.setReplySender(async (
  msg: BridgeMessage,
  requireReply?: boolean,
  onBusy?: "reject" | "steer" | "interrupt",
  idempotencyKey?: string,
) => {
  if (msg.source !== "claude") {
    return { success: false, error: "Invalid message source" };
  }

  if (daemonDisabled) {
    return {
      success: false,
      error: disabledReplyError(daemonDisabledReason ?? "killed"),
    };
  }

  return daemonClient.sendReply(msg, requireReply, onBusy, idempotencyKey);
});

// turn_started ACK (protocol v2 PR B): logged for correlation forensics. The
// reply tool's synchronous result already told the model its message was
// accepted; the ACK confirms the turn actually started (the "Claude saw a
// timeout but the turn WAS injected" trail).
daemonClient.on("turnStarted", ({ requestId, idempotencyKey, threadId, turnId }) => {
  log(
    `Codex turn started for reply ${requestId} (turn=${turnId}, thread=${threadId}` +
    `${idempotencyKey ? `, idempotencyKey=${idempotencyKey}` : ""})`,
  );
});

daemonClient.on("codexMessage", (message) => {
  log(`Forwarding daemon → Claude (${message.content.length} chars)`);
  void claude.pushNotification(message);
});

daemonClient.on("status", (status) => {
  log(
    `Daemon status: ready=${status.bridgeReady} tui=${status.tuiConnected} thread=${status.threadId ?? "none"} queued=${status.queuedMessageCount}`,
  );

  // Cache the latest budget snapshot for the get_budget tool (absent = sensing unavailable).
  claude.setBudgetSnapshot(status.budget ?? null);

  // Kickoff message on first TUI connect transition (not reconnects)
  if (!hasSeenTuiConnect && status.tuiConnected && !previousTuiConnected) {
    hasSeenTuiConnect = true;
    log("First TUI connect detected — sending kickoff message to Claude");
    void claude.pushNotification(systemMessage(
      "system_tui_kickoff",
      [
        "🤝 Codex has connected via AgentBridge.",
        "You are now in a multi-agent collaboration session.",
        "When you receive a complex task, propose a division of labor to Codex.",
        "Use `reply` to send messages and `get_messages` to check for responses.",
      ].join("\n"),
    ));
  }
  previousTuiConnected = status.tuiConnected;
});

daemonClient.on("disconnect", () => {
  if (shuttingDown || daemonDisabled) return;

  // A frozen budget snapshot from a dead daemon silently masquerades as live
  // data in get_budget — clear it so the tool reports "unavailable" instead.
  claude.setBudgetSnapshot(null);

  log("Daemon control connection closed — will attempt to reconnect");

  const now = Date.now();
  if (now - lastDisconnectNotifyTs >= RECONNECT_NOTIFY_COOLDOWN_MS) {
    lastDisconnectNotifyTs = now;
    void claude.pushNotification(systemMessage(
      "system_daemon_disconnected",
      "⚠️ AgentBridge daemon control connection lost. Attempting to reconnect...",
    ));
  } else {
    log("Suppressing duplicate disconnect notification (within cooldown)");
  }
  void reconnectToDaemon();
});

daemonClient.on("rejected", async (code: number) => {
  if (shuttingDown || daemonDisabled) return;

  let reason: BridgeDisabledReason;
  let notificationId: string;
  let notificationContent: string;
  switch (code) {
    case CLOSE_CODE_EVICTED_STALE:
      reason = "evicted";
      notificationId = "system_bridge_evicted";
      notificationContent = `⚠️ AgentBridge evicted this session because it stopped responding to liveness probes — a newer Claude Code session has taken over. Close this session and start a new one with \`${pairScopedCommand("claude")}\` if you want to reconnect. AgentBridge 因此会话未响应存活探测而将其驱逐——更新的 Claude Code 会话已接管。如需重连，请关闭此会话并运行 \`${pairScopedCommand("claude")}\` 启动新会话。`;
      break;
    case CLOSE_CODE_PROBE_IN_PROGRESS:
      reason = "probe_in_progress";
      notificationId = "system_bridge_probe_in_progress";
      notificationContent = `⚠️ AgentBridge rejected this session — a liveness probe is currently checking whether the incumbent Claude session is still alive. Retry in a few seconds with \`${pairScopedCommand("claude")}\`. AgentBridge 拒绝了此会话——正在通过存活探测检查现有 Claude 会话是否仍然在线。请稍后用 \`${pairScopedCommand("claude")}\` 重试。`;
      break;
    case CLOSE_CODE_PAIR_MISMATCH:
      // Without this branch a pair/cwd mismatch fell into the default text
      // ("another session is connected... run kill to reset"), sending users
      // off to kill a perfectly healthy daemon that simply belongs elsewhere.
      reason = "rejected";
      notificationId = "system_bridge_pair_mismatch";
      notificationContent = `⚠️ AgentBridge daemon rejected this session — pair/cwd identity mismatch (this daemon belongs to a different pair or directory). Do NOT kill it; start Claude Code from the pair's own directory, or pick another pair name with \`agentbridge --pair <name> claude\`. AgentBridge 拒绝了此会话——pair/目录身份不匹配（该 daemon 属于其他 pair 或目录）。无需 kill；请到对应目录启动，或换一个 pair 名：\`agentbridge --pair <名字> claude\`。`;
      break;
    default:
      reason = "rejected";
      notificationId = "system_bridge_replaced";
      notificationContent = `⚠️ AgentBridge daemon rejected this session — another Claude Code session is already connected. Close the other session first, or run \`${pairScopedCommand("kill")}\` to reset. AgentBridge 守护进程拒绝了此会话——另一个 Claude Code 会话已在连接中。请先关闭另一个会话，或运行 \`${pairScopedCommand("kill")}\` 重置。`;
      break;
  }
  log(`Daemon rejected this session (close code ${code}, reason=${reason})`);

  // Eviction and replacement are terminal until the user intervenes: the
  // legitimate new session must not be kicked out by an auto-reconnect. But
  // probe_in_progress is transient by definition (the probe resolves within
  // LIVENESS_PROBE_TIMEOUT_MS, default 3s), so we start the recovery poller
  // and let it auto-reconnect once the slot becomes available.
  daemonDisabled = true;
  daemonDisabledReason = reason;
  await claude.pushNotification(systemMessage(notificationId, notificationContent));
  await daemonClient.disconnect();
  if (reason === "probe_in_progress") {
    disabledRecoveryAttempts = 0;
    startDisabledRecoveryPoller();
  }
});

claude.on("ready", async () => {
  log("MCP server ready (push delivery) — ensuring AgentBridge daemon...");
  if (daemonLifecycle.wasKilled()) {
    await enterDisabledState(
      "Killed sentinel found — bridge staying idle",
      `⛔ AgentBridge was stopped by \`agentbridge kill\`. Bridge is staying idle. Restart Claude Code (\`${pairScopedCommand("claude")}\`), switch to a new conversation, or run \`/resume\` to reconnect.`,
    );
    return;
  }
  try {
    await connectToDaemon();
  } catch {
    // The initial attach has no retry of its own (unlike the disconnect path) —
    // a transient failure here (e.g. attach contest, daemon mid-replace) used
    // to strand the frontend until the user restarted Claude Code. Hand it to
    // the same backoff loop the reconnect path uses.
    void reconnectToDaemon();
  }
});

async function connectToDaemon(isReconnect = false) {
  if (daemonDisabled) {
    log("connectToDaemon() skipped — bridge is disabled");
    return;
  }

  try {
    await daemonLifecycle.ensureRunning();
    await daemonClient.connect();
    // Confirm window MUST exceed the daemon's liveness-probe timeout (3000ms
    // default): when this attach contests a half-open dead incumbent, the
    // daemon stays silent for the full probe before evicting it and admitting
    // us. The old 1500ms lost that race every time — the legitimate new
    // frontend reported "❌ daemon failed to start" while the daemon was about
    // to accept it.
    const status = await daemonClient.attachClaudeAndWaitForStatus(5000);
    if (!status) {
      throw new Error("Daemon did not confirm Claude attach.");
    }
    assertAttachedToExpectedDaemon(status);
    daemonDisabledReason = null;
    if (!isReconnect) {
      void claude.pushNotification(systemMessage(
        status.bridgeReady ? "system_bridge_ready" : "system_bridge_waiting",
        initialAttachMessage(status),
      ));
    }
  } catch (err: any) {
    log(`Failed to connect to daemon: ${err.message}`);
    await claude.pushNotification(
      systemMessage(
        "system_daemon_connect_failed",
        `❌ AgentBridge daemon failed to start or is unreachable: ${err.message}`,
      ),
    );
    throw err;
  }
}

function assertAttachedToExpectedDaemon(status: { pairId?: string | null }) {
  const expectedPairId = process.env.AGENTBRIDGE_PAIR_ID || null;
  if (expectedPairId && status.pairId !== expectedPairId) {
    throw new Error(
      `Daemon identity mismatch after attach: expected pair ${expectedPairId}, got ${status.pairId ?? "<none>"}.`,
    );
  }
}

function initialAttachMessage(status: { bridgeReady: boolean; tuiConnected: boolean }) {
  if (status.bridgeReady) {
    return "✅ AgentBridge bridge is ready. Codex TUI is connected.";
  }
  if (status.tuiConnected) {
    return "⏳ AgentBridge attached to daemon. Waiting for Codex to finish creating a thread.";
  }
  return `⏳ AgentBridge attached to daemon. Waiting for Codex TUI. Start Codex in another terminal with: ${pairScopedCommand("codex")}`;
}

async function enterDisabledState(logMessage: string, notificationContent: string) {
  if (daemonDisabled) return;

  daemonDisabled = true;
  daemonDisabledReason = "killed";
  log(logMessage);
  await claude.pushNotification(systemMessage("system_bridge_disabled", notificationContent));
  await daemonClient.disconnect();
  startDisabledRecoveryPoller();
}

const MAX_RECONNECT_DELAY_MS = 30_000;
let reconnectTask: Promise<void> | null = null;

async function notifyIfDaemonKilled(logMessage: string) {
  if (!daemonLifecycle.wasKilled()) return false;

  await enterDisabledState(
    logMessage,
    `⛔ AgentBridge was stopped by \`agentbridge kill\`. Bridge is staying idle. Restart Claude Code (\`${pairScopedCommand("claude")}\`), switch to a new conversation, or run \`/resume\` to reconnect.`,
  );
  return true;
}

/**
 * `abg pairs rm` / `prune` delete the pair's whole state dir — including the
 * killed sentinel that normally stops this frontend from relaunching. Without
 * this guard a surviving frontend would resurrect a full daemon for a pair the
 * user explicitly removed, as an unregistered orphan no CLI command can stop.
 */
async function notifyIfPairRemoved(logMessage: string) {
  // Trade-off: a transient fs error here (e.g. a network-volume hiccup) reads
  // as "removed" and disables this frontend — accepted, because the recovery
  // poller keeps checking and the alternative (resurrecting a deliberately
  // removed pair as an unkillable orphan daemon) is strictly worse.
  if (existsSync(stateDir.dir)) return false;

  await enterDisabledState(
    logMessage,
    `⛔ This pair's state directory was removed (\`abg pairs rm\` / \`prune\`). Bridge is staying idle. Start fresh with \`${pairScopedCommand("claude")}\` if you still need this pair. 该 pair 的状态目录已被删除（pairs rm / prune），桥接保持待机；如仍需要请用 \`${pairScopedCommand("claude")}\` 重新启动。`,
  );
  return true;
}

function reconnectToDaemon(): Promise<void> {
  if (shuttingDown || daemonDisabled) return Promise.resolve();

  if (reconnectTask) {
    log("Skipping reconnect — another reconnect is already in progress");
    return reconnectTask;
  }

  reconnectTask = (async () => {
    try {
      for (let attempt = 0; !shuttingDown; attempt += 1) {
        if (await notifyIfDaemonKilled("Daemon was intentionally killed by user (killed sentinel found) — not reconnecting")) {
          return;
        }
        if (await notifyIfPairRemoved("Pair state directory removed — not reconnecting")) {
          return;
        }

        const delayMs = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        if (attempt > 0) {
          log(`Reconnect attempt ${attempt + 1}, waiting ${delayMs}ms...`);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (shuttingDown) return;

        // Re-check after the backoff delay. The killed sentinel may be written
        // after the disconnect event fires but before the reconnect attempt runs.
        if (await notifyIfDaemonKilled("Daemon was intentionally killed during reconnect backoff — not reconnecting")) {
          return;
        }

        try {
          await connectToDaemon(true);
          log("Reconnected to AgentBridge daemon successfully");

          const now = Date.now();
          if (now - lastReconnectNotifyTs >= RECONNECT_NOTIFY_COOLDOWN_MS) {
            lastReconnectNotifyTs = now;
            void claude.pushNotification(systemMessage(
              "system_daemon_reconnected",
              "✅ AgentBridge daemon reconnected successfully.",
            ));
          } else {
            log("Suppressing duplicate reconnect notification (within cooldown)");
          }
          return;
        } catch {
          // Continue retrying with exponential backoff until shutdown or killed sentinel.
        }
      }
    } finally {
      reconnectTask = null;
    }
  })();

  return reconnectTask;
}

function startDisabledRecoveryPoller() {
  if (disabledRecoveryTimer || shuttingDown) return;

  log(`Starting disabled-state recovery poller (${DISABLED_RECOVERY_INTERVAL_MS}ms)`);
  disabledRecoveryTimer = setInterval(() => {
    void pollDisabledRecovery();
  }, DISABLED_RECOVERY_INTERVAL_MS);
}

function stopDisabledRecoveryPoller() {
  if (!disabledRecoveryTimer) return;

  clearInterval(disabledRecoveryTimer);
  disabledRecoveryTimer = null;
  disabledRecoveryInFlight = false;
  log("Stopped disabled-state recovery poller");
}

async function pollDisabledRecovery() {
  if (!daemonDisabled || shuttingDown || disabledRecoveryInFlight) return;

  disabledRecoveryInFlight = true;
  try {
    if (daemonLifecycle.wasKilled()) {
      return;
    }

    const healthy = await daemonLifecycle.isHealthy();
    if (!healthy) {
      return;
    }

    const recoveredFrom = daemonDisabledReason;
    switch (recoveredFrom) {
      case "probe_in_progress": {
        if (disabledRecoveryAttempts >= DISABLED_RECOVERY_MAX_ATTEMPTS) {
          log(
            `Disabled-state auto-recovery gave up after ${DISABLED_RECOVERY_MAX_ATTEMPTS} attempts ` +
            "— switching to auto_recovery_exhausted terminal state",
          );
          daemonDisabledReason = "auto_recovery_exhausted";
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          void claude.pushNotification(systemMessage(
            "system_bridge_auto_recovery_gave_up",
            `⚠️ AgentBridge auto-recovery gave up after exhausting its retry budget for the in-flight liveness probe contention. Retry manually with \`${pairScopedCommand("claude")}\`. AgentBridge 自动恢复已放弃——存活探测争用的重试预算已用尽。请使用 \`${pairScopedCommand("claude")}\` 手动重试。`,
          ));
          return;
        }

        disabledRecoveryAttempts += 1;
        log(
          `Disabled-state recovery attempt ${disabledRecoveryAttempts}/${DISABLED_RECOVERY_MAX_ATTEMPTS} ` +
          "for probe_in_progress — attempting direct daemon reconnect",
        );

        try {
          await daemonClient.connect();
          const attached = await daemonClient.attachClaudeAndWaitForStatus(
            DISABLED_RECOVERY_CONFIRM_TIMEOUT_MS,
          );
          if (!attached) {
            log(
              `Disabled-state probe_in_progress recovery attempt ${disabledRecoveryAttempts} did not confirm readiness`,
            );
            await daemonClient.disconnect();
            return;
          }

          daemonDisabled = false;
          daemonDisabledReason = null;
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          // We're inside the `probe_in_progress` case branch — TS has narrowed
          // recoveredFrom to that single value, so use the matching message
          // directly. The outer switch (with its `never` exhaustive default)
          // is what enforces compile-time coverage of every BridgeDisabledReason.
          void claude.pushNotification(systemMessage(
            "system_bridge_recovered",
            "✅ AgentBridge recovered after the liveness probe completed. Daemon reconnected.",
          ));
        } catch (err: any) {
          log(`Disabled-state probe_in_progress recovery attempt failed: ${err.message}`);
          await daemonClient.disconnect();
        }
        return;
      }
      case "killed": {
        log("Disabled-state recovery conditions met — attempting direct daemon reconnect");
        try {
          await daemonClient.connect();
          const attached = await daemonClient.attachClaudeAndWaitForStatus(
            DISABLED_RECOVERY_CONFIRM_TIMEOUT_MS,
          );
          if (!attached) {
            throw new Error("daemon did not confirm reconnect");
          }

          daemonDisabled = false;
          daemonDisabledReason = null;
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          void claude.pushNotification(systemMessage(
            "system_bridge_recovered",
            "✅ AgentBridge recovered after the killed sentinel was cleared. Daemon reconnected.",
          ));
        } catch (err: any) {
          log(`Disabled-state direct reconnect failed: ${err.message}`);
          daemonDisabled = false;
          daemonDisabledReason = null;
          disabledRecoveryAttempts = 0;
          stopDisabledRecoveryPoller();
          void reconnectToDaemon();
        }
        return;
      }
      case "evicted":
      case "rejected":
      case "auto_recovery_exhausted":
      case null:
        log(
          `Disabled-state recovery poller encountered terminal/unexpected reason ${recoveredFrom ?? "null"} — stopping`,
        );
        stopDisabledRecoveryPoller();
        return;
      default: {
        const exhaustive: never = recoveredFrom;
        return exhaustive;
      }
    }
  } finally {
    disabledRecoveryInFlight = false;
  }
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${Date.now()}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

function currentClientIdentity(): ControlClientIdentity {
  return {
    pairId: process.env.AGENTBRIDGE_PAIR_ID ?? null,
    pairName: process.env.AGENTBRIDGE_PAIR_NAME ?? null,
    cwd: process.cwd(),
    baseDir: process.env.AGENTBRIDGE_BASE_DIR ?? null,
    stateDir: stateDir.dir,
    clientPid: process.pid,
    contractVersion: BUILD_INFO.contractVersion,
  };
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down Claude frontend (${reason})...`);
  stopDisabledRecoveryPoller();
  const hardExit = setTimeout(() => {
    log("Shutdown timed out waiting for daemon disconnect; forcing exit");
    process.exit(0);
  }, 3000);

  void daemonClient.disconnect().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("exit", () => {
  if (shuttingDown) return;
  void daemonClient.disconnect();
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

log(`Starting AgentBridge frontend (daemon ws ${CONTROL_WS_URL})`);

(async () => {
  try {
    await claude.start();
  } catch (err: any) {
    log(`Fatal: failed to start MCP server: ${err.message}`);
  }
})();
