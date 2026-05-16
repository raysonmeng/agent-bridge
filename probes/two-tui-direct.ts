#!/usr/bin/env bun
/**
 * Multi-TUI viability probe.
 *
 * Question: can two independent WebSocket clients connect directly to a
 * single `codex app-server` and each maintain their OWN stable thread —
 * simulating two separate Codex TUI windows talking to the same backend?
 *
 * Setup:
 *   1. Spawn a fresh `codex app-server` on an isolated port.
 *   2. Open WS A, initialize, thread/start → thread_A.
 *   3. Open WS B, initialize, thread/start → thread_B.
 *   4. Both fire `turn/start` with a tiny prompt at the same time.
 *   5. Watch for `thread/closed` notifications (the smoking gun for the
 *      silent-TUI-exit bug we saw with the bridge proxy's secondaries) and
 *      for turn completion on each side.
 *
 * Verdict:
 *   - PASS if both threadIds remain valid, no thread/closed for either,
 *     and both turns complete with assistant output containing the marker.
 *   - FAIL if either thread is closed, or either turn fails to complete.
 *
 * This is the empirical evidence underpinning the "Path B" decision —
 * pointing `agentbridge codex` straight at port 4500 is only safe if
 * codex-rs handles two independent TUI-like clients without complaint.
 *
 * Cost: two minimal-effort Codex turns against the configured model.
 */

import { spawn } from "node:child_process";

const APP_PORT = 4720;
const APP_URL = `ws://127.0.0.1:${APP_PORT}`;
const PROBE_CWD = "/tmp/agentbridge-two-tui-probe";
const PROMPT_A = "Reply with exactly the marker probeA-OK-3jf and nothing else.";
const PROMPT_B = "Reply with exactly the marker probeB-OK-9qx and nothing else.";

interface Client {
  name: string;
  prompt: string;
  marker: string;
  ws: WebSocket;
  ready: Promise<void>;
  threadId: string | null;
  turnDone: Promise<{ completed: boolean; closed: boolean; gotMarker: boolean }>;
  events: string[];
}

const startTs = Date.now();
function ms() { return Date.now() - startTs; }
function log(s: string) { process.stderr.write(`[${ms().toString().padStart(6)}ms] ${s}\n`); }

async function waitHealth(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`app-server /healthz not ready within ${timeoutMs}ms`);
}

function startClient(name: string, prompt: string, marker: string): Client {
  let resolveReady!: () => void;
  let resolveDone!: (v: { completed: boolean; closed: boolean; gotMarker: boolean }) => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const turnDone = new Promise<{ completed: boolean; closed: boolean; gotMarker: boolean }>((r) => (resolveDone = r));
  const events: string[] = [];
  let threadId: string | null = null;
  let nextId = 1;
  let completed = false;
  let closed = false;
  let gotMarker = false;

  const ws = new WebSocket(APP_URL);

  ws.onopen = async () => {
    // initialize
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: nextId++, method: "initialize",
      params: { clientInfo: { name: `probe-${name}`, version: "0.0.1" } },
    }));
  };

  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : (ev.data as Buffer).toString()); }
    catch { return; }
    const tag = m.method ?? (m.result ? "result" : (m.error ? "error" : "?"));
    events.push(`${ms()}ms ${tag}`);
    if (m.method && m.method !== "item/agentMessage/delta") {
      // log everything except the noisy delta stream
      const itemType = m.params?.item?.type ?? "";
      log(`[${name}] ${m.method}${itemType ? ` (${itemType})` : ""}`);
    }

    if (m.id && m.result && tag === "result") {
      // initialize response → start thread
      if (!threadId && m.id === 1) {
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id: nextId++, method: "thread/start",
          params: { cwd: PROBE_CWD, approvalPolicy: "never" },
        }));
        return;
      }
      // thread/start response → record threadId, mark ready
      if (!threadId && m.id === 2) {
        threadId = m.result?.thread?.id ?? null;
        log(`[${name}] threadId=${threadId}`);
        resolveReady();
        return;
      }
    }

    if (m.method === "thread/closed" && m.params?.threadId === threadId) {
      log(`[${name}] ⚠️ thread/closed (threadId=${threadId})`);
      closed = true;
      resolveDone({ completed, closed, gotMarker });
    }

    if (m.method === "turn/started" && m.params?.threadId === threadId) {
      log(`[${name}] turn/started`);
    }
    // item/* notifications are routed per-WS (each TUI has its own connection),
    // so we don't filter by threadId — we trust the WS isolation.
    if (m.method === "item/completed") {
      const item = m.params?.item;
      if (item?.type === "agentMessage") {
        const text = (item.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        if (text.includes(marker)) gotMarker = true;
        log(`[${name}] item/completed agentMessage (${text.length} chars): ${text.slice(0, 80)}`);
      }
    }
    if (m.method === "turn/completed" && m.params?.threadId === threadId) {
      completed = true;
      log(`[${name}] turn/completed`);
      resolveDone({ completed, closed, gotMarker });
    }
  };

  ws.onerror = (e: any) => log(`[${name}] WS error: ${e?.message ?? e}`);
  ws.onclose = (e) => log(`[${name}] WS closed code=${e.code}`);

  return { name, prompt, marker, ws, ready, get threadId() { return threadId; }, turnDone, events } as any;
}

