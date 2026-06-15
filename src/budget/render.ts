/**
 * Shared human-readable rendering for budget snapshots.
 *
 * Used by both the `get_budget` MCP tool (claude-adapter) and the `abg budget`
 * CLI so the two surfaces stay consistent (plan v2.2 acceptance criterion).
 * User-facing text is Chinese per project convention.
 */

import { agentWeeklyFiveHourWindowsLeft } from "./burn-view";
import type {
  AgentBurnRates,
  AgentUsage,
  BudgetSnapshot,
  BudgetWindowKey,
  BurnRate,
  RunwayEstimate,
} from "./types";

/**
 * Default outer quota-guard hard line (the user's agent-quota-guard
 * BUDGET_HARD default). v3.2: the guard default moved 92→99 (last fuse above the
 * bridge's targetUtil 98). Display-only context for the guard annotation — never
 * feeds any pause/resume decision; AGENTBRIDGE_GUARD_HARD_HINT overrides it.
 */
export const DEFAULT_GUARD_HARD_PCT = 99;

/**
 * Resolve the guard hard-line DISPLAY hint: AGENTBRIDGE_GUARD_HARD_HINT
 * overrides the default; invalid or out-of-range values fall back. Only affects
 * rendering, never the decision layer.
 */
export function resolveGuardHardHint(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AGENTBRIDGE_GUARD_HARD_HINT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GUARD_HARD_PCT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) return DEFAULT_GUARD_HARD_PCT;
  return parsed;
}

function formatEpoch(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || epochSeconds <= 0) return "未知";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function formatWindow(window: { util: number; resetEpoch: number } | null, label: string): string {
  if (!window) return `${label} 未知`;
  return `${label} ${window.util}%（重置 ${formatEpoch(window.resetEpoch)}）`;
}

function formatAgent(name: string, usage: AgentUsage | null, snapshotAt: number): string {
  if (!usage) return `${name}：未知（探测不可用）`;
  const parts = [
    formatWindow(usage.fiveHour, "5h"),
    formatWindow(usage.weekly, "周"),
    `门控 ${usage.gateUtil}%`,
    `预警 ${usage.warnUtil}%`,
  ];
  if (usage.rateLimitedUntil > 0) {
    parts.push(`限流至 ${formatEpoch(usage.rateLimitedUntil)}`);
  }
  if (usage.parsedVia === "positional") {
    parts.push("⚠️ 窗口识别使用位置兜底");
  }
  // Data age, not poll age: a stale probe cache served at poll time carries a
  // fresh-looking snapshot timestamp over hours-old numbers.
  const ageSec = usage.fetchedAt > 0 ? snapshotAt - usage.fetchedAt : 0;
  if (ageSec > 300) {
    parts.push(`⚠️ 数据采集于 ${Math.round(ageSec / 60)} 分钟前`);
  } else if (usage.stale) {
    parts.push("（缓存数据）");
  }
  return `${name}：${parts.join(" · ")}`;
}

const WINDOW_LABELS: Record<BudgetWindowKey, string> = {
  fiveHour: "5h 窗口",
  weekly: "周窗口",
};

/**
 * Tolerance for "runway truncated by the window reset": the guard's neutral
 * runway_seconds is reset-truncated, so when it lands within this many
 * seconds of the basis window's reset, the binding constraint is the refresh
 * itself, not depletion — annotate accordingly instead of implying the quota
 * runs out.
 */
const RESET_TRUNCATION_EPSILON_SEC = 60;

