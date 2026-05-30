#!/usr/bin/env bun
// Real-codex integration E2E for #85: drive the actual CodexAdapter in unix
// transport mode against a real `codex app-server`, and prove a client can do a
// full initialize round-trip through proxy → adapter → relay → codex(unix).
// Uses isolated ports so it never touches the running daemon (4500/4501).
import { CodexAdapter } from "../src/codex-adapter.ts";
import { codexSocketPath, removeSocketFile } from "../src/codex-transport.ts";

const APP_PORT = 4560;
const PROXY_PORT = 4561;
const log = (...a) => console.log("[e2e-tp]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.AGENTBRIDGE_CODEX_TRANSPORT = "unix";
const logFile = "/tmp/agentbridge-probe/e2e-transport.log";

const adapter = new CodexAdapter(APP_PORT, PROXY_PORT, logFile);
let failed = false;

async function proxyInitialize() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok, msg) => { if (done) return; done = true; log(ok ? "PASS" : "FAIL", msg); if (!ok) failed = true; resolve(); };
    const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}`);
    ws.onopen = () => { log("proxy WS open; sending initialize"); ws.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "e2e", title: "e2e", version: "0" } } })); };
    ws.onmessage = (ev) => {
      const txt = String(ev.data);
      if (txt.includes('"id":1') && txt.includes("result")) { fin(true, "initialize round-trip through proxy→relay→codex(unix): " + txt.slice(0, 100)); try { ws.close(); } catch {} }
    };
    ws.onerror = (e) => fin(false, "proxy WS error: " + (e?.message ?? "?"));
    setTimeout(() => fin(false, "proxy initialize timeout"), 5000);
  });
}

async function main() {
  removeSocketFile(codexSocketPath(APP_PORT));
  log("starting adapter in unix transport mode (appPort=" + APP_PORT + ")");
  await adapter.start();
  log("adapter.start() completed; transport=" + adapter.transport + " socket=" + adapter.socketPath);
  if (adapter.transport !== "unix") { log("FAIL: expected unix transport"); failed = true; }

  // 1) Adapter's own primary WS is connected to codex via the relay.
  await sleep(300);
  log("relay connectionCount:", adapter.relay?.connectionCount);

  // 2) Full client round-trip through the proxy.
  await proxyInitialize();

  // 3) Socket file exists during run, removed on stop.
  const sock = adapter.socketPath;
  adapter.stop();
  await sleep(500);
  const { existsSync } = await import("node:fs");
  if (sock && existsSync(sock)) { log("FAIL: socket not cleaned up on stop:", sock); failed = true; }
  else log("PASS: socket cleaned up on stop");

  log(failed ? "=== E2E FAILED ===" : "=== E2E PASSED ===");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { log("FATAL", e); try { adapter.stop(); } catch {} process.exit(1); });
