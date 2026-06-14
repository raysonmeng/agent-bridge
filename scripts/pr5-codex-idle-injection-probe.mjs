#!/usr/bin/env bun
/**
 * PR5 Codex idle injection probe.
 *
 * This script intentionally drives the existing AgentBridge control protocol:
 * control WS -> claude_connect -> claude_to_codex -> CodexAdapter.injectMessage
 * -> app-server turn/start. It does not import private daemon internals.
 *
 * Default mode is observe-only. Any scenario that sends claude_to_codex requires
 * --confirm-inject and refuses to target the current cwd unless
 * --allow-current-cwd is provided.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONTROL_PORT = Number.parseInt(process.env.AGENTBRIDGE_CONTROL_PORT || "4502", 10);
const SCENARIOS = new Set(["observe", "success", "busy", "no-thread", "ws-down"]);

function usage() {
  return `Usage:
  bun scripts/pr5-codex-idle-injection-probe.mjs --scenario observe [--control-port 4502]
  bun scripts/pr5-codex-idle-injection-probe.mjs --scenario success --control-port 45xx --confirm-inject [--expected-cwd /tmp/pr5]

Scenarios:
  observe    Attach/read status only. No claude_to_codex injection.
  success    Require true idle: bridgeReady+tuiConnected+threadId+turnPhase=idle, then inject and wait for:
             claude_to_codex_result(success), turn_started ACK, and system_turn_started message.
  busy       Require running/stalled turn; inject with onBusy=reject and expect busy_reject, no turn_started.
  no-thread  Require no usable thread/readiness; expect no_thread, no turn_started.
  ws-down    Require TUI/bridge not ready; expect no_thread, no turn_started.

Safety:
  Non-observe scenarios require --confirm-inject.
  The script refuses status.cwd === process.cwd() unless --allow-current-cwd is set.
  It refuses to replace a live attached Claude frontend unless --replace-incumbent is set.

Options:
  --control-port <port>       Daemon control port. Default: AGENTBRIDGE_CONTROL_PORT or 4502.
  --state-dir <path>          Pair state dir. Default: /healthz status.stateDir.
  --expected-cwd <path>       Refuse if daemon status.cwd differs.
  --message <text>            Probe message for success scenario.
  --timeout-ms <ms>           Overall wait timeout per awaited event. Default: ${DEFAULT_TIMEOUT_MS}.
  --idempotency-key <key>     Optional idempotency key. Default: pr5-<scenario>-<timestamp>.
  --confirm-inject            Required for success/busy/no-thread/ws-down.
  --allow-current-cwd         Allow targeting the process cwd.
  --replace-incumbent         Allow attaching when probe_incumbent reports a live Claude frontend.
  --json                      Print machine-readable JSON summary.
  --help                      Show this help.
`;
}

function parseArgs(argv) {
  const opts = {
    scenario: "observe",
    controlPort: DEFAULT_CONTROL_PORT,
    stateDir: null,
    expectedCwd: null,
    message: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    idempotencyKey: null,
    confirmInject: false,
    allowCurrentCwd: false,
    replaceIncumbent: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    switch (arg) {
      case "--scenario":
        opts.scenario = next();
        break;
      case "--control-port":
        opts.controlPort = Number.parseInt(next(), 10);
        break;
      case "--state-dir":
        opts.stateDir = next();
        break;
      case "--expected-cwd":
        opts.expectedCwd = next();
        break;
      case "--message":
        opts.message = next();
        break;
      case "--timeout-ms":
        opts.timeoutMs = Number.parseInt(next(), 10);
        break;
      case "--idempotency-key":
        opts.idempotencyKey = next();
        break;
      case "--confirm-inject":
        opts.confirmInject = true;
        break;
      case "--allow-current-cwd":
        opts.allowCurrentCwd = true;
        break;
      case "--replace-incumbent":
        opts.replaceIncumbent = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!SCENARIOS.has(opts.scenario)) {
    throw new Error(`Invalid --scenario ${opts.scenario}; expected one of ${[...SCENARIOS].join(", ")}`);
  }
  if (!Number.isInteger(opts.controlPort) || opts.controlPort <= 0) {
    throw new Error(`Invalid --control-port ${opts.controlPort}`);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms ${opts.timeoutMs}`);
  }
  return opts;
}

function samePath(a, b) {
  return resolve(a) === resolve(b);
}

function readToken(stateDir) {
  const path = join(stateDir, "control-token");
  if (!existsSync(path)) return null;
  const token = readFileSync(path, "utf-8").trim();
  return token.length > 0 ? token : null;
}

async function fetchStatus(controlPort, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${controlPort}/healthz`, { signal: controller.signal });
    if (!response.ok) throw new Error(`/healthz returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class ControlProbe {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.messages = [];
    this.waiters = [];
    this.closed = null;
  }

  async connect() {
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable; run with Bun or a Node version that provides WebSocket.");
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, this.timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${this.url}`));
      };
      ws.onclose = (event) => {
        clearTimeout(timer);
        this.closed = { code: event.code, reason: event.reason };
        this.rejectAll(new Error(`WebSocket closed (${event.code} ${event.reason || "no reason"})`));
      };
      ws.onmessage = (event) => this.onMessage(event.data);
    });
  }

  onMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      parsed = { type: "unparseable", raw: String(raw) };
    }
    this.messages.push(parsed);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(parsed)) continue;
      waiter.resolve(parsed);
      this.removeWaiter(waiter);
    }
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Control WebSocket is not OPEN");
    }
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, label, timeoutMs = this.timeoutMs) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.closed) {
      return Promise.reject(new Error(`Cannot wait for ${label}; socket already closed (${this.closed.code})`));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async maybeWaitFor(predicate, timeoutMs) {
    try {
      return await this.waitFor(predicate, "optional event", timeoutMs);
    } catch {
      return null;
    }
  }

  removeWaiter(waiter) {
    clearTimeout(waiter.timer);
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }

  rejectAll(error) {
    for (const waiter of [...this.waiters]) {
      waiter.reject(error);
      this.removeWaiter(waiter);
    }
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

function buildIdentity(status, stateDir) {
  const token = readToken(stateDir);
  const identity = {
    pairId: status.pairId ?? null,
    pairName: null,
    cwd: status.cwd ?? undefined,
    stateDir,
    clientPid: process.pid,
    contractVersion: status.build?.contractVersion,
  };
  if (token) identity.controlToken = token;
  return identity;
}

function assertPreconditions(opts, status) {
  const phase = status.turnPhase || (status.turnInProgress ? "running" : "idle");
  const hasThread = typeof status.threadId === "string" && status.threadId.length > 0;
  const ready = status.bridgeReady === true;
  const tuiConnected = status.tuiConnected === true;

  if (opts.scenario === "success") {
    if (!ready || !tuiConnected || !hasThread || phase !== "idle") {
      throw new Error(
        `success scenario requires bridgeReady=true, tuiConnected=true, threadId present, turnPhase=idle; got ` +
          `bridgeReady=${ready} tuiConnected=${tuiConnected} threadId=${status.threadId ?? "null"} turnPhase=${phase}`,
      );
    }
    return;
  }

  if (opts.scenario === "busy") {
    if (!(phase === "running" || phase === "stalled" || status.turnInProgress === true)) {
      throw new Error(`busy scenario requires an active turn; got turnPhase=${phase}`);
    }
    return;
  }

  if (opts.scenario === "no-thread") {
    if (ready && hasThread) {
      throw new Error("no-thread scenario requires missing threadId or bridgeReady=false");
    }
    return;
  }

  if (opts.scenario === "ws-down") {
    if (ready && tuiConnected) {
      throw new Error("ws-down scenario requires bridgeReady=false or tuiConnected=false");
    }
  }
}

function makeProbeMessage(opts) {
  return opts.message ||
    "[PR5 idle injection probe] This is an isolated AgentBridge wakeup test. Reply exactly: PR5_IDLE_WAKEUP_OK";
}

function summarizeStatus(status) {
  return {
    bridgeReady: status.bridgeReady,
    tuiConnected: status.tuiConnected,
    threadId: status.threadId ?? null,
    turnPhase: status.turnPhase ?? null,
    turnInProgress: status.turnInProgress ?? null,
    cwd: status.cwd ?? null,
    pairId: status.pairId ?? null,
    stateDir: status.stateDir ?? null,
    controlContractVersion: status.build?.contractVersion ?? null,
  };
}

function print(opts, message, data = undefined) {
  if (opts.json) return;
  if (data === undefined) {
    console.log(message);
  } else {
    console.log(`${message} ${JSON.stringify(data)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  if (opts.scenario !== "observe" && !opts.confirmInject) {
    throw new Error(`--scenario ${opts.scenario} sends claude_to_codex; pass --confirm-inject to proceed`);
  }

  const initialStatus = await fetchStatus(opts.controlPort, Math.min(opts.timeoutMs, 5000));
  const stateDir = opts.stateDir || initialStatus.stateDir;
  if (!stateDir) throw new Error("No state dir available; pass --state-dir or use a daemon that reports status.stateDir");

  if (opts.expectedCwd && (!initialStatus.cwd || !samePath(initialStatus.cwd, opts.expectedCwd))) {
    throw new Error(`Daemon cwd mismatch: expected ${resolve(opts.expectedCwd)}, got ${initialStatus.cwd ?? "<none>"}`);
  }

  if (!opts.allowCurrentCwd && initialStatus.cwd && samePath(initialStatus.cwd, process.cwd())) {
    throw new Error(
      `Refusing to target current cwd (${initialStatus.cwd}). Run from a different directory or pass --allow-current-cwd for an isolated probe pair.`,
    );
  }

  const probe = new ControlProbe(`ws://127.0.0.1:${opts.controlPort}/ws`, opts.timeoutMs);
  await probe.connect();

  try {
    probe.send({ type: "probe_incumbent" });
    const incumbent = await probe.waitFor((m) => m.type === "incumbent_status", "incumbent_status", 5000);
    if (incumbent.connected && incumbent.alive && !opts.replaceIncumbent) {
      if (opts.scenario === "observe") {
        const summary = {
          ok: true,
          scenario: "observe",
          injected: false,
          attached: false,
          reason: "live Claude frontend already attached; observe mode did not contest it",
          incumbent,
          status: summarizeStatus(initialStatus),
        };
        if (opts.json) console.log(JSON.stringify(summary, null, 2));
        else print(opts, "[PR5] observe-only: live incumbent present; not attaching", summary);
        return;
      }
      throw new Error("A live Claude frontend is already attached; refusing to contest it without --replace-incumbent");
    }

    const identity = buildIdentity(initialStatus, stateDir);
    probe.send({ type: "claude_connect", identity });
    const attachedStatus = await probe.waitFor((m) => m.type === "status", "attach status", opts.timeoutMs);
    const status = attachedStatus.status;
    print(opts, "[PR5] attached status:", summarizeStatus(status));

    if (opts.scenario === "observe") {
      const summary = {
        ok: true,
        scenario: "observe",
        injected: false,
        incumbent,
        status: summarizeStatus(status),
      };
      if (opts.json) console.log(JSON.stringify(summary, null, 2));
      return;
    }

    assertPreconditions(opts, status);

    const requestId = `pr5-${opts.scenario}-${Date.now()}`;
    const idempotencyKey = opts.idempotencyKey || `pr5-${opts.scenario}-${Date.now()}`;
    const sentAt = Date.now();
    const resultP = probe.waitFor(
      (m) => m.type === "claude_to_codex_result" && m.requestId === requestId,
      "claude_to_codex_result",
      opts.timeoutMs,
    );

    probe.send({
      type: "claude_to_codex",
      requestId,
      message: {
        id: `pr5_msg_${Date.now()}`,
        source: "claude",
        content: makeProbeMessage(opts),
        timestamp: sentAt,
      },
      requireReply: false,
      onBusy: "reject",
      idempotencyKey,
    });

    const result = await resultP;

    if (opts.scenario === "success") {
      if (!result.success) {
        throw new Error(`Expected success but daemon returned ${JSON.stringify(result)}`);
      }
      const turnStartedAckP = probe.waitFor(
        (m) => m.type === "turn_started" && m.requestId === requestId,
        "turn_started ACK",
        opts.timeoutMs,
      );
      const rawTurnStartedP = probe.waitFor(
        (m) =>
          m.type === "codex_to_claude" &&
          typeof m.message?.id === "string" &&
          m.message.id.startsWith("system_turn_started_") &&
          (typeof m.message.timestamp !== "number" || m.message.timestamp >= sentAt - 1000),
        "system_turn_started bridge message",
        opts.timeoutMs,
      );
      const [turnStartedAck, rawTurnStarted] = await Promise.all([turnStartedAckP, rawTurnStartedP]);
      probe.send({ type: "status" });
      const after = await probe.waitFor(
        (m) => m.type === "status" && m !== attachedStatus,
        "post-injection status",
        opts.timeoutMs,
      );
      const summary = {
        ok: true,
        scenario: opts.scenario,
        classification: "fully_automatic_idle_wakeup",
        requestId,
        idempotencyKey,
        result,
        turnStartedAck,
        rawTurnStartedMessageId: rawTurnStarted.message?.id ?? null,
        before: summarizeStatus(status),
        after: summarizeStatus(after.status),
      };
      if (opts.json) console.log(JSON.stringify(summary, null, 2));
      else {
        print(opts, "[PASS] fully_automatic_idle_wakeup", {
          requestId,
          turnId: turnStartedAck.turnId,
          rawTurnStartedMessageId: rawTurnStarted.message?.id ?? null,
          after: summarizeStatus(after.status),
        });
      }
      return;
    }

    const expectedCode = opts.scenario === "busy" ? "busy_reject" : "no_thread";
    if (result.success || result.code !== expectedCode) {
      throw new Error(`Expected failure code ${expectedCode}, got ${JSON.stringify(result)}`);
    }

    const unexpectedAck = await probe.maybeWaitFor((m) => m.type === "turn_started" && m.requestId === requestId, 1500);
    if (unexpectedAck) {
      throw new Error(`Failure scenario unexpectedly produced turn_started: ${JSON.stringify(unexpectedAck)}`);
    }

    const summary = {
      ok: true,
      scenario: opts.scenario,
      classification: `expected_${expectedCode}`,
      requestId,
      idempotencyKey,
      result,
      before: summarizeStatus(status),
    };
    if (opts.json) console.log(JSON.stringify(summary, null, 2));
    else print(opts, `[PASS] ${opts.scenario} produced ${expectedCode} without turn_started`, { requestId });
  } finally {
    probe.close();
  }
}

main().catch((err) => {
  const payload = { ok: false, error: err?.message ?? String(err) };
  if (process.argv.includes("--json")) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(`[FAIL] ${payload.error}`);
  }
  process.exitCode = 1;
});
