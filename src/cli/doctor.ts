import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginCacheRoot } from "./plugin-cache";
import { BUILD_INFO, formatBuildInfo, sameRuntimeContract } from "../build-info";
import { ConfigService } from "../config-service";
import { fetchDaemonStatus } from "../daemon-status";
import { inspectAgentBridgeEnv } from "../env-guard";
import {
  parsePairFlag,
  type PairResolution,
  type ReadOnlyPairResolution,
  resolvePairReadOnly,
} from "../pair-resolver";
import { readRawCurrentThread, readUsableCurrentThread } from "../thread-state";
import { scanResumePollution } from "../resume-pollution";
import {
  commandMatchesManagedCodexTui,
  listManagedCodexTuiProcesses,
  type ManagedCodexTuiProcess,
} from "../process-lifecycle";
import type { DaemonStatus } from "../control-protocol";

// "skip" = not applicable in the current state (e.g. daemon not running): a
// single root cause must not fan out into three stacked WARNs that bury the
// real signal.
type CheckStatus = "ok" | "warn" | "fail" | "skip";

const LARGE_LOG_WARN_BYTES = 100 * 1024 * 1024;

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /**
   * Actionable next step for a non-OK check, in user-facing Chinese. Doctor is
   * run by someone who is ALREADY stuck — every FAIL/WARN must tell them what
   * to do about it, not just restate the symptom.
   */
  hint?: string;
}

interface DoctorReport {
  cwd: string;
  pair: {
    pairId: string;
    name: string;
    manual: boolean;
    slot: number | null;
    stateDir: string;
    ports: PairResolution["ports"];
  };
  env: ReturnType<typeof inspectAgentBridgeEnv>;
  daemon: {
    health: DaemonStatus | null;
    ready: DaemonStatus | null;
    buildDrift: boolean | null;
  };
  tui: {
    /** Managed Codex TUIs attached to THIS pair's proxy. */
    attachedHere: Array<{ pid: number; remoteUrl: string | null }>;
    /** Managed Codex TUIs attached to a DIFFERENT pair/proxy (likely another cwd). */
    attachedElsewhere: Array<{ pid: number; remoteUrl: string | null }>;
  };
  checks: DoctorCheck[];
}

