import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import type { BridgeMessage } from "../types";
import type { ControlServerMessage, DaemonStatus } from "../control-protocol";
import { portsForSlot, type PairPorts } from "../pair-registry";
import { readControlToken, resolveControlTokenPath } from "../control-token";
import { CONTRACT_VERSION } from "../contract-version";
import { installFakeCodex } from "./fixtures/fake-codex-install";
import { RESUME_PROMPT, claudeResumePrompt } from "../budget/resume-prompt";

const DAEMON_PATH = join(process.cwd(), "src", "daemon.ts");
const DEFAULT_TEST_SLOT_START = 2500 + (process.pid % 500);
const DIAGNOSTIC_TAIL_CHARS = 4000;

interface Harness {
  root: string;
  cwd: string;
  stateDir: string;
  binDir: string;
  commandFile: string;
  appPort: number;
  proxyPort: number;
  controlPort: number;
  slot: number;
  daemon: ChildProcess;
  messages: BridgeMessage[];
  statusMessages: ControlServerMessage[];
  close: () => Promise<void>;
  sendAppCommand: (command: string) => void;
  attachClaude: () => Promise<void>;
  /** Control socket from attachClaude (for sending claude_to_codex etc.). */
  controlWs: WebSocket | null;
  /** Connect a fake Codex TUI to the proxy and complete the thread/start handshake. */
  connectTui: () => Promise<void>;
  sendClaudeToCodex: (
    requestId: string,
    text: string,
    opts?: { onBusy?: "reject" | "steer" | "interrupt"; requireReply?: boolean; idempotencyKey?: string; wrapUp?: boolean },
  ) => void;
  /** Send an ack_resume control message over the attached control socket (PR4). */
  sendAckResume: (resumeId: string, status: string) => void;
}

const harnesses: Harness[] = [];

