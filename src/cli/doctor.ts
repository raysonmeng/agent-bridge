import { existsSync, statSync } from "node:fs";
import { BUILD_INFO, formatBuildInfo, sameRuntimeContract } from "../build-info";
import { inspectAgentBridgeEnv } from "../env-guard";
import { applyPairEnv, parsePairFlag, type PairResolution } from "../pair-resolver";
import { readRawCurrentThread, readUsableCurrentThread } from "../thread-state";
import { scanResumePollution } from "../resume-pollution";
import {
  commandMatchesManagedCodexTui,
  listManagedCodexTuiProcesses,
  type ManagedCodexTuiProcess,
} from "../process-lifecycle";
import type { DaemonStatus } from "../control-protocol";

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
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

  let pair: PairResolution;
  try {
    pair = await applyPairEnv({ pairFlag });
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  const report = await buildDoctorReport(pair);
  if (agent) {
    report.checks.push({
      name: "agent backend",
      status: "warn",
      detail: "--agent is reserved for read-only delegated analysis; static diagnostics were run locally in this build.",
    });
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

async function buildDoctorReport(pair: PairResolution): Promise<DoctorReport> {
  const cwd = process.cwd();
  const env = inspectAgentBridgeEnv({ cwd, env: process.env });
  const health = await fetchDaemonStatus(pair.ports.controlPort, "/healthz");
  const ready = await fetchDaemonStatus(pair.ports.controlPort, "/readyz");
  // Drift keys on the runtime contract (version/commit/contractVersion), not the
  // bundle kind — a dist daemon vs a plugin launcher is not real drift.
  const buildDrift = health?.build ? !sameRuntimeContract(health.build, BUILD_INFO) : health ? true : null;
  const rawThread = readRawCurrentThread(pair.stateDir);
  const usableThread = readUsableCurrentThread({
    stateDir: pair.stateDir,
    pairId: pair.manual ? null : pair.pairId,
    pairName: pair.name,
    cwd,
  });

  const checks: DoctorCheck[] = [];
  checks.push({
    name: "env",
    status: env.ok ? "ok" : "fail",
    detail: env.ok ? "AgentBridge env matches cwd" : env.reasons.join("; "),
  });
  checks.push({
    name: "daemon health",
    status: health ? "ok" : "warn",
    detail: health ? `healthz reachable pid=${health.pid}` : `no daemon reachable on :${pair.ports.controlPort}`,
  });
  checks.push({
    name: "daemon readiness",
    status: ready ? "ok" : health ? "warn" : "warn",
    detail: ready ? `ready thread=${ready.threadId ?? "none"}` : "readyz is not OK",
  });
  checks.push({
    name: "build drift",
    status: buildDrift === false ? "ok" : buildDrift === true ? "fail" : "warn",
    detail:
      buildDrift === false
        ? `runtime matches launcher ${formatBuildInfo(BUILD_INFO)}`
        : buildDrift === true
          ? `runtime ${formatBuildInfo(health?.build)} differs from launcher ${formatBuildInfo(BUILD_INFO)}`
          : "daemon build unavailable because daemon is not reachable",
  });
  checks.push({
    name: "current thread",
    status: usableThread ? "ok" : rawThread ? "warn" : "warn",
    detail: usableThread
      ? `current=${usableThread.threadId}`
      : rawThread
        ? `stored ${rawThread.threadId} is ${rawThread.status} or missing rollout`
        : "no current-thread.json for this pair",
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
  });
  checks.push({
    name: "codex tui (other pairs)",
    status: attachedElsewhere.length > 0 ? "warn" : "ok",
    detail:
      attachedElsewhere.length > 0
        ? `${attachedElsewhere.length} managed Codex TUI(s) attached to a DIFFERENT pair/proxy — likely started from another cwd, will not bridge here: ` +
          attachedElsewhere.map((t) => `pid ${t.pid}→${t.remoteUrl ?? "?"}`).join(", ")
        : "no managed Codex TUI attached to another pair",
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

function logCheck(name: string, path: string): DoctorCheck {
  if (!existsSync(path)) {
    return { name, status: "warn", detail: `missing: ${path}` };
  }
  const stat = statSync(path);
  return { name, status: "ok", detail: `${path} (${stat.size} bytes)` };
}

async function fetchDaemonStatus(port: number, path: "/healthz" | "/readyz"): Promise<DaemonStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as DaemonStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function printDoctorReport(report: DoctorReport) {
  console.log(`AgentBridge doctor: ${report.pair.pairId}`);
  console.log(`cwd: ${report.cwd}`);
  console.log(`state: ${report.pair.stateDir}`);
  console.log(`ports: ${report.pair.ports.appPort}/${report.pair.ports.proxyPort}/${report.pair.ports.controlPort}`);
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.detail}`);
  }
}
