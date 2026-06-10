import { describe, expect, test } from "bun:test";
import { renderBudgetSnapshot, BUDGET_UNAVAILABLE_TEXT } from "../budget/render";
import type { AgentUsage, BudgetSnapshot } from "../budget/types";

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    ok: true,
    stale: false,
    gateUtil: 42,
    warnUtil: 45,
    fiveHour: { util: 42, resetEpoch: 1_780_750_000 },
    weekly: { util: 19, resetEpoch: 1_781_193_812 },
    remaining: 58,
    rateLimitedUntil: 0,
    fetchedAt: 1_780_711_639,
    parsedVia: "id-match",
    ...overrides,
  };
}

function snapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    phase: "normal",
    updatedAt: 1_780_711_700,
    claude: usage(),
    codex: usage({ gateUtil: 10, warnUtil: 14, fiveHour: { util: 10, resetEpoch: 1_780_699_485 } }),
    driftPct: 31,
    paused: false,
    gateClosed: false,
    pauseSide: null,
    pauseReason: null,
    resumeAfterEpoch: null,
    parallelRecommended: false,
    codexTier: "full",
    claudeAdvice: null,
    ...overrides,
  };
}

describe("renderBudgetSnapshot", () => {
  test("renders both agents with window percentages and gate/warn utils", () => {
    const text = renderBudgetSnapshot(snapshot());
    expect(text).toContain("Claude：");
    expect(text).toContain("Codex：");
    expect(text).toContain("5h 42%");
    expect(text).toContain("周 19%");
    expect(text).toContain("门控 42%");
    expect(text).toContain("预警 45%");
  });

  test("shows drift direction with heavier side first", () => {
    const text = renderBudgetSnapshot(snapshot({ driftPct: 31 }));
    expect(text).toContain("Claude 比 Codex 高 31 个百分点");

    const reversed = renderBudgetSnapshot(snapshot({ driftPct: -12 }));
    expect(reversed).toContain("Codex 比 Claude 高 12 个百分点");
  });

  test("renders codex-side pause with gate-closed wording and live-probe caveat", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        phase: "paused",
        paused: true,
        gateClosed: true,
        pauseSide: "codex",
        pauseReason: "Codex 5h 窗口已达 92%",
        resumeAfterEpoch: 1_780_750_000,
      }),
    );
    expect(text).toContain("Codex 侧额度耗尽");
    expect(text).toContain("闸门关闭");
    expect(text).toContain("Codex 5h 窗口已达 92%");
    // v2.4: early weekly refresh may release sooner — estimate is advisory.
    expect(text).toContain("以实测为准");
    expect(text).not.toContain("不早于");
    // Side-aware: the phase label must NOT claim a joint pause for one side.
    expect(text).not.toContain("联合暂停");
  });

  test("renders claude-side handoff with gate OPEN wording", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        phase: "paused",
        paused: true,
        gateClosed: false,
        pauseSide: "claude",
        pauseReason: "Claude 5h 窗口已达 91%",
      }),
    );
    expect(text).toContain("接力中");
    expect(text).toContain("闸门开放");
    expect(text).not.toContain("闸门关闭");
    expect(text).not.toContain("联合暂停");
  });

  test("renders joint pause for both sides", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        phase: "paused",
        paused: true,
        gateClosed: true,
        pauseSide: "both",
        pauseReason: "双侧均超阈值",
      }),
    );
    expect(text).toContain("双侧联合暂停");
  });

  test("renders unknown side when one agent's probe is unavailable", () => {
    const text = renderBudgetSnapshot(snapshot({ codex: null }));
    expect(text).toContain("Codex：未知（探测不可用）");
    // Drift line is suppressed when either side is unknown.
    expect(text).not.toContain("个百分点");
  });

  test("annotates rate-limited and stale usage", () => {
    const text = renderBudgetSnapshot(
      snapshot({ claude: usage({ rateLimitedUntil: 1_780_712_000, stale: true }) }),
    );
    expect(text).toContain("限流至");
    expect(text).toContain("（缓存数据）");
  });

  test("marks positional quota parsing as heuristic", () => {
    const text = renderBudgetSnapshot(snapshot({ claude: usage({ parsedVia: "positional" }) }));
    expect(text).toContain("⚠️");
    expect(text).toContain("位置兜底");
  });

  test("shows parallel recommendation and non-full codex tier", () => {
    const text = renderBudgetSnapshot(
      snapshot({ phase: "parallel", parallelRecommended: true, codexTier: "eco" }),
    );
    expect(text).toContain("并行建议");
    expect(text).toContain("Codex 档位：eco");
  });

  test("always carries the account-level disclaimer", () => {
    expect(renderBudgetSnapshot(snapshot())).toContain("账号级");
  });

  test("unavailable text mentions the probe path", () => {
    expect(BUDGET_UNAVAILABLE_TEXT).toContain("budget-probe");
  });
});

describe("renderBudgetSnapshot — claudeAdvice", () => {
  test("shows the Claude tiering advice when present", () => {
    const text = renderBudgetSnapshot(
      snapshot({ claudeAdvice: "Claude 侧用量偏高：机械型 subagent 用 haiku，常规用 sonnet" }),
    );
    expect(text).toContain("Claude 建议：");
    expect(text).toContain("haiku");
  });

  test("omits the advice line when null", () => {
    expect(renderBudgetSnapshot(snapshot({ claudeAdvice: null }))).not.toContain("Claude 建议：");
  });
});
