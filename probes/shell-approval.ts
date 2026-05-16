#!/usr/bin/env bun
/**
 * Approval-policy probe.
 *
 * Spawns the daemon on isolated ports, attaches one simulated Claude, and
 * sends a turn that explicitly asks Codex to execute a shell command
 * (`echo agentbridge-multi-fix-probe`). Pre-fix, the daemon's ClaudeThread
 * auto-denied every server-initiated approval request with `-32601`,
 * which made `exec_command` impossible. Post-fix, we set
 * `approvalPolicy: "never"` at thread/start AND auto-accept any approval
 * server-request that still arrives.
 *
 * The probe passes when:
 *   1. The turn completes (turn/completed event observed).
 *   2. Codex echoes the marker string back inside an agentMessage.
 *   3. The bridge log shows no `auto-denied ... no UI to approve` lines for
 *      this chat (pre-fix signature). Auto-accepts are OK to see.
 *
 * Cost: one short Codex turn that runs a single `echo`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";

const STATE_DIR = "/tmp/agentbridge-shell-approval-probe";
const CTRL_PORT = 4702;
const CODEX_WS_PORT = 4700;
const CODEX_PROXY_PORT = 4701;
const CONTROL_URL = `ws://127.0.0.1:${CTRL_PORT}/ws`;
const MARKER = "agentbridge-multi-fix-probe-marker-9f1c4e";
const CHAT_ID = "shell_probe_a";

function elapsed(start: number) {
  return Date.now() - start;
}

async function waitReady(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CTRL_PORT}/readyz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`daemon /readyz not ready within ${timeoutMs}ms`);
}

async function main() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  const daemonJs = `${import.meta.dir}/../plugins/agentbridge/server/daemon.js`;
  const env = {
    ...process.env,
    AGENTBRIDGE_STATE_DIR: STATE_DIR,
    CODEX_WS_PORT: String(CODEX_WS_PORT),
    CODEX_PROXY_PORT: String(CODEX_PROXY_PORT),
    AGENTBRIDGE_CONTROL_PORT: String(CTRL_PORT),
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "300000",
  };

  const start = Date.now();
  const log = (s: string) => process.stderr.write(`[${elapsed(start).toString().padStart(6)}ms] ${s}\n`);

  log(`spawning daemon: bun ${daemonJs}`);
  const daemon = spawn("bun", [daemonJs], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stderr.on("data", (b: Buffer) => process.stderr.write(`[daemon] ${b}`));
  daemon.stdout.on("data", (b: Buffer) => process.stderr.write(`[daemon:out] ${b}`));
  daemon.on("exit", (code) => log(`daemon exited code=${code}`));

  let failed = false;
  let threadReady = false;
  let turnCompleted = false;
  let echoSeen = false;
  const agentMessages: string[] = [];

  try {
    await waitReady(45_000);
    log("daemon /readyz ok");

    const ws = new WebSocket(CONTROL_URL);
    let resolveReady!: () => void;
    let resolveDone!: () => void;
    const readyP = new Promise<void>((r) => (resolveReady = r));
    const doneP = new Promise<void>((r) => (resolveDone = r));

    ws.onopen = () => {
      log(`WS open → claude_connect chatId=${CHAT_ID}`);
      ws.send(JSON.stringify({ type: "claude_connect", chatId: CHAT_ID }));
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : (ev.data as Buffer).toString()); }
      catch { return; }

      if (msg.type === "codex_to_claude") {
        const content: string = msg.message?.content ?? "";
        const idPrefix = (msg.message?.id ?? "").split("_").slice(0, 2).join("_");
        log(`recv ${idPrefix} (${content.length} chars): ${content.slice(0, 80).replace(/\n/g, " ")}…`);

        if (content.startsWith("✅ Your Codex thread is ready")) {
          threadReady = true;
          resolveReady();
        }
        if (content.startsWith("✅ Codex finished")) {
          turnCompleted = true;
          resolveDone();
        }
        if (!content.startsWith("⏳") && !content.startsWith("✅") && !content.startsWith("⚠️") && !content.startsWith("[STATUS")) {
          agentMessages.push(content);
          if (content.includes(MARKER)) echoSeen = true;
        }
      }
    };

    ws.onerror = (e: any) => log(`WS error: ${e?.message ?? e}`);
    ws.onclose = (e) => log(`WS closed code=${e.code} reason=${e.reason || "-"}`);

    log("waiting for thread ready...");
    await Promise.race([
      readyP,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("thread never ready in 45s")), 45_000)),
    ]);

    const prompt = `Run the shell command exactly: echo ${MARKER}\n\nAfter running, reply [IMPORTANT] with one short line confirming you saw the output containing the marker. No further commentary.`;
    log(`firing turn with shell command...`);
    ws.send(JSON.stringify({
      type: "claude_to_codex",
      requestId: `req_${Date.now()}`,
      chatId: CHAT_ID,
      message: { id: `${CHAT_ID}_msg`, source: "claude", content: prompt, timestamp: Date.now() },
      requireReply: true,
    }));

    log("waiting up to 120s for turn completion...");
    await Promise.race([
      doneP,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("turn never completed in 120s")), 120_000)),
    ]);

    log(`turn done: turnCompleted=${turnCompleted} echoSeen=${echoSeen} msgCount=${agentMessages.length}`);
    log(`agentMessages preview: ${agentMessages.map((m) => m.slice(0, 100)).join("  ||  ").slice(0, 400)}`);

    ws.close();
    await new Promise((r) => setTimeout(r, 400));
  } catch (err: any) {
    log(`ERROR: ${err?.stack ?? err}`);
    failed = true;
  } finally {
    log("stopping daemon");
    try { daemon.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    try { daemon.kill("SIGKILL"); } catch {}
  }

  // Inspect the bridge log file for telltale pre-fix lines.
  const logPath = `${STATE_DIR}/agentbridge.log`;
  let autoDeniedNoUi = 0;
  let autoAccepted = 0;
  if (existsSync(logPath)) {
    const text = readFileSync(logPath, "utf-8");
    for (const line of text.split("\n")) {
      if (line.includes("auto-denied by ClaudeThread (no UI to approve)")) autoDeniedNoUi++;
      if (line.includes("auto-accepted item/")) autoAccepted++;
    }
  } else {
    log(`(no daemon log at ${logPath})`);
  }
  log(`Log scan: pre-fix-auto-denies=${autoDeniedNoUi}  post-fix-auto-accepts=${autoAccepted}`);

  const passed = threadReady && turnCompleted && echoSeen && autoDeniedNoUi === 0;
  log(passed ? "RESULT: PASSED ✅" : "RESULT: FAILED ❌");
  log(`  threadReady=${threadReady}  turnCompleted=${turnCompleted}  echoSeen=${echoSeen}  autoDeniedNoUi=${autoDeniedNoUi}`);
  process.exit(passed && !failed ? 0 : 1);
}

void main();
