import { describe, expect, test } from "bun:test";
import {
  renderBudgetSnapshot,
  resolveGuardHardHint,
  formatDuration,
  formatClockTime,
  BUDGET_UNAVAILABLE_TEXT,
} from "../budget/render";
import type { AgentUsage, BudgetSnapshot, BurnRate } from "../budget/types";

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

  test("surfaces admission-closed (5h finishing protection) when not paused", () => {
    const text = renderBudgetSnapshot(snapshot({ gateState: "admission-closed", paused: false }));
    expect(text).toContain("收尾保护：admission-closed");
    expect(text).toContain("budget_admission");
  });

  test("plain '暂停：否' when gate is open or gateState is absent (back-compat)", () => {
    expect(renderBudgetSnapshot(snapshot({ gateState: "open" }))).toContain("暂停：否");
    expect(renderBudgetSnapshot(snapshot({ gateState: "open" }))).not.toContain("收尾保护");
    // Old snapshot without gateState → unchanged plain line.
    expect(renderBudgetSnapshot(snapshot())).toContain("暂停：否");
    expect(renderBudgetSnapshot(snapshot())).not.toContain("收尾保护");
  });

  test("renders the dynamic line with per-agent headroom", () => {
    const text = renderBudgetSnapshot(
      snapshot({ dynamicPauseLine: { claude: 93.4, codex: 95.6 } }),
    );
    expect(text).toContain("动态暂停线：");
    expect(text).toContain("Claude 93.4%");
    expect(text).toContain("Codex 95.6%");
    // headroom = line - gateUtil (Claude 93.4-42=51.4, Codex 95.6-10=85.6)
    expect(text).toContain("余量 51.4");
    expect(text).toContain("余量 85.6");
  });

  test("omits the dynamic line when the snapshot carries no field (legacy daemon)", () => {
    expect(renderBudgetSnapshot(snapshot())).not.toContain("动态暂停线");
  });

  test("shows only the side that has a numeric dynamic line", () => {
    const text = renderBudgetSnapshot(
      snapshot({ dynamicPauseLine: { claude: null, codex: 95.6 } }),
    );
    expect(text).toContain("Codex 95.6%");
    expect(text).not.toContain("Claude 93");
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

describe("formatDuration（分钟取整，<1 小时只显分钟）", () => {
  test("boundaries", () => {
    expect(formatDuration(0)).toBe("0分钟");
    expect(formatDuration(29)).toBe("0分钟"); // rounds down
    expect(formatDuration(90)).toBe("2分钟"); // rounds up
    expect(formatDuration(59 * 60)).toBe("59分钟");
    expect(formatDuration(3599)).toBe("1小时0分钟"); // rounding carries into the hour
    expect(formatDuration(3600)).toBe("1小时0分钟");
    expect(formatDuration(9000)).toBe("2小时30分钟");
    expect(formatDuration(-5)).toBe("0分钟"); // defensive clamp
  });
});

describe("formatClockTime（本地时区 HH:MM）", () => {
  test("formats a local wall-clock time with zero padding", () => {
    // Construct the epoch FROM local components so the test is TZ-agnostic.
    const epoch = Math.floor(new Date(2026, 5, 11, 8, 5).getTime() / 1000);
    expect(formatClockTime(epoch)).toBe("08:05");
  });

  test("crosses midnight into the next local day", () => {
    const epoch = Math.floor(new Date(2026, 5, 12, 0, 7).getTime() / 1000);
    expect(formatClockTime(epoch)).toBe("00:07");
  });
});

describe("renderBudgetSnapshot — burn rate & runway (v3 P1, layered amendment)", () => {
  const NOW = 1_780_711_700; // == snapshot().updatedAt
  const NO_RATES = { fiveHour: null, weekly: null };

  function burnRate(overrides: Partial<BurnRate> = {}): BurnRate {
    return { pctPerHour: 1.2, confident: true, ...overrides };
  }

  test("legacy snapshot without the optional fields renders no burn-rate lines", () => {
    const text = renderBudgetSnapshot(snapshot());
    expect(text).not.toContain("燃尽率");
    expect(text).not.toContain("约可再工作");
    expect(text).not.toContain("guard 硬线");
  });

  test("confident rates render per-window rate, duration + local clock + basis, and the Claude guard annotation", () => {
    // 3.2h = 11520s; depletion well before the weekly reset → no truncation note.
    const depletedAt = NOW + 11_520;
    const snap = snapshot({
      burnRate: {
        claude: { fiveHour: burnRate(), weekly: burnRate({ pctPerHour: 0.8 }) },
        codex: NO_RATES,
      },
      runway: {
        claude: { seconds: 11_520, basis: "weekly", depletedAtEpoch: depletedAt },
        codex: null,
      },
    });
    const text = renderBudgetSnapshot(snap);
    expect(text).toContain("Claude 燃尽率：5h ≈1.20%/h · 周 ≈0.80%/h");
    expect(text).toContain(
      `约可再工作 3小时12分钟（至 ${formatClockTime(depletedAt)}，周窗口为约束）`,
    );
    // Honesty-first Q7 wording: the number is the guard's NEUTRAL runway,
    // never rescaled by the bridge (constraint #2) — the caveat is textual.
    expect(text).toContain("外层 guard 硬线 99%（v3 不可越过；runway 为中性口径，Claude 会先在硬线被外层停住）");
    expect(text).not.toContain("窗口刷新即截断");
  });

  test("runway ending at the basis window reset gets the truncation note", () => {
    // usage(): claude fiveHour resetEpoch 1_780_750_000 → 38300s after NOW.
    const resetEpoch = 1_780_750_000;
    const seconds = resetEpoch - NOW; // exactly reset-truncated
    const snap = snapshot({
      burnRate: { claude: { fiveHour: burnRate(), weekly: null }, codex: NO_RATES },
      runway: {
        claude: { seconds, basis: "fiveHour", depletedAtEpoch: resetEpoch },
        codex: null,
      },
    });
    const text = renderBudgetSnapshot(snap);
    expect(text).toContain(`至 ${formatClockTime(resetEpoch)} 窗口刷新即截断，5h 窗口为约束`);
  });

  test("runway without depleted_at_epoch omits the clock part (consume-only, no fabrication)", () => {
    const snap = snapshot({
      burnRate: { claude: { fiveHour: burnRate(), weekly: null }, codex: NO_RATES },
      runway: {
        claude: { seconds: 1800, basis: "fiveHour", depletedAtEpoch: null },
        codex: null,
      },
    });
    const text = renderBudgetSnapshot(snap);
    expect(text).toContain("约可再工作 30分钟（5h 窗口为约束）");
    expect(text).not.toContain("至 ");
  });

  test("Codex line renders runway but never the guard-hardline annotation", () => {
    const depletedAt = NOW + 23_400; // 6.5h
    const snap = snapshot({
      burnRate: {
        claude: NO_RATES,
        codex: { fiveHour: burnRate({ pctPerHour: 2.1 }), weekly: null },
      },
      runway: {
        claude: null,
        codex: { seconds: 23_400, basis: "fiveHour", depletedAtEpoch: depletedAt },
      },
    });
    const text = renderBudgetSnapshot(snap);
    const codexLine = text.split("\n").find((line) => line.startsWith("Codex 燃尽率"));
    expect(codexLine).toBeDefined();
    expect(codexLine!).toContain("约可再工作 6小时30分钟");
    expect(codexLine!).not.toContain("guard 硬线");
    // Claude has no data → no Claude burn-rate line, hence no guard annotation at all.
    expect(text).not.toContain("guard 硬线");
  });

  test("non-confident window renders 采样中 instead of a rate, and no runway", () => {
    const snap = snapshot({
      burnRate: {
        claude: { fiveHour: burnRate({ confident: false }), weekly: null },
        codex: NO_RATES,
      },
      runway: { claude: null, codex: null },
    });
    const text = renderBudgetSnapshot(snap);
    expect(text).toContain("5h 采样中");
    expect(text).not.toContain("约可再工作");
  });

  test("renders guard-provided weekly five-hour window count when present", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        claude: usage({
          weekly: {
            util: 19,
            resetEpoch: 1_781_193_812,
            burnConfident: true,
            runwaySeconds: 43_200,
            fiveHourWindowsLeft: 2.4,
          },
        }),
      }),
    );
    expect(text).toContain("按当前节奏，周额度还够 ~2.4 个 5h 窗口");
  });

  test("renders clock-windows (5h windows that physically fit before the weekly reset)", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        // weekly resets 2.5 × 5h after the snapshot's updatedAt → 2.5 clock-windows
        claude: usage({ weekly: { util: 19, resetEpoch: 1_780_711_700 + Math.round(2.5 * 5 * 3600) } }),
      }),
    );
    expect(text).toContain("距周刷新还能容纳");
    expect(text).toContain("~2.5");
  });

  test("omits clock-windows when both sides' weekly reset is already past", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        claude: usage({ weekly: { util: 19, resetEpoch: 1_780_711_700 - 100 } }),
        codex: usage({ weekly: { util: 10, resetEpoch: 1_780_711_700 - 100 } }),
      }),
    );
    expect(text).not.toContain("距周刷新");
  });

  test("omits weekly five-hour window count when the guard field is absent", () => {
    const text = renderBudgetSnapshot(snapshot());
    expect(text).not.toContain("周额度还够");
  });

  test("omits weekly five-hour window count when the weekly runway is absent", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        claude: usage({
          weekly: {
            util: 19,
            resetEpoch: 1_781_193_812,
            burnConfident: true,
            fiveHourWindowsLeft: 2.4,
          },
        }),
      }),
    );
    expect(text).not.toContain("周额度还够");
  });

  test("omits weekly five-hour window count from stale cached data", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        claude: usage({
          stale: true,
          weekly: {
            util: 19,
            resetEpoch: NOW + 3600,
            burnConfident: true,
            runwaySeconds: 1800,
            fiveHourWindowsLeft: 3.1,
          },
        }),
        burnRate: {
          claude: { fiveHour: null, weekly: burnRate() },
          codex: NO_RATES,
        },
        runway: { claude: null, codex: null },
      }),
    );
    expect(text).toContain("（缓存数据）");
    expect(text).not.toContain("约可再工作");
    expect(text).not.toContain("周额度还够");
  });
});

describe("resolveGuardHardHint", () => {
  test("defaults to 99 (v3.2 quota-guard BUDGET_HARD default)", () => {
    expect(resolveGuardHardHint({})).toBe(99);
  });

  test("AGENTBRIDGE_GUARD_HARD_HINT overrides the display value", () => {
    expect(resolveGuardHardHint({ AGENTBRIDGE_GUARD_HARD_HINT: "85" })).toBe(85);
  });

  test("invalid or out-of-range hints fall back to 99", () => {
    expect(resolveGuardHardHint({ AGENTBRIDGE_GUARD_HARD_HINT: "abc" })).toBe(99);
    expect(resolveGuardHardHint({ AGENTBRIDGE_GUARD_HARD_HINT: "150" })).toBe(99);
    expect(resolveGuardHardHint({ AGENTBRIDGE_GUARD_HARD_HINT: "0" })).toBe(99);
    expect(resolveGuardHardHint({ AGENTBRIDGE_GUARD_HARD_HINT: "" })).toBe(99);
  });
});
