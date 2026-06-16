/**
 * Shared type contract for the budget coordination layer (see budgetcoordinationplan.md v2.2).
 *
 * Ownership split:
 * - quota-source.ts / budget-state.ts / budget-coordinator.ts implement against these types (Codex).
 * - daemon/bridge/claude-adapter/cli wiring consumes them (Claude).
 *
 * Keep this file dependency-free; it is bundled into the plugin daemon.
 */

/**
 * Max age (seconds since fetchedAt) for usage data to count as decision-grade.
 * Shared by the entry-side guard (budget-state.ts) and the coordinator's
 * resume gate (budget-coordinator.ts) — they must never diverge, or one side
 * acts on data the other already rejected as stale.
 */
export const STALE_MAX_AGE_SEC = 600;

/** One quota window (5h primary or weekly secondary). */
export interface BudgetWindow {
  /** Utilization percent, 0-100. */
  util: number;
  /** Unix seconds when this window resets; 0 if unknown. */
  resetEpoch: number;
  /**
   * v3 layered amendment (§3.3): decision-grade burn fields produced by
 * agent-quota-guard's probe and passed through verbatim. AgentBridge NEVER
 * computes burn rates itself — these are consume-only. The group is absent
 * when the guard omitted them (old probe / not enough samples) or when any
 * of them failed strict validation (the whole group is dropped together).
   */
  /** Guard EWMA burn rate (probe `burn_rate_pct_per_hour`), pct/h, ≥0. */
  burnRate?: number;
  /** Guard confidence gate (probe `burn_confident`). */
  burnConfident?: boolean;
  /**
   * Guard runway in seconds (probe `runway_seconds`), neutral semantics:
   * time to 100% util, truncated at the window reset.
   */
  runwaySeconds?: number;
  /** Unix seconds when the guard projects depletion (probe `depleted_at_epoch`). */
  depletedAtEpoch?: number;
  /**
   * Guard weekly-window projection (probe `five_hour_windows_left`): how many
   * 5h windows the weekly runway can cover at the current burn rate.
   */
  fiveHourWindowsLeft?: number;
}

/** How confidently AgentBridge mapped raw probe buckets to known quota windows. */
export type ProbeParsedVia = "id-match" | "positional" | "top-level";

/**
 * Normalized per-agent usage from an agent-quota-guard probe.
 *
 * Normalization rules (dual probe shapes — bash `budget-probe` emits `hard_util`,
 * node `probe.mjs` does not):
 *   gateUtil  = raw.util ?? raw.hard_util ?? 0   // resettable hard winner — R4 gating metric
 *   warnUtil  = raw.warn_util ?? gateUtil        // max across ALL buckets — parity/display only
 *   rateLimitedUntil = raw.rate_limited_until ?? 0
 *
 * IMPORTANT: a probe result with ok:false but a meaningful rate_limited_until must
 * still be surfaced as an AgentUsage (not dropped to null) so R4 can pause on it.
 */
export interface AgentUsage {
  /** Probe reported ok. ok:false with rateLimitedUntil > 0 is still actionable. */
  ok: boolean;
  /** Data served from a stale cache (probe `stale` flag). */
  stale: boolean;
  /** Resettable hard-winner utilization percent (probe `util`). R4 gates ONLY on this. */
  gateUtil: number;
  /** Max utilization across all buckets incl. non-resettable (probe `warn_util`). */
  warnUtil: number;
  /** 5h window detail when identifiable, else null. */
  fiveHour: BudgetWindow | null;
  /** Weekly window detail when identifiable, else null. */
  weekly: BudgetWindow | null;
  /** Convenience: 100 - gateUtil, clamped to [0, 100]. */
  remaining: number;
  /** Unix seconds until which the provider is rate-limiting probes; 0 if none. */
  rateLimitedUntil: number;
  /** Unix seconds the underlying data was fetched. */
  fetchedAt: number;
  /** Probe bucket parsing path; positional means AgentBridge used a heuristic fallback. */
  parsedVia: ProbeParsedVia;
}

export type AgentName = "claude" | "codex";

// v3 P4: `parallel` is retired as a PRODUCED phase (the underutilization advice
// replaces it), but the literal is kept in the union so legacy daemon snapshots
// still deserialize. `underutilized` is the new advise phase.
export type BudgetPhase = "normal" | "balance" | "parallel" | "underutilized" | "paused";

export type CodexTier = "full" | "balanced" | "eco";

/** Identifies one of the two quota windows tracked per agent. */
export type BudgetWindowKey = "fiveHour" | "weekly";

/**
 * Burn rate for one agent × window (v3 §3.3, layered amendment): a pure
 * CONSUMPTION shape over the guard's probe fields. Collection / EWMA /
 * confidence all live in agent-quota-guard; the bridge never recomputes.
 * Percentage points of quota consumed per hour, account-wide.
 */
export interface BurnRate {
  /** Guard burn rate (probe `burn_rate_pct_per_hour`). */
  pctPerHour: number;
  /** Guard confidence gate (probe `burn_confident`); false/absent → 采样中. */
  confident: boolean;
}