describe("daemon wiring", () => {
  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop()!;
      await harness.close();
    }
  });

  test("local joins announce profiles to Claude, Codex and other native agents", async () => {
    const h = await startHarness({ pairId: "main-localjoins", pairName: "main" });
    const identity = { pairId: "main-localjoins", cwd: h.cwd, controlToken: readControlToken(resolveControlTokenPath(h.stateDir)), contractVersion: CONTRACT_VERSION };
    const received: any[] = [];
    const native = await connectControlSocket(h.controlPort);
    native.onmessage = event => { const m = JSON.parse(String(event.data)); received.push(m);
      if (m.type === "agy_message") native.send(JSON.stringify({ type: "agy_ack", deliveryId: m.deliveryId, accepted: true })); };
    try {
      native.send(JSON.stringify({ type: "agy_attach", routingVersion: 2, identity, conversationId: "ab9da612-66aa-4195-91ba-881369f93e8b", profile: { name: "Local A", model: "model-a", modelSource: "configured" } }));
      await waitFor(() => received.some(m => m.success), "native attached");
      await h.attachClaude(); await h.connectTui();
      await waitFor(() => received.filter(m => m.kind === "notice").length === 2, "Claude and Codex joins reached native");
      expect(received.filter(m => m.kind === "notice").every(m => m.from === "daemon")).toBe(true);
      await waitFor(() => h.messages.some(m => m.content.includes('"id":"codex"')), "Codex join reached Claude");
      native.send(JSON.stringify({ type: "local_chat_members", requestId: "roster", identity }));
      await waitFor(() => received.some(m => m.requestId === "roster"), "roster collected");
      const agents = received.find(m => m.requestId === "roster").agents;
      expect(agents.map((a: any) => a.id).sort()).toEqual(["agy:ab9da612-66aa-4195-91ba-881369f93e8b", "claude", "codex"]);
      expect(agents[0]).toMatchObject({ name: "Local A", model: "model-a", modelSource: "configured" });
      const other = await connectControlSocket(h.controlPort);
      try {
        other.send(JSON.stringify({ type: "agy_attach", routingVersion: 2, identity, conversationId: "c647e404-6a5c-4eca-aae9-ff62ca5e4b5b", profile: { name: "Local B", model: "model-b", modelSource: "configured" } }));
        await waitFor(() => received.some(m => m.kind === "notice" && m.text.includes("Local B")), "new native reaches other native");
        await waitFor(() => h.messages.some(m => m.content.includes("Local B")), "new native reaches Claude");
        await waitFor(() => readFileSync(join(h.stateDir, "agentbridge.log"), "utf8").includes("Codex room inbox: submitted"), "join notice queued into native Codex");
      } finally { other.close(); }
    } finally { native.close(); }
  }, 20000);

  test("explicit policy rejects unaddressed Claude bodies and never forwards normal Codex output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abg-explicit-policy-"));
    const turnLog = join(dir, "turns.jsonl");
    try {
      const h = await startHarness({ pairId: "main-explicitpolicy", pairName: "main", extraEnv: { FAKE_APP_TURNSTART_LOG: turnLog } });
      await h.attachClaude(); await h.connectTui();
      const result = (id: string) => h.statusMessages.find(m => m.type === "claude_to_codex_result" && m.requestId === id) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }> | undefined;
      h.controlWs!.send(JSON.stringify({ type: "claude_to_codex", requestId: "missing-to",
        message: { id: "missing-to", source: "claude", content: "ordinary body must not reach Codex", timestamp: Date.now() } }));
      await waitFor(() => !!result("missing-to"), "unaddressed body rejected");
      expect(result("missing-to")!.success).toBe(false);
      expect(existsSync(turnLog) ? readFileSync(turnLog, "utf8").trim() : "").toBe("");
      // These removed protocols must fail before injection, not silently degrade.
      for (const [index, control] of [{ onBusy: "steer" }, { onBusy: "interrupt" }, { requireReply: true }, { wrapUp: true }, { idempotencyKey: "legacy-key" }].entries()) {
        const id = `unsupported-${index}`;
        h.controlWs!.send(JSON.stringify({ type: "claude_to_codex", requestId: id,
          message: { id, source: "claude", to: "codex", content: "must not inject", timestamp: Date.now() }, ...control }));
        await waitFor(() => !!result(id), "legacy control rejected");
        expect(result(id)!.success).toBe(false);
        expect(result(id)!.error).toContain("Legacy turn controls");
      }
      expect(existsSync(turnLog) ? readFileSync(turnLog, "utf8").trim() : "").toBe("");
      h.sendAppCommand("agent-message:[IMPORTANT] ordinary output must remain private");
      const logs = () => readFileSync(join(h.stateDir, "agentbridge.log"), "utf8");
      await waitFor(() => logs().includes("Agent message completed"), "ordinary output processed");
      expect(h.messages.some(m => m.content.includes("ordinary output must remain private"))).toBe(false);
      h.controlWs!.send(JSON.stringify({ type: "claude_to_codex", requestId: "explicit-send",
        message: { id: "explicit-send", source: "claude", to: "codex", content: "explicit question", timestamp: Date.now() } }));
      await waitFor(() => !!result("explicit-send"), "explicit message accepted");
      expect(result("explicit-send")!.success).toBe(true);
      await waitFor(() => existsSync(turnLog) && readFileSync(turnLog, "utf8").includes("explicit question"), "explicit input injected");
      const injection = readFileSync(turnLog, "utf8");
      expect(injection).toContain('to=\\"claude\\"');
      expect(injection).toContain("in_reply_to=");
      h.sendAppCommand("agent-message:normal answer to correlated local request");
      await waitFor(() => (logs().match(/Agent message completed/g) ?? []).length >= 2, "correlated normal output processed");
      expect(h.messages.some(m => m.content.includes("normal answer to correlated local request"))).toBe(false);
      const status = await (await fetch(`http://127.0.0.1:${h.controlPort}/healthz`)).json() as DaemonStatus;
      expect(status.localChatVersion).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);

  test("CSWSH guard: a WS upgrade carrying an Origin header is 403'd on BOTH the control and proxy ports, while no-Origin clients still connect", async () => {
    const harness = await startHarness({ pairId: "main-cswshabcd", pairName: "main" });

    // The no-Origin legit path must still work: attachClaude uses the Bun global
    // WebSocket (control /ws) and connectTui uses it against the proxy. Both send
    // no Origin and must succeed through the guard.
    await harness.attachClaude();
    await harness.connectTui();
    expect(harness.controlWs?.readyState).toBe(WebSocket.OPEN);

    // A browser-style upgrade (Origin present) must be rejected with 403 — never
    // upgraded — on the control port (CSWSH against turn injection + readback)…
    const controlStatus = await rawUpgradeStatus(harness.controlPort, "/ws", "http://evil.example");
    expect(controlStatus).toContain("403");
    expect(controlStatus).not.toContain("101");

    // …and on the Codex proxy port (CSWSH against the Codex TUI relay).
    const proxyStatus = await rawUpgradeStatus(harness.proxyPort, "/", "http://evil.example");
    expect(proxyStatus).toContain("403");
    expect(proxyStatus).not.toContain("101");

    // /healthz is a plain GET, not an upgrade — the guard must not break it.
    const healthz = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
    expect(healthz.status).toBe(200);
  }, 25000);

  test("waiting notice uses pair-aware waiting message formatting", async () => {
    const harness = await startHarness({ pairId: "main-testabcd", pairName: "main" });

    await harness.attachClaude();

    const waiting = await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_waiting_"),
      "system_waiting message",
    );

    expect(waiting.content).toContain("Waiting for Codex TUI");
    expect(waiting.content).toContain(`cwd=${harness.cwd}`);
    expect(waiting.content).toContain("pair=main");
    expect(waiting.content).toContain("pairId=main-testabcd");
    expect(waiting.content).toContain(`slot=${harness.slot}`);
    expect(waiting.content).toContain(`proxy=ws://127.0.0.1:${harness.proxyPort}`);
    expect(waiting.content).toContain("different cwd");
    expect(waiting.content).toContain("another pair");
  }, 20000);

  test("turnAborted event emits system_turn_aborted to the attached Claude client", async () => {
    const harness = await startHarness({ pairId: "main-abortabcd", pairName: "main" });

    await harness.attachClaude();
    await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_waiting_"),
      "initial system_waiting message",
    );

    harness.sendAppCommand("start-turn");
    await sleep(100);
    harness.sendAppCommand("close-app-server");

    const aborted = await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_turn_aborted_"),
      "system_turn_aborted message",
    );

    expect(aborted.content).toContain("ended without completing");
    expect(aborted.content).toContain("app-server connection closed");
    expect(aborted.content).toContain("retry");
  }, 20000);

  // --- Regression: codex 'exit' during a boot retry must NOT warn (S1 fix) ---
  //
  // The teardown-on-failed-start fix SIGKILLs a partially-constructed codex child,
  // which fires the daemon's codex.on("exit") DURING bootCodex's retry loop (before
  // codexBootstrapped flips true). The pre-fix handler emitted the misleading
  // "⚠️ Codex app-server exited … restart it manually" warning unconditionally even
  // though the very next retry brought Codex up cleanly. The gate
  // (`if (wasBootstrapped) emit(system_codex_exit)`) must suppress that warning.
  //
  // Driven end-to-end: the fail-first fixture refuses the FIRST WS upgrade so
  // start() rejects → cleanupAfterFailedStart SIGKILLs the child → codex 'exit'
  // with codexBootstrapped===false; the retry boots clean and the harness reaches
  // readyz-200. A pre-fix unconditional emit would have BUFFERED a system_codex_exit
  // before the (later) system_waiting, so it would flush to Claude on attach.
  test("codex 'exit' during a boot retry (codexBootstrapped=false) does NOT emit system_codex_exit", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-bootexit-fixture-"));
    const failCounter = join(fixtureRoot, "spawn-count.txt");
    try {
      const harness = await startHarness({
        pairId: "main-bootexit1",
        pairName: "main",
        extraEnv: {
          FAKE_CODEX_FAIL_FIRST_BOOT: failCounter,
          // Keep the self-exit watchdog comfortably above the 1s retry backoff so a
          // single failed attempt + retry boots well within the bootstrap deadline.
          AGENTBRIDGE_BOOTSTRAP_TIMEOUT_MS: "20000",
        },
      });

      // The harness only returns once readyz-200 with the spawned pid — i.e. the
      // RETRY succeeded after the first boot was killed. The fixture must have been
      // spawned at least twice (first failing, second clean).
      const spawnCount = Number(readFileSync(failCounter, "utf-8").trim());
      expect(spawnCount).toBeGreaterThanOrEqual(2);

      // Attach: the daemon flushes everything buffered during boot. The genuine
      // boot notice (system_waiting) must arrive; the misleading boot-retry death
      // warning (system_codex_exit) must NOT.
      await harness.attachClaude();
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_waiting_"),
        "system_waiting after a recovered boot retry",
      );
      // Give any (erroneously buffered) exit warning the same flush window to land.
      await sleep(200);
      expect(harness.messages.some((m) => m.id.startsWith("system_codex_exit"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  // --- Regression complement: a POST-bootstrap codex death MUST warn (S1 fix) ---
  //
  // The other half of the gate: once codexBootstrapped===true, a real Codex process
  // death IS a "restart it manually" situation, so the warning must still fire. This
  // proves the gate suppresses ONLY the boot-retry case, not every exit. The fixture
  // `exit-process` command makes the live app-server child truly exit after boot.
  test("codex 'exit' after a successful bootstrap (codexBootstrapped=true) DOES emit system_codex_exit", async () => {
    const harness = await startHarness({ pairId: "main-postexit1", pairName: "main" });

    await harness.attachClaude();
    await harness.connectTui();
    await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_waiting_"),
      "system_waiting after a clean boot",
    );

    // Kill the app-server PROCESS (not just the WS): codex.on("exit") fires with
    // codexBootstrapped===true → the genuine post-boot death warning.
    harness.sendAppCommand("exit-process");

    const exitWarning = await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_codex_exit"),
      "system_codex_exit after a post-bootstrap Codex death",
    );
    expect(exitWarning.content).toContain("Codex app-server exited");
    expect(exitWarning.content).toContain("agentbridge codex");
  }, 45000);

  test("budget pause gate: STOP directive, reply rejected, RESUME reopens", async () => {
    // Fixture probe driven by per-agent JSON files the test rewrites at runtime
    // (explicit AGENTBRIDGE_QUOTA_PROBE is exclusive — no fallback to real probes).
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const writeUsage = (agent: "claude" | "codex", gateUtil: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 600 },
          ],
        }),
      );
    };
    writeUsage("claude", 10);
    writeUsage("codex", 95); // trips the default pauseAt=90 on the coordinator's first poll
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budgetabcd",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
        },
      });

      await harness.attachClaude();
      await harness.connectTui();

      // Coordinator starts on codex "ready"; its immediate first poll sees codex ≥ 90.
      const stop = await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_budget_pause_"),
        "system_budget_pause directive",
      );
      expect(stop.content).toContain("暂停委派");
      expect(stop.content).toContain("checkpoint");

      // Gate closed: claude_to_codex is refused with the budget error.
      harness.sendClaudeToCodex("req-budget-1", "hello during pause");
      await waitFor(
        () =>
          harness.statusMessages.some(
            (m) => m.type === "claude_to_codex_result" && m.requestId === "req-budget-1",
          ),
        "claude_to_codex_result for req-budget-1",
      );
      const rejected = harness.statusMessages.find(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-budget-1",
      ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain("预算暂停（闸门关闭）");
      expect(rejected.error).toContain("checkpoint");

      // DaemonStatus.budget reflects the pause.
      const healthz = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
      const status = (await healthz.json()) as DaemonStatus;
      expect(status.budget?.paused).toBe(true);
      expect(status.budget?.phase).toBe("paused");

      // Drop the tripping side below resumeBelow → next poll (≤5s) resumes.
      writeUsage("codex", 5);
      await waitFor(
        () => harness.messages.some((message) => message.id.startsWith("system_budget_resume_")),
        "system_budget_resume directive",
        400, // 20s — generous margin over the 5s poll for slow CI machines
        50,
      );
      const resume = harness.messages.find((message) => message.id.startsWith("system_budget_resume_"))!;
      expect(resume.content).toContain("Codex 侧预算闸门解除");

      // Gate open again: the same injection now succeeds.
      harness.sendClaudeToCodex("req-budget-2", "hello after resume");
      await waitFor(
        () =>
          harness.statusMessages.some(
            (m) => m.type === "claude_to_codex_result" && m.requestId === "req-budget-2",
          ),
        "claude_to_codex_result for req-budget-2",
      );
      const accepted = harness.statusMessages.find(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-budget-2",
      ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(accepted.success).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  test("budget resume with guard pending and checkpoint injects a Codex resume turn", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-resume-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const turnStartLog = join(fixtureRoot, "turn-starts.jsonl");
    const guardStateDir = join(fixtureRoot, "budget-guard");
    const readTurnStarts = (): Array<Record<string, any>> =>
      existsSync(turnStartLog)
        ? readFileSync(turnStartLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
    const writeUsage = (agent: "claude" | "codex", gateUtil: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 600 },
          ],
        }),
      );
    };
    writeUsage("claude", 10);
    writeUsage("codex", 95);
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-resumeabc",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
          BUDGET_STATE_DIR: guardStateDir,
          FAKE_APP_TURNSTART_LOG: turnStartLog,
        },
      });

      mkdirSync(join(harness.cwd, ".agent"), { recursive: true });
      writeFileSync(join(harness.cwd, ".agent", "checkpoint.md"), "# Checkpoint\n## 下一步\n1. continue\n", "utf-8");
      mkdirSync(join(guardStateDir, "pending"), { recursive: true });
      writeFileSync(
        join(guardStateDir, "pending", "codex_scope.json"),
        JSON.stringify({
          status: "paused",
          agent: "codex",
          session_id: "sess-resume",
          cwd: harness.cwd,
          reset_epoch: Math.floor(Date.now() / 1000) + 600,
          util: 95,
          warn_util: 95,
          at: Math.floor(Date.now() / 1000),
        }),
        "utf-8",
      );

      await harness.attachClaude();
      await harness.connectTui();
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_budget_pause_"),
        "system_budget_pause before resume injection",
      );

      writeUsage("codex", 5);
      // While the gate was CLOSED + Codex idle, the v3 P3 checkpoint baton (M3b)
      // legitimately injects one turn before recovery — so the resume turn is no
      // longer guaranteed to be turn-start [0]. Match the RESUME turn explicitly.
      const findResume = () =>
        readTurnStarts().find((p) => typeof p.input?.[0]?.text === "string" && p.input[0].text.includes(RESUME_PROMPT));
      await waitFor(
        () => findResume() !== undefined,
        "resume turn/start after budget recovery",
        400,
        50,
      );

      const injected = findResume()!;
      expect(injected.threadId).toBe("thread-fake-1");
      expect(injected.input[0].text).toContain(RESUME_PROMPT);
      expect(injected.model).toBeUndefined();
      expect(injected.effort).toBeUndefined();
      expect(harness.statusMessages.some((m) => m.type === "turn_started")).toBe(false);

      await waitFor(
        () => existsSync(join(guardStateDir, "consumed")) && readdirSync(join(guardStateDir, "consumed")).length === 1,
        "resume consumed marker",
        80,
        50,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  // --- PR4: Claude-side auto-resume via a REAL daemon (mirrors the Codex E2E) ---
  //
  // Drives an end-to-end Claude recovery through the real daemon process: the
  // budget probe pauses the CLAUDE side (handoff), then refreshes it → the
  // coordinator's onResume("claude", …) calls the SHARED routeResume →
  // claudeResumeTracker.start → a `system_budget_resume_*` channel push carrying
  // the stable resumeId. The test then sends an `ack_resume` control message and
  // asserts the tracker resolved (no further re-push beyond the single delivery).
  test("Claude-side recovery pushes system_budget_resume with resumeId; ack_resume stops the re-push", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-claude-resume-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const writeUsage = (agent: "claude" | "codex", gateUtil: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 600 },
          ],
        }),
      );
    };
    writeUsage("claude", 95); // Claude-only trip → handoff (gate stays open)
    writeUsage("codex", 10);
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-clauderes",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
          // A compressed (but not razor-thin) ack window: long enough that the
          // ack control message round-trips before the first re-push timer could
          // fire (so the count we capture at ack time is stable), yet short
          // enough that a STILL-armed timer after the ack would fire inside the
          // post-ack wait below — turning a broken ack into a visible re-push.
          AGENTBRIDGE_RESUME_ACK_TIMEOUT_MS: "3000",
          AGENTBRIDGE_RESUME_ACK_RETRIES: "3",
        },
      });

      await harness.attachClaude();
      await harness.connectTui();

      // Claude side trips first → a handoff directive (NOT a pause), gate open.
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_budget_handoff_"),
        "system_budget_handoff before Claude recovery",
      );

      // Refresh the Claude window → next poll (≤5s) recovers it. The recovery
      // surfaces as BOTH the coordinator directive (system_budget_claude_recovered_*)
      // and the ack-tracker channel push (system_budget_resume_*, carrying resumeId).
      writeUsage("claude", 5);
      const isResumePush = (m: BridgeMessage) =>
        m.id.startsWith("system_budget_resume_") && typeof m.resumeId === "string";
      // Recovery fires on the NEXT coordinator poll (≤5s), so wait well past one
      // poll cycle — generous for slow CI (300 × 50ms = 15s).
      await waitFor(
        () => harness.messages.some(isResumePush),
        "Claude-side system_budget_resume channel push with resumeId",
        300,
        50,
      );
      const push = harness.messages.find(isResumePush)!;

      const resumeId = push.resumeId!;
      expect(resumeId.startsWith("system_budget_claude_recovered_")).toBe(true);
      // The push content carries the ack instruction (claudeResumePrompt), which
      // embeds the stable resumeId so Claude's echo correlates.
      expect(push.content).toBe(claudeResumePrompt(resumeId));
      expect(push.content).toContain(`ack_resume(resume_id="${resumeId}"`);

      // Record how many resume pushes (for THIS resumeId) we've seen so we can
      // prove the ack stops the loop rather than a later poll incidentally quieting.
      const pushesForResume = () =>
        harness.messages.filter(
          (m) => m.id.startsWith("system_budget_resume_") && m.resumeId === resumeId,
        );
      const countAtAck = pushesForResume().length;
      expect(countAtAck).toBeGreaterThanOrEqual(1);

      // Ack it via the control plane (exactly what the ack_resume MCP tool does).
      harness.sendAckResume(resumeId, "resumed");

      // After the ack, no further re-push for this resumeId may arrive — wait out
      // more than one full ack window (3000ms) to give a (wrongly) still-armed
      // timer time to fire.
      await sleep(4000);
      expect(pushesForResume().length).toBe(countAtAck);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("budget pause is visible without an attached Claude; STOP is buffered until attach", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-buffer-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const usage = (gateUtil: number) =>
      JSON.stringify({
        ok: true,
        util: gateUtil,
        warn_util: gateUtil,
        fetched_at: Math.floor(Date.now() / 1000),
        buckets: [
          { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 600 },
        ],
      });
    writeFileSync(join(fixtureRoot, "usage-claude.json"), usage(10));
    writeFileSync(join(fixtureRoot, "usage-codex.json"), usage(95));
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budgetbuf1",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
        },
      });

      // No attachClaude yet — only the TUI handshake, so the coordinator starts
      // and pauses while no Claude frontend is connected.
      await harness.connectTui();

      // Pause is observable via /healthz even with no Claude attached.
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.budget?.paused === true;
        } catch {
          return false;
        }
      }, "budget.paused visible on /healthz without attached Claude", 200, 100);

      // Attaching now must deliver the buffered STOP directive.
      await harness.attachClaude();
      const stop = await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_budget_pause_"),
        "buffered system_budget_pause after attach",
      );
      expect(stop.content).toContain("暂停委派");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  test("claude-side handoff keeps the gate OPEN; codex escalation closes it (v2.4)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-handoff-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const writeUsage = (agent: "claude" | "codex", gateUtil: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 600 },
          ],
        }),
      );
    };
    writeUsage("claude", 93); // Claude-only trigger → handoff, gate stays open
    writeUsage("codex", 10);
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budgethand",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
        },
      });

      await harness.attachClaude();
      await harness.connectTui();

      // Handoff directive (NOT the pause id) arrives on the first poll.
      const handoff = await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_budget_handoff_"),
        "system_budget_handoff directive",
      );
      expect(handoff.content).toContain("交接");

      // The baton reply goes THROUGH — gate is open for a Claude-only trigger.
      harness.sendClaudeToCodex("req-handoff-1", "baton: remaining tasks + acceptance criteria");
      await waitFor(
        () =>
          harness.statusMessages.some(
            (m) => m.type === "claude_to_codex_result" && m.requestId === "req-handoff-1",
          ),
        "claude_to_codex_result for req-handoff-1",
      );
      const baton = harness.statusMessages.find(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-handoff-1",
      ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(baton.success).toBe(true);

      // Snapshot: intervention active, gate open, side=claude.
      const healthz = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
      const status = (await healthz.json()) as DaemonStatus;
      expect(status.budget?.paused).toBe(true);
      expect(status.budget?.gateClosed).toBe(false);
      expect(status.budget?.pauseSide).toBe("claude");

      // Escalation: codex also trips → upgrade to joint pause, gate closes.
      writeUsage("codex", 95);
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const s = (await res.json()) as DaemonStatus;
          return s.budget?.gateClosed === true && s.budget?.pauseSide === "both";
        } catch {
          return false;
        }
      }, "escalation to joint pause (gateClosed + both)", 400, 50);

      harness.sendClaudeToCodex("req-handoff-2", "should be gated now");
      await waitFor(
        () =>
          harness.statusMessages.some(
            (m) => m.type === "claude_to_codex_result" && m.requestId === "req-handoff-2",
          ),
        "claude_to_codex_result for req-handoff-2",
      );
      const gated = harness.statusMessages.find(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-handoff-2",
      ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(gated.success).toBe(false);
      expect(gated.error).toContain("闸门关闭");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  test("codex tier overrides ride on turn/start and restore explicitly (P4/R5)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-tier-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const turnStartLog = join(fixtureRoot, "turn-starts.jsonl");
    const writeUsage = (agent: "claude" | "codex", gateUtil: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 7200 },
          ],
        }),
      );
    };
    writeUsage("claude", 10);
    // eco band (warnUtil ≥80) yet below pauseAt=90 (no pause) AND below
    // admissionAt=85 (no v3 P3 admission-closed gate) — so the tier-override turn
    // still injects. (85 would now trip admission-closed and block the turn.)
    writeUsage("codex", 82);
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    const readTurnStarts = (): Array<Record<string, unknown>> => {
      if (!existsSync(turnStartLog)) return [];
      return readFileSync(turnStartLog, "utf-8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    };

    try {
      const harness = await startHarness({
        pairId: "main-budgettier",
        pairName: "main",
        projectConfig: {
          version: "1.0",
          budget: {
            codexTierControl: true,
            codexTiers: { full: { effort: "high" } }, // explicit restore point activates control
          },
        },
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
          FAKE_APP_TURNSTART_LOG: turnStartLog,
          FAKE_APP_NOTIFY_TURNSTART: "1",
        },
      });

      await harness.attachClaude();
      await harness.connectTui();

      // Wait until the coordinator's first poll computed the eco tier.
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.budget?.codexTier === "eco";
        } catch {
          return false;
        }
      }, "codexTier=eco on /healthz", 200, 100);

      // Injection 1 carries the eco override (default mapping effort=low).
      harness.sendClaudeToCodex("req-tier-1", "task under eco tier");
      await waitFor(() => readTurnStarts().length >= 1, "first recorded turn/start", 100, 100);
      const first = readTurnStarts()[0]!;
      expect(first.effort).toBe("low");

      harness.sendAppCommand("complete-turn");
      // Tier returns to full → explicit restore override on the next injection.
      writeUsage("codex", 10);
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.budget?.codexTier === "full";
        } catch {
          return false;
        }
      }, "codexTier back to full", 400, 50);
      harness.sendClaudeToCodex("req-tier-2", "task after restore");
      await waitFor(() => readTurnStarts().length >= 2, "second recorded turn/start", 100, 100);
      const second = readTurnStarts()[1]!;
      expect(second.effort).toBe("high"); // configured codexTiers.full restore value

      harness.sendAppCommand("complete-turn");
      // Pending consumed: a further injection carries NO override.
      harness.sendClaudeToCodex("req-tier-3", "steady state");
      await waitFor(() => readTurnStarts().length >= 3, "third recorded turn/start", 100, 100);
      const third = readTurnStarts()[2]!;
      expect(third.effort).toBeUndefined();
      expect(third.model).toBeUndefined();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("v3 P3 admission gate: addressed new turns rejected and legacy wrap-up cannot bypass", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-admission-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const turnStartLog = join(fixtureRoot, "turn-starts.jsonl");
    const writeUsage = (agent: "claude" | "codex", gateUtil: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            { id: "five_hour", util: gateUtil, reset_epoch: Math.floor(Date.now() / 1000) + 7200 },
          ],
        }),
      );
    };
    const readTurnStarts = (): Array<Record<string, unknown>> => {
      if (!existsSync(turnStartLog)) return [];
      return readFileSync(turnStartLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    };
    writeUsage("claude", 10);
    // 5h util 86 ≥ admissionAt(85) → admission-closed, yet < pauseAt(90) → NOT paused.
    writeUsage("codex", 86);
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budgetadm",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
          FAKE_APP_TURNSTART_LOG: turnStartLog,
        },
      });
      await harness.attachClaude();
      await harness.connectTui();

      // Wait until the coordinator's first poll computed gateState=admission-closed.
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.budget?.gateState === "admission-closed" && status.budget?.paused === false;
        } catch {
          return false;
        }
      }, "gateState=admission-closed on /healthz", 200, 100);

      // 1. A normal new turn is rejected with budget_admission (NOT budget_paused).
      harness.sendClaudeToCodex("req-adm-new", "start a new task");
      await waitFor(
        () => harness.statusMessages.some((m) => m.type === "claude_to_codex_result" && m.requestId === "req-adm-new"),
        "claude_to_codex_result for req-adm-new",
      );
      const rejected = harness.statusMessages.find(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-adm-new",
      ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(rejected.success).toBe(false);
      expect(rejected.code).toBe("budget_admission");
      expect(rejected.error).toContain("收尾保护");
      expect(readTurnStarts().length).toBe(0); // new task did NOT inject

      harness.sendClaudeToCodex("req-adm-wrap", "legacy wrap-up cannot bypass", { wrapUp: true });
      await waitFor(() => harness.statusMessages.some(m => m.type === "claude_to_codex_result" && m.requestId === "req-adm-wrap"), "wrap-up rejected");
      const wrap = harness.statusMessages.find(m => m.type === "claude_to_codex_result" && m.requestId === "req-adm-wrap") as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(wrap.success).toBe(false);
      expect(wrap.error).toContain("Legacy turn controls");
      expect(readTurnStarts()).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  test("v3 P3 admission gate: weekly-runway trigger (no fresh 5h) rejects addressed tasks", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-admweekly-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const turnStartLog = join(fixtureRoot, "turn-starts.jsonl");
    const now = Math.floor(Date.now() / 1000);
    const readTurnStarts = (): Array<Record<string, unknown>> => {
      if (!existsSync(turnStartLog)) return [];
      return readFileSync(turnStartLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    };
    // Claude idle. Codex: an EXPIRED 5h window (reset_epoch = now-100, > 0 yet past —
    // the round-4 case: a 5h-only ">0" key would mis-key here) plus a fresh weekly
    // that will-fill (util 70 + rate 30/h over 1h → 100 > targetUtil 98) with a short
    // runway (3000s < finishingHorizon 30m × 2 = 3600s) → admission-closed via the
    // weekly-runway trigger, while util 70 < pauseAt 90 keeps it OUT of pause. The
    // daemon must key the wrap-up quota on the FRESH weekly window, not the expired 5h.
    writeFileSync(join(fixtureRoot, "usage-claude.json"), JSON.stringify({
      ok: true, util: 10, warn_util: 10, fetched_at: now,
      buckets: [{ id: "five_hour", util: 10, reset_epoch: now + 7200 }],
    }));
    writeFileSync(join(fixtureRoot, "usage-codex.json"), JSON.stringify({
      ok: true, util: 70, warn_util: 70, fetched_at: now,
      buckets: [
        { id: "five_hour", util: 70, reset_epoch: now - 100 },
        { id: "seven_day", util: 70, reset_epoch: now + 3600, burn_rate_pct_per_hour: 30, burn_confident: true, runway_seconds: 3000 },
      ],
    }));
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budgetadmwk",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
          FAKE_APP_TURNSTART_LOG: turnStartLog,
        },
      });
      await harness.attachClaude();
      await harness.connectTui();

      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.budget?.gateState === "admission-closed" && status.budget?.paused === false;
        } catch {
          return false;
        }
      }, "gateState=admission-closed (weekly trigger) on /healthz", 200, 100);

      harness.sendClaudeToCodex("req-admwk", "new work under weekly-triggered admission");
      await waitFor(() => harness.statusMessages.some(m => m.type === "claude_to_codex_result" && m.requestId === "req-admwk"), "weekly admission rejection");
      const result = harness.statusMessages.find(m => m.type === "claude_to_codex_result" && m.requestId === "req-admwk") as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
      expect(result.success).toBe(false);
      expect(result.code).toBe("budget_admission");
      expect(readTurnStarts()).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  test("v3 P3 (M3b): closed gate fires the checkpoint baton ONCE per window when Codex is idle", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-baton-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const turnStartLog = join(fixtureRoot, "turn-starts.jsonl");
    const now = Math.floor(Date.now() / 1000);
    const readTurnStarts = (): Array<Record<string, unknown>> => {
      if (!existsSync(turnStartLog)) return [];
      return readFileSync(turnStartLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    };
    // A baton turn carries the system-initiated marker in its input text.
    const batonStarts = () =>
      readTurnStarts().filter((p) => {
        const input = (p.input as Array<{ text?: string }> | undefined) ?? [];
        return input.some((i) => typeof i.text === "string" && i.text.includes("系统发起"));
      });
    writeFileSync(join(fixtureRoot, "usage-claude.json"), JSON.stringify({
      ok: true, util: 10, warn_util: 10, fetched_at: now,
      buckets: [{ id: "five_hour", util: 10, reset_epoch: now + 7200 }],
    }));
    // Codex 5h util 95 ≥ pauseAt(90) → fully CLOSED (not just admission-closed).
    writeFileSync(join(fixtureRoot, "usage-codex.json"), JSON.stringify({
      ok: true, util: 95, warn_util: 95, fetched_at: now,
      buckets: [{ id: "five_hour", util: 95, reset_epoch: now + 7200 }],
    }));
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budgetbaton",
        pairName: "main",
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          // 5s poll (the config minimum) so the once-per-window assertion below can
          // OBSERVE a SECOND poll cycle (onSnapshot → maybeFireCheckpointBaton) — the
          // poll where a regressed dedup would re-fire the baton.
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "5",
          FAKE_APP_TURNSTART_LOG: turnStartLog,
        },
      });
      await harness.attachClaude();
      await harness.connectTui();

      // Gate closes on the first poll; the onSnapshot edge fires the baton while
      // Codex is idle (the fake app-server never emits turn/started, so the baton's
      // turn/start cannot re-arm a turn or re-trigger the listener).
      await waitFor(() => batonStarts().length >= 1, "checkpoint baton injected once", 200, 100);
      const quotaFile = join(harness.stateDir, "admission-quota.json");
      await waitFor(() => existsSync(quotaFile), "admission-quota.json persisted (baton)", 100, 100);
      const quota = JSON.parse(readFileSync(quotaFile, "utf-8"));
      expect(quota.checkpointBatonUsed).toBe(true);
      expect(quota.fiveHourResetEpoch).toBe(now + 7200);

      // ONCE per window across MULTIPLE polls: require the coordinator to have polled
      // (each onSnapshot calls maybeFireCheckpointBaton) at least 2 MORE times after
      // the baton fired — distinct budget.updatedAt values prove distinct poll cycles.
      // If the once-per-window dedup regressed (consumeCheckpointBaton always-true),
      // the baton would re-fire on those polls and the count would exceed 1. (The
      // earlier 5s-poll version returned before a 2nd poll and was vacuous on this axis.)
      const seenUpdatedAt = new Set<number>();
      await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
        if (!res.ok) return false;
        const status = (await res.json()) as DaemonStatus;
        if (status.budget?.gateState !== "closed") return false;
        if (typeof status.budget.updatedAt === "number") seenUpdatedAt.add(status.budget.updatedAt);
        return seenUpdatedAt.size >= 2; // the firing poll + ≥1 further poll cycle
      }, "≥2 closed-gate budget poll cycles observed", 200, 100);
      expect(batonStarts().length).toBe(1);
      // The baton instructs Codex to write .agent/checkpoint.md.
      const input = (batonStarts()[0]!.input as Array<{ text?: string }>);
      expect(input[0]!.text).toContain(".agent/checkpoint.md");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 45000);

  test("budget status broadcasts follow coordinator snapshot polls, not the daemon interval", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-budget-snapshot-fixture-"));
    const probePath = join(fixtureRoot, "probe.sh");
    const writeUsage = (agent: "claude" | "codex", gateUtil: number, resetOffsetSec: number) => {
      writeFileSync(
        join(fixtureRoot, `usage-${agent}.json`),
        JSON.stringify({
          ok: true,
          util: gateUtil,
          warn_util: gateUtil,
          fetched_at: Math.floor(Date.now() / 1000),
          buckets: [
            {
              id: "five_hour",
              util: gateUtil,
              reset_epoch: Math.floor(Date.now() / 1000) + resetOffsetSec,
            },
          ],
        }),
      );
    };
    const writeBoth = (gateUtil: number, resetOffsetSec: number) => {
      writeUsage("claude", gateUtil, resetOffsetSec);
      writeUsage("codex", gateUtil, resetOffsetSec);
    };
    writeBoth(10, 1);
    writeFileSync(probePath, `#!/bin/sh\ncat "${fixtureRoot}/usage-$2.json"\n`, "utf-8");
    chmodSync(probePath, 0o755);

    try {
      const harness = await startHarness({
        pairId: "main-budsnap1",
        pairName: "main",
        projectConfig: {
          version: "1.0",
          budget: {
            codexTierControl: true,
            codexTiers: { full: { effort: "high" } },
          },
        },
        extraEnv: {
          AGENTBRIDGE_BUDGET_ENABLED: "1",
          AGENTBRIDGE_QUOTA_PROBE: probePath,
          AGENTBRIDGE_BUDGET_POLL_SECONDS: "300",
        },
      });

      await harness.attachClaude();
      await harness.connectTui();

      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.budget?.codexTier === "full";
        } catch {
          return false;
        }
      }, "initial full budget snapshot", 100, 100);

      const statusCount = harness.statusMessages.length;
      writeBoth(85, 3600);

      await waitFor(
        () =>
          harness.statusMessages
            .slice(statusCount)
            .some((message) => message.type === "status" && message.status.budget?.codexTier === "eco"),
        "budget status broadcast from coordinator snapshot callback",
        140,
        100,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30000);

  test("attach guard: a NON-attached socket's claude_to_codex is rejected with not_attached, even with a valid token", async () => {
    const harness = await startHarness({ pairId: "main-attachgrd", pairName: "main" });

    // Legit frontend attaches + a ready thread exists, so the ONLY thing that can
    // reject the second socket below is the attach guard (not no_thread/busy).
    await harness.attachClaude();
    await harness.connectTui();

    // A SECOND control socket that connects to /ws but never wins the attach slot.
    // It even presents the correct capability token (so token admission would
    // pass) — proving the attach guard is an INDEPENDENT second layer: passing
    // the token gate is not sufficient to inject; you must also hold the slot.
    const intruder = await connectControlSocket(harness.controlPort);
    const intruderResults: ControlServerMessage[] = [];
    intruder.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      intruderResults.push(JSON.parse(raw) as ControlServerMessage);
    };

    // Deliberately do NOT send claude_connect on the intruder — it is an
    // unattached socket trying to inject a turn straight into Codex.
    intruder.send(JSON.stringify({
      type: "claude_to_codex",
      requestId: "req-intruder-1",
      message: { id: "req-intruder-1", source: "claude", content: "inject without attaching", timestamp: Date.now() },
    }));

    await waitFor(
      () => intruderResults.some(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-intruder-1",
      ),
      "claude_to_codex_result for the intruder socket",
    );
    const rejected = intruderResults.find(
      (m) => m.type === "claude_to_codex_result" && m.requestId === "req-intruder-1",
    ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
    expect(rejected.success).toBe(false);
    expect(rejected.code).toBe("not_attached");
    expect(rejected.error).toContain("not the attached Claude session");

    // The attached frontend's own reply on the SAME pair still works — the guard
    // does not misfire on the legitimate path (attachedClaude === its socket).
    harness.sendClaudeToCodex("req-legit-1", "legitimate reply from the attached session");
    await waitFor(
      () => harness.statusMessages.some(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-legit-1",
      ),
      "claude_to_codex_result for the attached session's reply",
    );
    const accepted = harness.statusMessages.find(
      (m) => m.type === "claude_to_codex_result" && m.requestId === "req-legit-1",
    ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
    expect(accepted.success).toBe(true);

    try { intruder.close(); } catch {}
  }, 30000);

  test("token gate: claude_connect with a WRONG control token is rejected and the socket is closed (4005)", async () => {
    const harness = await startHarness({ pairId: "main-tokengate", pairName: "main" });

    const ws = await connectControlSocket(harness.controlPort);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });

    // Present a SYNTACTICALLY valid identity (correct pair/cwd) but a bogus token —
    // a browser/foreign socket that cannot read the 0600 token file.
    ws.send(JSON.stringify({
      type: "claude_connect",
      identity: {
        pairId: "main-tokengate",
        pairName: "main",
        cwd: harness.cwd,
        stateDir: harness.stateDir,
        clientPid: process.pid,
        contractVersion: CONTRACT_VERSION,
        controlToken: "totally-wrong-token",
      },
    }));

    const result = await Promise.race([
      closed,
      sleep(4000).then(() => null),
    ]);
    expect(result).not.toBeNull();
    expect(result!.code).toBe(4005); // CLOSE_CODE_TOKEN_MISMATCH
    expect(result!.reason).toContain("token");

    // The daemon did NOT attach this socket: a follow-up status request from a
    // fresh, properly-tokened socket still reports no live frontend interference.
    // (The wrong-token socket is closed, so it cannot have become attachedClaude.)
    const healthz = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
    expect(healthz.ok).toBe(true);
  }, 30000);

  test("token gate: claude_connect MISSING the control token is rejected (4005)", async () => {
    const harness = await startHarness({ pairId: "main-tokenmiss", pairName: "main" });

    const ws = await connectControlSocket(harness.controlPort);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });

    // Correct pair/cwd but NO token at all (a pre-token client, or an attacker
    // who never read the file). The token-aware daemon rejects it.
    ws.send(JSON.stringify({
      type: "claude_connect",
      identity: {
        pairId: "main-tokenmiss",
        pairName: "main",
        cwd: harness.cwd,
        stateDir: harness.stateDir,
        clientPid: process.pid,
        contractVersion: CONTRACT_VERSION,
      },
    }));

    const result = await Promise.race([closed, sleep(4000).then(() => null)]);
    expect(result).not.toBeNull();
    expect(result!.code).toBe(4005);
    expect(result!.reason).toContain("missing control token");
  }, 30000);

  test("token gate: a correctly-tokened claude_connect attaches and can inject (end-to-end happy path)", async () => {
    const harness = await startHarness({ pairId: "main-tokenok12", pairName: "main" });

    // harness.attachClaude() reads the real token from the state dir and presents
    // it — the daemon admits it. Then a reply must flow through to a ready thread.
    await harness.attachClaude();
    await harness.connectTui();

    harness.sendClaudeToCodex("req-ok-1", "hello with a valid token");
    await waitFor(
      () => harness.statusMessages.some(
        (m) => m.type === "claude_to_codex_result" && m.requestId === "req-ok-1",
      ),
      "claude_to_codex_result for the tokened reply",
    );
    const accepted = harness.statusMessages.find(
      (m) => m.type === "claude_to_codex_result" && m.requestId === "req-ok-1",
    ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }>;
    expect(accepted.success).toBe(true);
  }, 30000);

  // --- Contract-version negotiation (arch-review P1 #303) ---

  test("contract gate: claude_connect with a MISMATCHED contractVersion is rejected and closed (4006)", async () => {
    const harness = await startHarness({ pairId: "main-contmism", pairName: "main" });

    const ws = await connectControlSocket(harness.controlPort);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });

    // Correct pair/cwd AND the correct capability token, so the ONLY thing the
    // daemon can reject is the contract version (proves 4006 is checked last and
    // is the deciding gate here, not 4004/4005).
    const controlToken = readControlToken(resolveControlTokenPath(harness.stateDir));
    ws.send(JSON.stringify({
      type: "claude_connect",
      identity: {
        pairId: "main-contmism",
        pairName: "main",
        cwd: harness.cwd,
        stateDir: harness.stateDir,
        clientPid: process.pid,
        contractVersion: CONTRACT_VERSION + 999, // deliberately incompatible
        ...(controlToken ? { controlToken } : {}),
      },
    }));

    const result = await Promise.race([closed, sleep(4000).then(() => null)]);
    expect(result).not.toBeNull();
    expect(result!.code).toBe(4006); // CLOSE_CODE_CONTRACT_MISMATCH
    expect(result!.reason).toContain("contract version mismatch");

    // The mismatched socket was NOT attached: the daemon still serves /healthz.
    const healthz = await fetch(`http://127.0.0.1:${harness.controlPort}/healthz`);
    expect(healthz.ok).toBe(true);
  }, 30000);

  test("contract gate: claude_connect MISSING contractVersion is rejected (4006)", async () => {
    const harness = await startHarness({ pairId: "main-contmiss", pairName: "main" });

    const ws = await connectControlSocket(harness.controlPort);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });

    // Correct pair/cwd + token, but NO contractVersion at all — an old frontend
    // that predates contract negotiation. Default policy = reject (can't negotiate).
    const controlToken = readControlToken(resolveControlTokenPath(harness.stateDir));
    ws.send(JSON.stringify({
      type: "claude_connect",
      identity: {
        pairId: "main-contmiss",
        pairName: "main",
        cwd: harness.cwd,
        stateDir: harness.stateDir,
        clientPid: process.pid,
        // contractVersion intentionally omitted
        ...(controlToken ? { controlToken } : {}),
      },
    }));

    const result = await Promise.race([closed, sleep(4000).then(() => null)]);
    expect(result).not.toBeNull();
    expect(result!.code).toBe(4006);
    expect(result!.reason).toContain("missing contract version");
  }, 30000);

  test("control-only path: probe_incumbent is NEVER rejected by the contract gate (no claude_connect)", async () => {
    // A control-only socket (the `abg claude` conflict guard) connects and sends
    // ONLY probe_incumbent — it carries no identity / contractVersion. The contract
    // gate lives in claude_connect admission, so this socket must get a normal
    // incumbent_status reply and must NOT be closed with 4006.
    const harness = await startHarness({ pairId: "main-probecon", pairName: "main" });

    const ws = await connectControlSocket(harness.controlPort);
    const replies: ControlServerMessage[] = [];
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      replies.push(JSON.parse(raw) as ControlServerMessage);
    };
    let closeCode: number | null = null;
    ws.onclose = (event) => { closeCode = event.code; };

    ws.send(JSON.stringify({ type: "probe_incumbent" }));

    await waitFor(
      () => replies.some((m) => m.type === "incumbent_status"),
      "incumbent_status reply for the control-only probe socket",
    );
    const reply = replies.find((m) => m.type === "incumbent_status") as Extract<
      ControlServerMessage,
      { type: "incumbent_status" }
    >;
    // No live frontend attached yet → connected:false. The point: a normal reply,
    // not a 4006 close.
    expect(reply.connected).toBe(false);
    // Give any (erroneous) close a chance to arrive, then assert it never did.
    await sleep(200);
    expect(closeCode).toBeNull();

    try { ws.close(); } catch {}
  }, 30000);
});

