import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { BridgeMessage } from "../types";
import type { ControlServerMessage, DaemonStatus } from "../control-protocol";
import { portsForSlot, type PairPorts } from "../pair-registry";

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
    opts?: { onBusy?: "reject" | "steer"; requireReply?: boolean },
  ) => void;
}

const harnesses: Harness[] = [];

describe("daemon wiring", () => {
  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop()!;
      await harness.close();
    }
  });

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
    writeUsage("codex", 85); // eco band (≥80) but below pauseAt=90 — no pause
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

  test("on_busy=steer feeds the message into a running turn via turn/steer (protocol v2 B0)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-steer-fixture-"));
    const steerLog = join(fixtureRoot, "turnsteer.jsonl");
    const readSteers = (): Array<{ threadId: string; input: Array<{ type: string; text: string }> }> =>
      existsSync(steerLog)
        ? readFileSync(steerLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
    const resultFor = (requestId: string) =>
      harness.statusMessages.find(
        (m) => m.type === "claude_to_codex_result" && m.requestId === requestId,
      ) as Extract<ControlServerMessage, { type: "claude_to_codex_result" }> | undefined;
    const waitForResult = async (requestId: string) => {
      await waitFor(() => resultFor(requestId) !== undefined, `claude_to_codex_result for ${requestId}`);
      return resultFor(requestId)!;
    };

    const harness = await startHarness({
      pairId: "main-steerabcd",
      pairName: "main",
      extraEnv: { FAKE_APP_TURNSTEER_LOG: steerLog },
    });

    try {
      await harness.attachClaude();
      await harness.connectTui();

      // Drive the adapter into a running turn so the busy path is active.
      harness.sendAppCommand("start-turn");
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_turn_started"),
        "system_turn_started",
      );

      // Default policy unchanged: a plain reply during the turn is rejected,
      // and the busy error now advertises the steer escape hatch.
      harness.sendClaudeToCodex("req-steer-0", "plain message during turn");
      const rejected = await waitForResult("req-steer-0");
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain('on_busy="steer"');

      // B0 limitation is loud, not silent: require_reply×steer is refused.
      harness.sendClaudeToCodex("req-steer-rr", "needs ack", { onBusy: "steer", requireReply: true });
      const refused = await waitForResult("req-steer-rr");
      expect(refused.success).toBe(false);
      expect(refused.error).toContain("require_reply is not supported");

      // The steer path: message reaches the app-server as turn/steer with the
      // explicit [STEER from Claude] framing, on the live thread.
      harness.sendClaudeToCodex("req-steer-1", "course correction: use approach B", { onBusy: "steer" });
      const accepted = await waitForResult("req-steer-1");
      expect(accepted.success).toBe(true);
      await waitFor(() => readSteers().length >= 1, "recorded turn/steer", 100, 100);
      const steer = readSteers()[0]!;
      expect(steer.threadId).toBe("thread-fake-1");
      expect(steer.input[0]!.type).toBe("text");
      expect(steer.input[0]!.text.startsWith("[STEER from Claude]\n")).toBe(true);
      expect(steer.input[0]!.text).toContain("course correction: use approach B");

      // An app-server rejection after transport-accept surfaces as
      // system_steer_failed (the original turn is NOT reported aborted).
      harness.sendClaudeToCodex("req-steer-2", "[force-steer-error] doomed", { onBusy: "steer" });
      const failedNotice = await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_steer_failed"),
        "system_steer_failed",
      );
      expect(failedNotice.content).toContain("did NOT reach Codex");
      expect(failedNotice.content).toContain("ActiveTurnNotSteerable");
      expect(harness.messages.some((m) => m.id.startsWith("system_turn_aborted"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);
});

async function startHarness(opts: {
  pairId: string;
  pairName: string;
  extraEnv?: Record<string, string>;
  /** Optional .agentbridge/config.json content written into the daemon cwd before spawn. */
  projectConfig?: unknown;
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

  if (opts.projectConfig !== undefined) {
    mkdirSync(join(cwd, ".agentbridge"), { recursive: true });
    writeFileSync(join(cwd, ".agentbridge", "config.json"), JSON.stringify(opts.projectConfig));
  }

  const { slot, ports } = await reserveFreePairSlot();
  const { appPort, proxyPort, controlPort } = ports;

  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, fakeCodexScript(), "utf-8");
  chmodSync(codexPath, 0o755);

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
      ws.send(JSON.stringify({
        type: "claude_connect",
        identity: {
          pairId: opts.pairId,
          pairName: opts.pairName,
          cwd,
          stateDir,
          clientPid: process.pid,
          contractVersion: 1,
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
    sendClaudeToCodex: (requestId: string, text: string, sendOpts?: { onBusy?: "reject" | "steer"; requireReply?: boolean }) => {
      harness.controlWs?.send(JSON.stringify({
        type: "claude_to_codex",
        requestId,
        message: { id: requestId, source: "claude", content: text, timestamp: Date.now() },
        ...(sendOpts?.requireReply ? { requireReply: true } : {}),
        ...(sendOpts?.onBusy && sendOpts.onBusy !== "reject" ? { onBusy: sendOpts.onBusy } : {}),
      }));
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

function fakeCodexScript(): string {
  return `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";

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
const commandFile = process.env.FAKE_APP_COMMAND_FILE;
let appWs = null;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req, serverInstance) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      return Response.json({ ok: true });
    }
    if (serverInstance.upgrade(req)) return undefined;
    return new Response("fake codex app-server");
  },
  websocket: {
    open(ws) {
      appWs = ws;
    },
    message(ws, raw) {
      // Minimal handshake support: auto-respond to thread/start so the adapter
      // can detect an active thread and emit "ready" (used by budget gate tests).
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg.method === "thread/start") {
          ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-fake-1" } } }));
        }
        // Record received turn/start params (tier-override assertions).
        if (msg.method === "turn/start" && process.env.FAKE_APP_TURNSTART_LOG) {
          appendFileSync(process.env.FAKE_APP_TURNSTART_LOG, JSON.stringify(msg.params) + "\\n");
        }
        // turn/steer: record params, then ack — or reject when the text carries
        // the [force-steer-error] marker (drives the steerFailed wiring test).
        if (msg.method === "turn/steer") {
          if (process.env.FAKE_APP_TURNSTEER_LOG) {
            appendFileSync(process.env.FAKE_APP_TURNSTEER_LOG, JSON.stringify(msg.params) + "\\n");
          }
          const steerText = msg.params?.input?.[0]?.text ?? "";
          if (steerText.includes("[force-steer-error]")) {
            ws.send(JSON.stringify({ id: msg.id, error: { message: "ActiveTurnNotSteerable" } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        }
      } catch {}
    },
    close(ws) {
      if (appWs === ws) appWs = null;
    },
  },
});

setInterval(() => {
  if (!commandFile || !existsSync(commandFile)) return;
  const command = readFileSync(commandFile, "utf-8").trim();
  try { unlinkSync(commandFile); } catch {}
  if (!appWs) return;
  if (command === "start-turn") {
    appWs.send(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
  }
  if (command === "close-app-server") {
    appWs.close(1011, "test app-server close");
    setTimeout(() => server.stop(true), 20);
  }
}, 25).unref();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

await new Promise(() => {});
`;
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