/** Per-agent burn rates, one slot per identifiable window. */
export interface AgentBurnRates {
  fiveHour: BurnRate | null;
  weekly: BurnRate | null;
}

/**
 * "How long can this agent keep working" estimate (v3 §3.3, layered
 * amendment): selected — not computed — from the guard's `runway_seconds`
 * fields: the minimum across decision-grade windows with a confident rate.
 * Neutral semantics inherited from the guard: time to 100%, truncated at
 * the window reset.
 */
export interface RunwayEstimate {
  /** Guard `runway_seconds` of the binding window, passed through verbatim. */
  seconds: number;
  /** Which window produced the binding (shortest) runway. */
  basis: BudgetWindowKey;
  /** Guard `depleted_at_epoch` of the binding window; null when omitted. */
  depletedAtEpoch: number | null;
}

/**
 * Time-aware dynamic-pause-line parameters (v3 §3.1/§4.1). These are the SOLE
 * budget strategy as of v3.2 (the conserve|maximize selector is gone). All have
 * defaults + bounded validation in config-service.ts and are tuned via env
 * escape hatches, not as product-facing config.
 */
export interface MaximizeConfig {
  /** Reset-point target utilization (asymptote); default 98, range [90, 99]. Must be > pauseAt. */
  targetUtil: number;
  /** Extra reserve per hour-to-reset; default 0.4 pct/h, range [0, 5] (fractional). */
  reserveSlopePctPerHour: number;
  /** Reserve ceiling; default 7, range [0, 30]. Far-from-reset → line floors at pauseAt. */
  reserveMaxPct: number;
  /** Expected in-flight wrap-up duration; default 30 min, range [5, 180]. */
  finishingHorizonMinutes: number;
  /** Symmetric-resume hysteresis below the dynamic line; default 5, range [1, 30]. */
  resumeHysteresisPct: number;
  /**
   * v3 P3 (§3.2): 5h-window util at/above which the admission gate enters
   * `admission-closed` (reject new turns, allow wrap-up). Default 85, range
   * [50, 99]. Must be < targetUtil (else the whole maximize block resets).
   */
  admissionAt: number;
  /**
   * v3 P3 (§3.2): max wrap-up turns let through `admission-closed` per 5h
   * window (persisted, survives daemon restart). Default 2, range [0, 10].
   */
  wrapUpQuota: number;
}

/**
 * v3 P3 (§3.2): three-state admission gate.
 * - `open`: admit everything.
 * - `admission-closed`: reject NEW turns (error `budget_admission`), allow
 *   `on_busy:"steer"` and `wrapUp:true` replies (bounded by `wrapUpQuota` per
 *   5h window); never interrupt a running turn.
 * - `closed`: the existing pause gate — reject all (error `budget_paused`),
 *   except the system-initiated checkpoint baton.
 * `closed` takes precedence over `admission-closed`.
 */
export type GateState = "open" | "admission-closed" | "closed";

/** Budget section of AgentBridgeConfig (defaults in config-service.ts). */
export interface BudgetConfig {
  enabled: boolean;
  /** Coordinator poll interval in seconds (first poll fires immediately on start()). */
  pollSeconds: number;
  /** Dynamic-line floor + no-burn-data fallback entry threshold on gateUtil; below guard's hard=99. */
  pauseAt: number;
  /** Joint-pause exit threshold; BOTH sides must drop below this on gateUtil. */
  resumeBelow: number;
  /** |warnUtil drift| above this triggers balance directives. */
  syncDriftPct: number;
  parallel: {
    /** Both sides must have at least this much remaining (100 - gateUtil). */
    minRemainingPct: number;
    /** Nearest 5h reset must be within this many seconds. */
    timeWindowSec: number;
  };
  /** When false (default), model/effort overrides are never injected into turn/start. */
  codexTierControl: boolean;
  /** Tier → override mapping; `full` must be configured for tier control to activate. */
  codexTiers: CodexTierMap;
  /**
   * v3.2: pauseAt / resumeBelow above are the FALLBACK gateUtil line (used only
   * when per-window burn data is unavailable); the time-aware dynamic line below
   * is the primary, always-on strategy. The legacy `strategy` selector is gone —
   * an old config that still carries `strategy:"conserve"` is tolerated (the key
   * is silently ignored — normalizeBudgetConfig only reads known keys).
   */
  maximize: MaximizeConfig;
  /**
   * v3 P4 (§3.4): thresholds for the runway-difference balance criterion. A
   * balance directive fires only when BOTH sides have a confident runway AND the
   * shorter/longer ratio is below `minRunwayRatio` AND the absolute gap is at
   * least `minRunwayGapHours` — the double gate prevents over-sensitive
   * rebalancing (Codex acceptance). Advisory-only; never touches the gate.
   */
  allocation: AllocationConfig;
}

/** Runway-difference balance thresholds (v3 P4 §3.4; defaults in config-service.ts). */
export interface AllocationConfig {
  /** Min shorter/longer runway ratio (integer percent) below which sides are "unbalanced"; default 50, range [10, 100]. */
  minRunwayRatio: number;
  /** Min absolute runway gap (hours) to treat as unbalanced; default 2, range [1, 168]. */
  minRunwayGapHours: number;
}

