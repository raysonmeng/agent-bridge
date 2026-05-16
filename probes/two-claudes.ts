#!/usr/bin/env bun
/**
 * End-to-end probe: two simulated Claude clients on one daemon.
 *
 * Spawns the multi-Claude daemon on isolated ports + state dir, then opens
 * two control-port WebSockets pretending to be two Claude MCP instances.
 * Each registers a different chatId, gets its own Codex thread, and sends a
 * tiny turn concurrently. We check that:
 *
 *   1. Both `system_thread_ready` notifications arrive (provisioning OK).
 *   2. After firing `claude_to_codex` on both, both `turn/started` (or our
 *      proxy "system_turn_started") notifications arrive before either
 *      `turn/completed` — i.e. the daemon executes them in parallel.
 *   3. Each chat only receives its own thread's notifications.
 *
 * Cost: two minimal-effort turns against Codex's configured model.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const STATE_DIR = "/tmp/agentbridge-multi-probe";
const CTRL_PORT = 4702;
const CODEX_WS_PORT = 4700;
const CODEX_PROXY_PORT = 4701;
const CONTROL_URL = `ws://127.0.0.1:${CTRL_PORT}/ws`;

interface RecordedEvent {
  ts: number;
  chatId: string;
  method: string;
  content?: string;
}

const events: RecordedEvent[] = [];
const startTs = Date.now();

function elapsed() {
  return Date.now() - startTs;
}

function log(s: string) {
  process.stderr.write(`[${elapsed().toString().padStart(6)}ms] ${s}\n`);
}

async function waitHealthz(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CTRL_PORT}/readyz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`daemon did not become ready at /readyz within ${timeoutMs}ms`);
}

interface Claude {
  chatId: string;
  ws: WebSocket;
  ready: Promise<void>;
  threadId: Promise<string | null>;
  turnStarted: Promise<number>;
  turnCompleted: Promise<number>;
  agentMessages: string[];
}

function startClaude(chatId: string): Claude {
  let resolveReady!: () => void;
  let resolveThreadId!: (id: string | null) => void;
  let resolveStarted!: (ts: number) => void;
  let resolveCompleted!: (ts: number) => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const threadIdP = new Promise<string | null>((r) => (resolveThreadId = r));
  const turnStarted = new Promise<number>((r) => (resolveStarted = r));
  const turnCompleted = new Promise<number>((r) => (resolveCompleted = r));

  const ws = new WebSocket(CONTROL_URL);
  const agentMessages: string[] = [];

  ws.onopen = () => {
    log(`[${chatId}] WS open → claude_connect`);
    ws.send(JSON.stringify({ type: "claude_connect", chatId }));
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : (ev.data as Buffer).toString());
    } catch {
      return;
    }
    if (msg.type === "codex_to_claude") {
      const content: string = msg.message?.content ?? "";
      const idPrefix = (msg.message?.id ?? "").split("_")[0] + "_" + ((msg.message?.id ?? "").split("_")[1] ?? "");
      events.push({ ts: elapsed(), chatId, method: idPrefix, content: content.slice(0, 80) });
      log(`[${chatId}] codex_to_claude id=${msg.message?.id} (${content.length} chars): ${content.slice(0, 60).replace(/\n/g, " ")}…`);
      if (content.startsWith("✅ Your Codex thread is ready")) {
        const match = content.match(/threadId=([0-9a-f-]+)\)/);
        resolveThreadId(match ? match[1] : null);
        resolveReady();
      }
      if (content.startsWith("⏳ Codex is working")) resolveStarted(elapsed());
      if (content.startsWith("✅ Codex finished")) resolveCompleted(elapsed());
      if (!content.startsWith("[STATUS") && !content.startsWith("⏳") && !content.startsWith("✅") && !content.startsWith("⚠️")) {
        agentMessages.push(content);
      }
    } else if (msg.type === "claude_to_codex_result") {
      log(`[${chatId}] claude_to_codex_result reqId=${msg.requestId} success=${msg.success}${msg.error ? " error=" + msg.error : ""}`);
    } else if (msg.type === "status") {
      // ignore for brevity
    }
  };
  ws.onerror = (e: any) => log(`[${chatId}] WS error: ${e?.message ?? e}`);
  ws.onclose = (e) => log(`[${chatId}] WS closed code=${e.code} reason=${e.reason || "-"}`);

  return { chatId, ws, ready, threadId: threadIdP, turnStarted, turnCompleted, agentMessages };
}

function sendTurn(c: Claude, text: string): Promise<void> {
  const reqId = `${c.chatId}_${Date.now()}`;
  c.ws.send(JSON.stringify({
    type: "claude_to_codex",
    requestId: reqId,
    chatId: c.chatId,
    message: {
      id: `${c.chatId}_msg`,
      source: "claude",
      content: text,
      timestamp: Date.now(),
    },
  }));
  return Promise.resolve();
}

async function main() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  // Spawn daemon directly via bun on the built bundle.
  const daemonJs = `${import.meta.dir}/../plugins/agentbridge/server/daemon.js`;
  const env = {
    ...process.env,
    AGENTBRIDGE_STATE_DIR: STATE_DIR,
    CODEX_WS_PORT: String(CODEX_WS_PORT),
    CODEX_PROXY_PORT: String(CODEX_PROXY_PORT),
    AGENTBRIDGE_CONTROL_PORT: String(CTRL_PORT),
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "300000",
  };

  log(`spawning daemon: bun ${daemonJs}`);
  const daemon = spawn("bun", [daemonJs], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stderr.on("data", (b: Buffer) => process.stderr.write(`[daemon] ${b}`));
  daemon.stdout.on("data", (b: Buffer) => process.stderr.write(`[daemon:out] ${b}`));
  daemon.on("exit", (code) => log(`daemon exited code=${code}`));

  let failed = false;
  try {
    await waitHealthz(45_000);
    log("daemon /readyz ok");

    const a = startClaude("probe_a");
    const b = startClaude("probe_b");

    log("waiting for both threads ready...");
    await Promise.all([a.ready, b.ready]);
    const [tidA, tidB] = await Promise.all([a.threadId, b.threadId]);
    log(`thread A=${tidA} / thread B=${tidB} (must differ)`);
    if (!tidA || !tidB || tidA === tidB) {
      log(`FAIL: thread IDs not distinct (${tidA} vs ${tidB})`);
      failed = true;
    }

    const fireAt = elapsed();
    log(`fire turn on both at ${fireAt}ms`);
    const prompt = "Reply with exactly the two characters OK and absolutely nothing else. No reasoning, no tool calls.";
    await Promise.all([sendTurn(a, prompt + " --A"), sendTurn(b, prompt + " --B")]);

    log("waiting for both turn completions (timeout 90s)...");
    const completedTimer = setTimeout(() => log("⏰ 90s timeout reached"), 90_000);
    try {
      const startedA = await Promise.race([a.turnStarted, new Promise<number>((_, rej) => setTimeout(() => rej(new Error("A turn never started")), 60_000))]);
      const startedB = await Promise.race([b.turnStarted, new Promise<number>((_, rej) => setTimeout(() => rej(new Error("B turn never started")), 60_000))]);
      const completedA = await Promise.race([a.turnCompleted, new Promise<number>((_, rej) => setTimeout(() => rej(new Error("A turn never completed")), 120_000))]);
      const completedB = await Promise.race([b.turnCompleted, new Promise<number>((_, rej) => setTimeout(() => rej(new Error("B turn never completed")), 120_000))]);

      log(`startedA=${startedA} startedB=${startedB} completedA=${completedA} completedB=${completedB}`);
      const maxStart = Math.max(startedA, startedB);
      const minComplete = Math.min(completedA, completedB);
      const verdict = maxStart < minComplete ? "PARALLEL ✅" : "SERIALIZED ❌";
      log(`Concurrency verdict: ${verdict}  (maxStart=${maxStart}ms < minComplete=${minComplete}ms ?)`);

      log(`A agentMessages: ${JSON.stringify(a.agentMessages)}`);
      log(`B agentMessages: ${JSON.stringify(b.agentMessages)}`);
      // Cross-leak check
      const aLeaked = a.agentMessages.some((m) => m.includes("--B"));
      const bLeaked = b.agentMessages.some((m) => m.includes("--A"));
      if (aLeaked || bLeaked) {
        log(`FAIL: cross-chat leakage detected (a got --B? ${aLeaked}, b got --A? ${bLeaked})`);
        failed = true;
      } else {
        log("Isolation: each chat only saw its own messages ✅");
      }
    } finally {
      clearTimeout(completedTimer);
    }

    // Close cleanly
    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 500));
  } catch (err: any) {
    log(`ERROR: ${err?.stack ?? err}`);
    failed = true;
  } finally {
    log("stopping daemon");
    try { daemon.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    try { daemon.kill("SIGKILL"); } catch {}
  }

  log("=== EVENT TRACE ===");
  for (const e of events) {
    log(`  +${e.ts}ms  [${e.chatId}]  ${e.method}  ${e.content ?? ""}`);
  }
  log(failed ? "RESULT: FAILED" : "RESULT: PASSED");
  process.exit(failed ? 1 : 0);
}

void main();
