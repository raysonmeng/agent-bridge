import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetCoordinator, nextBudgetPollDelayMs } from "../budget/budget-coordinator";
import { AdviceCooldown } from "../budget/advice-cooldown";
import type { ResumeSignals } from "../budget/budget-fingerprint";
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
  maximize: { targetUtil: 97, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
  allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
};

type FetchResult = { claude: AgentUsage | null; codex: AgentUsage | null } | null;
type ScheduledCallback = () => void | Promise<void>;

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
    parsedVia: "id-match",
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

class FakeScheduler {
  scheduled: Array<{ delayMs: number; callback: ScheduledCallback; active: boolean }> = [];

  setTimeout(callback: ScheduledCallback, delayMs: number): number {
    const id = this.scheduled.length;
    this.scheduled.push({ delayMs, callback, active: true });
    return id;
  }

  clearTimeout(id: number): void {
    if (this.scheduled[id]) this.scheduled[id].active = false;
  }

  async runNext(): Promise<void> {
    const next = this.scheduled.find((timer) => timer.active);
    if (!next) throw new Error("no active scheduled timer");
    next.active = false;
    await next.callback();
  }
}

function makeCoordinator(
  source: FakeSource,
  config: BudgetConfig = CONFIG,
  adviceCooldown?: AdviceCooldown,
) {
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
    adviceCooldown,
  });

  return { coordinator, emitted, pauseChanges, logs };
}

/** Weekly window with a confident low burn rate → will-not-fill → underutilized. */
function underutilizedUsage(): AgentUsage {
  return usage({
    gateUtil: 20,
    warnUtil: 20,
    weekly: { util: 20, resetEpoch: NOW + 500_000, burnRate: 0.1, burnConfident: true },
  });
}

function readySignals(overrides: Partial<ResumeSignals> = {}): ResumeSignals {
  return {
    tuiReady: { codex: true, claude: true },
    pendingExists: { codex: true, claude: true },
    checkpointExists: true,
    ...overrides,
  };
}

function longPollConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    ...CONFIG,
    pollSeconds: 300,
    ...overrides,
  };
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
  test("calls onSnapshot after latestSnapshot is updated", async () => {
    const source = new FakeSource([{ claude: usage(), codex: usage({ gateUtil: 25, warnUtil: 25 }) }]);
    let coordinator: BudgetCoordinator;
    const snapshots: Array<{
      snapshot: ReturnType<BudgetCoordinator["getSnapshot"]>;
      current: ReturnType<BudgetCoordinator["getSnapshot"]>;
    }> = [];
    coordinator = new BudgetCoordinator({
      source,
      config: CONFIG,
      emit: () => {},
      onPauseChange: () => {},
      now: () => NOW,
      onSnapshot: (snapshot) => {
        snapshots.push({ snapshot, current: coordinator.getSnapshot() });
      },
    });

    await coordinator.start();
    coordinator.stop();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.snapshot).toBe(coordinator.getSnapshot());
    expect(snapshots[0]!.current).toBe(snapshots[0]!.snapshot);
    expect(snapshots[0]!.snapshot).toMatchObject({ codex: { gateUtil: 25 } });
  });

  test("adaptive poll delay uses longer intervals far from thresholds", () => {
    const config = longPollConfig();

    expect(nextBudgetPollDelayMs({
      config,
      now: NOW,
      usage: { claude: usage({ gateUtil: 20, warnUtil: 25 }), codex: usage({ gateUtil: 10, warnUtil: 15 }) },
      paused: false,
    })).toBe(300_000);

    expect(nextBudgetPollDelayMs({
      config,
      now: NOW,
      usage: { claude: usage({ gateUtil: 55, warnUtil: 55 }), codex: usage({ gateUtil: 40, warnUtil: 40 }) },
      paused: false,
    })).toBe(150_000);

    expect(nextBudgetPollDelayMs({
      config,
      now: NOW,
      usage: { claude: usage({ gateUtil: 82, warnUtil: 82 }), codex: usage({ gateUtil: 40, warnUtil: 40 }) },
      paused: false,
    })).toBe(60_000);
  });

  test("adaptive poll delay stays short during an active intervention", () => {
    expect(nextBudgetPollDelayMs({
      config: longPollConfig(),
      now: NOW,
      usage: { claude: usage({ gateUtil: 91, warnUtil: 91 }), codex: usage() },
      paused: true,
    })).toBe(15_000);
  });

  test("adaptive poll delay aligns to nearby reset epochs", () => {
    const config = longPollConfig();
    expect(nextBudgetPollDelayMs({
      config,
      now: NOW,
      usage: {
        claude: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 42 } }),
        codex: usage({ gateUtil: 15, warnUtil: 15, fiveHour: { util: 15, resetEpoch: NOW + 3600 } }),
      },
      paused: false,
    })).toBe(47_000);

    expect(nextBudgetPollDelayMs({
      config,
      now: NOW,
      usage: {
        claude: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW - 20 } }),
        codex: usage({ gateUtil: 15, warnUtil: 15 }),
      },
      paused: false,
    })).toBe(5_000);
  });

  test("scheduler seam arms reset-aligned timers without wall-clock waits", async () => {
    let now = NOW;
    const scheduler = new FakeScheduler();
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 42 } }),
        codex: usage({ gateUtil: 15, warnUtil: 15 }),
      },
      { claude: usage({ gateUtil: 21, warnUtil: 21 }), codex: usage({ gateUtil: 16, warnUtil: 16 }) },
    ]);
    const coordinator = new BudgetCoordinator({
      source,
      config: longPollConfig(),
      emit: () => {},
      onPauseChange: () => {},
      now: () => now,
      scheduler,
    });

    await coordinator.start();
    expect(source.calls).toBe(1);
    expect(scheduler.scheduled.at(-1)?.delayMs).toBe(47_000);

    now += 47;
    await scheduler.runNext();
    coordinator.stop();

    expect(source.calls).toBe(2);
    expect(scheduler.scheduled.at(-1)?.delayMs).toBe(300_000);
  });

  test("fake scheduler preserves pause hysteresis and quick recovery polling", async () => {
    let now = NOW;
    const scheduler = new FakeScheduler();
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }) },
      { claude: usage(), codex: usage({ gateUtil: 50, warnUtil: 50, remaining: 50 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }) },
    ]);
    const emitted: Array<{ id: string; content: string }> = [];
    const pauseChanges: boolean[] = [];
    const coordinator = new BudgetCoordinator({
      source,
      config: longPollConfig(),
      emit: (id, content) => emitted.push({ id, content }),
      onPauseChange: (paused) => pauseChanges.push(paused),
      now: () => now,
      scheduler,
    });

    await coordinator.start();
    expect(coordinator.isPaused()).toBe(true);
    expect(scheduler.scheduled.at(-1)?.delayMs).toBe(15_000);

    now += 15;
    await scheduler.runNext();
    expect(coordinator.isPaused()).toBe(true);
    expect(emitted.some((event) => event.id.startsWith("system_budget_resume"))).toBe(false);
    expect(scheduler.scheduled.at(-1)?.delayMs).toBe(15_000);

    now += 15;
    await scheduler.runNext();
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(false);
    expect(pauseChanges).toEqual([true, false]);
    expect(emitted.some((event) => event.id.startsWith("system_budget_resume"))).toBe(true);
  });

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

  test("holds balance directive across a non-decision-grade blip (observed live: phantom 0% record flipped the heavier side)", async () => {
    // A transient empty probe record (gate=0, no windows) must not flap the
    // balance directive: during the blip the heavier side flips to a phantom,
    // and on recovery the unchanged real state must re-emit nothing.
    const drifted = {
      claude: usage({ gateUtil: 35, warnUtil: 45 }),
      codex: usage({ gateUtil: 20, warnUtil: 20 }),
    };
    const source = new FakeSource([
      drifted,
      {
        claude: usage({ gateUtil: 0, warnUtil: 0, fiveHour: null, weekly: null }),
        codex: usage({ gateUtil: 20, warnUtil: 20 }),
      },
      drifted,
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 3);
    coordinator.stop();

    expect(
      emitted.filter((event) => event.id.startsWith("system_budget_balance") || event.id.startsWith("system_budget_parallel")),
    ).toHaveLength(1);
  });

  test("a blip that deflates drift below threshold must not reset the dedup fingerprint", async () => {
    // Ordering regression guard: the decision-grade hold must run BEFORE the
    // null-directive branch — a phantom that makes the drift directive
    // disappear would otherwise clear the fingerprint and re-emit the same
    // directive when the data recovers.
    // Note the gate condition is the blip's fiveHour/weekly being null (no
    // fresh window → not decision-grade), NOT the drift magnitude — a blip
    // with valid windows would legitimately update the directive.
    const drifted = {
      claude: usage({ gateUtil: 15, warnUtil: 15 }),
      codex: usage({ gateUtil: 2, warnUtil: 2 }),
    };
    const source = new FakeSource([
      drifted,
      {
        claude: usage({ gateUtil: 0, warnUtil: 0, fiveHour: null, weekly: null }),
        codex: usage({ gateUtil: 2, warnUtil: 2 }),
      },
      drifted,
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 3);
    coordinator.stop();

    expect(
      emitted.filter((event) => event.id.startsWith("system_budget_balance") || event.id.startsWith("system_budget_parallel")),
    ).toHaveLength(1);
  });

  test("does not re-emit balance directive on probe reset-epoch jitter (observed live: ±1s per poll)", async () => {
    // The probe's reset_epoch wobbles by a second between polls. A raw epoch
    // in the directive fingerprint re-emitted the same balance directive
    // every 60s poll — one spam notification per minute for as long as the
    // drift persisted.
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 35, warnUtil: 45 }),
        codex: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3600 } }),
      },
      {
        claude: usage({ gateUtil: 35, warnUtil: 45 }),
        codex: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3601 } }),
      },
      {
        claude: usage({ gateUtil: 35, warnUtil: 45 }),
        codex: usage({ gateUtil: 20, warnUtil: 20, fiveHour: { util: 20, resetEpoch: NOW + 3599 } }),
      },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 3);
    coordinator.stop();

    expect(emitted.filter((event) => event.id.startsWith("system_budget_balance"))).toHaveLength(1);
  });

  test("degraded display-only record must not queue a codex tier override (#103)", async () => {
    // warnUtil 85 would select "eco" — but the record's only window has an
    // unknown reset (resetEpoch 0, the #103 degraded shape), so the tier
    // decision must fall back to "full" / no override, exactly like a probe
    // miss. Display-layer acceptance must never reach the override queue.
    const tierConfig = { ...CONFIG, codexTierControl: true };

    // Positive control first: the same warnUtil on DECISION-GRADE data does
    // queue the eco override — proving the mechanism is live, so the degraded
    // case below blocks specifically on data quality, not on configuration.
    const freshSource = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 85, warnUtil: 85 }) },
    ]);
    const fresh = makeCoordinator(freshSource, tierConfig);
    await fresh.coordinator.start();
    await waitFor(() => freshSource.calls >= 1);
    fresh.coordinator.stop();
    expect(fresh.coordinator.getCodexTurnOverrides()).toEqual({ effort: "low" });

    const source = new FakeSource([
      {
        claude: usage(),
        codex: usage({ gateUtil: 85, warnUtil: 85, stale: true, fiveHour: { util: 85, resetEpoch: 0 }, weekly: null }),
      },
    ]);
    const { coordinator } = makeCoordinator(source, tierConfig);

    await coordinator.start();
    await waitFor(() => source.calls >= 1);
    coordinator.stop();

    expect(coordinator.getCodexTurnOverrides()).toBeNull();
    expect(coordinator.getSnapshot()?.codexTier).toBe("full");
  });

  test("mid-pause degraded record holds the pause directive fingerprint (#103)", async () => {
    // Pause entered on decision-grade data; the next poll returns a degraded
    // stale windowless record WITHOUT a rate-limit gate (the shape that
    // previously normalized to null and was held by the probe-uncertain
    // check). It must still hold — not recompute the fingerprint against a
    // phantom reset bucket and re-emit the pause directive.
    const source = new FakeSource([
      { claude: usage(), codex: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }) },
      {
        claude: usage(),
        codex: usage({ gateUtil: 0, warnUtil: 0, stale: true, fiveHour: { util: 0, resetEpoch: 0 }, weekly: null }),
      },
      {
        claude: usage(),
        codex: usage({ gateUtil: 0, warnUtil: 0, stale: true, fiveHour: { util: 0, resetEpoch: 0 }, weekly: null }),
      },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 3);
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(emitted.filter((event) => event.id.startsWith("system_budget_pause"))).toHaveLength(1);
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

  test("maximize: recovery directive describes the dynamic line, not resumeBelow (Q10)", async () => {
    const maximizeConfig: BudgetConfig = { ...CONFIG };
    const source = new FakeSource([
      { claude: usage(), codex: usage() },
      { claude: usage(), codex: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }) },
      { claude: usage(), codex: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }) },
    ]);
    const { coordinator, emitted } = makeCoordinator(source, maximizeConfig);

    await coordinator.start();
    await waitFor(() => emitted.some((event) => event.id.startsWith("system_budget_pause")));
    await waitFor(() => emitted.some((event) => event.id.startsWith("system_budget_resume")));
    coordinator.stop();

    const resume = emitted.find((event) => event.id.startsWith("system_budget_resume"));
    expect(resume?.content).toContain("动态暂停线");
    expect(resume?.content).not.toContain("低于 30%");
  });

  test("maximize CONFIDENT path: coordinator enter→exit on the dynamic line", async () => {
    const maximizeConfig: BudgetConfig = { ...CONFIG };
    // fiveHour with a confident guard burn rate: tH=1h, rate=1.2 → line 95.6.
    const codexUsage = (fiveHourUtil: number): AgentUsage => ({
      ok: true,
      stale: false,
      gateUtil: fiveHourUtil,
      warnUtil: fiveHourUtil,
      fiveHour: { util: fiveHourUtil, resetEpoch: NOW + 3600, burnRate: 1.2, burnConfident: true },
      weekly: { util: 10, resetEpoch: NOW + 500_000, burnRate: 0.4, burnConfident: true },
      remaining: 100 - fiveHourUtil,
      rateLimitedUntil: 0,
      fetchedAt: NOW,
      parsedVia: "id-match",
    });
    const source = new FakeSource([
      { claude: usage(), codex: codexUsage(96) }, // 96 ≥ line 95.6 → pause (confident b-branch)
      { claude: usage(), codex: codexUsage(88) }, // 88 → projected 89.2 ≤ 97 → won't-fill → resume
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source, maximizeConfig);

    await coordinator.start();
    await waitFor(() => emitted.some((e) => e.id.startsWith("system_budget_pause")));
    await waitFor(() => emitted.some((e) => e.id.startsWith("system_budget_resume")));
    coordinator.stop();

    expect(pauseChanges).toEqual([true, false]);
    const pause = emitted.find((e) => e.id.startsWith("system_budget_pause"));
    expect(pause?.content).toContain("动态暂停线"); // confident path → dynamic-line reason
    const resume = emitted.find((e) => e.id.startsWith("system_budget_resume"));
    expect(resume?.content).toContain("动态暂停线");
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
      "system_budget_claude_recovered",
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
      "system_budget_resume",
      "system_budget_handoff",
    ]);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: false, pauseSide: "claude" });
  });

  test("partial recovery emits Codex resume, calls onResume once, and leaves Claude handoff active", async () => {
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      },
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
    ]);
    const emitted: Array<{ id: string; content: string }> = [];
    const resumes: Array<{ side: "claude" | "codex"; directive: string; resumeId: string; gateClosed: boolean; paused: boolean }> = [];
    let coordinator: BudgetCoordinator;
    coordinator = new BudgetCoordinator({
      source,
      config: longPollConfig(),
      emit: (id, content) => emitted.push({ id, content }),
      onPauseChange: () => {},
      onResume: (side, directive, resumeId) => {
        resumes.push({ side, directive, resumeId, gateClosed: coordinator.isGateClosed(), paused: coordinator.isPaused() });
      },
      now: () => NOW,
      resumeSignals: () => readySignals(),
    });

    await coordinator.start();
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: true, gateClosed: false, pauseSide: "claude" });
    expect(coordinator.getResumeCandidate().codex).toBe(true);
    expect(coordinator.getResumeCandidate().claude).toBeUndefined();
    expect(emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_pause",
      "system_budget_resume",
      "system_budget_handoff",
    ]);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ side: "codex" });
    expect(resumes[0].resumeId).toBe(emitted[1].id);
    expect(resumes[0].directive).toBe(emitted[1].content);
    expect(resumes[0].gateClosed).toBe(false);
    expect(resumes[0].paused).toBe(true);

    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    coordinator.stop();

    expect(resumes).toHaveLength(1);
    expect(emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_pause",
      "system_budget_resume",
      "system_budget_handoff",
    ]);
  });

  test("final recovery after a partial recovery emits the remaining side only", async () => {
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      },
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
      { claude: usage(), codex: usage() },
    ]);
    const emitted: Array<{ id: string; content: string }> = [];
    const resumes: Array<{ side: "claude" | "codex"; directive: string; resumeId: string }> = [];
    const coordinator = new BudgetCoordinator({
      source,
      config: longPollConfig(),
      emit: (id, content) => emitted.push({ id, content }),
      onPauseChange: () => {},
      onResume: (side, directive, resumeId) => resumes.push({ side, directive, resumeId }),
      now: () => NOW,
      resumeSignals: () => readySignals(),
    });

    await coordinator.start();
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.isGateClosed()).toBe(false);
    expect(emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_pause",
      "system_budget_resume",
      "system_budget_handoff",
      "system_budget_claude_recovered",
    ]);
    expect(resumes.map((resume) => resume.side)).toEqual(["codex", "claude"]);
    expect(resumes[0].resumeId).toBe(emitted[1].id);
    expect(resumes[1].resumeId).toBe(emitted[3].id);
  });

  test("full recovery from joint pause emits both per-side recovery directives", async () => {
    const source = new FakeSource([
      {
        claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }),
        codex: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      },
      { claude: usage(), codex: usage() },
    ]);
    const emitted: Array<{ id: string; content: string }> = [];
    const resumes: Array<{ side: "claude" | "codex"; directive: string; resumeId: string }> = [];
    const coordinator = new BudgetCoordinator({
      source,
      config: longPollConfig(),
      emit: (id, content) => emitted.push({ id, content }),
      onPauseChange: () => {},
      onResume: (side, directive, resumeId) => resumes.push({ side, directive, resumeId }),
      now: () => NOW,
      resumeSignals: () => readySignals(),
    });

    await coordinator.start();
    await (coordinator as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    coordinator.stop();

    expect(emitted.map((event) => event.id.replace(/_\d+$/, ""))).toEqual([
      "system_budget_pause",
      "system_budget_claude_recovered",
      "system_budget_resume",
    ]);
    expect(resumes.map(({ side }) => ({ side }))).toEqual([{ side: "claude" }, { side: "codex" }]);
    expect(resumes[0].resumeId).toBe(emitted[1].id);
    expect(resumes[1].resumeId).toBe(emitted[2].id);
    expect(resumes[0].directive).toBe(emitted[1].content);
    expect(resumes[1].directive).toBe(emitted[2].content);
    expect(coordinator.getSnapshot()).toMatchObject({ paused: false, gateClosed: false, pauseSide: null });
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

describe("BudgetCoordinator — guard burn-field passthrough (v3 P1, layered amendment)", () => {
  // The bridge is a pure consumer: rates/runway come verbatim from the guard's
  // probe fields on each window; the coordinator only selects the minimum
  // runway across decision-grade confident windows.

  test("snapshot passes guard burn fields through and selects the binding runway", async () => {
    const claude = usage({
      fiveHour: {
        util: 20,
        resetEpoch: NOW + 3600,
        burnRate: 1.2,
        burnConfident: true,
        runwaySeconds: 1800,
        depletedAtEpoch: NOW + 1800,
      },
      weekly: {
        util: 20,
        resetEpoch: NOW + 500_000,
        burnRate: 0.5,
        burnConfident: true,
        runwaySeconds: 7200,
        depletedAtEpoch: NOW + 7200,
      },
    });
    const source = new FakeSource([{ claude, codex: usage() }]);
    const { coordinator } = makeCoordinator(source, longPollConfig());
    await coordinator.start();
    coordinator.stop();

    const snapshot = coordinator.getSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.burnRate?.claude.fiveHour).toEqual({ pctPerHour: 1.2, confident: true });
    expect(snapshot!.burnRate?.claude.weekly).toEqual({ pctPerHour: 0.5, confident: true });
    expect(snapshot!.burnRate?.codex).toEqual({ fiveHour: null, weekly: null });
    // Minimum across windows: 1800s (fiveHour) < 7200s (weekly).
    expect(snapshot!.runway?.claude).toEqual({
      seconds: 1800,
      basis: "fiveHour",
      depletedAtEpoch: NOW + 1800,
    });
    expect(snapshot!.runway?.codex).toBeNull();
  });

  test("legacy probe output without burn fields keeps the legacy snapshot shape", async () => {
    const source = new FakeSource([{ claude: usage(), codex: usage() }]);
    const { coordinator } = makeCoordinator(source, longPollConfig());
    await coordinator.start();
    coordinator.stop();

    const snapshot = coordinator.getSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.burnRate).toBeUndefined();
    expect(snapshot!.runway).toBeUndefined();
  });

  test("non-confident window passes the rate through but never yields a runway (conserve)", async () => {
    const claude = usage({
      fiveHour: {
        util: 20,
        resetEpoch: NOW + 3600,
        burnRate: 1.2,
        burnConfident: false,
        runwaySeconds: 1800,
      },
    });
    const source = new FakeSource([{ claude, codex: usage() }]);
    const { coordinator } = makeCoordinator(source, longPollConfig());
    await coordinator.start();
    coordinator.stop();

    const snapshot = coordinator.getSnapshot();
    expect(snapshot!.burnRate?.claude.fiveHour).toEqual({ pctPerHour: 1.2, confident: false });
    expect(snapshot!.runway?.claude).toBeNull();
  });

  test("stale records never yield a runway even with confident guard fields (conserve)", async () => {
    const claude = usage({
      stale: true,
      // fetchedAt far in the past → fails isDecisionGrade's freshness check.
      fetchedAt: NOW - 100_000,
      fiveHour: {
        util: 20,
        resetEpoch: NOW + 3600,
        burnRate: 1.2,
        burnConfident: true,
        runwaySeconds: 1800,
        depletedAtEpoch: NOW + 1800,
      },
    });
    const source = new FakeSource([{ claude, codex: usage() }]);
    const { coordinator } = makeCoordinator(source, longPollConfig());
    await coordinator.start();
    coordinator.stop();

    const snapshot = coordinator.getSnapshot();
    // Rate is display-grade (like stale util itself); runway is decision-adjacent → dropped.
    expect(snapshot!.burnRate?.claude.fiveHour).toEqual({ pctPerHour: 1.2, confident: true });
    expect(snapshot!.runway?.claude).toBeNull();
  });

  test("reset-unknown window (resetEpoch 0) never yields a runway (conserve)", async () => {
    const claude = usage({
      fiveHour: {
        util: 20,
        resetEpoch: 0,
        burnRate: 1.2,
        burnConfident: true,
        runwaySeconds: 1800,
      },
    });
    const source = new FakeSource([{ claude, codex: usage() }]);
    const { coordinator } = makeCoordinator(source, longPollConfig());
    await coordinator.start();
    coordinator.stop();

    const snapshot = coordinator.getSnapshot();
    expect(snapshot!.burnRate?.claude.fiveHour).toEqual({ pctPerHour: 1.2, confident: true });
    expect(snapshot!.runway?.claude).toBeNull();
  });
});

