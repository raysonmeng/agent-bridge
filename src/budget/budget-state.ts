import { matchingGateReset } from "./budget-gate";
import {
  agentShouldAdmitClose,
  agentShouldPause,
  dynamicWindowVerdict,
  isDecisionGrade,
  resumeBlockingEpochFor,
} from "./budget-decision";
import type {
  AgentName,
  AgentUsage,
  BudgetConfig,
  BudgetState,
  CodexTier,
  RunwayEstimate,
} from "./types";

/**
 * Per-agent runway passed INTO computeBudgetState (v3 P4). The coordinator
 * computes these from the guard probe (burn-view `agentRunway`) and injects them
 * here, so budget-state never imports burn-view — which would close an import
 * cycle (burn-view → budget-state for isDecisionGrade). Both null on legacy
 * callers / no burn data → the balance criterion falls back to warnUtil drift.
 */
export interface RunwayInput {
  claude: RunwayEstimate | null;
  codex: RunwayEstimate | null;
}

const NO_RUNWAY: RunwayInput = { claude: null, codex: null };

/**
 * Minimum projected waste (targetUtil − projectedAtReset, in percent) before the
 * underutilization advice fires. A window projected at 97.5 vs a 98 target is
 * barely underutilizing and not worth a nag; only flag a materially idle account.
 */
const UNDERUTILIZATION_MIN_WASTE_PCT = 10;

// isDecisionGrade moved to budget-decision.ts (the strategy-aware decision
// module needs it too); re-export keeps existing importers (budget-fingerprint,
// burn-view) working unchanged.
export { isDecisionGrade } from "./budget-decision";

interface PauseTrigger {
  agent: AgentName;
  reason: string;
}

const AGENT_LABEL: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

