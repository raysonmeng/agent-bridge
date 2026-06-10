import { computeBudgetState, isDecisionGrade, renderBudgetInterventionDirective } from "./budget-state";
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

// Directive-fingerprint quantum for reset epochs. Must absorb probe jitter
// (seconds) while still distinguishing a genuine window reset (hours).
const RESET_FINGERPRINT_BUCKET_SEC = 600;
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
  private readonly now: () => number;
  private readonly scheduler: BudgetPollScheduler;
  private readonly log: (message: string) => void;

  private timer: BudgetPollTimer | null = null;
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

    // Drift/parallel advice compares the two sides — against a non-decision-
    // grade record the comparison is a phantom. Observed live: a transient
    // empty Claude probe record (gate=0%, no windows) inflated drift 54%→58%
    // and emitted a directive on each side of the blip. Hold the previous
    // directive state and KEEP the fingerprint — whether the phantom inflated
    // drift (directive present) or deflated it away (directive null), the
    // recovery to the same real state must re-emit nothing. This sits BEFORE
    // the null-directive branch so a blip cannot reset the fingerprint.
    // (Pause entry/exit above has its own decision-grade guards in
    // shouldEnter/canAgentResume.)
    if (
      !isDecisionGrade(state.perAgent.claude, state.now) ||
      !isDecisionGrade(state.perAgent.codex, state.now)
    ) {
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

  // Only decision-grade records may CHANGE intervention state (enter or exit).
  // Two real-machine failure shapes feed untrustworthy records into the
  // decision loop:
  //  - the probe serves a stale cache during an outage: hours-old utils with
  //    resetEpochs already in the past would enter (and then freeze) a pause
  //    whose "estimated resume" predates now;
  //  - a windowless rate-limit-only record reads gateUtil=0, which must not
  //    AUTHORIZE a resume the moment the throttle expires (the entry-side
  //    information floor in quota-source has no resume-side counterpart).
  // Untrustworthy data holds the current state — same semantics as a probe
  // miss. The check itself is shared with the entry-side guard: see
  // isDecisionGrade in budget-state.ts.

  private shouldEnter(usage: AgentUsage | null, now: number): boolean {
    if (!isDecisionGrade(usage, now)) return false;
    return usage!.gateUtil >= this.config.pauseAt;
  }

  private canAgentResume(usage: AgentUsage | null, now: number): boolean {
    if (!isDecisionGrade(usage, now)) return false;
    if (usage!.rateLimitedUntil > now) return false;
    return usage!.gateUtil < this.config.resumeBelow;
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
      // Round-to-nearest bucket, not the raw epoch: the probe's reset_epoch
      // jitters by ±1s between polls (observed live: 09:49:59 ⇄ 09:50:00),
      // and a raw value re-emits the same directive every poll. Rounding —
      // not floor — because real reset times sit ON round boundaries, so a
      // floor bucket edge would keep flapping. A genuine window reset jumps
      // hours and still lands in a different bucket.
      // Domain assumption: jitter tolerance holds because reset epochs sit
      // near bucket-aligned times. An ARBITRARY epoch at a half-bucket point
      // (k*600+300) would still flap under ±1s — not a shape the probe emits.
      Math.round(reset / RESET_FINGERPRINT_BUCKET_SEC),
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
      // Non-decision-grade covers every degraded shape (#103 lets stale /
      // unknown-reset records through as display data): mid-pause they must
      // hold the directive fingerprint, not recompute it against a phantom
      // reset bucket — recomputing re-emitted the pause directive on each
      // data-quality flap, the exact regression e7a66fc guarded against.
      return usage === null || usage.rateLimitedUntil > state.now || !isDecisionGrade(usage, state.now);
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
