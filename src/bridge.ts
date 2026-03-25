#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { ClaudeAdapter } from "./claude-adapter";
import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
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

claude.setReplySender(async (msg: BridgeMessage) => {
  if (msg.source !== "claude") {
    return { success: false, error: "Invalid message source" };
  }

  return daemonClient.sendReply(msg);
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
  if (shuttingDown) return;

  log("Daemon control connection closed — will attempt to reconnect");
  void claude.pushNotification(systemMessage(
    "system_daemon_disconnected",
    "⚠️ AgentBridge daemon control connection lost. Attempting to reconnect...",
  ));
  void reconnectToDaemon();
});

claude.on("ready", async () => {
  log(`MCP server ready (delivery mode: ${claude.getDeliveryMode()}) — ensuring AgentBridge daemon...`);
  await connectToDaemon();
});

async function connectToDaemon() {
  try {
    await daemonLifecycle.ensureRunning();
    await daemonClient.connect();
    daemonClient.attachClaude();
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

const MAX_RECONNECT_DELAY_MS = 30_000;

async function reconnectToDaemon(attempt = 0) {
  if (shuttingDown) return;

  // Don't reconnect if user explicitly killed the daemon
  if (daemonLifecycle.wasKilled()) {
    log("Daemon was intentionally killed by user (killed sentinel found) — not reconnecting");
    void claude.pushNotification(systemMessage(
      "system_daemon_killed",
      "⛔ AgentBridge daemon was stopped by `agentbridge kill`. Run `agentbridge codex` to restart.",
    ));
    return;
  }

  const delayMs = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
  if (attempt > 0) {
    log(`Reconnect attempt ${attempt + 1}, waiting ${delayMs}ms...`);
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  if (shuttingDown) return;

  try {
    await connectToDaemon();
    log("Reconnected to AgentBridge daemon successfully");
    void claude.pushNotification(systemMessage(
      "system_daemon_reconnected",
      "✅ AgentBridge daemon reconnected successfully.",
    ));
  } catch {
    void reconnectToDaemon(attempt + 1);
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
