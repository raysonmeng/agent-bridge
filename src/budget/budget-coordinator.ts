import { computeBudgetState, renderBudgetInterventionDirective } from "./budget-state";
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

export interface BudgetCoordinatorOptions {
  source: QuotaSourceLike;
  config: BudgetConfig;
  emit: (id: string, content: string) => void;
  onPauseChange: (paused: boolean) => void;
  now?: () => number;
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

function matchingGateReset(usage: AgentUsage | null): number {
  if (!usage) return 0;

  const windows = [usage.fiveHour, usage.weekly].filter((window): window is NonNullable<typeof window> =>
    !!window && window.resetEpoch > 0
  );
  const matching = windows.filter((window) => Math.abs(window.util - usage.gateUtil) < 0.0001);
  const candidates = matching.length > 0 ? matching : windows;
  if (candidates.length === 0) return 0;
  return Math.min(...candidates.map((window) => window.resetEpoch));
}

export class BudgetCoordinator {
  private readonly source: QuotaSourceLike;
  private readonly config: BudgetConfig;
  private readonly emit: (id: string, content: string) => void;
  private readonly onPauseChange: (paused: boolean) => void;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly activeSides = new Set<AgentName>();
  private lastDirectiveFingerprint: string | null = null;
  private latestSnapshot: BudgetSnapshot | null = null;
  private pauseReason: string | null = null;
  private pauseResumeAfterEpoch: number | null = null;
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
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
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
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isPaused(): boolean {
    return this.activeSides.size > 0;
  }

