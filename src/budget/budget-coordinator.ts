import { computeBudgetState, renderBudgetInterventionDirective } from "./budget-state";
import {
  classifyPoll,
  INITIAL_FINGERPRINT_STATE,
  type FingerprintState,
} from "./budget-fingerprint";
import type {
  AgentName,
  AgentUsage,
  BudgetConfig,
  BudgetSnapshot,
  BudgetState,
  CodexTier,
  CodexTurnOverrides,
} from "./types";
import type { QuotaSource } from "./quota-source";

type QuotaSourceLike = Pick<QuotaSource, "fetchBoth">;
type PauseSide = BudgetSnapshot["pauseSide"];
type BudgetPollTimer = unknown;
type BudgetPollCallback = () => void | Promise<void>;

export interface BudgetPollScheduler {
  setTimeout(callback: BudgetPollCallback, delayMs: number): BudgetPollTimer;
  clearTimeout(timer: BudgetPollTimer): void;
}

export interface BudgetPollDelayInput {
  config: Pick<BudgetConfig, "pollSeconds" | "pauseAt">;
  usage: { claude: AgentUsage | null; codex: AgentUsage | null } | null;
  now: number;
  paused: boolean;
}

const LOW_UTIL_PCT = 50;
const NEAR_PAUSE_MARGIN_PCT = 10;
const NEAR_WARN_UTIL_PCT = 75;
const NEAR_THRESHOLD_POLL_MS = 60_000;
const PAUSED_POLL_MS = 15_000;
const RESET_WAKE_AFTER_SEC = 5;
const RESET_RECENTLY_PASSED_WINDOW_SEC = 120;