async function startHarness(opts: {
  pairId: string;
  pairName: string;
  extraEnv?: Record<string, string>;
  /** Optional .agentbridge/config.json content written into the daemon cwd before spawn. */
  projectConfig?: unknown;
  prepare?: (cwd: string) => Promise<void>;
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "agentbridge-daemon-wiring-"));
  const cwdPath = join(root, "project");
  const stateDir = join(root, "state");
  const binDir = join(root, "bin");
  const commandFile = join(root, "app-command.txt");
  mkdirSync(cwdPath, { recursive: true });
  const cwd = realpathSync(cwdPath);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  await opts.prepare?.(cwd);

  if (opts.projectConfig !== undefined) {
    mkdirSync(join(cwd, ".agentbridge"), { recursive: true });
    writeFileSync(join(cwd, ".agentbridge", "config.json"), JSON.stringify(opts.projectConfig));
  }

  const { slot, ports } = await reserveFreePairSlot();
  const { appPort, proxyPort, controlPort } = ports;

  installFakeCodex({ binDir, capability: "command-driven" });

  const env = {
    ...scrubAgentBridgeEnv(process.env),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    AGENTBRIDGE_PAIR_ID: opts.pairId,
    AGENTBRIDGE_PAIR_NAME: opts.pairName,
    AGENTBRIDGE_STATE_DIR: stateDir,
    AGENTBRIDGE_CONTROL_PORT: String(controlPort),
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "60000",
    AGENTBRIDGE_BOOTSTRAP_TIMEOUT_MS: "10000",
    AGENTBRIDGE_CODEX_TRANSPORT: "ws",
    CODEX_WS_PORT: String(appPort),
    CODEX_PROXY_PORT: String(proxyPort),
    FAKE_APP_COMMAND_FILE: commandFile,
    // Hermetic default: a test daemon must never poll the REAL installed budget
    // probe (~/.budget-guard/bin). Budget tests opt back in via extraEnv with an
    // explicit fixture probe (explicit env probes are exclusive — no fallback).
    AGENTBRIDGE_BUDGET_ENABLED: "0",
    ...(opts.extraEnv ?? {}),
  };

  const daemon = spawn("bun", ["run", DAEMON_PATH], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  const stdout: string[] = [];
  daemon.stdout?.on("data", (chunk) => stdout.push(chunk.toString()));
  daemon.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));

  const harness: Harness = {
    root,
    cwd,
    stateDir,
    binDir,
    commandFile,
    appPort,
    proxyPort,
    controlPort,
    slot,
    daemon,
    messages: [],
    statusMessages: [],
    close: async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGTERM");
        await waitFor(() => daemon.exitCode !== null || daemon.signalCode !== null, "daemon exit", 100, 50)
          .catch(() => {
            try { daemon.kill("SIGKILL"); } catch {}
          });
      }
      await sleep(50);
      rmSync(root, { recursive: true, force: true });
    },
    sendAppCommand: (command: string) => {
      writeFileSync(commandFile, `${command}\n`, "utf-8");
    },
    attachClaude: async () => {
      const ws = await connectControlSocket(controlPort);
      harness.controlWs = ws;
      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        const message = JSON.parse(raw) as ControlServerMessage;
        harness.statusMessages.push(message);
        if (message.type === "codex_to_claude") {
          harness.messages.push(message.message);
        }
      };
      // Mirror the real frontend (bridge.ts): read the daemon's capability token
      // from the pair state dir and echo it in the identity (arch-review P1 #283).
      // The daemon is readyz-200 here, so the token file already exists.
      const controlToken = readControlToken(resolveControlTokenPath(stateDir));
      ws.send(JSON.stringify({
        type: "claude_connect",
        identity: {
          pairId: opts.pairId,
          pairName: opts.pairName,
          cwd,
          stateDir,
          clientPid: process.pid,
          // Mirror bridge.ts: echo the daemon's contract version (#303). Read from
          // the single source so a future bump keeps the happy path green.
          contractVersion: CONTRACT_VERSION,
          ...(controlToken ? { controlToken } : {}),
        },
      }));
    },
    controlWs: null,
    connectTui: async () => {
      // A fake Codex TUI: connect to the proxy and start a thread. The fake
      // app-server auto-responds to thread/start, which drives the adapter to
      // setActiveThreadId → "ready" → canReply() truthy (with TUI connected).
      const tuiWs = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("TUI ws connect timeout")), 5000);
        tuiWs.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        tuiWs.onerror = () => {
          clearTimeout(timer);
          reject(new Error("TUI ws connect error"));
        };
      });
      tuiWs.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
      // Wait until the daemon reports bridge-ready over /healthz.
      await waitFor(async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${controlPort}/healthz`);
          if (!res.ok) return false;
          const status = (await res.json()) as DaemonStatus;
          return status.bridgeReady === true;
        } catch {
          return false;
        }
      }, "bridge ready after TUI handshake", 100, 100);
    },
    sendClaudeToCodex: (requestId: string, text: string, sendOpts?: { onBusy?: "reject" | "steer" | "interrupt"; requireReply?: boolean; idempotencyKey?: string; wrapUp?: boolean }) => {
      harness.controlWs?.send(JSON.stringify({
        type: "claude_to_codex",
        requestId,
        message: { id: requestId, source: "claude", to: "codex", content: text, timestamp: Date.now() },
        ...(sendOpts?.requireReply ? { requireReply: true } : {}),
        ...(sendOpts?.onBusy && sendOpts.onBusy !== "reject" ? { onBusy: sendOpts.onBusy } : {}),
        ...(sendOpts?.idempotencyKey ? { idempotencyKey: sendOpts.idempotencyKey } : {}),
        ...(sendOpts?.wrapUp ? { wrapUp: true } : {}),
      }));
    },
    sendAckResume: (resumeId: string, status: string) => {
      harness.controlWs?.send(JSON.stringify({ type: "ack_resume", resumeId, status }));
    },
  };
  harnesses.push(harness);

  await waitForHarnessDaemonReady({
    controlPort,
    daemon,
    expectedPairId: opts.pairId,
    stateDir,
    stdout,
    stderr,
  });

  return harness;
}

/**
 * Drive a raw HTTP WS-upgrade handshake against a port with an explicit Origin
 * header and return the response status line. A raw socket is the only way to
 * attach an arbitrary Origin to the upgrade — the JS WebSocket constructor does
 * not let us set it, but a browser always sends one.
 */
function rawUpgradeStatus(port: number, path: string, origin: string): Promise<string> {
  const handshake =
    `GET ${path} HTTP/1.1\r\n` +
    "Host: 127.0.0.1\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    `Origin: ${origin}\r\n` +
    "\r\n";
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, "127.0.0.1", () => sock.write(handshake));
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("raw upgrade timeout"));
    }, 5000);
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl !== -1) {
        clearTimeout(timer);
        sock.destroy();
        resolve(buf.slice(0, nl));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function scrubAgentBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("AGENTBRIDGE_") || key.startsWith("CODEX_")) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}

async function reserveFreePairSlot(startSlot = DEFAULT_TEST_SLOT_START): Promise<{ slot: number; ports: PairPorts }> {
  for (let slot = startSlot; slot < startSlot + 100; slot++) {
    const ports = portsForSlot(slot);
    const reservations: Array<ReturnType<typeof createServer>> = [];
    try {
      for (const port of [ports.appPort, ports.proxyPort, ports.controlPort]) {
        reservations.push(await listenOnPort(port));
      }
      await Promise.all(reservations.map((server) => closeServer(server)));
      return { slot, ports };
    } catch {
      await Promise.all(reservations.map((server) => closeServer(server).catch(() => {})));
    }
  }
  throw new Error("Could not find a free pair slot for daemon wiring test");
}

function listenOnPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function waitForHarnessDaemonReady(opts: {
  controlPort: number;
  daemon: ChildProcess;
  expectedPairId: string;
  stateDir: string;
  stdout: string[];
  stderr: string[];
}): Promise<void> {
  let lastReadyz = "<not probed>";

  for (let i = 0; i < 120; i++) {
    if (opts.daemon.exitCode !== null || opts.daemon.signalCode !== null) {
      throw new Error(
        `Daemon exited before readyz matched spawned process identity\n${daemonDiagnostics(opts, lastReadyz)}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${opts.controlPort}/readyz`);
      const body = await response.text();
      const status = parseReadyzStatus(body);
      lastReadyz = `HTTP ${response.status} pid=${status?.pid ?? "<missing>"} pairId=${status?.pairId ?? "<missing>"} body=${tailText(body)}`;

      if (response.ok && status?.pid === opts.daemon.pid && status?.pairId === opts.expectedPairId) {
        return;
      }
    } catch (err: any) {
      lastReadyz = `fetch error: ${err?.message ?? String(err)}`;
    }

    await sleep(100);
  }

  throw new Error(
    `Timed out waiting for daemon readyz from spawned process identity\n${daemonDiagnostics(opts, lastReadyz)}`,
  );
}

function parseReadyzStatus(body: string): Partial<DaemonStatus> | null {
  try {
    return JSON.parse(body) as Partial<DaemonStatus>;
  } catch {
    return null;
  }
}

function daemonDiagnostics(
  opts: {
    daemon: ChildProcess;
    stateDir: string;
    stdout: string[];
    stderr: string[];
  },
  lastReadyz: string,
): string {
  return [
    `daemon.pid=${opts.daemon.pid ?? "<none>"} exitCode=${opts.daemon.exitCode ?? "<running>"} signalCode=${opts.daemon.signalCode ?? "<none>"}`,
    `lastReadyz=${lastReadyz}`,
    `stdout.tail=${tailText(opts.stdout.join(""))}`,
    `stderr.tail=${tailText(opts.stderr.join(""))}`,
    `agentbridge.log.tail=${readFileTail(join(opts.stateDir, "agentbridge.log"))}`,
  ].join("\n");
}

function readFileTail(path: string): string {
  if (!existsSync(path)) return "<missing>";
  try {
    return tailText(readFileSync(path, "utf-8"));
  } catch (err: any) {
    return `<failed to read: ${err?.message ?? String(err)}>`;
  }
}

function tailText(value: string): string {
  if (value.length <= DIAGNOSTIC_TAIL_CHARS) return value;
  return value.slice(-DIAGNOSTIC_TAIL_CHARS);
}

function connectControlSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("timed out connecting to daemon control socket"));
    }, 2000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("failed to connect to daemon control socket"));
    };
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  maxRetries = 80,
  delayMs = 50,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (await condition()) return;
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForMessage(
  messages: BridgeMessage[],
  predicate: (message: BridgeMessage) => boolean,
  label: string,
): Promise<BridgeMessage> {
  await waitFor(() => messages.some(predicate), `${label}; observed=${JSON.stringify(messages)}`);
  return messages.find(predicate)!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
