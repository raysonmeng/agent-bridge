#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { ClaudeAdapter } from "./claude-adapter";
import { DaemonClient } from "./daemon-client";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import type { BridgeMessage } from "./types";

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
const CONTROL_WS_URL = daemonLifecycle.controlWsUrl;

const claude = new ClaudeAdapter(stateDir.logFile);
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

  log("Daemon control connection closed");
  void claude.pushNotification(systemMessage(
    "system_daemon_disconnected",
    "⚠️ AgentBridge daemon control connection lost. The Codex proxy may still be running in the background, but Claude cannot communicate bidirectionally right now.",
  ));
});

claude.on("ready", async () => {
  log(`MCP server ready (delivery mode: ${claude.getDeliveryMode()}) — ensuring AgentBridge daemon...`);

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
  }
});

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
