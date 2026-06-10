#!/usr/bin/env node

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distCli = join(repoRoot, "dist", "cli.js");
const distDaemon = join(repoRoot, "dist", "daemon.js");
const skipBuild = process.argv.includes("--skip-build");
const keepTmp = process.env.AGENTBRIDGE_SMOKE_KEEP_TMP === "1";
const fakeCodexHealthStatus = Number.parseInt(process.env.AGENTBRIDGE_SMOKE_FAKE_CODEX_HEALTH_STATUS ?? "200", 10);

const SMOKE_TIMEOUT_MS = 20_000;

function log(message) {
  process.stderr.write(`[smoke-built-cli] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function run(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    timeoutMs = SMOKE_TIMEOUT_MS,
  } = options;

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000).unref();
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    fail(
      `${command} ${args.join(" ")} failed with code ${result.code ?? `signal ${result.signal}`}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  return result;
}

function assertRunnableArtifact(path, label) {
  assert(existsSync(path), `${label} is missing: ${path}`);
  const mode = statSync(path).mode;
  assert((mode & 0o111) !== 0, `${label} is not executable: ${path}`);
}

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a TCP port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function assertPortFree(port, label) {
  const deadline = Date.now() + 3000;
  let lastError = null;

  while (Date.now() < deadline) {
    const free = await new Promise((resolveProbe) => {
      const server = net.createServer();
      server.unref();
      server.on("error", (err) => {
        lastError = err;
        resolveProbe(false);
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolveProbe(true));
      });
    });

    if (free) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }

  throw new Error(`${label} port ${port} was not released: ${lastError?.message ?? "still busy"}`);
}