describe("BudgetCoordinator — v3 P4 underutilization cooldown gate", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "abg-coord-cooldown-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("emits system_budget_underutilized when the cooldown allows", async () => {
    const source = new FakeSource([{ claude: underutilizedUsage(), codex: underutilizedUsage() }]);
    const cooldown = new AdviceCooldown({ homeDir: home, cooldownSec: 1800 });
    const { coordinator, emitted } = makeCoordinator(source, longPollConfig(), cooldown);
    await coordinator.start();
    coordinator.stop();

    expect(coordinator.getSnapshot()!.phase).toBe("underutilized");
    expect(emitted.some((e) => e.id.startsWith("system_budget_underutilized"))).toBe(true);
  });

  test("suppresses the emit when the cross-pair cooldown is already held", async () => {
    // Another pair (same state dir) already emitted: pre-seed the cooldown.
    new AdviceCooldown({ homeDir: home, cooldownSec: 1800 }).tryAcquire("underutilization", NOW);

    const source = new FakeSource([{ claude: underutilizedUsage(), codex: underutilizedUsage() }]);
    const cooldown = new AdviceCooldown({ homeDir: home, cooldownSec: 1800 });
    const { coordinator, emitted } = makeCoordinator(source, longPollConfig(), cooldown);
    await coordinator.start();
    coordinator.stop();

    // The phase is still computed (snapshot reflects it), but emission is gated.
    expect(coordinator.getSnapshot()!.phase).toBe("underutilized");
    expect(emitted.some((e) => e.id.startsWith("system_budget_underutilized"))).toBe(false);
  });
});