const REAL_BUDGET_POLL_SCHEDULER: BudgetPollScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(() => {
      void callback();
    }, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export interface BudgetCoordinatorOptions {
  source: QuotaSourceLike;
  config: BudgetConfig;
  emit: (id: string, content: string) => void;
  onPauseChange: (paused: boolean) => void;
  onSnapshot?: (snapshot: BudgetSnapshot | null) => void;
  now?: () => number;
  scheduler?: BudgetPollScheduler;
  log?: (message: string) => void;
}

const AGENT_LABEL: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function usageLine(agent: AgentName, usage: AgentUsage | null): string {
  if (!usage) return `${AGENT_LABEL[agent]} 未知`;
  return `${AGENT_LABEL[agent]} gate=${pct(usage.gateUtil)} warn=${pct(usage.warnUtil)}`;
}

function maxPollDelayMs(config: Pick<BudgetConfig, "pollSeconds">): number {
  return Math.max(0, config.pollSeconds * 1000);
}

function capDelay(delayMs: number, maxDelayMs: number): number {
  if (maxDelayMs <= 0) return 0;
  return Math.min(delayMs, maxDelayMs);
}

function usagePressure(usage: { claude: AgentUsage | null; codex: AgentUsage | null } | null): number | null {
  const readings = [usage?.claude, usage?.codex]
    .filter((agentUsage): agentUsage is AgentUsage => agentUsage !== null && agentUsage !== undefined)
    .flatMap((agentUsage) => [agentUsage.gateUtil, agentUsage.warnUtil]);
  if (readings.length === 0) return null;
  return Math.max(...readings);
}

function usageResetEpochs(usage: { claude: AgentUsage | null; codex: AgentUsage | null } | null): number[] {
  return [usage?.claude, usage?.codex]
    .filter((agentUsage): agentUsage is AgentUsage => agentUsage !== null && agentUsage !== undefined)
    .flatMap((agentUsage) => [agentUsage.fiveHour?.resetEpoch ?? 0, agentUsage.weekly?.resetEpoch ?? 0])
    .filter((epoch) => epoch > 0);
}

function adaptiveBudgetPollDelayMs(input: BudgetPollDelayInput): number {
  const maxDelayMs = maxPollDelayMs(input.config);
  if (input.paused) return capDelay(PAUSED_POLL_MS, maxDelayMs);

  const pressure = usagePressure(input.usage);
  if (pressure === null || pressure < LOW_UTIL_PCT) return maxDelayMs;

  const nearPauseAt = Math.max(0, input.config.pauseAt - NEAR_PAUSE_MARGIN_PCT);
  if (pressure >= nearPauseAt || pressure >= NEAR_WARN_UTIL_PCT) {
    return capDelay(NEAR_THRESHOLD_POLL_MS, maxDelayMs);
  }

  return capDelay(maxDelayMs / 2, maxDelayMs);
}

function resetAlignedDelayMs(input: BudgetPollDelayInput, adaptiveDelayMs: number): number | null {
  const epochs = usageResetEpochs(input.usage);
  if (epochs.length === 0) return null;

  const candidates = epochs
    .map((epoch) => {
      if (epoch >= input.now) return (epoch - input.now + RESET_WAKE_AFTER_SEC) * 1000;
      if (input.now - epoch <= RESET_RECENTLY_PASSED_WINDOW_SEC) return RESET_WAKE_AFTER_SEC * 1000;
      return null;
    })
    .filter((delayMs): delayMs is number => delayMs !== null && delayMs >= 0 && delayMs <= adaptiveDelayMs);

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export function nextBudgetPollDelayMs(input: BudgetPollDelayInput): number {
  const adaptiveDelayMs = adaptiveBudgetPollDelayMs(input);
  return resetAlignedDelayMs(input, adaptiveDelayMs) ?? adaptiveDelayMs;
}

export class BudgetCoordinator {
  private readonly source: QuotaSourceLike;
  private readonly config: BudgetConfig;
  private readonly emit: (id: string, content: string) => void;
  private readonly onPauseChange: (paused: boolean) => void;
  private readonly onSnapshot: (snapshot: BudgetSnapshot | null) => void;
  private readonly now: () => number;
  private readonly scheduler: BudgetPollScheduler;
  private readonly log: (message: string) => void;

  private timer: BudgetPollTimer | null = null;
  private running = false;
  // Single source of truth for the directive state machine (side / fingerprint
  // / resume bookkeeping). Replaces the former 4 mutable fields
  // (activeSides, lastDirectiveFingerprint, pauseReason, pauseResumeAfterEpoch).
  private fpState: FingerprintState = INITIAL_FINGERPRINT_STATE;
  private latestSnapshot: BudgetSnapshot | null = null;
  private pendingOverrideTier: CodexTier | null = null;
  private pendingOverrides: CodexTurnOverrides | null = null;
  private lastAppliedTier: CodexTier = "full";
  private missingFullMappingLogged = false;
  private sequence = 0;

  constructor(options: BudgetCoordinatorOptions) {
    this.source = options.source;
    this.config = options.config;
    this.emit = options.emit;
    this.onPauseChange = options.onPauseChange;
    this.onSnapshot = options.onSnapshot ?? (() => {});
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.scheduler = options.scheduler ?? REAL_BUDGET_POLL_SCHEDULER;
    this.log = options.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.running || !this.config.enabled) return;
    this.running = true;
    await this.pollOnce();
    if (this.running) this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isPaused(): boolean {
    return this.fpState.side !== null;
  }

  isGateClosed(): boolean {
    return this.fpState.side === "codex" || this.fpState.side === "both";
  }

  getSnapshot(): BudgetSnapshot | null {
    return this.latestSnapshot;
  }

  getCodexTurnOverrides(): CodexTurnOverrides | null {
    if (!this.tierControlEnabled()) return null;
    return this.pendingOverrides ? { ...this.pendingOverrides } : null;
  }

  notifyOverridesDelivered(): void {
    if (!this.pendingOverrideTier) return;
    this.lastAppliedTier = this.pendingOverrideTier;
    this.pendingOverrideTier = null;
    this.pendingOverrides = null;
  }

  /**
   * Forget the delivered-tier bookkeeping. turn/start overrides are sticky PER
   * THREAD — after a thread switch or a codex restart the new thread runs at
   * its own defaults, so a stale `lastAppliedTier` would suppress the next
   * legitimate override ("already applied") or skip the explicit full-restore.
   * The daemon calls this on codex `ready` and `threadChanged`.
   */
  resetAppliedTier(): void {
    this.lastAppliedTier = "full";
    this.pendingOverrideTier = null;
    this.pendingOverrides = null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    // Defensive: never fork a second polling chain if a timer is already armed
    // (e.g. a future stop()→start() reentry pattern).
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    const snapshotUsage = this.latestSnapshot
      ? { claude: this.latestSnapshot.claude, codex: this.latestSnapshot.codex }
      : null;
    const delayMs = nextBudgetPollDelayMs({
      config: this.config,
      usage: snapshotUsage,
      now: this.now(),
      paused: this.isPaused(),
    });
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      return this.pollAndReschedule();
    }, delayMs);
  }

  private async pollAndReschedule(): Promise<void> {
    await this.pollOnce();
    if (this.running) this.scheduleNext();
  }

  private async pollOnce(): Promise<void> {
    let usage: Awaited<ReturnType<QuotaSourceLike["fetchBoth"]>>;
    try {
      usage = await this.source.fetchBoth();
    } catch (error) {
      this.log(`budget coordinator poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!usage) {
      if (!this.isPaused()) this.setSnapshot(null);
      return;
    }

    if (!this.running) {
      return;
    }

    const state = computeBudgetState(usage.claude, usage.codex, this.config, this.now());
    this.updatePendingOverrides(state.effort.codexTier);
    this.applyState(state);
    this.setSnapshot(this.toSnapshot(state));
  }

  private setSnapshot(snapshot: BudgetSnapshot | null): void {
    this.latestSnapshot = snapshot;
    this.onSnapshot(snapshot);
  }

  /**
   * IO shell over the pure {@link classifyPoll} reducer. The reducer decides
   * the next directive state and what to do; this method only carries out the
   * effect (emit / onPauseChange) and commits the new state. All transition
   * semantics — including the branch order that keeps a phantom blip from
   * resetting the fingerprint — live in budget-fingerprint.ts.
   */
  private applyState(state: BudgetState): void {
    const { next, effect } = classifyPoll(this.fpState, state, this.config);
    this.fpState = next;

    switch (effect.kind) {
      case "enter":
      case "hold-uncertain": {
        if (effect.pauseChanged) this.onPauseChange(true);
        if (effect.emit) {
          this.emitDirective(
            this.interventionPrefix(effect.side),
            this.interventionDirective(state, effect.side, effect.reason, effect.resumeEpoch),
          );
        }
        return;
      }
      case "exit": {
        this.onPauseChange(false);
        this.emitDirective(this.recoveryPrefix(effect.previousSide), this.recoveryDirective(state, effect.previousSide));
        return;
      }
      case "advise": {
        const prefix = effect.phase === "balance" ? "system_budget_balance" : "system_budget_parallel";
        // state.directiveToClaude is non-null whenever the reducer emits advise.
        this.emitDirective(prefix, state.directiveToClaude!);
        return;
      }
      case "none":
        return;
    }
  }

  private tierControlEnabled(): boolean {
    if (!this.config.codexTierControl) return false;
    if (this.config.codexTiers.full) return true;
    if (!this.missingFullMappingLogged) {
      this.missingFullMappingLogged = true;
      this.log("Codex tier control disabled: budget.codexTiers.full restore mapping is missing");
    }
    return false;
  }

  private updatePendingOverrides(tier: CodexTier): void {
    if (!this.tierControlEnabled()) {
      this.pendingOverrideTier = null;
      this.pendingOverrides = null;
      return;
    }

    if (this.lastAppliedTier === tier) {
      this.pendingOverrideTier = null;
      this.pendingOverrides = null;
      return;
    }

    if (this.pendingOverrideTier === tier) return;

    const overrides = this.config.codexTiers[tier];
    if (!overrides) {
      this.pendingOverrideTier = null;
      this.pendingOverrides = null;
      return;
    }

    this.pendingOverrideTier = tier;
    this.pendingOverrides = { ...overrides };
  }

  private emitDirective(prefix: string, content: string): void {
    this.emit(`${prefix}_${this.sequence++}`, content);
  }

  private interventionPrefix(side: Exclude<PauseSide, null>): string {
    return side === "claude" ? "system_budget_handoff" : "system_budget_pause";
  }

  private recoveryPrefix(previousSide: Exclude<PauseSide, null>): string {
    return previousSide === "claude" ? "system_budget_claude_recovered" : "system_budget_resume";
  }

  private interventionDirective(
    state: BudgetState,
    side: Exclude<PauseSide, null>,
    reason: string,
    resumeEpoch: number | null,
  ): string {
    return renderBudgetInterventionDirective(
      state.perAgent.claude,
      state.perAgent.codex,
      side,
      // `reason` is always a non-empty string here: it comes from
      // interventionReason(curSide) which joins ≥1 active agent, so the `||`
      // fallback is defensive-only and never fires — observationally identical
      // to the old `this.pauseReason ?? "..."` (whose null default was also
      // never reached on this paused path).
      reason || "预算接近耗尽",
      resumeEpoch,
      this.config,
    );
  }

  private recoveryDirective(state: BudgetState, previousSide: Exclude<PauseSide, null>): string {
    if (previousSide === "claude") {
      return [
        "【预算协调 · 账号级】Claude 侧预算已恢复。",
        `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
        `Claude gateUtil 已低于 ${pct(this.config.resumeBelow)}，且没有有效 rate_limit。`,
        "Claude 可恢复 orchestrator 角色；后续分配前请重新查询实时额度，不要依赖旧数字。",
      ].join("\n");
    }

    if (previousSide === "codex") {
      return [
        "【预算协调 · 账号级】Codex 侧预算闸门解除。",
        `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
        `闸门已放开：Codex gateUtil 低于 ${pct(this.config.resumeBelow)}，且没有有效 rate_limit。`,
        "建议 Claude 用 reply 带上当前目标、checkpoint 和下一步，唤醒 Codex 接续执行。",
      ].join("\n");
    }

    return [
      "【预算协调 · 账号级】联合暂停解除。",
      `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
      `闸门已放开：双方 gateUtil 均低于 ${pct(this.config.resumeBelow)}，且没有有效 rate_limit。`,
      "建议 Claude 用 reply 带上当前目标、checkpoint 和下一步，唤醒 Codex 接续执行。",
    ].join("\n");
  }

  private toSnapshot(state: BudgetState): BudgetSnapshot {
    const paused = this.isPaused();
    return {
      phase: paused ? "paused" : state.phase,
      updatedAt: state.now,
      claude: state.perAgent.claude,
      codex: state.perAgent.codex,
      driftPct: state.drift.pct,
      paused,
      gateClosed: this.isGateClosed(),
      pauseSide: this.fpState.side,
      pauseReason: paused ? this.fpState.reason ?? state.pause.reason : null,
      resumeAfterEpoch: paused ? this.fpState.resumeEpoch ?? state.pause.resumeAfterEpoch : null,
      parallelRecommended: paused ? false : state.parallel.recommended,
      codexTier: state.effort.codexTier,
      claudeAdvice: state.effort.claudeAdvice,
    };
  }
}
