#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter } from "./claude-adapter";
import { DaemonClient } from "./daemon-client";
import type { BridgeMessage } from "./types";

const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const PID_FILE = process.env.AGENTBRIDGE_PID_FILE ?? `/tmp/agentbridge-daemon-${CONTROL_PORT}.pid`;
const CONTROL_HEALTH_URL = `http://127.0.0.1:${CONTROL_PORT}/healthz`;
const CONTROL_WS_URL = `ws://127.0.0.1:${CONTROL_PORT}/ws`;
const LOG_FILE = "/tmp/agentbridge.log";
const DAEMON_PATH = fileURLToPath(new URL("./daemon.ts", import.meta.url));

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

  log("Daemon control connection closed");
  void claude.pushNotification(systemMessage(
    "system_daemon_disconnected",
    "⚠️ AgentBridge daemon control connection lost. The Codex proxy may still be running in the background, but Claude cannot communicate bidirectionally right now.",
  ));
});

claude.on("ready", async () => {
  log(`MCP server ready (delivery mode: ${claude.getDeliveryMode()}) — ensuring AgentBridge daemon...`);

  try {
    await ensureDaemonRunning();
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

async function ensureDaemonRunning() {
  if (await isDaemonHealthy()) {
    return;
  }

  const existingPid = readDaemonPid();
  if (existingPid) {
    if (isProcessAlive(existingPid)) {
      try {
        await waitForDaemonHealthy(12, 250);
        return;
      } catch {
        throw new Error(
          `Found existing daemon process ${existingPid}, but control port ${CONTROL_PORT} never became healthy.`,
        );
      }
    }

    removeStalePidFile();
  }

  launchDaemon();
  await waitForDaemonHealthy();
}

function launchDaemon() {
  log(`Launching detached daemon on control port ${CONTROL_PORT}`);

  const daemonProc = spawn(process.execPath, ["run", DAEMON_PATH], {
    cwd: process.cwd(),
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
  });
  daemonProc.unref();
}

async function isDaemonHealthy() {
  try {
    const response = await fetch(CONTROL_HEALTH_URL);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDaemonHealthy(maxRetries = 40, delayMs = 250) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (await isDaemonHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Timed out waiting for AgentBridge daemon health on ${CONTROL_HEALTH_URL}`);
}

function readDaemonPid() {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    if (!raw) return null;

    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStalePidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {}
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
    appendFileSync(LOG_FILE, line);
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