describe("gateState — v3 P3 three-state gate (M2)", () => {
  async function gateAfterPoll(claudeU: AgentUsage | null, codexU: AgentUsage | null) {
    const source = new FakeSource([{ claude: claudeU, codex: codexU }]);
    const { coordinator } = makeCoordinator(source);
    await coordinator.start();
    return coordinator;
  }

  test("open when neither side is admission-closed or paused", async () => {
    const c = await gateAfterPoll(usage({ gateUtil: 20 }), usage({ gateUtil: 20 }));
    expect(c.gateState()).toBe("open");
    expect(c.getSnapshot()?.gateState).toBe("open");
  });

  test("admission-closed when Codex 5h util >= admissionAt but below the pause line", async () => {
    const c = await gateAfterPoll(usage({ gateUtil: 20 }), usage({ gateUtil: 86 }));
    expect(c.isGateClosed()).toBe(false); // not the pause gate
    expect(c.gateState()).toBe("admission-closed");
    expect(c.getSnapshot()?.gateState).toBe("admission-closed");
  });

  test("closed (pause) takes precedence over admission-closed", async () => {
    // Codex util 95 → pause (>= pauseAt 90) AND admission (>= 85); closed wins.
    const c = await gateAfterPoll(usage({ gateUtil: 20 }), usage({ gateUtil: 95 }));
    expect(c.isGateClosed()).toBe(true);
    expect(c.gateState()).toBe("closed");
    expect(c.getSnapshot()?.gateState).toBe("closed");
  });

  test("Claude-side admission does NOT close the daemon gate (gates Codex turns only)", async () => {
    const c = await gateAfterPoll(usage({ gateUtil: 86 }), usage({ gateUtil: 20 }));
    expect(c.gateState()).toBe("open");
  });
});