function readPidFile(path) {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidFromStatus(path) {
  try {
    const status = JSON.parse(readFileSync(path, "utf-8"));
    return Number.isInteger(status.pid) && status.pid > 0 ? status.pid : null;
  } catch {
    return null;
  }
}

async function waitForHttpOk(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  fail(`daemon pid ${pid} did not exit within ${timeoutMs}ms`);
}

function writeFakeCodex(binDir) {
  const fakeCodexPath = join(binDir, "codex");
  const fakeCodex = `#!${process.execPath}
const args = process.argv.slice(2);

if (args[0] === "app-server") {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: codex app-server [OPTIONS]");
    console.log("      --listen <URL>");
    console.log("          Transport endpoint URL. Supported values: stdio://, unix://, unix://PATH, ws://IP:PORT, off");
    process.exit(0);
  }

  const listenIndex = args.indexOf("--listen");
  const listenUrl = listenIndex >= 0 ? args[listenIndex + 1] : "stdio://";
  if (!listenUrl || !listenUrl.startsWith("ws://")) {
    console.error("fake codex only supports app-server --listen ws://HOST:PORT");
    process.exit(2);
  }

  const url = new URL(listenUrl);
  const port = Number.parseInt(url.port, 10);
  const hostname = url.hostname || "127.0.0.1";
  const healthStatus = () => Number.parseInt(process.env.AGENTBRIDGE_SMOKE_FAKE_CODEX_HEALTH_STATUS || "200", 10);

  if (typeof Bun !== "undefined" && typeof Bun.serve === "function") {
    const server = Bun.serve({
      port,
      hostname,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz" || url.pathname === "/readyz") {
          const status = healthStatus();
          return Response.json({ ok: status >= 200 && status < 300 }, { status });
        }
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (server.upgrade(req)) return undefined;
          return new Response("websocket upgrade failed", { status: 400 });
        }
        return new Response("fake codex app-server\\n");
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    console.error("fake codex app-server listening " + listenUrl);

    function shutdown() {
      server.stop(true);
      process.exit(0);
    }
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    setInterval(() => {}, 1000);
    return;
  }

  const http = require("node:http");
  const crypto = require("node:crypto");

  function websocketAccept(key) {
    return crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      const status = healthStatus();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status >= 200 && status < 300 }) + "\\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fake codex app-server\\n");
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\\r\\n" +
        "Upgrade: websocket\\r\\n" +
        "Connection: Upgrade\\r\\n" +
        "Sec-WebSocket-Accept: " + websocketAccept(key) + "\\r\\n" +
        "\\r\\n",
    );
    socket.on("data", () => {});
    socket.on("error", () => {});
  });

  server.listen(port, hostname, () => {
    console.error("fake codex app-server listening " + listenUrl);
  });

  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => {}, 1000).unref();
  return;
}

if (args.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

console.log("fake codex " + args.join(" "));
process.exit(0);
`;

  writeFileSync(fakeCodexPath, fakeCodex, "utf-8");
  return fakeCodexPath;
}

async function main() {
  if (!skipBuild) {
    log("building CLI artifacts");
    await runChecked("bun", ["run", "build:cli"], { timeoutMs: 60_000 });
  } else {
    log("skipping build (--skip-build)");
  }

  assertRunnableArtifact(distCli, "dist/cli.js");
  assertRunnableArtifact(distDaemon, "dist/daemon.js");

  const tempRoot = mkdtempSync(join(tmpdir(), "agentbridge-built-smoke-"));
  const stateDir = join(tempRoot, "state");
  const binDir = join(tempRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  const fakeCodexPath = writeFakeCodex(binDir);
  await chmod(fakeCodexPath, 0o755);

  const appPort = await getFreePort();
  const proxyPort = await getFreePort();
  const controlPort = await getFreePort();
  let daemonPid = null;
  const statusPath = join(stateDir, "status.json");

  // Two env hazards (both bit us in CI/locally — CI red since 2026-06-03):
  // 1. The CLI's env-guard treats manual runtime env (STATE_DIR/ports) WITHOUT
  //    AGENTBRIDGE_PAIR_ID or AGENTBRIDGE_MANUAL=1 as stale and CLEARS it —
  //    the daemon then boots at the default location while we poll the smoke
  //    ports ("Unable to connect"). Declare manual mode explicitly.
  // 2. Ambient AGENTBRIDGE_*/CODEX_* from the invoking shell (a live pair
  //    session) leaks through ...process.env and trips the guard's pair
  //    consistency checks. Strip them before applying the smoke's own env.
  const ambient = { ...process.env };
  for (const key of Object.keys(ambient)) {
    if (key.startsWith("AGENTBRIDGE_") || key === "CODEX_WS_PORT" || key === "CODEX_PROXY_PORT") {
      delete ambient[key];
    }
  }
  const env = {
    ...ambient,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    AGENTBRIDGE_MANUAL: "1",
    AGENTBRIDGE_STATE_DIR: stateDir,
    AGENTBRIDGE_CONTROL_PORT: String(controlPort),
    CODEX_WS_PORT: String(appPort),
    CODEX_PROXY_PORT: String(proxyPort),
    AGENTBRIDGE_SMOKE_FAKE_CODEX_HEALTH_STATUS: String(fakeCodexHealthStatus),
  };

  try {
    log(`starting built CLI smoke on app:${appPort} proxy:${proxyPort} control:${controlPort}`);
    const cliResult = await run(distCli, ["codex", "help"], {
      env,
      timeoutMs: SMOKE_TIMEOUT_MS,
    });

    if (cliResult.code !== 0) {
      fail(
        `built CLI smoke command failed with code ${cliResult.code ?? `signal ${cliResult.signal}`}\n` +
          `--- stdout ---\n${cliResult.stdout}\n--- stderr ---\n${cliResult.stderr}`,
      );
    }

    await waitForHttpOk(`http://127.0.0.1:${controlPort}/healthz`);
    await waitForHttpOk(`http://127.0.0.1:${controlPort}/readyz`);

    assert(existsSync(statusPath), `status.json was not written: ${statusPath}`);
    const status = JSON.parse(readFileSync(statusPath, "utf-8"));
    assert(Number.isInteger(status.pid) && status.pid > 0, "status.json missing numeric pid");
    assert(status.controlPort === controlPort, `status.json controlPort mismatch: ${status.controlPort}`);
    assert(status.proxyUrl === `ws://127.0.0.1:${proxyPort}`, `status.json proxyUrl mismatch: ${status.proxyUrl}`);
    assert(status.appServerUrl === `ws://127.0.0.1:${appPort}`, `status.json appServerUrl mismatch: ${status.appServerUrl}`);

    daemonPid = status.pid;
    try {
      process.kill(daemonPid, 0);
    } catch {
      fail(`daemon pid from status.json is not alive: ${daemonPid}`);
    }

    log(`daemon healthy pid=${daemonPid}`);
  } finally {
    const pidPath = join(stateDir, "daemon.pid");
    daemonPid ??= pidFromStatus(statusPath);
    daemonPid ??= readPidFile(pidPath);

    let cleanupError = null;
    if (daemonPid) {
      try {
        process.kill(daemonPid, "SIGTERM");
        await waitForProcessExit(daemonPid);
      } catch (err) {
        log(`cleanup warning: ${err.message}`);
        try { process.kill(daemonPid, "SIGKILL"); } catch {}
      }
    }

    for (const [port, label] of [
      [appPort, "app"],
      [proxyPort, "proxy"],
      [controlPort, "control"],
    ]) {
      try {
        await assertPortFree(port, label);
      } catch (err) {
        cleanupError ??= new Error(
          `${err.message}. This often means daemon bootstrap failed before status.json was written; ` +
            `cleanup attempted pid from ${statusPath} and ${pidPath}.`,
        );
      }
    }

    if (keepTmp) {
      log(`kept temp dir: ${tempRoot}`);
    } else {
      rmSync(tempRoot, { recursive: true, force: true });
    }

    if (cleanupError) throw cleanupError;
  }

  log("PASS");
}

main().catch((err) => {
  console.error(`[smoke-built-cli] FAIL: ${err.stack ?? err.message}`);
  process.exit(1);
});
