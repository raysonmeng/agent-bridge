import { computeBudgetState, renderBudgetInterventionDirective } from "./budget-state";
import { effectiveDynamicLine } from "./budget-decision";
import {
  classifyPoll,
  computeResumeCandidate,
  resumeCandidateSides,
  INITIAL_FINGERPRINT_STATE,
  type FingerprintState,
  type ResumeCandidate,
  type ResumeSignals,
} from "./budget-fingerprint";
import { agentBurnRates, agentRunway, hasAnyBurnSignal } from "./burn-view";
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
  onResume?: (side: AgentName, directive: string, resumeId: string) => void;
  /**
   * PR2 (detection only): daemon-injected readiness signals for the resume
   * candidate. Pulled once per poll after classifyPoll; the result is exposed
   * read-only via getResumeCandidate(). Absent → candidate stays empty (no
   * signals means nothing can be a candidate). The coordinator NEVER acts on
   * this value (no emit/onPauseChange/inject) — that is PR3/PR4.
   */
  resumeSignals?: () => ResumeSignals;
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
  private readonly onResume: (side: AgentName, directive: string, resumeId: string) => void;
  private readonly resumeSignals: (() => ResumeSignals) | null;

  private timer: BudgetPollTimer | null = null;
  private running = false;
  // Single source of truth for the directive state machine (side / fingerprint
  // / resume bookkeeping). Replaces the former 4 mutable fields
  // (activeSides, lastDirectiveFingerprint, pauseReason, pauseResumeAfterEpoch).
  private fpState: FingerprintState = INITIAL_FINGERPRINT_STATE;
  // PR2: latest per-side resume candidate (detection only — read-only exposure
  // via getResumeCandidate(); the coordinator never acts on it).
  private resumeCandidate: ResumeCandidate = {};
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
    this.onResume = options.onResume ?? (() => {});
    this.resumeSignals = options.resumeSignals ?? null;
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

  /**
   * PR2 read-only exposure of the latest per-side resume candidate. Returns a
   * fresh copy so callers cannot mutate the coordinator's internal state. A side
   * is `true` only when its window refreshed AND all daemon-injected signals
   * (pending / TUI / checkpoint) held on the last poll. Detection only — the
   * coordinator takes no action on this value (no emit/inject); PR3/PR4 own that.
   */
  getResumeCandidate(): ResumeCandidate {
    // Deep-copy the per-side detail map AND each nested ResumeCandidateDetail,
    // so a caller mutating the returned value — including an IN-PLACE flip like
    // PR3's claim bookkeeping `result.detail.codex.ready = false` — cannot reach
    // the coordinator's internal resumeCandidate. A shallow `{ ...detail }` would
    // copy the outer map only, leaving each inner detail shared by reference.
    const { detail, ...rest } = this.resumeCandidate;
    return detail
      ? {
          ...rest,
          detail: Object.fromEntries(
            Object.entries(detail).map(([side, value]) => [
              side,
              {
                ...value,
                ...(value.pending ? { pending: { ...value.pending } } : {}),
              },
            ]),
          ) as ResumeCandidate["detail"],
        }
      : { ...rest };
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

    // PR2 (detection only): recompute the per-side resume candidate from the
    // EFFECT, not the post-transition fingerprint. The hysteresis removes a side
    // from `next.side` on the same poll its window refreshes, so the exit poll —
    // exactly when a side becomes resumable — carries `next.side = null`.
    // resumeCandidateSides() reads the recovered side off the exit effect (and
    // the still-paused side off enter/hold), so the candidate lands on the right
    // side. When no signal provider is wired the candidate stays empty — nothing
    // can be a candidate without the readiness signals. This populates state
    // only; committed recovered sides emit below, but injection remains PR3/PR4.
    this.resumeCandidate = this.resumeSignals
      ? computeResumeCandidate(resumeCandidateSides(effect), state, this.config, this.resumeSignals())
      : {};

    for (const side of effect.recoveredSides) {
      const { id, directive } = this.emitRecovery(side, state);
      this.onResume(side, directive, id);
    }

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

  private emitDirective(prefix: string, content: string): string {
    const id = `${prefix}_${this.sequence++}`;
    this.emit(id, content);
    return id;
  }

  private interventionPrefix(side: Exclude<PauseSide, null>): string {
    return side === "claude" ? "system_budget_handoff" : "system_budget_pause";
  }

  private recoveryPrefix(side: AgentName): string {
    return side === "claude" ? "system_budget_claude_recovered" : "system_budget_resume";
  }

  private emitRecovery(side: AgentName, state: BudgetState): { id: string; directive: string } {
    const directive = this.recoveryDirective(state, side);
    const id = this.emitDirective(this.recoveryPrefix(side), directive);
    return { id, directive };
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

  private recoveryDirective(state: BudgetState, side: AgentName): string {
    // Q10: the recovery-condition text must match the active strategy. maximize
    // exits per-window (dynamic line − hysteresis, or window reset), not at
    // resumeBelow — see renderBudgetInterventionDirective for the same fix.
    const maximizeRecoveredText = `各窗口 util 已回落至动态暂停线 − ${pct(this.config.maximize.resumeHysteresisPct)} 以下或对应窗口已刷新`;
    if (side === "claude") {
      const condClaude =
        this.config.strategy === "maximize"
          ? maximizeRecoveredText
          : `gateUtil 已低于 ${pct(this.config.resumeBelow)}`;
      return [
        "【预算协调 · 账号级】Claude 侧预算已恢复。",
        `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
        `Claude ${condClaude}，且没有有效 rate_limit。`,
        "Claude 可恢复 orchestrator 角色；后续分配前请重新查询实时额度，不要依赖旧数字。",
      ].join("\n");
    }

    const condCodex =
      this.config.strategy === "maximize"
        ? maximizeRecoveredText
        : `gateUtil 低于 ${pct(this.config.resumeBelow)}`;
    return [
      "【预算协调 · 账号级】Codex 侧预算闸门解除。",
      `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
      `闸门已放开：Codex ${condCodex}，且没有有效 rate_limit。`,
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
      ...this.burnRateSnapshotFields(state),
      ...this.dynamicLineSnapshotFields(state),
    };
  }

  /**
   * v3 P2 (display-only): the binding maximize dynamic pause line per agent.
   * Omitted entirely in conserve mode so the legacy snapshot shape is unchanged;
   * mirrors the decision layer (effectiveDynamicLine) without ever feeding it.
   */
  private dynamicLineSnapshotFields(state: BudgetState): Pick<BudgetSnapshot, "dynamicPauseLine"> | Record<never, never> {
    if (this.config.strategy !== "maximize") return {};
    return {
      dynamicPauseLine: {
        claude: effectiveDynamicLine(state.perAgent.claude, this.config, state.now),
        codex: effectiveDynamicLine(state.perAgent.codex, this.config, state.now),
      },
    };
  }

  /**
   * v3 P1 burn fields (display-only, layered amendment): pass the guard's
   * decision-grade probe fields through verbatim — the bridge selects (min
   * across windows) but never computes. Absent entirely when the probe
   * carries no burn signal (old guard / not enough samples), keeping the
   * legacy snapshot shape for old consumers.
   */
  private burnRateSnapshotFields(state: BudgetState): Pick<BudgetSnapshot, "burnRate" | "runway"> | Record<never, never> {
    const rates = {
      claude: agentBurnRates(state.perAgent.claude),
      codex: agentBurnRates(state.perAgent.codex),
    };
    const runway = {
      claude: agentRunway(state.perAgent.claude, state.now),
      codex: agentRunway(state.perAgent.codex, state.now),
    };
    if (!hasAnyBurnSignal(rates, runway)) return {};
    return { burnRate: rates, runway };
  }
}
