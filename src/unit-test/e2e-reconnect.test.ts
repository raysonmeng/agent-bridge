import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../daemon-client";

/**
 * E2E tests: daemon lifecycle + client reconnect
 *
 * Spins up a real daemon process, connects a DaemonClient, verifies
 * health/messages, kills the daemon, restarts it, and verifies the client can
 * reconnect — exercising the same path bridge.ts uses.
 *
 * Hermeticity (all verified live failure modes of the old version):
 *  - dynamic ports + mkdtemp state dir — fixed 14500-14502 and a shared /tmp
 *    dir made concurrent runs (main repo + worktree) kill each other's daemons
 *    and delete each other's state;
 *  - a PATH-shimmed FAKE codex — the old version launched a REAL logged-in
 *    `codex app-server` on every `bun test src`, and its SIGKILL fallback
 *    leaked orphan codex processes.
 */

const DAEMON_PATH = fileURLToPath(new URL("../daemon.ts", import.meta.url));

let testRoot = "";
let stateDir = "";
let binDir = "";
let controlPort = 0;
let appPort = 0;
let proxyPort = 0;
let healthUrl = "";
let wsUrl = "";
let pidFile = "";

let daemonProc: ChildProcess | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal fake codex app-server: healthz/readyz + WS accept + clean SIGTERM. */
function fakeCodexScript(): string {
  return `#!/usr/bin/env bun
if (process.argv.includes("--version")) {
  console.log("codex fake");
  process.exit(0);
}
if (process.argv[2] !== "app-server") {
  await Bun.sleep(60_000);
  process.exit(0);
}
const listenIndex = process.argv.indexOf("--listen");
const listen = process.argv[listenIndex + 1];
const port = Number(new URL(listen).port);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      return Response.json({ ok: true });
    }
    if (server.upgrade(req)) return undefined;
    return new Response("fake codex app-server");
  },
  websocket: { open() {}, message() {}, close() {} },
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
await new Promise(() => {});
`;
}

function launchDaemon(): ChildProcess {
  mkdirSync(stateDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    AGENTBRIDGE_MANUAL: "1",
    AGENTBRIDGE_CONTROL_PORT: String(controlPort),
    AGENTBRIDGE_STATE_DIR: stateDir,
    CODEX_WS_PORT: String(appPort),
    CODEX_PROXY_PORT: String(proxyPort),
    AGENTBRIDGE_CODEX_TRANSPORT: "ws",
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "60000", // don't auto-shutdown during tests
    // Hermetic: never let a test daemon poll the REAL installed budget probe
    // (~/.budget-guard/bin) — real quota ≥ pauseAt would close the reply gate
    // and break unrelated tests.
    AGENTBRIDGE_BUDGET_ENABLED: "0",
  };
  delete env.AGENTBRIDGE_BASE_DIR;
  delete env.AGENTBRIDGE_PAIR_ID;
  delete env.AGENTBRIDGE_PAIR_NAME;
  const proc = spawn(process.execPath, ["run", DAEMON_PATH], {
    env,
    stdio: "pipe",
  });
  return proc;
}

async function waitForHealth(maxRetries = 40, delayMs = 250): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(healthUrl);
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
    // Fallback force kill (also fires "exit", resolving the promise)
    setTimeout(() => {
      if (daemonProc && daemonProc.exitCode === null) {
        daemonProc.kill("SIGKILL");
      }
    }, 3000);
  });
}

function cleanup() {
  try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
}

describe("E2E: daemon lifecycle + reconnect", () => {
  beforeAll(async () => {
    testRoot = mkdtempSync(join(tmpdir(), "agentbridge-e2e-reconnect-"));
    stateDir = join(testRoot, "state");
    binDir = join(testRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const codexPath = join(binDir, "codex");
    writeFileSync(codexPath, fakeCodexScript(), "utf-8");
    chmodSync(codexPath, 0o755);

    [controlPort, appPort, proxyPort] = await Promise.all([freePort(), freePort(), freePort()]);
    healthUrl = `http://127.0.0.1:${controlPort}/healthz`;
    wsUrl = `ws://127.0.0.1:${controlPort}/ws`;
    pidFile = join(stateDir, "daemon.pid");
  });

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
    const res = await fetch(healthUrl);
    expect(res.ok).toBe(true);
    const body = await res.json() as any;
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.proxyUrl).toBe("string");
  });

  test("PID file is written correctly", () => {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
  });

  test("DaemonClient connects and receives status", async () => {
    const client = new DaemonClient(wsUrl);
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
    const client = new DaemonClient(wsUrl);
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
    const client = new DaemonClient(wsUrl);
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
    const client = new DaemonClient(wsUrl);
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

    const client = new DaemonClient(wsUrl);
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
    const client2 = new DaemonClient(wsUrl);
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