  isGateClosed(): boolean {
    return this.activeSides.has("codex");
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

  private scheduleNext(): void {
    if (!this.running) return;
    const delayMs = Math.max(0, this.config.pollSeconds * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollAndReschedule();
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
      if (!this.isPaused()) this.latestSnapshot = null;
      return;
    }

    if (!this.running) {
      return;
    }

    const state = computeBudgetState(usage.claude, usage.codex, this.config, this.now());
    this.updatePendingOverrides(state.effort.codexTier);
    this.applyState(state);
    this.latestSnapshot = this.toSnapshot(state);
  }

  private applyState(state: BudgetState): void {
    const previousSide = this.pauseSide();
    this.updateActiveSides(state);
    const currentSide = this.pauseSide();

    if (currentSide) {
      this.pauseReason = this.interventionReason(state);
      const nextResumeAfterEpoch = this.resumeAfterEpoch(state);
      this.pauseResumeAfterEpoch = previousSide === currentSide
        ? nextResumeAfterEpoch ?? this.pauseResumeAfterEpoch
        : nextResumeAfterEpoch;
      const fingerprint = previousSide === currentSide && this.activeSideProbeUncertain(state) && this.lastDirectiveFingerprint
        ? this.lastDirectiveFingerprint
        : this.directiveFingerprint(state, currentSide);
      if (!previousSide) {
        this.onPauseChange(true);
      }
      if (!previousSide || previousSide !== currentSide || fingerprint !== this.lastDirectiveFingerprint) {
        this.emitDirective(
          this.interventionPrefix(currentSide),
          this.interventionDirective(state, currentSide),
        );
      }
      this.lastDirectiveFingerprint = fingerprint;
      return;
    }

    if (previousSide) {
      this.pauseReason = null;
      this.pauseResumeAfterEpoch = null;
      this.lastDirectiveFingerprint = null;
      this.onPauseChange(false);
      this.emitDirective(this.recoveryPrefix(previousSide), this.recoveryDirective(state, previousSide));
      return;
    }

    if (!state.directiveToClaude) {
      this.lastDirectiveFingerprint = null;
      return;
    }

    const fingerprint = this.directiveFingerprint(state);
    if (fingerprint !== this.lastDirectiveFingerprint) {
      const prefix = state.phase === "balance" ? "system_budget_balance" : "system_budget_parallel";
      this.emitDirective(prefix, state.directiveToClaude);
      this.lastDirectiveFingerprint = fingerprint;
    }
  }

  private updateActiveSides(state: BudgetState): void {
    for (const agent of ["claude", "codex"] as const) {
      const usage = state.perAgent[agent];
      if (this.shouldEnter(usage, state.now)) {
        this.activeSides.add(agent);
      } else if (this.activeSides.has(agent) && this.canAgentResume(usage, state.now)) {
        this.activeSides.delete(agent);
      }
    }
  }

  private shouldEnter(usage: AgentUsage | null, now: number): boolean {
    if (!usage) return false;
    return usage.gateUtil >= this.config.pauseAt;
  }

  private canAgentResume(usage: AgentUsage | null, now: number): boolean {
    if (!usage) return false;
    if (usage.rateLimitedUntil > now) return false;
    return usage.gateUtil < this.config.resumeBelow;
  }

  private resumeAfterEpoch(state: BudgetState): number | null {
    const epochs = (["claude", "codex"] as const)
      .filter((agent) => this.activeSides.has(agent))
      .map((agent) => this.resumeBlockingEpoch(state.perAgent[agent], state.now))
      .filter((epoch) => epoch > 0);
    if (epochs.length === 0) return null;
    return Math.max(...epochs);
  }

  private resumeBlockingEpoch(usage: AgentUsage | null, now: number): number {
    if (!usage) return 0;
    if (usage.rateLimitedUntil > now) return usage.rateLimitedUntil;
    if (usage.gateUtil >= this.config.resumeBelow) return matchingGateReset(usage);
    return 0;
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

  private directiveFingerprint(state: BudgetState, activeSide?: Exclude<PauseSide, null>): string {
    const side = activeSide ?? (state.phase === "balance"
      ? state.drift.lighter ?? "none"
      : state.pause.side ?? "none");
    let reset = 0;
    if (activeSide === "claude") {
      reset = state.pause.resetEpochs.claude;
    } else if (activeSide === "codex") {
      reset = state.pause.resetEpochs.codex;
    } else if (activeSide === "both") {
      reset = Math.max(state.pause.resetEpochs.claude, state.pause.resetEpochs.codex);
    } else if (state.phase === "balance" && state.drift.lighter) {
      reset = state.perAgent[state.drift.lighter]?.fiveHour?.resetEpoch ?? 0;
    } else if (side === "claude") {
      reset = state.pause.resetEpochs.claude;
    } else if (side === "codex") {
      reset = state.pause.resetEpochs.codex;
    } else if (side === "both") {
      reset = Math.max(state.pause.resetEpochs.claude, state.pause.resetEpochs.codex);
    }

    return [
      activeSide ? "paused" : state.phase,
      state.drift.heavier ?? "none",
      side,
      reset,
    ].join("|");
  }

  private emitDirective(prefix: string, content: string): void {
    this.emit(`${prefix}_${this.sequence++}`, content);
  }

  private pauseSide(): PauseSide {
    const claude = this.activeSides.has("claude");
    const codex = this.activeSides.has("codex");
    if (claude && codex) return "both";
    if (claude) return "claude";
    if (codex) return "codex";
    return null;
  }

  private interventionPrefix(side: Exclude<PauseSide, null>): string {
    return side === "claude" ? "system_budget_handoff" : "system_budget_pause";
  }

  private recoveryPrefix(previousSide: Exclude<PauseSide, null>): string {
    return previousSide === "claude" ? "system_budget_claude_recovered" : "system_budget_resume";
  }

  private interventionDirective(state: BudgetState, side: Exclude<PauseSide, null>): string {
    return renderBudgetInterventionDirective(
      state.perAgent.claude,
      state.perAgent.codex,
      side,
      this.pauseReason ?? "预算接近耗尽",
      this.pauseResumeAfterEpoch,
      this.config,
    );
  }

  private interventionReason(state: BudgetState): string {
    return (["claude", "codex"] as const)
      .filter((agent) => this.activeSides.has(agent))
      .map((agent) => this.activeSideReason(agent, state.perAgent[agent], state.now))
      .join("；");
  }

  private activeSideProbeUncertain(state: BudgetState): boolean {
    return (["claude", "codex"] as const).some((agent) => {
      if (!this.activeSides.has(agent)) return false;
      const usage = state.perAgent[agent];
      return usage === null || usage.rateLimitedUntil > state.now;
    });
  }

  private activeSideReason(agent: AgentName, usage: AgentUsage | null, now: number): string {
    if (!usage) return `${AGENT_LABEL[agent]} 探测暂时不可用，保持上一轮预算干预`;
    if (usage.rateLimitedUntil > now) {
      return `${AGENT_LABEL[agent]} 探针被限流至 ${this.formatEpoch(usage.rateLimitedUntil)}`;
    }
    if (usage.gateUtil >= this.config.pauseAt) {
      return `${AGENT_LABEL[agent]} gateUtil ${pct(usage.gateUtil)} ≥ pauseAt ${pct(this.config.pauseAt)}`;
    }
    return `${AGENT_LABEL[agent]} gateUtil ${pct(usage.gateUtil)} 尚未低于 resumeBelow ${pct(this.config.resumeBelow)}`;
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

  private formatEpoch(epoch: number): string {
    return new Date(epoch * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
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
      pauseSide: this.pauseSide(),
      pauseReason: paused ? this.pauseReason ?? state.pause.reason : null,
      resumeAfterEpoch: paused ? this.pauseResumeAfterEpoch ?? state.pause.resumeAfterEpoch : null,
      parallelRecommended: paused ? false : state.parallel.recommended,
      codexTier: state.effort.codexTier,
      claudeAdvice: state.effort.claudeAdvice,
    };
  }
}
