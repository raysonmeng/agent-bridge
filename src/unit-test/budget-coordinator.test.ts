import { describe, expect, test } from "bun:test";
import { BudgetCoordinator } from "../budget/budget-coordinator";
import type { AgentUsage, BudgetConfig } from "../budget/types";

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
  enabled: true,
  pollSeconds: 0.01,
  pauseAt: 90,
  resumeBelow: 30,
  syncDriftPct: 10,
  parallel: {
    minRemainingPct: 60,
    timeWindowSec: 3600,
  },
  codexTierControl: false,
  codexTiers: {
    full: { effort: "high" },
    balanced: { effort: "medium" },
    eco: { effort: "low" },
  },
};

type FetchResult = { claude: AgentUsage | null; codex: AgentUsage | null } | null;

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  const gateUtil = overrides.gateUtil ?? 20;
  const warnUtil = overrides.warnUtil ?? gateUtil;
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil,
    fiveHour: { util: gateUtil, resetEpoch: NOW + 3600 },
    weekly: { util: warnUtil, resetEpoch: NOW + 500_000 },
    remaining: 100 - gateUtil,
    rateLimitedUntil: 0,
    fetchedAt: NOW,
    ...overrides,
  };
}

class FakeSource {
  calls = 0;
  private last: FetchResult;

  constructor(private readonly results: FetchResult[]) {
    this.last = results[results.length - 1] ?? null;
  }

  async fetchBoth(): Promise<FetchResult> {
    const result = this.results[this.calls] ?? this.last;
    this.calls += 1;
    this.last = result;
    return result;
  }
}

