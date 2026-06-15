import { matchingGateReset } from "./budget-gate";
import { agentShouldPause, isDecisionGrade, resumeBlockingEpochFor } from "./budget-decision";
import type { AgentName, AgentUsage, BudgetConfig, BudgetState, CodexTier } from "./types";

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

function parallelState(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): BudgetState["parallel"] {
  if (!claude || !codex) return { recommended: false, reason: null };
  if (claude.remaining <= cfg.parallel.minRemainingPct || codex.remaining <= cfg.parallel.minRemainingPct) {
    return { recommended: false, reason: null };
  }
  const claudeReset = claude.fiveHour?.resetEpoch ?? 0;
  const codexReset = codex.fiveHour?.resetEpoch ?? 0;
  if (claudeReset <= now || codexReset <= now) return { recommended: false, reason: null };

  const nearestResetSec = Math.min(claudeReset - now, codexReset - now);
  if (nearestResetSec >= cfg.parallel.timeWindowSec) return { recommended: false, reason: null };

  const minutes = Math.ceil(nearestResetSec / 60);
  return {
    recommended: true,
    reason: `双方剩余额度均高于 ${pct(cfg.parallel.minRemainingPct)}，最近 5h 桶约 ${minutes} 分钟后重置`,
  };
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

function balanceDirective(
  claude: AgentUsage,
  codex: AgentUsage,
  drift: BudgetState["drift"],
  parallel: BudgetState["parallel"],
): string {
  const heavier = drift.heavier ? AGENT_LABEL[drift.heavier] : "未知";
  const lighter = drift.lighter ? AGENT_LABEL[drift.lighter] : "未知";
  const lines = [
    "【预算协调 · 账号级】检测到双方用量比例漂移。",
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `${heavier} 比 ${lighter} 高 ${pct(Math.abs(drift.pct))}，请优先把后续可拆分任务分给 ${lighter}，直到 warnUtil 接近。`,
  ];
  if (parallel.recommended && parallel.reason) {
    lines.push(`${parallel.reason}；可让 ${lighter} 承担更多并行子任务，兼顾均衡与提速。`);
  }
  return lines.join("\n");
}

function parallelDirective(
  claude: AgentUsage,
  codex: AgentUsage,
  parallel: BudgetState["parallel"],
): string {
  return [
    "【预算协调 · 账号级】当前额度富余且临近 5h 结算，建议动态并行。",
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `${parallel.reason}；可以拆更多独立子任务并行推进。`,
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
): BudgetState {
  const triggers = [
    pauseTrigger("claude", claude, cfg, now),
    pauseTrigger("codex", codex, cfg, now),
  ].filter((trigger): trigger is PauseTrigger => trigger !== null);
  const paused = triggers.length > 0;
  const drift = driftFor(claude, codex, cfg);
  const parallel = paused ? { recommended: false, reason: null } : parallelState(claude, codex, cfg, now);
  const resetEpochs = {
    claude: matchingGateReset(claude),
    codex: matchingGateReset(codex),
  };
  const filteredResumeAfterEpoch = paused ? resumeAfterEpoch(claude, codex, cfg, now) : null;

  let phase: BudgetState["phase"] = "normal";
  if (paused) phase = "paused";
  else if (drift.heavier && drift.lighter) phase = "balance";
  else if (parallel.recommended) phase = "parallel";

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
    directiveToClaude = balanceDirective(claude, codex, drift, parallel);
  } else if (phase === "parallel" && claude && codex) {
    directiveToClaude = parallelDirective(claude, codex, parallel);
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
    effort: { claudeAdvice: claudeAdviceFor(claude, now), codexTier: codexTierFor(codex, now) },
    directiveToClaude,
  };
}
