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
import { createServer, connect, type Socket } from "node:net";
import type { BridgeMessage } from "../types";
import type { ControlServerMessage, DaemonStatus } from "../control-protocol";
import { portsForSlot, type PairPorts } from "../pair-registry";
import { readControlToken, resolveControlTokenPath } from "../control-token";

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
    opts?: { onBusy?: "reject" | "steer" | "interrupt"; requireReply?: boolean; idempotencyKey?: string },
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

  test("on_busy=steer feeds the message into a running turn via turn/steer (protocol v2 B0)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-steer-fixture-"));
    const steerLog = join(fixtureRoot, "turnsteer.jsonl");
    const readSteers = (): Array<{ threadId: string; expectedTurnId?: string; input: Array<{ type: string; text: string }> }> =>
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
      // and the busy error advertises both escape hatches. The structured
      // result fields (PR B) ride alongside the legacy error string.
      harness.sendClaudeToCodex("req-steer-0", "plain message during turn");
      const rejected = await waitForResult("req-steer-0");
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain('on_busy="steer"');
      expect(rejected.error).toContain('on_busy="interrupt"');
      expect(rejected.ok).toBe(false);
      expect(rejected.code).toBe("busy_reject");
      expect(rejected.phase).toBe("running");
      expect(typeof rejected.retryAfterMs).toBe("number");

      // The steer path: message reaches the app-server as turn/steer with the
      // explicit [STEER from Claude] framing, on the live thread.
      harness.sendClaudeToCodex("req-steer-1", "course correction: use approach B", { onBusy: "steer" });
      const accepted = await waitForResult("req-steer-1");
      expect(accepted.success).toBe(true);
      expect(accepted.ok).toBe(true);
      await waitFor(() => readSteers().length >= 1, "recorded turn/steer", 100, 100);
      const steer = readSteers()[0]!;
      expect(steer.threadId).toBe("thread-fake-1");
      // This assertion is the real regression gate: `accepted.success` above is
      // only the daemon's SYNCHRONOUS transport-accept (sent before the fake's
      // JSON-RPC verdict arrives), so a strict-fake rejection would NOT flip it
      // — it would surface later as an async system_steer_failed.
      expect(steer.expectedTurnId).toBe("turn-1");
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

      // require_reply × steer is now ALLOWED (PR B real semantics): the steer
      // is accepted, the body carries the reply-required instruction, and the
      // daemon arms the expectation on steer-accept.
      harness.sendClaudeToCodex("req-steer-rr", "needs ack", { onBusy: "steer", requireReply: true });
      const rrResult = await waitForResult("req-steer-rr");
      expect(rrResult.success).toBe(true);
      await waitFor(() => readSteers().length >= 3, "recorded require_reply steer", 100, 100);
      const rrSteer = readSteers()[2]!;
      expect(rrSteer.input[0]!.text).toContain("needs ack");
      expect(rrSteer.input[0]!.text).toContain("[⚠️ REPLY REQUIRED]");

      // Completing the turn WITHOUT any agentMessage must fire the
      // reply-missing warning — proof the expectation armed on steer-accept.
      await sleep(300); // let the fake's steer-success verdict arrive and arm the tracker
      harness.sendAppCommand("complete-turn");
      const replyMissing = await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_reply_missing"),
        "system_reply_missing after require_reply steer",
      );
      expect(replyMissing.content).toContain("require_reply");
      expect(harness.messages.some((m) => m.id.startsWith("system_turn_completed"))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("on_busy=interrupt stops the running turn, injects as a new turn, and turn_started ACK correlates (protocol v2 PR B)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-interrupt-fixture-"));
    const interruptLog = join(fixtureRoot, "turninterrupt.jsonl");
    const turnStartLog = join(fixtureRoot, "turn-starts.jsonl");
    const readJsonl = (path: string): Array<Record<string, any>> =>
      existsSync(path)
        ? readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
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
      pairId: "main-intrabcde",
      pairName: "main",
      extraEnv: {
        FAKE_APP_TURNINTERRUPT_LOG: interruptLog,
        FAKE_APP_TURNSTART_LOG: turnStartLog,
      },
    });

    try {
      await harness.attachClaude();
      await harness.connectTui();

      // Drive the adapter into a running turn so the interrupt path is active.
      harness.sendAppCommand("start-turn");
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_turn_started"),
        "system_turn_started",
      );

      // Interrupt + inject, carrying an idempotency key.
      harness.sendClaudeToCodex("req-int-1", "drop everything: new priority task", {
        onBusy: "interrupt",
        idempotencyKey: "key-int-1",
      });
      const result = await waitForResult("req-int-1");
      expect(result.success).toBe(true);
      expect(result.ok).toBe(true);

      // The fake app-server received turn/interrupt with the RIGHT ids.
      expect(readJsonl(interruptLog)).toEqual([{ threadId: "thread-fake-1", turnId: "turn-1" }]);

      // The message was then injected as a NORMAL turn/start (no steer framing).
      await waitFor(() => readJsonl(turnStartLog).length >= 1, "recorded post-interrupt turn/start", 100, 100);
      const injected = readJsonl(turnStartLog)[0]!;
      expect(injected.threadId).toBe("thread-fake-1");
      expect(injected.input[0].type).toBe("text");
      expect(injected.input[0].text).toContain("drop everything: new priority task");
      expect(injected.input[0].text).not.toContain("[STEER from Claude]");

      // turn_started control event correlates requestId + idempotencyKey.
      await waitFor(
        () => harness.statusMessages.some((m) => m.type === "turn_started" && m.requestId === "req-int-1"),
        "turn_started control event for req-int-1",
      );
      const ack = harness.statusMessages.find(
        (m) => m.type === "turn_started" && m.requestId === "req-int-1",
      ) as Extract<ControlServerMessage, { type: "turn_started" }>;
      expect(ack.idempotencyKey).toBe("key-int-1");
      expect(ack.threadId).toBe("thread-fake-1");
      expect(ack.turnId).toMatch(/^turn-injected-/);

      // A duplicate idempotencyKey while the key is in flight (started, no
      // terminal yet) is NOT re-injected and reports duplicate_in_flight.
      harness.sendClaudeToCodex("req-int-2", "same message retried", { idempotencyKey: "key-int-1" });
      const dup = await waitForResult("req-int-2");
      expect(dup.success).toBe(false);
      expect(dup.ok).toBe(false);
      expect(dup.code).toBe("duplicate_in_flight");
      expect(dup.error).toContain("Duplicate idempotency_key");

      // ...and the fake never saw a second turn/start.
      await sleep(200);
      expect(readJsonl(turnStartLog)).toHaveLength(1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("a rejected keyed steer RELEASES its idempotency key — a same-key retry is allowed (PR B REAL #2)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-steerfail-fixture-"));
    const steerLog = join(fixtureRoot, "turnsteer.jsonl");
    const readSteers = (): Array<{ threadId: string; expectedTurnId?: string; input: Array<{ type: string; text: string }> }> =>
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
      pairId: "main-strflabcd",
      pairName: "main",
      extraEnv: { FAKE_APP_TURNSTEER_LOG: steerLog },
    });

    try {
      await harness.attachClaude();
      await harness.connectTui();

      // Drive into a running turn so the steer path is active.
      harness.sendAppCommand("start-turn");
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_turn_started"),
        "system_turn_started",
      );

      // A KEYED steer that the fake app-server REJECTS ([force-steer-error]).
      // The daemon transport-accepts it (so the sync result is success) and
      // accept()+markStarted-binds the key to the running original turn; the
      // async rejection then fires steerFailed.
      harness.sendClaudeToCodex("req-sf-1", "[force-steer-error] doomed steer", {
        onBusy: "steer",
        idempotencyKey: "key-sf-1",
      });
      const first = await waitForResult("req-sf-1");
      expect(first.success).toBe(true); // transport-accepted
      await waitFor(() => readSteers().length >= 1, "recorded the doomed turn/steer", 100, 100);

      // The async rejection surfaces as system_steer_failed (the key is released here).
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_steer_failed"),
        "system_steer_failed for the doomed steer",
      );

      // The SAME key is now retryable: a fresh steer with key-sf-1 must NOT be
      // rejected as duplicate_in_flight — it reaches the wire as a real steer.
      harness.sendClaudeToCodex("req-sf-2", "second attempt, same key", {
        onBusy: "steer",
        idempotencyKey: "key-sf-1",
      });
      const second = await waitForResult("req-sf-2");
      expect(second.success).toBe(true);
      // Critically NOT duplicate_in_flight — the release made the key retryable.
      expect(second.code).not.toBe("duplicate_in_flight");
      await waitFor(() => readSteers().length >= 2, "recorded the retried turn/steer", 100, 100);
      const retried = readSteers()[1]!;
      expect(retried.input[0]!.text).toContain("second attempt, same key");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  test("a lost-response (orphaned) require_reply steer cannot mis-arm a LATER steer's reply expectation (PR B REAL #3)", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "agentbridge-steerorphan-fixture-"));
    const steerLog = join(fixtureRoot, "turnsteer.jsonl");
    const readSteers = (): Array<{ input: Array<{ type: string; text: string }> }> =>
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
      pairId: "main-strorabcd",
      pairName: "main",
      extraEnv: { FAKE_APP_TURNSTEER_LOG: steerLog },
    });

    try {
      await harness.attachClaude();
      await harness.connectTui();

      harness.sendAppCommand("start-turn");
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_turn_started"),
        "system_turn_started",
      );

      // 1) A require_reply steer whose app-server verdict is LOST ([hang-steer]).
      // It orphans a dispatch entry carrying requireReply=true. Under the OLD
      // FIFO pairing, a LATER steerAccepted would shift() this orphan and arm
      // the reply expectation against the wrong turn.
      harness.sendClaudeToCodex("req-orphan-1", "[hang-steer] never answered", {
        onBusy: "steer",
        requireReply: true,
      });
      await waitForResult("req-orphan-1"); // transport-accepted, but no verdict
      await waitFor(() => readSteers().length >= 1, "recorded the hung steer", 100, 100);

      // 2) A SECOND steer (NO require_reply) that the fake ACCEPTS → steerAccepted.
      // Id-keyed correlation must consume THIS dispatch (req-orphan-2), never the
      // orphaned require_reply one.
      harness.sendClaudeToCodex("req-orphan-2", "plain steer that gets accepted", {
        onBusy: "steer",
      });
      await waitForResult("req-orphan-2");
      await waitFor(() => readSteers().length >= 2, "recorded the accepted steer", 100, 100);

      // Give the accepted steer's verdict time to (wrongly, under the old bug)
      // arm the orphaned require_reply expectation.
      await sleep(300);

      // 3) Complete the turn WITHOUT any agentMessage. If the orphan had mis-armed
      // the reply expectation, a system_reply_missing warning would fire. With the
      // id-keyed fix it must NOT — the orphan was never consumed by req-orphan-2.
      harness.sendAppCommand("complete-turn");
      await waitForMessage(
        harness.messages,
        (message) => message.id.startsWith("system_turn_completed"),
        "system_turn_completed",
      );
      expect(harness.messages.some((m) => m.id.startsWith("system_reply_missing"))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60000);

  // --- Security: attach-convergence guard + capability token (arch-review P1 #283) ---

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
        contractVersion: 1,
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
        contractVersion: 1,
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
          contractVersion: 1,
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
    sendClaudeToCodex: (requestId: string, text: string, sendOpts?: { onBusy?: "reject" | "steer" | "interrupt"; requireReply?: boolean; idempotencyKey?: string }) => {
      harness.controlWs?.send(JSON.stringify({
        type: "claude_to_codex",
        requestId,
        message: { id: requestId, source: "claude", content: text, timestamp: Date.now() },
        ...(sendOpts?.requireReply ? { requireReply: true } : {}),
        ...(sendOpts?.onBusy && sendOpts.onBusy !== "reject" ? { onBusy: sendOpts.onBusy } : {}),
        ...(sendOpts?.idempotencyKey ? { idempotencyKey: sendOpts.idempotencyKey } : {}),
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
let lastStartedTurnId = null;
let turnStartCounter = 0;

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
        // Record received turn/start params (tier-override assertions), then
        // respond success with the created turn id like the real app-server
        // (TurnStartResponse.turn.id) so the bridge's turn_started ACK
        // correlation can be asserted end-to-end. NOTE: deliberately NO
        // turn/started notification here — emitting one would mark the
        // adapter busy and break the multi-injection budget tests; the
        // "start-turn" command drives the busy state explicitly.
        if (msg.method === "turn/start") {
          if (process.env.FAKE_APP_TURNSTART_LOG) {
            appendFileSync(process.env.FAKE_APP_TURNSTART_LOG, JSON.stringify(msg.params) + "\\n");
          }
          turnStartCounter += 1;
          ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-injected-" + turnStartCounter } } }));
        }
        // turn/interrupt: record params, respond success ({}), then emit the
        // terminal turn/completed for that turnId — mirroring the REAL
        // app-server (verified in codex-rs): the success response is deferred
        // until TurnAborted and the interrupted turn's terminal notification
        // is a normal turn/completed with status "interrupted".
        if (msg.method === "turn/interrupt") {
          if (process.env.FAKE_APP_TURNINTERRUPT_LOG) {
            appendFileSync(process.env.FAKE_APP_TURNINTERRUPT_LOG, JSON.stringify(msg.params) + "\\n");
          }
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          ws.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: msg.params.turnId, status: "interrupted" } } }));
          if (lastStartedTurnId === msg.params.turnId) lastStartedTurnId = null;
        }
        // turn/steer: record params, then ack — or reject when the text carries
        // the [force-steer-error] marker (drives the steerFailed wiring test).
        // Strict emulation of the real app-server (expectedTurnId has been
        // REQUIRED since turn/steer was introduced — live-E2E regression: B0
        // shipped without the field and every steer bounced): missing field →
        // serde-style error; wrong value → ExpectedTurnMismatch-style error.
        if (msg.method === "turn/steer") {
          if (process.env.FAKE_APP_TURNSTEER_LOG) {
            appendFileSync(process.env.FAKE_APP_TURNSTEER_LOG, JSON.stringify(msg.params) + "\\n");
          }
          const steerText = msg.params?.input?.[0]?.text ?? "";
          if (typeof msg.params?.expectedTurnId !== "string" || msg.params.expectedTurnId.length === 0) {
            ws.send(JSON.stringify({ id: msg.id, error: { message: "Invalid request: missing field \`expectedTurnId\`" } }));
          } else if (lastStartedTurnId && msg.params.expectedTurnId !== lastStartedTurnId) {
            ws.send(JSON.stringify({ id: msg.id, error: { message: "expected active turn id \`" + msg.params.expectedTurnId + "\` but found \`" + lastStartedTurnId + "\`" } }));
          } else if (steerText.includes("[hang-steer]")) {
            // Deliberately send NO verdict — simulate a steer whose app-server
            // response is lost while the WS stays open (drives the PR B #3
            // lost-response orphan test: turnTrackingReset must clean it up).
          } else if (steerText.includes("[force-steer-error]")) {
            ws.send(JSON.stringify({ id: msg.id, error: { message: "ActiveTurnNotSteerable" } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: { turnId: msg.params.expectedTurnId } }));
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
    lastStartedTurnId = "turn-1";
    appWs.send(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
  }
  if (command === "complete-turn" && lastStartedTurnId) {
    appWs.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: lastStartedTurnId } } }));
    lastStartedTurnId = null;
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
