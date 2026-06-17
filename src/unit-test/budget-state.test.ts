import { describe, expect, test } from "bun:test";
import { computeBudgetState } from "../budget/budget-state";
import { formatBeijing } from "../budget/format-time";
import type { AgentUsage, BudgetConfig } from "../budget/types";

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
  enabled: true,
  pollSeconds: 60,
  budgetFreshTtlSec: 25,
  idleAdviceActivityWindowSec: 600,
  pauseAt: 90,
  resumeBelow: 30,
  syncDriftPct: 10,
  parallel: {
    minRemainingPct: 60,
    timeWindowSec: 3600,
  },
  codexTierControl: false,
  codexTiers: {
    full: { effort: "high" },
    balanced: { effort: "medium" },
    eco: { effort: "low" },
  },
  maximize: { targetUtil: 97, reserveSlopePctPerHour: 0.4, reserveMaxPct: 7, finishingHorizonMinutes: 30, resumeHysteresisPct: 5, admissionAt: 85, wrapUpQuota: 2 },
  allocation: { minRunwayRatio: 50, minRunwayGapHours: 2 },
};

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  const gateUtil = overrides.gateUtil ?? 20;
  const warnUtil = overrides.warnUtil ?? gateUtil;
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil,
    fiveHour: { util: gateUtil, resetEpoch: NOW + 7200 },
    weekly: { util: warnUtil, resetEpoch: NOW + 500_000 },
    remaining: 100 - gateUtil,
    rateLimitedUntil: 0,
    fetchedAt: NOW,
    parsedVia: "id-match",
    ...overrides,
  };
}