function makeCoordinator(source: FakeSource, config: BudgetConfig = CONFIG) {
  const emitted: Array<{ id: string; content: string }> = [];
  const pauseChanges: boolean[] = [];
  const logs: string[] = [];
  const coordinator = new BudgetCoordinator({
    source,
    config,
    emit: (id, content) => emitted.push({ id, content }),
    onPauseChange: (paused) => pauseChanges.push(paused),
    now: () => NOW,
    log: (message) => logs.push(message),
  });

  return { coordinator, emitted, pauseChanges, logs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error("condition was not met before timeout");
}

describe("BudgetCoordinator", () => {
  test("start immediately polls and stores the first snapshot", async () => {
    const source = new FakeSource([{ claude: usage(), codex: usage({ gateUtil: 21, warnUtil: 21 }) }]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(source.calls).toBe(1);
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: "normal",
      updatedAt: NOW,
      paused: false,
      gateClosed: false,
      pauseSide: null,
      codexTier: "full",
    });
    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(coordinator.getCodexTurnOverrides()).toBeNull();
    expect(emitted).toEqual([]);
  });

  test("deduplicates repeated directives with the same phase fingerprint", async () => {
    const source = new FakeSource([
      { claude: usage({ warnUtil: 45 }), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
      { claude: usage({ warnUtil: 45 }), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toStartWith("system_budget_balance");
    expect(emitted[0].content).toContain("用量比例漂移");
  });

  test("re-emits balance directive when the lighter side enters a new five-hour window", async () => {
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 35, warnUtil: 45 }),
        codex: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3600 } }),
      },
      {
        claude: usage({ gateUtil: 35, warnUtil: 45 }),
        codex: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 7200 } }),
      },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(emitted.filter((event) => event.id.startsWith("system_budget_balance"))).toHaveLength(2);
  });

  test("emits Codex-side pause and resume on gate lifecycle edges", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage() },
      { claude: usage(), codex: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }) },
      { claude: usage(), codex: usage({ gateUtil: 50, warnUtil: 50, remaining: 50 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }) },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => emitted.some((event) => event.id.startsWith("system_budget_pause")));
    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(true);
    await waitFor(() => source.calls >= 3);
    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(true);
    expect(emitted.some((event) => event.id.startsWith("system_budget_resume"))).toBe(false);
    await waitFor(() => emitted.some((event) => event.id.startsWith("system_budget_resume")));
    coordinator.stop();

    expect(pauseChanges).toEqual([true, false]);
    expect(emitted.map((event) => event.id.split("_").slice(0, 3).join("_"))).toContain("system_budget_pause");
    const resume = emitted.find((event) => event.id.startsWith("system_budget_resume"));
    expect(resume?.content).toContain("Codex 侧预算闸门解除");
    expect(resume?.content).toContain("reply");
    expect(resume?.content).toContain("唤醒 Codex");
    expect(coordinator.getSnapshot()).toMatchObject({ paused: false, gateClosed: false, pauseSide: null });
  });

  test("Claude-side handoff keeps intervention visible but leaves the gate open", async () => {
    const source = new FakeSource([
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: false, pauseSide: "claude" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toStartWith("system_budget_handoff");
    expect(emitted[0].content).toContain("立即交接");
    expect(pauseChanges).toEqual([true]);
  });

  test("joint pause closes the gate and records both sides", async () => {
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: true, pauseSide: "both" });
    expect(emitted[0].id).toStartWith("system_budget_pause");
    expect(emitted[0].content).toContain("联合暂停");
  });

  test("re-emits a pause after coordinator reconstruction", async () => {
    const firstSource = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }) },
    ]);
    const first = makeCoordinator(firstSource);

    await first.coordinator.start();
    first.coordinator.stop();

    const secondSource = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }) },
    ]);
    const second = makeCoordinator(secondSource);

    await second.coordinator.start();
    second.coordinator.stop();

    expect(first.emitted.filter((event) => event.id.startsWith("system_budget_pause"))).toHaveLength(1);
    expect(second.emitted.filter((event) => event.id.startsWith("system_budget_pause"))).toHaveLength(1);
    expect(first.pauseChanges).toEqual([true]);
    expect(second.pauseChanges).toEqual([true]);
  });

  test("keeps paused without extra emits when both probes disappear during pause", async () => {
    const source = new FakeSource([
      { claude: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }), codex: usage() },
      { claude: null, codex: null },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: false, pauseSide: "claude", claude: null, codex: null });
    expect(emitted.filter((event) => event.id.startsWith("system_budget_handoff"))).toHaveLength(1);
    expect(emitted.some((event) => event.id.startsWith("system_budget_resume"))).toBe(false);
    expect(pauseChanges).toEqual([true]);
  });

  test("keeps Codex-side gate closed when probes disappear during pause", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }) },
      { claude: null, codex: null },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: true, pauseSide: "codex", claude: null, codex: null });
    expect(emitted.filter((event) => event.id.startsWith("system_budget_pause"))).toHaveLength(1);
    expect(pauseChanges).toEqual([true]);
  });

  test("stop cancels scheduled polling timers", async () => {
    const source = new FakeSource([{ claude: usage(), codex: usage() }]);
    const { coordinator } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();
    await sleep(30);

    expect(source.calls).toBe(1);
  });

  test("does not enter intervention on rate-limited-only usage", async () => {
    const source = new FakeSource([
      {
        claude: usage({
          ok: false,
          gateUtil: 0,
          warnUtil: 0,
          remaining: 100,
          rateLimitedUntil: NOW + 900,
          fiveHour: null,
          weekly: null,
        }),
        codex: usage({ gateUtil: 0, warnUtil: 0, remaining: 100 }),
      },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: false, gateClosed: false, pauseSide: null });
    expect(coordinator.getSnapshot()?.claude?.rateLimitedUntil).toBe(NOW + 900);
    expect(pauseChanges).toEqual([]);
    expect(emitted).toEqual([]);
  });

  test("keeps an existing active side paused while its probe is rate-limited", async () => {
    const source = new FakeSource([
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
      {
        claude: usage({
          gateUtil: 5,
          warnUtil: 5,
          remaining: 95,
          rateLimitedUntil: NOW + 900,
        }),
        codex: usage(),
      },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      paused: true,
      gateClosed: false,
      pauseSide: "claude",
      resumeAfterEpoch: NOW + 900,
    });
    expect(emitted.filter((event) => event.id.startsWith("system_budget_handoff"))).toHaveLength(1);
    expect(emitted.some((event) => event.id.startsWith("system_budget_claude_recovered"))).toBe(false);
    expect(pauseChanges).toEqual([true]);
  });

  test("keeps working when one side probe is unavailable", async () => {
    const source = new FakeSource([{ claude: null, codex: usage() }]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: "normal",
      claude: null,
      paused: false,
      gateClosed: false,
      pauseSide: null,
    });
    expect(emitted).toEqual([]);
    expect(pauseChanges).toEqual([]);
  });

  test("transitions Claude handoff to joint pause and down to Codex pause", async () => {
    const source = new FakeSource([
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
      {
        claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      },
      { claude: usage(), codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }) },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 3);
    coordinator.stop();

    expect(emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_handoff",
      "system_budget_pause",
      "system_budget_pause",
    ]);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: true, pauseSide: "codex" });
  });

  test("downgrades joint pause to Claude handoff when Codex recovers first", async () => {
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      },
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_pause",
      "system_budget_handoff",
    ]);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: false, pauseSide: "claude" });
  });

  test("emits distinct recovery events for Codex pause and Claude handoff", async () => {
    const codexSource = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }) },
      { claude: usage(), codex: usage() },
    ]);
    const codex = makeCoordinator(codexSource);

    await codex.coordinator.start();
    await waitFor(() => codexSource.calls >= 2);
    codex.coordinator.stop();

    expect(codex.emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_pause",
      "system_budget_resume",
    ]);
    expect(codex.coordinator.getSnapshot()).toMatchObject({ paused: false, gateClosed: false, pauseSide: null });

    const claudeSource = new FakeSource([
      { claude: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }), codex: usage() },
      { claude: usage(), codex: usage() },
    ]);
    const claude = makeCoordinator(claudeSource);

    await claude.coordinator.start();
    await waitFor(() => claudeSource.calls >= 2);
    claude.coordinator.stop();

    expect(claude.emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_handoff",
      "system_budget_claude_recovered",
    ]);
    expect(claude.coordinator.getSnapshot()).toMatchObject({ paused: false, gateClosed: false, pauseSide: null });
  });

  test("queues pending Codex overrides, clears after delivery, and does not requeue same tier", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 60 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 60 }) },
    ]);
    const { coordinator } = makeCoordinator(source, { ...CONFIG, codexTierControl: true });

    await coordinator.start();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "medium" });
    coordinator.notifyOverridesDelivered();
    expect(coordinator.getCodexTurnOverrides()).toBeNull();

    await waitFor(() => source.calls >= 2);
    coordinator.stop();
    expect(coordinator.getCodexTurnOverrides()).toBeNull();
  });

  test("updates pending Codex overrides to the latest tier before delivery", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 60 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 80 }) },
    ]);
    const { coordinator } = makeCoordinator(source, { ...CONFIG, codexTierControl: true });

    await coordinator.start();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "medium" });

    await waitFor(() => source.calls >= 2);
    coordinator.stop();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "low" });
  });

  test("returns null overrides when Codex tier control is disabled", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 80 }) },
    ]);
    const { coordinator } = makeCoordinator(source, { ...CONFIG, codexTierControl: false });

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.getCodexTurnOverrides()).toBeNull();
  });

  test("stores Claude tiering advice in the latest snapshot", async () => {
    const source = new FakeSource([
      { claude: usage({ gateUtil: 20, warnUtil: 80 }), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
    ]);
    const { coordinator } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.getSnapshot()?.claudeAdvice).toContain("haiku");
  });

  test("queues explicit full restore after delivering a lower tier", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 80 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
    ]);
    const { coordinator } = makeCoordinator(source, { ...CONFIG, codexTierControl: true });

    await coordinator.start();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "low" });
    coordinator.notifyOverridesDelivered();
    expect(coordinator.getCodexTurnOverrides()).toBeNull();

    await waitFor(() => source.calls >= 2);
    coordinator.stop();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "high" });
  });

  test("disables Codex tier control when full restore mapping is missing", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 80 }) },
    ]);
    const { coordinator, logs } = makeCoordinator(source, {
      ...CONFIG,
      codexTierControl: true,
      codexTiers: { ...CONFIG.codexTiers, full: null },
    });

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.getCodexTurnOverrides()).toBeNull();
    expect(logs.filter((message) => message.includes("full restore mapping"))).toHaveLength(1);
  });
});