/** Pure-function output of computeBudgetState(). */
export interface BudgetState {
  phase: BudgetPhase;
  /** Unix seconds used for all decisions (injected, never Date.now() inside). */
  now: number;
  perAgent: { claude: AgentUsage | null; codex: AgentUsage | null };
  drift: {
    /** warnUtil(claude) - warnUtil(codex); 0 when either side is unknown. */
    pct: number;
    heavier: AgentName | null;
    lighter: AgentName | null;
  };
  pause: {
    active: boolean;
    /** Which side tripped the gate. */
    side: AgentName | "both" | null;
    reason: string | null;
    resumeBelow: number;
    /** Earliest plausible resume epoch considering only sides still blocking resume; null when unknown/not paused. */
    resumeAfterEpoch: number | null;
    resetEpochs: { claude: number; codex: number };
  };
  /**
   * v3 P4: retired as a produced signal — always `{ recommended: false }`. Kept
   * on the shape so `BudgetSnapshot.parallelRecommended` (a back-compat field
   * external consumers still read) has a source. The underutilization advice
   * below supersedes it.
   */
  parallel: { recommended: boolean; reason: string | null };
  /**
   * v3 P4 (§3.4): "the account will not use its weekly quota before reset" →
   * advise more parallelism / higher delegation density. Driven by the weekly
   * window's `will-not-fill` verdict; advisory-only (never gates). The
   * coordinator additionally gates EMISSION behind a cross-pair disk cooldown.
   */
  underutilization: { recommended: boolean; reason: string | null };
  effort: { claudeAdvice: string | null; codexTier: CodexTier };
  /** Rendered Chinese directive for Claude, or null when nothing to say (dedup is the coordinator's job). */
  directiveToClaude: string | null;
}

/** Serializable summary exposed via DaemonStatus.budget, get_budget and `abg budget`. */
export interface BudgetSnapshot {
  phase: BudgetPhase;
  /** Unix seconds of the poll that produced this snapshot. */
  updatedAt: number;
  claude: AgentUsage | null;
  codex: AgentUsage | null;
  driftPct: number;
  /** R4 intervention active (handoff OR pause) — kept for backwards consumers. */
  paused: boolean;
  /**
   * v2.4 side-aware semantics (coordinator hysteresis state, NOT instantaneous):
   * gateClosed is the daemon gate's ONLY authority — true when the Codex side
   * is exhausted ({codex} or {claude,codex}); false for Claude-only handoff.
   */
  gateClosed: boolean;
  /**
   * v3 P3 (§3.2): the three-state daemon gate (`open` | `admission-closed` |
   * `closed`). Optional for backward-compatible deserialization of legacy daemon
   * snapshots (absent → treat as `open`/`closed` per `gateClosed`). `closed`
   * mirrors `gateClosed`; `admission-closed` is the new finishing-protection tier.
   */
  gateState?: GateState;
  /** Which side(s) are budget-exhausted per the coordinator's activeSides set. */
  pauseSide: AgentName | "both" | null;
  pauseReason: string | null;
  /** Earliest unix seconds at which resume is plausible (max of gating reset epochs), null when not paused. */
  resumeAfterEpoch: number | null;
  parallelRecommended: boolean;
  codexTier: CodexTier;
  /** Advisory for Claude-side subagent model tiering when its budget is tight; null when none. */
  claudeAdvice: string | null;
  /**
   * v3 P1 (optional — absent on legacy daemons and when the guard probe does
   * not provide burn fields, so old consumers deserialize unchanged):
   * per-agent per-window burn rates passed through from the guard probe.
   */
  burnRate?: { claude: AgentBurnRates; codex: AgentBurnRates };
  /**
   * v3 P1 (optional, same compatibility contract as burnRate): guard-provided
   * remaining work time per agent; null until the guard reports a confident
   * rate on at least one decision-grade window.
   */
  runway?: { claude: RunwayEstimate | null; codex: RunwayEstimate | null };
  /**
   * v3.2: the effective numeric dynamic pause line per agent that tripped (or
   * would trip) the pause this poll. Always present on current daemons (the
   * dynamic line is the sole strategy); each side is null when no confident
   * window yields a numeric line. Optional only for backward-compatible
   * deserialization of legacy daemon snapshots. Display-only — never a decision
   * input.
   */
  dynamicPauseLine?: { claude: number | null; codex: number | null };
}

/** Optional per-turn overrides injected into Codex turn/start (sticky on the thread). */
export interface CodexTurnOverrides {
  model?: string;
  effort?: string;
}

/**
 * Per-tier turn/start override values (P4 / R5).
 *
 * `full` is the explicit RESTORE point: turn/start overrides are sticky on the
 * thread and we cannot know the user's original model/effort, so tier control
 * only activates when the user configures the values to restore to. When
 * `codexTierControl` is true but `full` is null, the daemon degrades tier
 * control to disabled (with one log line).
 */
export interface CodexTierMap {
  /** Restore values; REQUIRED for tier control to activate. */
  full: CodexTurnOverrides | null;
  balanced: CodexTurnOverrides;
  eco: CodexTurnOverrides;
}