describe("computeBudgetState", () => {
  test("returns normal with no directive when both agents are within budget", () => {
    const state = computeBudgetState(usage(), usage({ gateUtil: 21, warnUtil: 21, remaining: 79 }), CONFIG, NOW);

    expect(state.phase).toBe("normal");
    expect(state.directiveToClaude).toBeNull();
    expect(state.drift).toEqual({ pct: -1, heavier: null, lighter: null });
    expect(state.pause.active).toBe(false);
  });

  test("renders Claude-side handoff directive when only Claude reaches pauseAt", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9, fiveHour: { util: 91, resetEpoch: NOW + 1800 } }),
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("paused");
    expect(state.pause).toMatchObject({ active: true, side: "claude", resumeBelow: 30 });
    expect(state.pause.resetEpochs.claude).toBe(NOW + 1800);
    expect(state.directiveToClaude).toContain("立即交接");
    expect(state.directiveToClaude).toContain("剩余任务清单");
    expect(state.directiveToClaude).toContain("上下文");
    expect(state.directiveToClaude).toContain("验收标准");
    expect(state.directiveToClaude).toContain("单 turn");
    expect(state.directiveToClaude).toContain("checkpoint");
    expect(state.directiveToClaude).toContain("不要期待 Claude 回复");
    expect(state.directiveToClaude).not.toContain("进入联合暂停");
    expect(state.directiveToClaude).toContain("账号级");
  });

  test("renders Codex-side pause directive when only Codex reaches pauseAt", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }),
      usage({ gateUtil: 91, warnUtil: 91, remaining: 9, fiveHour: { util: 91, resetEpoch: NOW + 1800 } }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("paused");
    expect(state.pause).toMatchObject({ active: true, side: "codex" });
    expect(state.directiveToClaude).toContain("Codex");
    expect(state.directiveToClaude).toContain("暂停委派");
    expect(state.directiveToClaude).toContain("solo");
    expect(state.directiveToClaude).toContain("分工断点");
    expect(state.directiveToClaude).toContain("以实测为准");
    expect(state.directiveToClaude).toContain("提前刷新会更早解除");
  });

  test("does not pause when warnUtil is high but every window util is below pauseAt", () => {
    // warnUtil (96) drives drift/balance only; pause gating is per-window util.
    // Keep both windows' util low so no window crosses the maximize fallback line.
    const state = computeBudgetState(
      usage({
        gateUtil: 20,
        warnUtil: 96,
        remaining: 80,
        fiveHour: { util: 20, resetEpoch: NOW + 7200 },
        weekly: { util: 20, resetEpoch: NOW + 500_000 },
      }),
      usage({ gateUtil: 18, warnUtil: 18, remaining: 82 }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("balance");
    expect(state.pause.active).toBe(false);
    expect(state.drift).toMatchObject({ pct: 78, heavier: "claude", lighter: "codex" });
  });

  test("does not enter intervention for rate-limited-only usage", () => {
    const active = computeBudgetState(
      usage({ gateUtil: 5, warnUtil: 5, rateLimitedUntil: NOW + 600 }),
      usage({ gateUtil: 5, warnUtil: 5, remaining: 95 }),
      CONFIG,
      NOW,
    );
    expect(active.phase).toBe("normal");
    expect(active.pause.active).toBe(false);
    expect(active.pause.reason).toBeNull();
    expect(active.directiveToClaude).toBeNull();

    const expired = computeBudgetState(
      usage({ gateUtil: 5, warnUtil: 5, rateLimitedUntil: NOW }),
      usage({ gateUtil: 5, warnUtil: 5, remaining: 95 }),
      CONFIG,
      NOW,
    );
    expect(expired.phase).toBe("normal");
    expect(expired.pause.active).toBe(false);
  });

  test("marks both sides when both trip the pause gate", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }),
      usage({ gateUtil: 93, warnUtil: 93, remaining: 7 }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("paused");
    expect(state.pause.side).toBe("both");
  });

  test("resume estimate ignores healthy side reset when only the other side blocks resume", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 5, warnUtil: 5, remaining: 95, fiveHour: { util: 5, resetEpoch: NOW + 7200 } }),
      usage({ gateUtil: 93, warnUtil: 93, remaining: 7, fiveHour: { util: 93, resetEpoch: NOW + 600 } }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("paused");
    expect(state.pause.side).toBe("codex");
    expect(state.pause.resumeAfterEpoch).toBe(NOW + 600);
    const codexResume = formatBeijing(NOW + 600);
    const claudeReset = formatBeijing(NOW + 7200);
    expect(state.directiveToClaude).toContain(`预计恢复时间（以实测为准；提前刷新会更早解除）：${codexResume}`);
    expect(state.directiveToClaude).not.toContain(`预计恢复时间（以实测为准；提前刷新会更早解除）：${claudeReset}`);
  });

  test("balances toward the lighter side using warnUtil drift", () => {
    const claudeHeavy = computeBudgetState(
      usage({ gateUtil: 35, warnUtil: 40, remaining: 65 }),
      usage({ gateUtil: 18, warnUtil: 20, remaining: 82 }),
      CONFIG,
      NOW,
    );
    expect(claudeHeavy.phase).toBe("balance");
    expect(claudeHeavy.drift).toMatchObject({ pct: 20, heavier: "claude", lighter: "codex" });
    expect(claudeHeavy.directiveToClaude).toContain("Codex");

    const codexHeavy = computeBudgetState(
      usage({ gateUtil: 18, warnUtil: 20, remaining: 82 }),
      usage({ gateUtil: 35, warnUtil: 40, remaining: 65 }),
      CONFIG,
      NOW,
    );
    expect(codexHeavy.phase).toBe("balance");
    expect(codexHeavy.drift).toMatchObject({ pct: -20, heavier: "codex", lighter: "claude" });
    expect(codexHeavy.directiveToClaude).toContain("Claude");
  });

  test("v3 P3 (M3b): routing advice is suppressed when a side is admission-closing", () => {
    // REAL (cross-engine): balance/underutilization advice moves work DENSITY between
    // sides and directly contradicts the admission gate ("no new Codex tasks"). A side
    // at 5h util ≥ admissionAt(85) but < pauseAt(90) is admission-closed yet NOT paused,
    // so without this guard adviceEligible stayed true and phase=balance fired alongside
    // the admission directive. Contrast: util 84 (not admit-closing) still balances.
    const notClosing = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }),
      usage({ gateUtil: 84, warnUtil: 84, remaining: 16 }),
      CONFIG,
      NOW,
    );
    expect(notClosing.phase).toBe("balance"); // baseline: drift would route to Claude

    const admissionClosing = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }),
      usage({ gateUtil: 86, warnUtil: 86, remaining: 14 }), // codex 5h util 86 ≥ admissionAt
      CONFIG,
      NOW,
    );
    expect(admissionClosing.phase).toBe("normal"); // advice suppressed
    expect(admissionClosing.directiveToClaude).toBeNull();
  });

  test("balances reverse 20/40 drift toward Claude", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }),
      usage({ gateUtil: 40, warnUtil: 40, remaining: 60 }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("balance");
    expect(state.drift).toEqual({ pct: -20, heavier: "codex", lighter: "claude" });
    expect(state.directiveToClaude).toContain("分给 Claude");
  });

  test("v3 P4: parallel phase is retired — high remaining + near reset stays normal", () => {
    // Former "parallel" trigger (both sides flush, a nearby 5h reset) no longer
    // produces a parallel directive; the underutilization advice replaces it and
    // is driven by the weekly will-not-fill verdict, not 5h remaining. Without
    // burn data, no advice fires → normal.
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 20, remaining: 80, fiveHour: { util: 20, resetEpoch: NOW + 3500 } }),
      usage({ gateUtil: 25, warnUtil: 25, remaining: 75, fiveHour: { util: 25, resetEpoch: NOW + 5000 } }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("normal");
    expect(state.parallel.recommended).toBe(false);
    expect(state.directiveToClaude).toBeNull();
  });

  test("balance directive (warnUtil basis) names the lighter side without a parallel addendum", () => {
    const state = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 40, remaining: 80, fiveHour: { util: 20, resetEpoch: NOW + 1200 } }),
      usage({ gateUtil: 10, warnUtil: 20, remaining: 90, fiveHour: { util: 10, resetEpoch: NOW + 1800 } }),
      CONFIG,
      NOW,
    );

    expect(state.phase).toBe("balance");
    expect(state.parallel.recommended).toBe(false);
    expect(state.directiveToClaude).toContain("Codex");
    // No runway passed → warnUtil basis text, never the retired parallel addendum.
    expect(state.directiveToClaude).toContain("用量比例漂移");
    expect(state.directiveToClaude).not.toContain("并行");
  });

  test("keeps phase normal when one side is unknown and known side is healthy", () => {
    const state = computeBudgetState(null, usage(), CONFIG, NOW);

    expect(state.phase).toBe("normal");
    expect(state.drift).toEqual({ pct: 0, heavier: null, lighter: null });
    expect(state.parallel.recommended).toBe(false);
    expect(state.directiveToClaude).toBeNull();
  });

  test("assigns Codex tier by codex warnUtil boundaries", () => {
    const cases = [
      { warnUtil: 59, expected: "full" },
      { warnUtil: 60, expected: "balanced" },
      { warnUtil: 79, expected: "balanced" },
      { warnUtil: 80, expected: "eco" },
    ] as const;

    for (const item of cases) {
      const state = computeBudgetState(
        usage({ gateUtil: 20, warnUtil: 20 }),
        usage({ gateUtil: 20, warnUtil: item.warnUtil }),
        { ...CONFIG, syncDriftPct: 100 },
        NOW,
      );

      expect(state.effort.codexTier).toBe(item.expected);
    }
  });

  test("advises Claude subagent downgrade when Claude warnUtil is high", () => {
    const high = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 80 }),
      usage({ gateUtil: 20, warnUtil: 20 }),
      CONFIG,
      NOW,
    );

    expect(high.effort.claudeAdvice).toContain("subagent");
    expect(high.effort.claudeAdvice).toContain("haiku");
    expect(high.effort.claudeAdvice).toContain("sonnet");

    const low = computeBudgetState(
      usage({ gateUtil: 20, warnUtil: 79 }),
      usage({ gateUtil: 20, warnUtil: 20 }),
      CONFIG,
      NOW,
    );
    expect(low.effort.claudeAdvice).toBeNull();
  });
});
