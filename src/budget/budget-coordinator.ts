import { homedir } from "node:os";
import {
  computeBudgetState,
  renderBudgetAdmissionDirective,
  renderBudgetInterventionDirective,
} from "./budget-state";
import type { RunwayInput } from "./budget-state";
import { effectiveDynamicLine } from "./budget-decision";
import { AdviceCooldown, resolveAdviceCooldownSec } from "./advice-cooldown";
import {
  classifyAdmission,
  classifyPoll,
  computeResumeCandidate,
  resumeCandidateSides,
  INITIAL_ADMISSION_STATE,
  INITIAL_FINGERPRINT_STATE,
  type AdmissionState,
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
  GateState,
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
  /**
   * v3 P4: cross-pair cooldown for the underutilization advice. Injected so tests
   * isolate to a temp dir; defaults to a real one rooted at the account-level
   * guard state dir (BUDGET_STATE_DIR ?? ~/.budget-guard), shared across pairs.
   */
  adviceCooldown?: AdviceCooldown;
  /**
   * v3 P3 (§3.2, M3b): whether Codex currently has a turn in progress (daemon
   * passes `codex.turnInProgress`). Read at poll time to make the admission
   * directive turnPhase-aware: while a Codex turn runs the directive is DEFERRED
   * (not emitted mid-turn) and flushed by {@link onCodexTurnIdle} when the turn
   * ends. Absent (tests / no wiring) → treated as never-active, so the directive
   * emits immediately on entry — the safe default for unit tests.
   */
  isCodexTurnActive?: () => boolean;
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
  private readonly adviceCooldown: AdviceCooldown;
  private readonly isCodexTurnActive: () => boolean;

  private timer: BudgetPollTimer | null = null;
  private running = false;
  // Single source of truth for the directive state machine (side / fingerprint
  // / resume bookkeeping). Replaces the former 4 mutable fields
  // (activeSides, lastDirectiveFingerprint, pauseReason, pauseResumeAfterEpoch).
  private fpState: FingerprintState = INITIAL_FINGERPRINT_STATE;
  // v3 P3 (§3.2): admission lane, parallel to the pause fpState. In-memory only
  // (recomputed each poll); the durable per-window quota is in admission-quota.ts.
  private admissionState: AdmissionState = INITIAL_ADMISSION_STATE;
  // v3 P3 (§3.2, M3b): the admission directive deferred because a Codex turn was
  // running when the admission lane closed (turnPhase-aware emission). Flushed by
  // onCodexTurnIdle() when the turn ends; dropped if the gate reopens/escalates
  // first. Holds the LATEST rendered content + its fingerprint (a later poll that
  // changes the fingerprint mid-turn overwrites it).
  private pendingAdmissionDirective: { content: string; fingerprint: string } | null = null;
  // Fingerprint of the last admission directive actually emitted — dedup guard so
  // a deferred-then-flushed directive (or a phantom re-decide) never double-emits
  // for the same admission episode. Cleared on admission exit so a fresh episode
  // emits again.
  private lastEmittedAdmissionFingerprint: string | null = null;
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
    this.adviceCooldown =
      options.adviceCooldown ??
      new AdviceCooldown({
        homeDir: homedir(),
        cooldownSec: resolveAdviceCooldownSec(),
        log: this.log,
      });
    this.isCodexTurnActive = options.isCodexTurnActive ?? (() => false);
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

  /**
   * v3 P3 (§3.2): the three-state daemon gate. `closed` (the existing pause gate,
   * = isGateClosed) takes precedence over `admission-closed`. Both tiers key on
   * the CODEX side (incl. "both") because the daemon gates Codex turn/start —
   * Claude self-governs via the prompt. Observability today (snapshot.gateState);
   * the daemon begins enforcing the admission tier in M3.
   */
  gateState(): GateState {
    if (this.fpState.side === "codex" || this.fpState.side === "both") return "closed";
    if (this.admissionState.side === "codex" || this.admissionState.side === "both") return "admission-closed";
    return "open";
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

    // v3 P4: compute runway ONCE here (from the guard's verbatim probe fields)
    // and inject it into both the decision (computeBudgetState — breaks the
    // budget-state → burn-view import cycle) and the snapshot, so the two never
    // diverge on a different now().
    const now = this.now();
    const runway: RunwayInput = {
      claude: agentRunway(usage.claude, now),
      codex: agentRunway(usage.codex, now),
    };
    const state = computeBudgetState(usage.claude, usage.codex, this.config, now, runway);
    this.updatePendingOverrides(state.effort.codexTier);
    this.applyState(state);
    this.setSnapshot(this.toSnapshot(state, runway));
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
    // v3 P3 (§3.2): advance the parallel admission lane and apply its directive
    // effect (M3b — turnPhase-aware emission). The daemon's three-state gate reads
    // gateState(); this only governs the advisory directive to Claude.
    this.admissionState = classifyAdmission(this.admissionState, state, this.config).next;
    this.applyAdmissionDirective(state);

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
      // v3 P3 (M3b, round-2 REAL): a side recovering from PAUSE may still be
      // ADMISSION-closed — the closed→admission-closed de-escalation (codex util
      // crosses below the pause-resume line into the admission hold band). Firing
      // the codex recovery here would (a) tell Claude codex is fully recovered and
      // (b) route an auto-resume turn through enqueueCodexBudgetResume → the resume
      // queue → codex.injectMessage, which BYPASSES the codex_to_codex admission
      // gate and would inject an unbounded continuation that never consumes a wrap-up
      // slot — both wrong while codex is still in finishing protection. HOLD the
      // codex recovery until the admission lane also opens. (admission is
      // codex-scoped, so a claude recovery is never gated by it.) Trade-off: in a
      // monotonic recovery (pause → admission-closed → open with no re-pause) the
      // codex auto-resume is skipped for this episode; it re-fires on the next
      // genuine pause-recovery cycle, and once the gate is open Claude can resume
      // Codex manually via reply. The SAFE direction — no gate bypass. (follow-up:
      // optionally re-fire the held resume on the admission-exit transition.)
      if (side === "codex" && (this.admissionState.side === "codex" || this.admissionState.side === "both")) {
        this.log(`Budget recovery for Codex held: pause cleared but still admission-closed`);
        continue;
      }
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
        // v3 P3 (M3b): hard-gate routing advice on an OPEN gate. computeBudgetState
        // already suppresses the advise PHASE when either side admit-closes (raw
        // predicate), so an advise effect normally never reaches here while the gate
        // is admission-closed. This catches the residual hysteresis EXIT band: the
        // raw predicate reads "open" (advise phase produced) while the coordinator's
        // admissionState still HOLDS admission-closed — emitting "route work to
        // Codex" then would contradict the still-active daemon admission gate.
        if (this.gateState() !== "open") {
          // RE-ARM the advice fingerprint (null) instead of a plain return.
          // classifyPoll already committed `this.fpState = next` with the advise
          // fingerprint (budget-fingerprint.ts advise branch), so a bare return
          // would burn the dedup key WITHOUT emitting — and once the gate opens the
          // same persistent drift yields an identical fingerprint → classifyPoll
          // returns kind:"none" → the legitimate balance/underutilization advice is
          // permanently lost for the episode (round-2 REAL, both review engines).
          // Nulling it makes the next OPEN-gate poll recompute and emit exactly once.
          this.fpState = { ...this.fpState, fingerprint: null };
          return;
        }
        // state.directiveToClaude is non-null whenever the reducer emits advise.
        if (effect.phase === "underutilized") {
          // v3 P4: the accelerate/underutilization advice is account-level — gate
          // EMISSION behind the cross-pair disk cooldown so multiple daemons do
          // not collectively nag "split more parallel work" (R8). The in-memory
          // fingerprint already deduped within this coordinator; the cooldown is
          // the cross-pair brake. Denied → emit nothing this poll.
          //
          // INTENTIONAL: a denied acquire does not retry later in the same
          // episode. classifyPoll only emits `advise` when the fingerprint
          // CHANGES; the first underutilized poll already advanced it, so a
          // denial here leaves the losing pair silent for this episode (the pair
          // that won the cooldown emits once). That is the design intent —
          // underutilization is a one-shot "you could parallelize more" nudge,
          // not a repeating alarm — and is the collective-nagging suppression R8
          // asks for.
          if (!this.adviceCooldown.tryAcquire("underutilization", state.now)) return;
          this.emitDirective("system_budget_underutilized", state.directiveToClaude!);
          return;
        }
        // The only other advise phase is balance (parallel is retired).
        this.emitDirective("system_budget_balance", state.directiveToClaude!);
        return;
      }
      case "none":
        return;
    }
  }

  /**
   * v3 P3 (§3.2, M3b): decide the admission directive each poll. The daemon gate
   * (gateState) is independent of this — this only governs the advisory
   * `system_budget_admission` directive to Claude.
   *
   * IDEMPOTENT by design: the emit decision is driven off the coordinator's own
   * `lastEmittedAdmissionFingerprint`, NOT the reducer's one-shot `emit` flag. The
   * one-shot flag fires only on the poll an episode first enters; if THAT poll is
   * blocked (a pause is active, or a Codex turn is running) the directive must
   * still emit on a LATER poll once the blocker clears. The classic miss this
   * prevents: codex enters pause+admission together (admission suppressed by the
   * pause), then de-escalates to admission-only (burn-data regime: util in
   * [admissionAt, dynamicLine−hysteresis) clears pause but holds admission) — with
   * a one-shot flag the directive would NEVER emit yet the daemon rejects every new
   * Codex turn. Driving off lastEmitted re-evaluates every poll until it lands.
   *
   * Suppression cases do NOT advance lastEmitted, so they re-arm naturally:
   *   - admission open / claude-only → reset bookkeeping (a fresh codex episode
   *     re-emits; the daemon gate is codex-scoped, Claude self-governs its line).
   *   - a pause is active → pause has display priority (its directive covers
   *     winding down); HOLD (re-evaluated next poll once the pause clears).
   *   - a Codex turn is running → DEFER (store the rendered directive; flushed by
   *     onCodexTurnIdle when the turn ends, with a poll-driven backstop here).
   */
  private applyAdmissionDirective(state: BudgetState): void {
    const side = this.admissionState.side;
    if (side !== "codex" && side !== "both") {
      // Gate open on the codex axis (or claude-only) → nothing to announce; clear
      // bookkeeping so a future codex episode emits fresh.
      this.pendingAdmissionDirective = null;
      this.lastEmittedAdmissionFingerprint = null;
      return;
    }
    const fingerprint = this.admissionState.fingerprint;
    // Already announced this episode (fingerprint unchanged) → no-op. Drop any
    // stale pending (e.g. the directive was already flushed by onCodexTurnIdle).
    if (fingerprint === null || fingerprint === this.lastEmittedAdmissionFingerprint) {
      this.pendingAdmissionDirective = null;
      return;
    }
    // Pause display priority: HOLD without marking emitted, so it re-fires the
    // poll the pause clears. Drop any deferred copy (the pause directive supersedes).
    if (this.isPaused()) {
      this.pendingAdmissionDirective = null;
      return;
    }
    const content = renderBudgetAdmissionDirective(
      state.perAgent.claude,
      state.perAgent.codex,
      side,
      this.admissionState.reason ?? "额度窗口收尾保护",
      this.admissionResetEpoch(state),
      this.config,
    );
    // turnPhase-aware: defer while a Codex turn runs (re-rendered each poll so the
    // deferred copy never goes stale); onCodexTurnIdle flushes it the moment the
    // turn ends, and the next poll here is the backstop if that event is missed.
    if (this.isCodexTurnActive()) {
      this.pendingAdmissionDirective = { content, fingerprint };
      return;
    }
    this.emitAdmission(content, fingerprint);
  }

  private emitAdmission(content: string, fingerprint: string): void {
    this.emitDirective("system_budget_admission", content);
    this.lastEmittedAdmissionFingerprint = fingerprint;
    this.pendingAdmissionDirective = null;
  }

  /**
   * The reset epoch for the admission directive's "window refreshes at" line. ALWAYS
   * the CODEX fresh window (fresh 5h, else fresh weekly) — the admission gate is
   * codex-scoped (the daemon rejects Codex turns and keys the wrap-up/baton quota on
   * exactly this codex window), and Claude self-governs its own line. Even for a
   * side="both" directive the actionable "when can I delegate to Codex again" answer
   * is the codex window, NOT max(claude,codex): a later-resetting Claude window would
   * mislead Claude into waiting past the point Codex's gate actually reopens (round-2
   * REAL). NOT matchingGateReset (state.pause.resetEpochs): that admits a window whose
   * epoch is merely > 0, so a weekly-triggered admission with an EXPIRED 5h window
   * would display the stale 5h time. `now` from state keeps it consistent with the poll.
   */
  private admissionResetEpoch(state: BudgetState): number | null {
    const usage = state.perAgent.codex;
    const now = state.now;
    const fiveHour = usage?.fiveHour?.resetEpoch ?? 0;
    const weekly = usage?.weekly?.resetEpoch ?? 0;
    const fresh = fiveHour > now ? fiveHour : weekly > now ? weekly : 0;
    return fresh > 0 ? fresh : null;
  }

  /**
   * v3 P3 (§3.2, M3b): flush a deferred admission directive when the Codex turn
   * ends (daemon calls this on turnPhaseChanged → idle/aborted) — the immediacy
   * optimization over the poll-driven backstop in applyAdmissionDirective. `pending`
   * is poll-managed: every poll re-evaluates it and CLEARS it on a pause escalation
   * or an admission exit, so a non-null `pending` already means the last poll
   * confirmed admission-closed + not paused. The isPaused()/gateState() re-check is
   * defense-in-depth against future event/poll interleaving; it never fires today.
   * No-op when nothing is pending.
   */
  onCodexTurnIdle(): void {
    const pending = this.pendingAdmissionDirective;
    if (!pending) return;
    this.pendingAdmissionDirective = null;
    if (this.isPaused() || this.gateState() !== "admission-closed") return;
    this.emitAdmission(pending.content, pending.fingerprint);
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
    // v3.2: recovery is per-window (dynamic line − hysteresis, or window reset),
    // not at resumeBelow — the dynamic line is the sole strategy.
    const recoveredText = `各窗口 util 已回落至动态暂停线 − ${pct(this.config.maximize.resumeHysteresisPct)} 以下或对应窗口已刷新`;
    if (side === "claude") {
      return [
        "【预算协调 · 账号级】Claude 侧预算已恢复。",
        `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
        `Claude ${recoveredText}，且没有有效 rate_limit。`,
        "Claude 可恢复 orchestrator 角色；后续分配前请重新查询实时额度，不要依赖旧数字。",
      ].join("\n");
    }

    return [
      "【预算协调 · 账号级】Codex 侧预算闸门解除。",
      `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
      `闸门已放开：Codex ${recoveredText}，且没有有效 rate_limit。`,
      "建议 Claude 用 reply 带上当前目标、checkpoint 和下一步，唤醒 Codex 接续执行。",
    ].join("\n");
  }

  private toSnapshot(state: BudgetState, runway: RunwayInput): BudgetSnapshot {
    const paused = this.isPaused();
    return {
      phase: paused ? "paused" : state.phase,
      updatedAt: state.now,
      claude: state.perAgent.claude,
      codex: state.perAgent.codex,
      driftPct: state.drift.pct,
      paused,
      gateClosed: this.isGateClosed(),
      gateState: this.gateState(),
      pauseSide: this.fpState.side,
      pauseReason: paused ? this.fpState.reason ?? state.pause.reason : null,
      resumeAfterEpoch: paused ? this.fpState.resumeEpoch ?? state.pause.resumeAfterEpoch : null,
      parallelRecommended: paused ? false : state.parallel.recommended,
      codexTier: state.effort.codexTier,
      claudeAdvice: state.effort.claudeAdvice,
      ...this.burnRateSnapshotFields(state, runway),
      ...this.dynamicLineSnapshotFields(state),
    };
  }

  /**
   * v3.2 (display-only): the binding dynamic pause line per agent. The dynamic
   * line is always-on now, so this is always present; each side is null when no
   * confident window yields a numeric line. Mirrors the decision layer
   * (effectiveDynamicLine) without ever feeding it.
   */
  private dynamicLineSnapshotFields(state: BudgetState): Pick<BudgetSnapshot, "dynamicPauseLine"> {
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
  private burnRateSnapshotFields(
    state: BudgetState,
    runway: RunwayInput,
  ): Pick<BudgetSnapshot, "burnRate" | "runway"> | Record<never, never> {
    const rates = {
      claude: agentBurnRates(state.perAgent.claude),
      codex: agentBurnRates(state.perAgent.codex),
    };
    if (!hasAnyBurnSignal(rates, runway)) return {};
    return { burnRate: rates, runway };
  }
}