function fireTurn(c: Client) {
  c.ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 100 + Math.floor(Math.random() * 1000), method: "turn/start",
    params: {
      threadId: c.threadId,
      input: [{ type: "text", text: c.prompt }],
      effort: "minimal",
    },
  }));
}

async function main() {
  // ensure cwd exists
  try { (await import("node:fs")).mkdirSync(PROBE_CWD, { recursive: true }); } catch {}

  log(`spawning codex app-server on ${APP_URL}`);
  const codex = spawn("codex", ["app-server", "--listen", APP_URL], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  codex.stderr.on("data", (b: Buffer) => process.stderr.write(`[codex] ${b}`));

  let failed = false;
  try {
    await waitHealth(APP_URL);
    log("/healthz ok, connecting two clients");

    const a = startClient("A", PROMPT_A, "probeA-OK-3jf");
    const b = startClient("B", PROMPT_B, "probeB-OK-9qx");

    await Promise.all([a.ready, b.ready]);
    log(`both threads ready: A=${a.threadId}  B=${b.threadId}  distinct=${a.threadId !== b.threadId}`);

    // small stagger to avoid same-millisecond storm; not strictly needed
    fireTurn(a);
    fireTurn(b);
    log("fired both turns");

    const [resA, resB] = await Promise.all([
      Promise.race([a.turnDone, new Promise<any>((_, rej) => setTimeout(() => rej(new Error("A timeout")), 120_000))]),
      Promise.race([b.turnDone, new Promise<any>((_, rej) => setTimeout(() => rej(new Error("B timeout")), 120_000))]),
    ]);

    log(`A: completed=${resA.completed} closed=${resA.closed} gotMarker=${resA.gotMarker}`);
    log(`B: completed=${resB.completed} closed=${resB.closed} gotMarker=${resB.gotMarker}`);

    const ok = a.threadId !== b.threadId
      && resA.completed && !resA.closed && resA.gotMarker
      && resB.completed && !resB.closed && resB.gotMarker;
    if (!ok) failed = true;
    log(failed ? "RESULT: FAILED ❌" : "RESULT: PASSED ✅ — codex app-server supports 2 independent TUI-like clients");

    a.ws.close(); b.ws.close();
  } catch (e: any) {
    log(`ERROR: ${e?.stack ?? e}`);
    failed = true;
  } finally {
    log("stopping codex app-server");
    try { codex.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    try { codex.kill("SIGKILL"); } catch {}
  }
  process.exit(failed ? 1 : 0);
}

void main();