describe("decision-grade data guards (stale cache / expired windows)", () => {
  test("expired-window stale cache does NOT enter intervention", async () => {
    // Real-machine shape: probe serves an hours-old cache during an upstream
    // outage — every window's resetEpoch is already in the past. Trusting it
    // would open (and freeze) a pause whose "resume estimate" predates now.
    const source = new FakeSource([
      {
        claude: usage(),
        codex: usage({
          gateUtil: 95,
          fiveHour: { util: 95, resetEpoch: NOW - 5400 },
          weekly: { util: 95, resetEpoch: NOW - 100 },
          fetchedAt: NOW - 7200,
        }),
      },
    ]);
    const emitted: Array<{ id: string }> = [];
    const coordinator = new BudgetCoordinator({
      source: source as any,
      config: CONFIG,
      emit: (id) => emitted.push({ id }),
      onPauseChange: () => {},
      now: () => NOW,
    });
    await coordinator.start();
    coordinator.stop();
    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(emitted.some((e) => e.id.startsWith("system_budget_pause"))).toBe(false);
    expect(emitted.some((e) => e.id.startsWith("system_budget_handoff"))).toBe(false);
  });

  test("fresh-window but ancient fetchedAt does NOT enter intervention", async () => {
    const source = new FakeSource([
      {
        claude: usage(),
        codex: usage({ gateUtil: 95, fetchedAt: NOW - 3600 }),
      },
    ]);
    const coordinator = new BudgetCoordinator({
      source: source as any,
      config: CONFIG,
      emit: () => {},
      onPauseChange: () => {},
      now: () => NOW,
    });
    await coordinator.start();
    coordinator.stop();
    expect(coordinator.isPaused()).toBe(false);
  });

  test("windowless rate-limit record cannot AUTHORIZE resume at throttle expiry", async () => {
    // Poll 1: codex genuinely over the gate → pause. Poll 2: a rate-limit-only
    // record (no windows, util 0) whose throttle just expired — gateUtil=0 must
    // NOT read as "recovered" (it is absence of information, not a measurement).
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 95 }) },
      {
        claude: usage(),
        codex: usage({
          ok: false,
          gateUtil: 0,
          warnUtil: 0,
          fiveHour: null,
          weekly: null,
          rateLimitedUntil: NOW - 1,
        }),
      },
    ]);
    const emitted: Array<{ id: string }> = [];
    const coordinator = new BudgetCoordinator({
      source: source as any,
      config: CONFIG,
      emit: (id) => emitted.push({ id }),
      onPauseChange: () => {},
      now: () => NOW,
    });
    await coordinator.start();
    await (coordinator as any).pollOnce();
    coordinator.stop();
    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(true);
    expect(emitted.some((e) => e.id.startsWith("system_budget_resume"))).toBe(false);
  });

  test("resetAppliedTier re-arms the override after a thread switch", async () => {
    const tierConfig: BudgetConfig = {
      ...CONFIG,
      codexTierControl: true,
      codexTiers: { full: { effort: "high" }, balanced: { effort: "medium" }, eco: { effort: "low" } },
    };
    // codex warnUtil 85 → eco band on every poll.
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 40, warnUtil: 85 }) },
      { claude: usage(), codex: usage({ gateUtil: 40, warnUtil: 85 }) },
    ]);
    const coordinator = new BudgetCoordinator({
      source: source as any,
      config: tierConfig,
      emit: () => {},
      onPauseChange: () => {},
      now: () => NOW,
    });
    await coordinator.start();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "low" });
    coordinator.notifyOverridesDelivered();
    expect(coordinator.getCodexTurnOverrides()).toBeNull(); // delivered — no requeue for same tier

    // Thread switch: the new thread runs at its defaults; stale bookkeeping
    // would keep suppressing the override forever.
    coordinator.resetAppliedTier();
    await (coordinator as any).pollOnce();
    coordinator.stop();
    expect(coordinator.getCodexTurnOverrides()).toEqual({ effort: "low" });
  });
});