// R5 v1 Codex tier bands use warnUtil, not gateUtil: model/effort economy is a
// soft-cost control, while gateUtil remains reserved for R4 hard pause gating.
const CODEX_BALANCED_WARN_UTIL = 60;
const CODEX_ECO_WARN_UTIL = 80;
const CLAUDE_ADVICE_WARN_UTIL = 80;

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function formatEpoch(epoch: number | null): string {
  if (!epoch || epoch <= 0) return "未知";
  return new Date(epoch * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function usageSummary(name: AgentName, usage: AgentUsage | null): string {
  if (!usage) return `${AGENT_LABEL[name]} 未知`;
  return `${AGENT_LABEL[name]} gate=${pct(usage.gateUtil)} warn=${pct(usage.warnUtil)} 5h重置=${formatEpoch(usage.fiveHour?.resetEpoch ?? 0)}`;
}

function resumeAfterEpoch(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): number | null {
  const epochs = [
    resumeBlockingEpochFor(claude, cfg, now),
    resumeBlockingEpochFor(codex, cfg, now),
  ].filter((epoch) => epoch > 0);
  if (epochs.length === 0) return null;
  return Math.max(...epochs);
}

/**
 * Pause-entry trigger for one agent. Delegates the whole decision (per-window
 * dynamic line, with the gateUtil fallback when burn data is absent) to the
 * single source of truth in budget-decision.ts, so the rendered state here can
 * never diverge from the coordinator's gating in budget-fingerprint.ts.
 */
function pauseTrigger(agent: AgentName, usage: AgentUsage | null, cfg: BudgetConfig, now: number): PauseTrigger | null {
  const decision = agentShouldPause(agent, usage, cfg, now);
  if (!decision.pause) return null;
  return { agent, reason: decision.reason };
}

function driftFor(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
): BudgetState["drift"] {
  if (!claude || !codex) return { pct: 0, heavier: null, lighter: null };
  const drift = Math.round((claude.warnUtil - codex.warnUtil) * 10) / 10;
  if (Math.abs(drift) <= cfg.syncDriftPct) {
    return { pct: drift, heavier: null, lighter: null };
  }
  return {
    pct: drift,
    heavier: drift > 0 ? "claude" : "codex",
    lighter: drift > 0 ? "codex" : "claude",
  };
}

/**
 * v3 P4 (§3.4) runway-difference balance criterion. Returns the heavier/lighter
 * pair ONLY when both gates trip: the shorter/longer ratio is below
 * `minRunwayRatio` AND the absolute gap is at least `minRunwayGapHours`. The
 * shorter-runway side is `heavier` (route work AWAY from it). `null` means
 * balanced enough — no balance directive. Pure runway arithmetic; the guard's
 * `seconds` are passed through verbatim (§3.3 #2: no burn-rate recomputation).
 *
 * Today's live case (Codex util high but near reset → runway truncated to ~6.5h,
 * Claude ~9h) lands inside [50%, 2h] tolerance → balanced → NOT flagged, which
 * is the whole point of moving off warnUtil.
 */
function runwayBalance(
  claudeRunway: RunwayEstimate,
  codexRunway: RunwayEstimate,
  cfg: BudgetConfig,
): { heavier: AgentName; lighter: AgentName } | null {
  const ch = claudeRunway.seconds / 3600;
  const xh = codexRunway.seconds / 3600;
  const lo = Math.min(ch, xh);
  const hi = Math.max(ch, xh);
  // hi <= 0 (both depleted) is not an imbalance the balance lever can fix; the
  // pause/gate layer owns that. Treat as balanced to avoid a divide-by-zero.
  const ratioPct = hi <= 0 ? 100 : Math.round((100 * lo) / hi);
  const gapHours = Math.abs(ch - xh);
  if (ratioPct < cfg.allocation.minRunwayRatio && gapHours >= cfg.allocation.minRunwayGapHours) {
    const shorter: AgentName = ch < xh ? "claude" : "codex";
    return { heavier: shorter, lighter: shorter === "claude" ? "codex" : "claude" };
  }
  return null;
}

/** How the balance heavier/lighter pair was chosen — drives the directive text. */
type AllocationBasis = "warn" | "runway";

/**
 * The balance routing decision. `drift.pct` is ALWAYS the warnUtil diff (stable
 * display contract for `snapshot.driftPct` and the 漂移 readout); only
 * heavier/lighter switch to the runway criterion when BOTH sides have a
 * confident runway. Otherwise it is exactly the legacy `driftFor` (§3.4 #2/#3).
 */
function allocationDrift(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  runway: RunwayInput,
  cfg: BudgetConfig,
): { drift: BudgetState["drift"]; basis: AllocationBasis } {
  const warnDrift = driftFor(claude, codex, cfg);
  if (!claude || !codex || !runway.claude || !runway.codex) {
    return { drift: warnDrift, basis: "warn" };
  }
  const balance = runwayBalance(runway.claude, runway.codex, cfg);
  return {
    drift: {
      pct: warnDrift.pct,
      heavier: balance?.heavier ?? null,
      lighter: balance?.lighter ?? null,
    },
    basis: "runway",
  };
}

/** Format a duration in seconds as 「~X.Xh」 for the runway balance directive. */
function runwayHoursText(runway: RunwayEstimate | null): string {
  if (!runway) return "未知";
  return `~${(runway.seconds / 3600).toFixed(1)}h`;
}

/**
 * v3 P4 (§3.4) underutilization signal: the account will not use its WEEKLY
 * quota before reset (the weekly window's `will-not-fill` verdict), with at
 * least `UNDERUTILIZATION_MIN_WASTE_PCT` of headroom going to waste. Picks the
 * side wasting the most. 5h underutilization is intentionally NOT a driver
 * (Q3 consensus: display-only). Advisory-only; never gates.
 */
function underutilizationState(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): BudgetState["underutilization"] {
  let top: { agent: AgentName; projected: number; waste: number; resetEpoch: number } | null = null;
  for (const [agent, usage] of [["claude", claude], ["codex", codex]] as const) {
    const weekly = usage?.weekly;
    if (!weekly) continue;
    const verdict = dynamicWindowVerdict(weekly, cfg, now);
    if (verdict.kind !== "will-not-fill") continue;
    // Round to 1 decimal before the threshold compare so a projected-at-reset
    // float error (util + rate×tH) cannot drop a genuine 10.0% waste to
    // 9.9999…% and silently skip the boundary case (display-only, never gates).
    const waste = Math.round((cfg.maximize.targetUtil - verdict.projectedAtReset) * 10) / 10;
    if (waste < UNDERUTILIZATION_MIN_WASTE_PCT) continue;
    if (top === null || waste > top.waste) {
      top = { agent, projected: verdict.projectedAtReset, waste, resetEpoch: weekly.resetEpoch };
    }
  }
  if (top === null) return { recommended: false, reason: null };
  const hoursToReset = Math.max(0, (top.resetEpoch - now) / 3600);
  const reason = [
    "【预算协调 · 账号级】额度将欠载，建议提高并行/委派密度。",
    `${AGENT_LABEL[top.agent]} 按当前燃尽率周窗口刷新时只会用到 ~${pct(top.projected)}，` +
      `距刷新还有 ~${hoursToReset.toFixed(1)}h —— 建议拆更多并行子任务/提高委派密度，` +
      `否则约 ${pct(top.waste)} 周额度将作废。`,
  ].join("\n");
  return { recommended: true, reason };
}

export function renderBudgetInterventionDirective(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  side: AgentName | "both",
  reason: string,
  resumeEpoch: number | null,
  cfg: BudgetConfig,
): string {
  const resumeText = `预计恢复时间（以实测为准；提前刷新会更早解除）：${formatEpoch(resumeEpoch)}。`;
  // v3.2: resume happens per-window at `util < dynamicPauseAt − resumeHysteresisPct`
  // (or window reset), NOT at resumeBelow — the dynamic line is the sole strategy.
  const resumeCondSingle = `各窗口 util 回落至动态暂停线 − ${pct(cfg.maximize.resumeHysteresisPct)} 以下或对应窗口刷新`;
  const resumeCondBoth = `各窗口 util 都回落至动态暂停线 − ${pct(cfg.maximize.resumeHysteresisPct)} 以下或对应窗口刷新`;
  if (side === "claude") {
    return [
      "【预算协调 · 账号级】Claude 侧额度紧张，进入接力模式。",
      `触发方：Claude；原因：${reason}。`,
      `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
      `恢复参考：Claude ${resumeCondSingle} 且没有有效 rate_limit；${resumeText}`,
      "请立即交接：把剩余任务清单、关键上下文、产出位置、验收标准打包成一条 reply 发给 Codex。",
      "交接后 Claude 停手；要求 Codex 在单 turn 内尽量完成，尾巴写 checkpoint，暂停期不要期待 Claude 回复。",
    ].join("\n");
  }

  if (side === "codex") {
    return [
      "【预算协调 · 账号级】Codex 侧额度紧张，暂停委派。",
      `触发方：Codex；原因：${reason}。`,
      `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
      `恢复参考：Codex ${resumeCondSingle} 且没有有效 rate_limit；${resumeText}`,
      "请 Claude 写 checkpoint，并可 solo 推进不依赖 Codex 的独立部分；不要继续向 Codex 委派，标注清楚分工断点。",
    ].join("\n");
  }

  return [
    "【预算协调 · 账号级】进入联合暂停。",
    `触发方：双方；原因：${reason}。`,
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `恢复条件：Claude 与 Codex 的 ${resumeCondBoth}，且没有有效 rate_limit；${resumeText}`,
    "请收尾当前步、写 checkpoint、停止继续委派；pause 期间不要重试向 Codex 发送 reply。",
  ].join("\n");
}

/**
 * v3 P3 (§3.2): the `admission-closed` directive to Claude — the Codex-side
 * finishing-protection notice. Emitted (turnPhase-aware: only when Codex is not
 * mid-turn) when the admission lane closes the codex/both side. Tells Claude the
 * daemon will now decline NEW Codex turns (`budget_admission`) while still
 * accepting wrap-up replies, so Claude routes toward winding the collaboration
 * down rather than starting new Codex work. Pure render; the emission/dedup and
 * the daemon gate live in the coordinator and daemon respectively. `side` is
 * always "codex" or "both" here (the daemon gate is codex-scoped — Claude
 * self-governs its own line via the always-on budget prompt).
 */
export function renderBudgetAdmissionDirective(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  side: AgentName | "both",
  reason: string,
  resetEpoch: number | null,
  cfg: BudgetConfig,
): string {
  const resetText = `对应窗口约 ${formatEpoch(resetEpoch)} 刷新（以实测为准；提前刷新会更早解除）`;
  const head =
    side === "both"
      ? "【预算协调 · 账号级】双方进入收尾保护（admission-closed）。"
      : "【预算协调 · 账号级】Codex 侧进入收尾保护（admission-closed）。";
  return [
    head,
    `触发原因：${reason}。`,
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `闸门已收紧：新的 Codex 任务会被拒（budget_admission），但仍可用 reply 带 wrap_up=true 把当前协作收尾到 checkpoint` +
      `（每窗口至多 ${cfg.maximize.wrapUpQuota} 个），steer 修正不受限；${resetText}。`,
    "建议：不要再向 Codex 派新任务；把当前 Codex 协作收尾、写 checkpoint，可独立推进的部分 Claude 可 solo 继续。",
  ].join("\n");
}

function balanceDirective(
  claude: AgentUsage,
  codex: AgentUsage,
  drift: BudgetState["drift"],
  basis: AllocationBasis,
  runway: RunwayInput,
): string {
  const heavier = drift.heavier ? AGENT_LABEL[drift.heavier] : "未知";
  const lighter = drift.lighter ? AGENT_LABEL[drift.lighter] : "未知";
  if (basis === "runway") {
    return [
      "【预算协调 · 账号级】按剩余可工作时间需要均衡。",
      `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
      `Claude 按当前燃尽率约可再工作 ${runwayHoursText(runway.claude)}、` +
        `Codex ${runwayHoursText(runway.codex)}（窗口为约束）；` +
        `runway 较短的一侧是 ${heavier}，请把后续可拆分任务优先派给 ${lighter}。`,
    ].join("\n");
  }
  return [
    "【预算协调 · 账号级】检测到双方用量比例漂移。",
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `${heavier} 比 ${lighter} 高 ${pct(Math.abs(drift.pct))}，请优先把后续可拆分任务分给 ${lighter}，直到 warnUtil 接近。`,
  ].join("\n");
}

// Tier/advice are decision OUTPUTS (they queue turn overrides and inject
// advice), so they require decision-grade data exactly like pause/advice
// directives — a degraded display-only record (stale cache, unknown-reset
// window, see agent-bridge#103) must not flip the Codex tier. Non-decision-
// grade falls back to the same outputs a probe miss produces.
function codexTierFor(codex: AgentUsage | null, now: number): CodexTier {
  if (!codex || !isDecisionGrade(codex, now)) return "full";
  if (codex.warnUtil >= CODEX_ECO_WARN_UTIL) return "eco";
  if (codex.warnUtil >= CODEX_BALANCED_WARN_UTIL) return "balanced";
  return "full";
}

function claudeAdviceFor(claude: AgentUsage | null, now: number): string | null {
  if (!claude || !isDecisionGrade(claude, now)) return null;
  if (claude.warnUtil < CLAUDE_ADVICE_WARN_UTIL) return null;
  return `Claude warnUtil ${pct(claude.warnUtil)} 已偏高；后续可拆分 subagent 建议降档到 haiku/sonnet，并保留高难度主线给当前会话。`;
}

export function computeBudgetState(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
  runway: RunwayInput = NO_RUNWAY,
): BudgetState {
  const triggers = [
    pauseTrigger("claude", claude, cfg, now),
    pauseTrigger("codex", codex, cfg, now),
  ].filter((trigger): trigger is PauseTrigger => trigger !== null);
  const paused = triggers.length > 0;
  const { drift, basis } = allocationDrift(claude, codex, runway, cfg);
  // v3 P4: the parallel directive is retired; underutilization advice replaces
  // it. The field is kept (always false) so snapshot.parallelRecommended has a
  // source for back-compat consumers.
  const parallel = { recommended: false, reason: null };
  // §3.4 invariant 6: balance / underutilization advice fires only when the gate
  // is OPEN and NEITHER side is rate-limited. (The coordinator's phantom-hold
  // already suppresses advise on non-decision-grade data; this adds the
  // non-rate-limited guard and keeps the rendered phase honest — never advise
  // toward an account whose probes are being rate-limited.) `drift` is still
  // computed regardless so snapshot.driftPct stays the raw warnUtil readout.
  const adviceEligible =
    !paused &&
    claude !== null &&
    codex !== null &&
    claude.rateLimitedUntil <= now &&
    codex.rateLimitedUntil <= now &&
    // H1: enforce "decision-grade(fresh)" LOCALLY too. The coordinator's
    // classifyPoll phantom-hold already gates EMISSION on decision-grade, so
    // this is not a send-path fix — it keeps the rendered snapshot.phase honest
    // (no balance/underutilized label on stale data via get_budget / abg budget).
    isDecisionGrade(claude, now) &&
    isDecisionGrade(codex, now) &&
    // v3 P3 (M3b): the routing advice (balance / underutilization) moves work
    // DENSITY between the two sides; it is meaningless — and directly
    // contradictory — while EITHER side is in admission-closed finishing
    // protection (the daemon gate would reject new turns the advice routes
    // toward that side). Suppress at the source so snapshot.phase stays honest
    // AND classifyPoll never produces an advise effect whose fingerprint would
    // otherwise get advanced-but-suppressed. Uses the raw predicate (the
    // hysteresis lives in the coordinator); the coordinator additionally hard-
    // gates the advise EMISSION on gateState()==="open" to cover the exit band.
    !agentShouldAdmitClose("claude", claude, cfg, now).admitClose &&
    !agentShouldAdmitClose("codex", codex, cfg, now).admitClose;
  const balanceActive = adviceEligible && drift.heavier !== null && drift.lighter !== null;
  // Compute underutilization only when it could actually become the phase (not
  // paused, advice-eligible, and balance has not already claimed the advise
  // slot) — keeps BudgetState internally consistent: no stale underutilization
  // flag while phase is balance/paused.
  const underutilization =
    adviceEligible && !balanceActive
      ? underutilizationState(claude, codex, cfg, now)
      : { recommended: false, reason: null };
  const resetEpochs = {
    claude: matchingGateReset(claude),
    codex: matchingGateReset(codex),
  };
  const filteredResumeAfterEpoch = paused ? resumeAfterEpoch(claude, codex, cfg, now) : null;

  let phase: BudgetState["phase"] = "normal";
  if (paused) phase = "paused";
  else if (balanceActive) phase = "balance";
  else if (underutilization.recommended) phase = "underutilized";

  const pauseSide = !paused
    ? null
    : triggers.length > 1
      ? "both"
      : triggers[0].agent;

  let directiveToClaude: string | null = null;
  if (phase === "paused") {
    directiveToClaude = renderBudgetInterventionDirective(
      claude,
      codex,
      pauseSide ?? "both",
      triggers.map((trigger) => trigger.reason).join("；"),
      filteredResumeAfterEpoch,
      cfg,
    );
  } else if (phase === "balance" && claude && codex) {
    directiveToClaude = balanceDirective(claude, codex, drift, basis, runway);
  } else if (phase === "underutilized") {
    directiveToClaude = underutilization.reason;
  }

  return {
    phase,
    now,
    perAgent: { claude, codex },
    drift,
    pause: {
      active: paused,
      side: pauseSide,
      reason: paused ? triggers.map((trigger) => trigger.reason).join("；") : null,
      resumeBelow: cfg.resumeBelow,
      resumeAfterEpoch: filteredResumeAfterEpoch,
      resetEpochs,
    },
    parallel,
    underutilization,
    effort: { claudeAdvice: claudeAdviceFor(claude, now), codexTier: codexTierFor(codex, now) },
    directiveToClaude,
  };
}
