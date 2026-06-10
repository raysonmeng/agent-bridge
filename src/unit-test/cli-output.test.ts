import { describe, expect, test } from "bun:test";
import { formatKillReport, type StopResult } from "../cli/kill";
import { formatDoctorReport } from "../cli/doctor";
import { listBridgeFrontendProcessesFromList } from "../process-lifecycle";

function stopResult(overrides: Partial<StopResult>): StopResult {
  return {
    label: "main-aaaa0000",
    portsLabel: "4520/4521/4522",
    daemonKilled: false,
    tuiKilled: false,
    details: [],
    ...overrides,
  };
}

describe("formatKillReport", () => {
  test("categorizes stopped / idle / failed targets into one glanceable summary", () => {
    const lines = formatKillReport(
      [
        stopResult({
          label: "main-aaaa0000",
          daemonKilled: true,
          tuiKilled: true,
          details: ["Stopping Codex TUI pid 111", "Sending SIGTERM to daemon pid 222"],
        }),
        stopResult({ label: "main-bbbb1111" }),
        stopResult({ label: "main-cccc2222" }),
        stopResult({ label: "main-dddd3333", error: new Error("boom"), details: ["ERROR: boom"] }),
      ],
      [],
      "agentbridge claude",
    );
    const text = lines.join("\n");
    expect(text).toContain("✅ 已停止 1 个: main-aaaa0000（daemon + Codex TUI）");
    expect(text).toContain("⚪ 本来就没在运行 2 个: main-bbbb1111, main-cccc2222");
    expect(text).toContain("❌ 失败 1 个: main-dddd3333");
    // e2e contract string must survive the rewrite.
    expect(text).toContain("AgentBridge stopped.");
    // killed-sentinel semantics must be explained (the #1 historical confusion).
    expect(text).toContain("killed 哨兵");
  });

  test("idle targets do NOT emit per-target detail blocks (noise control)", () => {
    const lines = formatKillReport(
      [
        stopResult({ label: "main-idle0001", details: ["No daemon pid file found"] }),
        stopResult({ label: "main-idle0002", details: ["No daemon pid file found"] }),
      ],
      [],
      "agentbridge claude",
    );
    const text = lines.join("\n");
    expect(text).not.toContain("No daemon pid file found");
    expect(text).toContain("No running AgentBridge daemon or managed Codex TUI found.");
  });

  test("active targets DO emit their detail blocks", () => {
    const lines = formatKillReport(
      [stopResult({ label: "main-act0001", daemonKilled: true, details: ["Sending SIGTERM to daemon pid 9"] })],
      [],
      "agentbridge claude",
    );
    expect(lines.join("\n")).toContain("Sending SIGTERM to daemon pid 9");
  });

  test("lists surviving Claude Code bridge frontends with reopen guidance", () => {
    const lines = formatKillReport(
      [stopResult({ label: "main-aaaa0000", daemonKilled: true })],
      [
        { pid: 24698, command: "bun run /repo/plugins/agentbridge/server/bridge-server.js" },
        { pid: 31320, command: "bun run /repo/plugins/agentbridge/server/bridge-server.js" },
      ],
      "agentbridge claude",
    );
    const text = lines.join("\n");
    expect(text).toContain("检测到 2 个仍在运行的 Claude Code 桥接前端 (pid 24698, 31320)");
    expect(text).toContain("关闭并重开");
  });

  test("empty result set reports no pairs registered", () => {
    expect(formatKillReport([], [], "agentbridge claude")).toEqual(["No pairs registered."]);
  });
});

describe("formatDoctorReport", () => {
  function report(checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string; hint?: string }>) {
    return {
      cwd: "/tmp/x",
      pair: {
        pairId: "main-aaaa0000",
        name: "main",
        manual: false,
        slot: 0,
        stateDir: "/tmp/state",
        ports: { appPort: 4520, proxyPort: 4521, controlPort: 4522 },
      },
      env: { ok: true, reasons: [] } as any,
      daemon: { health: null, ready: null, buildDrift: null },
      tui: { attachedHere: [], attachedElsewhere: [] },
      checks,
    };
  }

  test("non-OK checks print their hint with the action arrow", () => {
    const lines = formatDoctorReport(
      report([
        { name: "build drift", status: "fail", detail: "runtime differs", hint: "运行 `abg kill` 后重启对齐。" },
        { name: "daemon health", status: "ok", detail: "healthz reachable", hint: "不该显示" },
      ]) as any,
    );
    const text = lines.join("\n");
    expect(text).toContain("↳ 运行 `abg kill` 后重启对齐。");
    expect(text).not.toContain("不该显示");
  });

  test("all-OK report concludes with a clean verdict", () => {
    const lines = formatDoctorReport(report([{ name: "env", status: "ok", detail: "fine" }]) as any);
    expect(lines.join("\n")).toContain("结论: 全部检查通过 ✅");
  });

  test("FAIL-bearing report names the first FAIL as the priority", () => {
    const lines = formatDoctorReport(
      report([
        { name: "env", status: "warn", detail: "w" },
        { name: "build drift", status: "fail", detail: "d", hint: "h" },
      ]) as any,
    );
    expect(lines.join("\n")).toContain("优先处理: build drift");
  });

  test("WARN-only report notes warns are often normal intermediate states", () => {
    const lines = formatDoctorReport(report([{ name: "codex tui (this pair)", status: "warn", detail: "w", hint: "h" }]) as any);
    expect(lines.join("\n")).toContain("无 FAIL");
  });
});

describe("listBridgeFrontendProcessesFromList", () => {
  test("matches agentbridge bridge-server.js processes only", () => {
    const out = listBridgeFrontendProcessesFromList([
      { pid: 1, command: "bun run /Users/x/repo/agent_bridge/plugins/agentbridge/server/bridge-server.js" },
      { pid: 2, command: "bun run /Users/x/.claude/plugins/cache/agentbridge/agentbridge/0.1.6/server/bridge-server.js" },
      { pid: 3, command: "node /other/project/bridge-server.js" }, // not agentbridge
      { pid: 4, command: "bun run /Users/x/repo/agent_bridge/plugins/agentbridge/server/daemon.js" }, // daemon, not frontend
      { pid: 5, command: "grep bridge-server.js" }, // no path-ish match... actually matches regex; relies on agentbridge substring
    ]);
    expect(out.map((p) => p.pid)).toEqual([1, 2]);
  });
});