/** Format a duration as 「X小时Y分钟」 (minutes rounded; <1h shows 「Y分钟」). */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}分钟`;
  return `${hours}小时${minutes}分钟`;
}

/** Format an epoch as a LOCAL-timezone wall-clock 「HH:MM」. */
export function formatClockTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatWindowRate(label: string, rate: BurnRate | null): string | null {
  if (!rate) return null;
  if (!rate.confident) return `${label} 采样中`;
  return `${label} ≈${rate.pctPerHour.toFixed(2)}%/h`;
}

/**
 * The runway display segment. All numbers are the guard's verbatim fields
 * (constraint #2: the bridge never recomputes) — this function only formats:
 *  - duration from runway_seconds;
 *  - 「至 HH:MM」 from depleted_at_epoch (local clock; omitted when absent);
 *  - the reset-truncation note when runway_seconds ends at the basis
 *    window's reset (refresh un-blocks before depletion would).
 */
function formatRunwaySegment(
  runway: RunwayEstimate,
  basisWindow: AgentUsage["fiveHour"],
  snapshotAt: number,
): string {
  const truncatedByReset =
    basisWindow !== null &&
    basisWindow.resetEpoch > 0 &&
    snapshotAt + runway.seconds >= basisWindow.resetEpoch - RESET_TRUNCATION_EPSILON_SEC;

  const clock = runway.depletedAtEpoch ? formatClockTime(runway.depletedAtEpoch) : null;
  let clockNote: string;
  if (clock) {
    clockNote = truncatedByReset ? `至 ${clock} 窗口刷新即截断，` : `至 ${clock}，`;
  } else {
    clockNote = truncatedByReset ? "窗口刷新即截断，" : "";
  }
  return `约可再工作 ${formatDuration(runway.seconds)}（${clockNote}${WINDOW_LABELS[runway.basis]}为约束）`;
}

/**
 * One burn-rate/runway line per agent (v3 P1, layered amendment). Returns
 * null when the agent has no rate data at all — legacy snapshots (and old
 * guard probes without the burn fields) render exactly as before.
 *
 * Claude guard annotation (Q7, honesty-first choice): the guard's
 * runway_seconds is the NEUTRAL "to 100%" estimate, but quota-guard
 * hard-stops the Claude process at its own hard line (default 99%) first.
 * Rather than scaling the number ourselves (a proportional fold assumes
 * linear burn AND breaks when the runway is reset-truncated — effectively a
 * recomputation, which constraint #2 forbids), we display the guard's number
 * untouched and state the caveat explicitly.
 */
function formatBurnRateLine(
  name: string,
  usage: AgentUsage | null,
  rates: AgentBurnRates,
  runway: RunwayEstimate | null,
  snapshotAt: number,
  guardHardPct: number | null,
): string | null {
  const parts = [
    formatWindowRate("5h", rates.fiveHour),
    formatWindowRate("周", rates.weekly),
  ].filter((part): part is string => part !== null);
  if (parts.length === 0 && !runway) return null;

  if (runway) {
    const basisWindow = usage ? usage[runway.basis] : null;
    parts.push(formatRunwaySegment(runway, basisWindow, snapshotAt));
  }
  if (guardHardPct !== null) {
    parts.push(
      `外层 guard 硬线 ${guardHardPct}%（v3 不可越过；runway 为中性口径，Claude 会先在硬线被外层停住）`,
    );
  }
  return `${name} 燃尽率：${parts.join(" · ")}`;
}

function formatFiveHourWindowsLeftLine(snapshot: BudgetSnapshot): string | null {
  const values: Array<[string, number]> = [];
  const claude = agentWeeklyFiveHourWindowsLeft(snapshot.claude, snapshot.updatedAt);
  const codex = agentWeeklyFiveHourWindowsLeft(snapshot.codex, snapshot.updatedAt);
  if (claude !== null) values.push(["Claude", claude]);
  if (codex !== null) values.push(["Codex", codex]);
  if (values.length === 0) return null;

  const unique = [...new Set(values.map(([, value]) => value.toFixed(1)))];
  if (unique.length === 1) return `按当前节奏，周额度还够 ~${unique[0]} 个 5h 窗口`;

  const byAgent = values.map(([name, value]) => `${name} ~${value.toFixed(1)}`).join(" / ");
  return `按当前节奏，周额度还够 ${byAgent} 个 5h 窗口`;
}

/**
 * v3.2 (display-only): the binding dynamic pause line per agent and its headroom
 * to the agent's gateUtil. Present when the snapshot carries `dynamicPauseLine`
 * (always-on since v3.2) and at least one side has a numeric line. Never a
 * decision input — mirrors the decision layer's effectiveDynamicLine.
 */
function formatDynamicLineLine(snapshot: BudgetSnapshot): string | null {
  const lines = snapshot.dynamicPauseLine;
  if (!lines) return null;
  const parts: string[] = [];
  const entries: Array<[string, number | null, AgentUsage | null]> = [
    ["Claude", lines.claude, snapshot.claude],
    ["Codex", lines.codex, snapshot.codex],
  ];
  for (const [name, line, usage] of entries) {
    if (line === null) continue;
    const headroom = usage ? `（util ${usage.gateUtil}%，余量 ${(line - usage.gateUtil).toFixed(1)}）` : "";
    parts.push(`${name} ${line.toFixed(1)}%${headroom}`);
  }
  if (parts.length === 0) return null;
  return `动态暂停线：${parts.join(" · ")}`;
}

const PHASE_LABELS: Record<BudgetSnapshot["phase"], string> = {
  normal: "normal（正常）",
  balance: "balance（需均衡）",
  parallel: "parallel（建议并行提速）",
  // Side-neutral: the detail line below distinguishes handoff / codex-only / joint.
  paused: "paused（预算干预中）",
};

/** Render a budget snapshot as readable Chinese text. */
export function renderBudgetSnapshot(
  snapshot: BudgetSnapshot,
  options: { guardHardPct?: number } = {},
): string {
  const guardHardPct = options.guardHardPct ?? resolveGuardHardHint();
  const lines: string[] = [];
  lines.push(`【预算快照 · 账号级】阶段：${PHASE_LABELS[snapshot.phase]} · 更新于 ${formatEpoch(snapshot.updatedAt)}`);
  lines.push(formatAgent("Claude", snapshot.claude, snapshot.updatedAt));
  lines.push(formatAgent("Codex", snapshot.codex, snapshot.updatedAt));

  // v3 P1 (layered amendment): burn-rate / runway lines, present only when the
  // guard probe supplied the optional decision-grade fields. The guard-hardline
  // annotation applies to the CLAUDE side only — quota-guard supervises the
  // Claude process; Codex has no such bound.
  if (snapshot.burnRate) {
    const claudeLine = formatBurnRateLine(
      "Claude",
      snapshot.claude,
      snapshot.burnRate.claude,
      snapshot.runway?.claude ?? null,
      snapshot.updatedAt,
      guardHardPct,
    );
    if (claudeLine) lines.push(claudeLine);
    const codexLine = formatBurnRateLine(
      "Codex",
      snapshot.codex,
      snapshot.burnRate.codex,
      snapshot.runway?.codex ?? null,
      snapshot.updatedAt,
      null,
    );
    if (codexLine) lines.push(codexLine);
  }
  const fiveHourWindowsLeftLine = formatFiveHourWindowsLeftLine(snapshot);
  if (fiveHourWindowsLeftLine) lines.push(fiveHourWindowsLeftLine);

  const dynamicLineLine = formatDynamicLineLine(snapshot);
  if (dynamicLineLine) lines.push(dynamicLineLine);

  if (snapshot.claude && snapshot.codex) {
    const abs = Math.abs(snapshot.driftPct);
    if (abs > 0) {
      const heavier = snapshot.driftPct > 0 ? "Claude" : "Codex";
      const lighter = snapshot.driftPct > 0 ? "Codex" : "Claude";
      lines.push(`漂移：${heavier} 比 ${lighter} 高 ${abs} 个百分点`);
    } else {
      lines.push("漂移：双方持平");
    }
  }

  if (snapshot.paused) {
    // Estimate only: an early weekly refresh resets both windows ahead of
    // schedule, so release always follows live probes, not this timestamp.
    const resume = snapshot.resumeAfterEpoch
      ? `；预计恢复 ${formatEpoch(snapshot.resumeAfterEpoch)}（以实测为准；提前刷新会更早解除）`
      : "";
    const reason = snapshot.pauseReason ?? "额度接近耗尽";
    if (snapshot.pauseSide === "claude" && !snapshot.gateClosed) {
      lines.push(`接力中：Claude 侧额度耗尽，已交接 Codex 继续推进（闸门开放） — ${reason}${resume}`);
    } else if (snapshot.pauseSide === "codex") {
      lines.push(`暂停：Codex 侧额度耗尽（闸门关闭，Claude 可 solo 推进独立部分） — ${reason}${resume}`);
    } else {
      lines.push(`暂停：双侧联合暂停（闸门关闭） — ${reason}${resume}`);
    }
  } else {
    lines.push("暂停：否");
  }

  if (snapshot.parallelRecommended) {
    lines.push("并行建议：额度富余且临近结算，建议拆分更多并行子任务");
  }
  if (snapshot.codexTier !== "full") {
    lines.push(`Codex 档位：${snapshot.codexTier}`);
  }
  if (snapshot.claudeAdvice) {
    lines.push(`Claude 建议：${snapshot.claudeAdvice}`);
  }

  lines.push("注：百分比为订阅账号级用量（同机其他会话共享同一额度池）。");
  return lines.join("\n");
}

/** Rendered fallback when budget sensing is unavailable (probe missing or disabled). */
export const BUDGET_UNAVAILABLE_TEXT =
  "预算感知不可用：未检测到 agent-quota-guard 探针（~/.budget-guard/bin/budget-probe）或 budget 功能已禁用。协作不受影响。";