export async function runDoctor(args: string[] = []) {
  if (args[0] === "resume-pollution") {
    runResumePollution(args.slice(1));
    return;
  }

  const json = args.includes("--json");
  const agent = args.includes("--agent");
  const { pairFlag, rest } = parsePairFlag(args.filter((arg) => arg !== "--json" && arg !== "--agent"));
  const unknown = rest.filter((arg) => arg.startsWith("-"));
  if (unknown.length > 0) {
    console.error(`Unknown doctor option(s): ${unknown.join(", ")}`);
    console.error("Usage: abg doctor [--pair <name|id>] [--json] [--agent]");
    process.exit(1);
  }

  // READ-ONLY pair resolution. The old path went through applyPairEnv →
  // resolvePair, which ALLOCATES and persists a registry entry for a new cwd
  // and refuses to run at all when the slot's port is occupied — a diagnostic
  // command must never mutate the state it is diagnosing, and must keep
  // working precisely when things are broken.
  let resolution: ReadOnlyPairResolution;
  try {
    resolution = resolvePairReadOnly(pairFlag);
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  const report = await buildDoctorReport(resolution.pair, resolution.registered);
  if (agent) {
    report.checks.push({
      name: "agent backend",
      status: "warn",
      detail: "--agent is reserved for read-only delegated analysis; static diagnostics were run locally in this build.",
    });
  }

  // Scriptability: FAIL checks must be observable without parsing stdout.
  if (report.checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printDoctorReport(report);
}

function runResumePollution(args: string[]) {
  const json = args.includes("--json");
  const apply = args.includes("--apply");
  const codexHomeIndex = args.indexOf("--codex-home");
  const codexHome = codexHomeIndex >= 0 ? args[codexHomeIndex + 1] : undefined;
  if (codexHomeIndex >= 0 && !codexHome) {
    console.error("Usage: abg doctor resume-pollution [--json] [--apply] [--codex-home <path>]");
    process.exit(1);
  }
  const report = scanResumePollution({ codexHome, apply });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const renameCount = report.candidates.filter((c) => c.action === "rename").length;
  const deleteCount = report.candidates.filter((c) => c.action === "delete").length;
  console.log(
    `Resume pollution scan: ${report.candidates.length} candidate(s) ` +
      `(${renameCount} rename, ${deleteCount} delete) from ${report.dbPath}`,
  );
  if (report.backupDir) console.log(`Backup: ${report.backupDir}`);
  for (const candidate of report.candidates) {
    if (candidate.action === "delete") {
      const verb = apply ? "deleted" : "would delete";
      console.log(`${verb} ${candidate.id}: ${candidate.reason}`);
    } else {
      const verb = apply ? "updated" : "would rename";
      console.log(`${verb} ${candidate.id}: ${candidate.reason}`);
      console.log(`  title: ${candidate.replacementTitle}`);
    }
  }
  if (apply) {
    console.log(`Applied: ${report.renamed} renamed, ${report.deleted} deleted.`);
  } else if (report.candidates.length > 0) {
    console.log(
      "Dry-run only. Re-run with --apply to rename/delete Codex sessions after backing up state.",
    );
  }
}

async function buildDoctorReport(pair: PairResolution, registered: boolean): Promise<DoctorReport> {
  const cwd = process.cwd();
  const env = inspectAgentBridgeEnv({ cwd, env: process.env });
  const [health, ready] = registered
    ? await Promise.all([
        fetchDaemonStatus(pair.ports.controlPort, "/healthz"),
        fetchDaemonStatus(pair.ports.controlPort, "/readyz"),
      ])
    : [null, null];
  // Drift keys on the runtime contract (version/commit/contractVersion), not the
  // bundle kind — a dist daemon vs a plugin launcher is not real drift.
  // A source-mode launcher (bun src/cli.ts …) is unstamped — "source" never
  // equals a real commit, so comparing would show drift on every dev run.
  const launcherStamped = BUILD_INFO.commit !== "source";
  const buildDrift = !launcherStamped
    ? null
    : health?.build
      ? !sameRuntimeContract(health.build, BUILD_INFO)
      : health
        ? true
        : null;
  const rawThread = readRawCurrentThread(pair.stateDir);
  const usableThread = readUsableCurrentThread({
    stateDir: pair.stateDir,
    pairId: pair.manual ? null : pair.pairId,
    pairName: pair.name,
    cwd,
  });

  const checks: DoctorCheck[] = [];
  checks.push({
    name: "pair registration",
    status: registered ? "ok" : "warn",
    detail: registered
      ? pair.manual
        ? "manual mode (explicit env)"
        : `registered as ${pair.pairId}`
      : `not registered yet — would be ${pair.pairId} (created on first launch)`,
    hint: registered
      ? undefined
      : "该目录还没有注册过 pair：运行 `agentbridge claude` 即会创建。以下检查按未启动状态解读。",
  });
  checks.push({
    name: "env",
    status: env.ok ? "ok" : "fail",
    detail: env.ok ? "AgentBridge env matches cwd" : env.reasons.join("; "),
    hint: env.ok
      ? undefined
      : "环境变量与当前目录不匹配：请在正确的项目目录里重新运行 `agentbridge claude`，不要复用其他目录的会话环境。",
  });
  checks.push(configParseabilityCheck(cwd));
  checks.push({
    name: "daemon health",
    status: health ? "ok" : "warn",
    detail: health
      ? `healthz reachable pid=${health.pid}`
      : registered
        ? `no daemon reachable on :${pair.ports.controlPort}`
        : "n/a — pair not registered",
    hint: health ? undefined : "daemon 未运行。运行 `agentbridge claude`（或 `agentbridge codex`）会自动启动它。",
  });
  // Daemon-dependent checks collapse to skip when the daemon is not running:
  // one root cause must not stack three WARNs.
  checks.push({
    name: "daemon readiness",
    status: ready ? "ok" : health ? "warn" : "skip",
    detail: ready
      ? `ready thread=${ready.threadId ?? "none"}`
      : health
        ? "readyz is not OK"
        : "n/a — daemon not running",
    hint:
      !ready && health
        ? "daemon 在运行但 codex app-server 尚未就绪；稍候片刻重试，持续不就绪请查看下方 daemon log。"
        : undefined,
  });
  checks.push({
    name: "build drift",
    status: buildDrift === false ? "ok" : buildDrift === true ? "fail" : "skip",
    detail:
      buildDrift === false
        ? `runtime matches launcher ${formatBuildInfo(BUILD_INFO)}`
        : buildDrift === true
          ? `runtime ${formatBuildInfo(health?.build)} differs from launcher ${formatBuildInfo(BUILD_INFO)}`
          : launcherStamped
            ? "n/a — daemon not running"
            : "n/a — launcher running from source (unstamped)",
    hint:
      buildDrift === true
        ? "daemon 运行的是旧构建（通常由旧版 CLI 或未重开的 Claude Code 窗口启动）。" +
          "没有进行中的 Codex 会话时，运行 `abg kill` 后重新 `agentbridge claude` 即可对齐；" +
          "有活跃会话则等收尾后再重启——版本差异不会强杀活跃会话，可以继续用。"
        : undefined,
  });
  checks.push(artifactAlignmentCheck());
  checks.push({
    name: "current thread",
    status: usableThread ? "ok" : rawThread ? "warn" : registered ? "warn" : "skip",
    detail: usableThread
      ? `current=${usableThread.threadId}`
      : rawThread
        ? rawThread.status === "current"
          ? `stored ${rawThread.threadId} has no rollout file yet`
          : `stored ${rawThread.threadId} is still ${rawThread.status} (no first response yet)`
        : registered
          ? "no current-thread.json for this pair"
          : "n/a — pair not registered",
    hint: usableThread
      ? undefined
      : rawThread
        ? "通常无害：线程还没有产生首条回应、或 rollout 文件尚未落盘。" +
          "仅当 `abg codex`（resume）失败时才需要处理：用 `abg codex --new` 开新线程。"
        : registered
          ? "尚无线程记录：连接 Codex 后建立首个线程时会自动写入，无需处理。"
          : undefined,
  });

  // Cross-pair Codex TUI scan: this is the half of the waiting-state diagnosis
  // that `formatWaitingForCodexTuiMessage` points users to ("For diagnostics:
  // abg doctor"). A Codex TUI started from a different cwd belongs to a
  // different pair (a different proxy port) and will NEVER bridge here — the #1
  // pairing pitfall. Surface both "attached here" and "attached elsewhere".
  const pairProxyUrl = `ws://127.0.0.1:${pair.ports.proxyPort}`;
  const managedTuis = listManagedCodexTuiProcesses();
  const attachedHere: ManagedCodexTuiProcess[] = [];
  const attachedElsewhere: ManagedCodexTuiProcess[] = [];
  for (const tui of managedTuis) {
    if (commandMatchesManagedCodexTui(tui.command, pairProxyUrl)) {
      attachedHere.push(tui);
    } else {
      attachedElsewhere.push(tui);
    }
  }

  checks.push({
    name: "codex tui (this pair)",
    status: attachedHere.length > 0 ? "ok" : "warn",
    detail:
      attachedHere.length > 0
        ? `${attachedHere.length} attached to ${pairProxyUrl} (pid ${attachedHere.map((t) => t.pid).join(", ")})`
        : `no managed Codex TUI attached to this pair's proxy ${pairProxyUrl}`,
    hint:
      attachedHere.length > 0
        ? undefined
        : "另开一个终端、在同一目录运行 `agentbridge codex` 连接本 pair。",
  });
  checks.push({
    name: "codex tui (other pairs)",
    status: attachedElsewhere.length > 0 ? "warn" : "ok",
    detail:
      attachedElsewhere.length > 0
        ? `${attachedElsewhere.length} managed Codex TUI(s) attached to a DIFFERENT pair/proxy — likely started from another cwd, will not bridge here: ` +
          attachedElsewhere.map((t) => `pid ${t.pid}→${t.remoteUrl ?? "?"}`).join(", ")
        : "no managed Codex TUI attached to another pair",
    hint:
      attachedElsewhere.length > 0
        ? "这些 TUI 属于其他目录的 pair，不影响本 pair；它们不会桥接到这里。如不再需要，去对应目录运行 `abg kill`。"
        : undefined,
  });

  for (const [name, path] of [
    ["daemon log", pair.stateDir.logFile],
    ["codex wrapper log", pair.stateDir.codexWrapperLogFile],
  ] as const) {
    checks.push(logCheck(name, path));
  }

  return {
    cwd,
    pair: {
      pairId: pair.pairId,
      name: pair.name,
      manual: pair.manual,
      slot: pair.slot,
      stateDir: pair.stateDir.dir,
      ports: pair.ports,
    },
    env,
    daemon: { health, ready, buildDrift },
    tui: {
      attachedHere: attachedHere.map((t) => ({ pid: t.pid, remoteUrl: t.remoteUrl })),
      attachedElsewhere: attachedElsewhere.map((t) => ({ pid: t.pid, remoteUrl: t.remoteUrl })),
    },
    checks,
  };
}

/**
 * Cross-artifact build alignment. Three deployables each embed a build commit
 * (global CLI dist, Claude Code plugin cache, this launcher); when they split,
 * launchers replace-war each other's daemons — the failure mode behind several
 * live incidents. None of the existing guards compared the artifacts directly;
 * this check makes a split visible BEFORE it costs a daemon.
 */
function artifactAlignmentCheck(): DoctorCheck {
  const stamps: Array<{ label: string; commit: string }> = [];
  if (BUILD_INFO.commit !== "source") {
    stamps.push({ label: `launcher(${BUILD_INFO.bundle})`, commit: BUILD_INFO.commit });
  }
  const bin = Bun.which("agentbridge") ?? Bun.which("abg");
  if (bin) {
    try {
      const commit = extractBundleCommit(realpathSync(bin));
      if (commit) stamps.push({ label: "global-cli", commit });
    } catch {}
  }
  const cacheRoot = pluginCacheRoot();
  try {
    for (const version of readdirSync(cacheRoot)) {
      const commit = extractBundleCommit(join(cacheRoot, version, "server", "daemon.js"));
      if (commit) stamps.push({ label: `plugin-cache@${version}`, commit });
    }
  } catch {}
  // Inside a repo checkout, the committed bundle is a fourth artifact (the dev
  // marketplace loads it directly). A repo ahead of the installed artifacts is
  // the "forgot install:global" state — exactly what this check should expose.
  const repoBundle = join(process.cwd(), "plugins", "agentbridge", "server", "daemon.js");
  if (existsSync(repoBundle)) {
    const commit = extractBundleCommit(repoBundle);
    if (commit) stamps.push({ label: "repo-bundle", commit });
  }

  if (stamps.length < 2) {
    return {
      name: "artifact alignment",
      status: "skip",
      detail: "n/a — fewer than two stamped artifacts found",
    };
  }
  const commits = new Set(stamps.map((s) => s.commit));
  const rendered = stamps.map((s) => `${s.label}=${s.commit}`).join(", ");
  if (commits.size === 1) {
    return { name: "artifact alignment", status: "ok", detail: rendered };
  }
  return {
    name: "artifact alignment",
    status: "fail",
    detail: `deployed artifacts are at DIFFERENT builds: ${rendered}`,
    hint:
      "部署物版本分裂会导致互相替换 daemon（杀掉活会话）。在仓库目录运行 `bun run install:global` " +
      "一次性对齐全局 CLI 与插件缓存，然后关闭并重开仍在使用旧插件的 Claude Code 窗口。",
  };
}

function extractBundleCommit(path: string): string | null {
  try {
    const match = readFileSync(path, "utf-8").match(/commit:\s*defineString\("([^"]+)",\s*"source"\)/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Config parseability + whether custom values are actually in effect. A corrupt
 * config.json silently reverts the user's custom budget/idle thresholds to
 * defaults at startup (P1); surface that loudly here so doctor — run by someone
 * already stuck — can see it instead of chasing why their thresholds "don't work".
 */
function configParseabilityCheck(cwd: string): DoctorCheck {
  const desc = new ConfigService(cwd).describeConfig();
  if (desc.state === "absent") {
    return {
      name: "config.json",
      status: "ok",
      detail: `no project config at ${desc.path} — built-in defaults in effect`,
    };
  }
  if (desc.state === "corrupt") {
    return {
      name: "config.json",
      status: "warn",
      detail: `unparseable at ${desc.path} (${desc.reason}) — custom thresholds NOT in effect, using defaults`,
      hint:
        "config.json 损坏或字段类型错误：bridge 已回退到默认阈值，你的自定义 budget/idle 设置未生效。" +
        "修正该文件的 JSON 语法/字段类型后重启 `agentbridge claude` 即可重新生效。",
    };
  }
  return {
    name: "config.json",
    status: "ok",
    detail: desc.customValues
      ? `parsed at ${desc.path} — custom values in effect`
      : `parsed at ${desc.path} — all values match defaults`,
  };
}

function logCheck(name: string, path: string): DoctorCheck {
  if (!existsSync(path)) {
    return {
      name,
      status: "warn",
      detail: `missing: ${path}`,
      hint: "日志会在相应进程首次启动时创建；进程从未启动过时这是正常的。",
    };
  }
  const stat = statSync(path);
  if (stat.size > LARGE_LOG_WARN_BYTES) {
    return {
      name,
      status: "warn",
      detail:
        `${path} (${stat.size} bytes, oversized; stop the pair, rebuild/reinstall, then rotate or remove this log)`,
      hint: "日志过大：`abg kill` 停止 pair 后删除该文件再重启即可。",
    };
  }
  return { name, status: "ok", detail: `${path} (${stat.size} bytes)` };
}

/** Render the doctor report. Pure (no I/O) so the exact shape is unit-testable. */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  lines.push(`AgentBridge doctor: ${report.pair.pairId}`);
  lines.push(`cwd: ${report.cwd}`);
  lines.push(`state: ${report.pair.stateDir}`);
  lines.push(`ports: ${report.pair.ports.appPort}/${report.pair.ports.proxyPort}/${report.pair.ports.controlPort}`);
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`);
    // Hints only for actionable non-OK checks: an OK line needs no next step,
    // a SKIP is informational, and the reader under stress needs the arrows to
    // mean "act here".
    if ((check.status === "warn" || check.status === "fail") && check.hint) {
      lines.push(`     ↳ ${check.hint}`);
    }
  }

  const fails = report.checks.filter((c) => c.status === "fail");
  const warns = report.checks.filter((c) => c.status === "warn");
  lines.push("");
  if (fails.length === 0 && warns.length === 0) {
    lines.push("结论: 全部检查通过 ✅");
  } else if (fails.length > 0) {
    lines.push(
      `结论: ${fails.length} FAIL / ${warns.length} WARN — 优先处理: ${fails[0]!.name}（见上方 ↳ 提示）`,
    );
  } else {
    lines.push(`结论: ${warns.length} WARN（无 FAIL）— 多数 WARN 是待连接/未启动的正常中间态，按 ↳ 提示判断即可`);
  }
  return lines;
}

function printDoctorReport(report: DoctorReport) {
  for (const line of formatDoctorReport(report)) {
    console.log(line);
  }
}
