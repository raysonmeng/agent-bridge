import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./daemon-client";

/**
 * E2E tests: daemon lifecycle + client reconnect
 *
 * Spins up a real daemon process on an isolated port, connects a DaemonClient,
 * verifies health/messages, kills the daemon, restarts it, and verifies
 * the client can reconnect — exercising the same path bridge.ts uses.
 */

const TEST_CONTROL_PORT = 14502;
const TEST_APP_PORT = 14500;
const TEST_PROXY_PORT = 14501;
const TEST_STATE_DIR = `/tmp/agentbridge-e2e-test-${TEST_CONTROL_PORT}`;
const TEST_PID_FILE = join(TEST_STATE_DIR, "daemon.pid");
const HEALTH_URL = `http://127.0.0.1:${TEST_CONTROL_PORT}/healthz`;
const WS_URL = `ws://127.0.0.1:${TEST_CONTROL_PORT}/ws`;
const DAEMON_PATH = fileURLToPath(new URL("./daemon.ts", import.meta.url));

let daemonProc: ChildProcess | null = null;

function launchDaemon(): ChildProcess {
  mkdirSync(TEST_STATE_DIR, { recursive: true });
  const proc = spawn(process.execPath, ["run", DAEMON_PATH], {
    env: {
      ...process.env,
      AGENTBRIDGE_CONTROL_PORT: String(TEST_CONTROL_PORT),
      AGENTBRIDGE_STATE_DIR: TEST_STATE_DIR,
      CODEX_WS_PORT: String(TEST_APP_PORT),
      CODEX_PROXY_PORT: String(TEST_PROXY_PORT),
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "60000", // don't auto-shutdown during tests
    },
    stdio: "pipe",
  });
  return proc;
}

async function waitForHealth(maxRetries = 40, delayMs = 250): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function killDaemon(): Promise<void> {
  return new Promise((resolve) => {
    if (!daemonProc || daemonProc.exitCode !== null) {
      resolve();
      return;
    }
    daemonProc.once("exit", () => resolve());
    daemonProc.kill("SIGTERM");
    // Fallback force kill
    setTimeout(() => {
      if (daemonProc && daemonProc.exitCode === null) {
        daemonProc.kill("SIGKILL");
      }
    }, 3000);
  });
}

function cleanup() {
  try { rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch {}
}

describe("E2E: daemon lifecycle + reconnect", () => {
  afterAll(async () => {
    await killDaemon();
    cleanup();
  });

  test("daemon starts and becomes healthy", async () => {
    daemonProc = launchDaemon();
    const healthy = await waitForHealth();
    expect(healthy).toBe(true);
  }, 15000);

  test("health endpoint returns daemon status", async () => {
    const res = await fetch(HEALTH_URL);
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.proxyUrl).toBe("string");
  });

  test("PID file is written correctly", () => {
    const raw = readFileSync(TEST_PID_FILE, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
  });

  test("DaemonClient connects and receives status", async () => {
    const client = new DaemonClient(WS_URL);
    await client.connect();

    const statusPromise = new Promise<any>((resolve) => {
      client.on("status", (s) => resolve(s));
    });

    client.attachClaude();

    const status = await statusPromise;
    expect(status.pid).toBeGreaterThan(0);
    expect(typeof status.proxyUrl).toBe("string");

    await client.disconnect();
  }, 10000);

  test("sendReply fails gracefully when Codex TUI is not connected", async () => {
    const client = new DaemonClient(WS_URL);
    await client.connect();
    client.attachClaude();

    // Give daemon a moment to process attachment
    await new Promise((r) => setTimeout(r, 200));

    const result = await client.sendReply({
      id: "test_reply_1",
      source: "claude",
      content: "hello codex",
      timestamp: Date.now(),
    });

    // Should fail because no Codex TUI is connected
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    await client.disconnect();
  }, 10000);

  test("client detects daemon shutdown via disconnect event", async () => {
    const client = new DaemonClient(WS_URL);
    await client.connect();
    client.attachClaude();

    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    // Kill daemon
    await killDaemon();

    // Client should detect disconnect
    await disconnected;

    // Cleanup client
    await client.disconnect();
  }, 15000);

  test("daemon restarts and client reconnects successfully", async () => {
    // Start a fresh daemon
    daemonProc = launchDaemon();
    const healthy = await waitForHealth();
    expect(healthy).toBe(true);

    // Connect a new client (simulating bridge.ts reconnect flow)
    const client = new DaemonClient(WS_URL);
    await client.connect();

    const statusPromise = new Promise<any>((resolve) => {
      client.on("status", (s) => resolve(s));
    });

    client.attachClaude();

    const status = await statusPromise;
    expect(status.pid).toBeGreaterThan(0);

    await client.disconnect();
  }, 15000);

  test("full reconnect cycle: connect → kill → restart → reconnect", async () => {
    // Ensure daemon is running from previous test
    const healthy1 = await waitForHealth(10, 100);
    expect(healthy1).toBe(true);

    const client = new DaemonClient(WS_URL);
    await client.connect();
    client.attachClaude();

    // Wait for initial status
    await new Promise<void>((resolve) => {
      client.on("status", () => resolve());
    });

    // Kill daemon
    const disconnected = new Promise<void>((resolve) => {
      client.on("disconnect", () => resolve());
    });

    await killDaemon();
    await disconnected;

    // Restart daemon
    daemonProc = launchDaemon();
    const healthy2 = await waitForHealth();
    expect(healthy2).toBe(true);

    // Reconnect — same flow as bridge.ts reconnectToDaemon()
    const client2 = new DaemonClient(WS_URL);
    await client2.connect();

    const status2 = new Promise<any>((resolve) => {
      client2.on("status", (s) => resolve(s));
    });

    client2.attachClaude();
    const status = await status2;
    expect(status.pid).toBeGreaterThan(0);

    await client2.disconnect();
  }, 30000);
});
