/**
 * Shared human-readable rendering for budget snapshots.
 *
 * Used by both the `get_budget` MCP tool (claude-adapter) and the `abg budget`
 * CLI so the two surfaces stay consistent (plan v2.2 acceptance criterion).
 * User-facing text is Chinese per project convention.
 */

import type { AgentUsage, BudgetSnapshot } from "./types";

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

const PHASE_LABELS: Record<BudgetSnapshot["phase"], string> = {
  normal: "normal（正常）",
  balance: "balance（需均衡）",
  parallel: "parallel（建议并行提速）",
  // Side-neutral: the detail line below distinguishes handoff / codex-only / joint.
  paused: "paused（预算干预中）",
};

/** Render a budget snapshot as readable Chinese text. */
export function renderBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const lines: string[] = [];
  lines.push(`【预算快照 · 账号级】阶段：${PHASE_LABELS[snapshot.phase]} · 更新于 ${formatEpoch(snapshot.updatedAt)}`);
  lines.push(formatAgent("Claude", snapshot.claude, snapshot.updatedAt));
  lines.push(formatAgent("Codex", snapshot.codex, snapshot.updatedAt));

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
