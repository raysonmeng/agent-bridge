#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { ClaudeAdapter } from "./claude-adapter";
import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import { disabledReplyError, type BridgeDisabledReason } from "./bridge-disabled-state";
import type { BridgeMessage } from "./types";

const stateDir = new StateDirResolver();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
const CONTROL_WS_URL = daemonLifecycle.controlWsUrl;

const claude = new ClaudeAdapter();
const daemonClient = new DaemonClient(CONTROL_WS_URL);

let shuttingDown = false;
let daemonDisabled = false;
let daemonDisabledReason: BridgeDisabledReason | null = null;

// --- Notification throttling for reconnect loops ---
const RECONNECT_NOTIFY_COOLDOWN_MS = 30_000; // Only notify once per 30s window
const DISABLED_RECOVERY_INTERVAL_MS = 5_000;
let lastDisconnectNotifyTs = 0;
let lastReconnectNotifyTs = 0;
let disabledRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let disabledRecoveryInFlight = false;

claude.setReplySender(async (msg: BridgeMessage, requireReply?: boolean) => {
  if (msg.source !== "claude") {
    return { success: false, error: "Invalid message source" };
  }

  if (daemonDisabled) {
    return {
      success: false,
      error: disabledReplyError(daemonDisabledReason ?? "killed"),
    };
  }

  return daemonClient.sendReply(msg, requireReply);
});

daemonClient.on("codexMessage", (message) => {
  log(`Forwarding daemon → Claude (${message.content.length} chars)`);
  void claude.pushNotification(message);
});

daemonClient.on("status", (status) => {
  log(
    `Daemon status: ready=${status.bridgeReady} tui=${status.tuiConnected} thread=${status.threadId ?? "none"} queued=${status.queuedMessageCount}`,
  );
});

daemonClient.on("disconnect", () => {
  if (shuttingDown || daemonDisabled) return;

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

daemonClient.on("rejected", async () => {
  if (shuttingDown || daemonDisabled) return;

  log("Daemon rejected this session (close code 4001) — another Claude session is already connected");

  // The daemon now rejects NEW connections when an existing session is active.
  // This session was the latecomer, so it should enter dormant state permanently
  // and not try to reconnect (which would just get rejected again).
  daemonDisabled = true;
  daemonDisabledReason = "rejected";
  await claude.pushNotification(systemMessage(
    "system_bridge_replaced",
    "⚠️ AgentBridge daemon rejected this session — another Claude Code session is already connected. Close the other session first, or run `agentbridge kill` to reset. AgentBridge 守护进程拒绝了此会话——另一个 Claude Code 会话已在连接中。请先关闭另一个会话，或运行 `agentbridge kill` 重置。",
  ));
  await daemonClient.disconnect();
});

claude.on("ready", async () => {
  log(`MCP server ready (delivery mode: ${claude.getDeliveryMode()}) — ensuring AgentBridge daemon...`);
  if (daemonLifecycle.wasKilled()) {
    await enterDisabledState(
      "Killed sentinel found — bridge staying idle",
      "⛔ AgentBridge was stopped by `agentbridge kill`. Bridge is staying idle. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.",
    );
    return;
  }
  await connectToDaemon();
});

async function connectToDaemon(isReconnect = false) {
  if (daemonDisabled) {
    log("connectToDaemon() skipped — bridge is disabled");
    return;
  }

  try {
    await daemonLifecycle.ensureRunning();
    await daemonClient.connect();
    daemonClient.attachClaude();
    daemonDisabledReason = null;
    if (!isReconnect) {
      void claude.pushNotification(systemMessage(
        "system_bridge_ready",
        "✅ AgentBridge bridge is ready. Daemon connected. Start Codex in another terminal with: agentbridge codex",
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
    "⛔ AgentBridge was stopped by `agentbridge kill`. Bridge is staying idle. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.",
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

    log("Disabled-state recovery conditions met — attempting direct daemon reconnect");
    try {
      await daemonClient.connect();
      daemonClient.attachClaude();
      daemonDisabled = false;
      daemonDisabledReason = null;
      stopDisabledRecoveryPoller();
      void claude.pushNotification(systemMessage(
        "system_bridge_recovered",
        "✅ AgentBridge recovered after the killed sentinel was cleared. Daemon reconnected.",
      ));
    } catch (err: any) {
      log(`Disabled-state direct reconnect failed: ${err.message}`);
      daemonDisabled = false;
      daemonDisabledReason = null;
      stopDisabledRecoveryPoller();
      void reconnectToDaemon();
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
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeFrontend] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(stateDir.logFile, line);
  } catch {}
}

log(`Starting AgentBridge frontend (daemon ws ${CONTROL_WS_URL})`);

(async () => {
  try {
    await claude.start();
  } catch (err: any) {
    log(`Fatal: failed to start MCP server: ${err.message}`);
  }
})();
