import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, atomicWriteText } from "./atomic-json";
import {
  BUILD_INFO,
  compatibleContractVersion,
  formatBuildInfo,
  runtimeContractComparisonBasis,
  sameRuntimeContract,
} from "./build-info";
import { StateDirResolver } from "./state-dir";
import { parsePositiveIntEnv } from "./env-utils";
import { isAgentBridgeDaemon, isAgentBridgeProcess, isProcessAlive } from "./process-lifecycle";
import {
  readUnifiedDaemonRecord,
  writeDaemonRecord,
  type DaemonRecord,
} from "./daemon-record";
import type { DaemonStatus } from "./control-protocol";
import type { AgentBridgeBuildInfo } from "./build-info";

// In source/dev mode this module is loaded from src/*.ts and can launch the
// sibling daemon.ts directly. In bundled CLI/plugin mode it is loaded from a
// generated *.js bundle, so the daemon must be a sibling daemon.js artifact.
const DEFAULT_DAEMON_ENTRY = import.meta.url.endsWith(".ts") ? "./daemon.ts" : "./daemon.js";
const DAEMON_ENTRY = process.env.AGENTBRIDGE_DAEMON_ENTRY || DEFAULT_DAEMON_ENTRY;
const DAEMON_PATH = fileURLToPath(new URL(DAEMON_ENTRY, import.meta.url));

// Short readiness window for VALIDATING an already-running daemon (the reuse path),
// distinct from a fresh launch's full waitForReady(). ~3s (12×250ms): long enough for
// a sane daemon / legit slow boot to report ready, short enough to fail fast on a
// healthz-OK/readyz-503 zombie so we replace it instead of hanging the full ~10s.
const REUSE_READY_RETRIES = parsePositiveIntEnv("AGENTBRIDGE_REUSE_READY_RETRIES", 12);
const REUSE_READY_DELAY_MS = 250;
// Full readiness wait (fresh launch + contended-lock branches). ~10s (40×250ms):
// the historical waitForReady() / waitForReadyAndOurs() signature defaults, now
// named so DaemonLifecycleTiming can override them without touching the prod path.
const WAIT_READY_RETRIES = 40;
const WAIT_READY_DELAY_MS = 250;
const HEALTH_FETCH_TIMEOUT_MS = 500;
// A legitimate startup-lock hold lasts seconds (launch + waitForReady, plus a
// 3s graceful kill during a replace). Only locks far older than that get the
// pid-recycling identity check — see acquireLockStrict.
const LOCK_IDENTITY_GRACE_MS = parsePositiveIntEnv("AGENTBRIDGE_LOCK_IDENTITY_GRACE_MS", 120_000);

export type DaemonClassificationVerdict =
  | "reuse"
  | "reuse-despite-drift"
  | "replace-foreign"
  | "replace-drifted"
  | "manual-conflict"
  | "unreachable";

export interface DaemonClassification {
  verdict: DaemonClassificationVerdict;
  reason: string;
}

function isReuseVerdict(verdict: DaemonClassificationVerdict): boolean {
  return verdict === "reuse" || verdict === "reuse-despite-drift";
}

export function classifyDaemon(
  expectedPairId: string | null,
  status: DaemonStatus | null,
  buildInfo: AgentBridgeBuildInfo,
): DaemonClassification {
  if (!status) {
    return { verdict: "unreachable", reason: "daemon status is unavailable or unparseable" };
  }

  const reportedPairId = status.pairId;
  if (!expectedPairId && reportedPairId != null) {
    return {
      verdict: "manual-conflict",
      reason: `manual mode must not adopt registered pair ${reportedPairId}`,
    };
  }

  if (expectedPairId) {
    if (reportedPairId == null) {
      return {
        verdict: "replace-foreign",
        reason: `pair ${expectedPairId} found daemon without pair identity`,
      };
    }
    if (reportedPairId !== expectedPairId) {
      return {
        verdict: "replace-foreign",
        reason: `pair ${expectedPairId} found daemon for pair ${reportedPairId}`,
      };
    }
  }

  if (!sameRuntimeContract(status.build, buildInfo)) {
    if (compatibleContractVersion(status.build, buildInfo) && status.tuiConnected === true) {
      return {
        verdict: "reuse-despite-drift",
        reason: "runtime build drift has a compatible contract and a live Codex TUI is attached",
      };
    }
    // Surface WHICH identity decided the verdict: a codeHash-basis drift is a
    // real code difference; a commit-stamp-basis drift on a legacy build (no
    // codeHash on one side) may be the squash-merge stamp lag.
    const basis =
      runtimeContractComparisonBasis(status.build, buildInfo) === "codeHash"
        ? "compared by codeHash"
        : "compared by commit stamp; legacy build without codeHash";
    return {
      verdict: "replace-drifted",
      reason:
        `runtime build ${formatBuildInfo(status.build)} does not match launcher ` +
        `${formatBuildInfo(buildInfo)} (${basis})`,
    };
  }

  return { verdict: "reuse", reason: "daemon pair and runtime contract match" };
}

/**
 * Polling cadence for the readiness loops. Injectable so tests can drive the
 * self-heal contract at 10-20ms instead of paying the real ~3s reuse window /
 * ~10s wait. PRODUCTION DEFAULTS (resolveTiming below) must stay bit-for-bit
 * identical to the historical hardcoded constants — daemon-lifecycle.test pins
 * them so the injection seam can never silently drift the shipped cadence.
 */
export interface DaemonLifecycleTiming {
  /** Retries for the reuse-validation readiness window (REUSE_READY_RETRIES). */
  reuseReadyRetries?: number;
  /** Delay between reuse-validation probes (REUSE_READY_DELAY_MS). */
  reuseReadyDelayMs?: number;
  /** Retries for the full waitForReady / waitForReadyAndOurs loops. */
  waitReadyRetries?: number;
  /** Delay between full readiness probes. */
  waitReadyDelayMs?: number;
}

export interface ResolvedTiming {
  reuseReadyRetries: number;
  reuseReadyDelayMs: number;
  waitReadyRetries: number;
  waitReadyDelayMs: number;
}

/**
 * Resolve the timing knobs, falling back to the historical production constants
 * for any field left undefined. Keep these fallbacks in lockstep with the
 * module-level constants — they are the shipped daemon cadence. Exported so a
 * lock-down test can pin the production defaults against the injection seam.
 */
export function resolveTiming(timing?: DaemonLifecycleTiming): ResolvedTiming {
  return {
    reuseReadyRetries: timing?.reuseReadyRetries ?? REUSE_READY_RETRIES,
    reuseReadyDelayMs: timing?.reuseReadyDelayMs ?? REUSE_READY_DELAY_MS,
    waitReadyRetries: timing?.waitReadyRetries ?? WAIT_READY_RETRIES,
    waitReadyDelayMs: timing?.waitReadyDelayMs ?? WAIT_READY_DELAY_MS,
  };
}

export interface DaemonLifecycleOptions {
  stateDir: StateDirResolver;
  controlPort: number;
  log: (msg: string) => void;
  /** Optional polling cadence override; defaults to production constants. */
  timing?: DaemonLifecycleTiming;
}

/**
 * Shared daemon lifecycle management.
 * Used by both CLI (agentbridge codex) and plugin frontend (bridge.ts).
 */
export class DaemonLifecycle {
  private readonly stateDir: StateDirResolver;
  private readonly controlPort: number;
  private readonly log: (msg: string) => void;
  private readonly timing: ResolvedTiming;

  constructor(opts: DaemonLifecycleOptions) {
    this.stateDir = opts.stateDir;
    this.controlPort = opts.controlPort;
    this.log = opts.log;
    this.timing = resolveTiming(opts.timing);
  }

  get healthUrl(): string {
    return `http://127.0.0.1:${this.controlPort}/healthz`;
  }

  get readyUrl(): string {
    return `http://127.0.0.1:${this.controlPort}/readyz`;
  }

  get controlWsUrl(): string {
    return `ws://127.0.0.1:${this.controlPort}/ws`;
  }

  /** This pair's expected daemon identity (null in legacy/manual single-pair mode). */
  private get expectedPairId(): string | null {
    return process.env.AGENTBRIDGE_PAIR_ID || null;
  }

  /** Fetch the daemon's /healthz status body (null if unreachable / non-OK / unparseable). */
  private async fetchStatus(): Promise<DaemonStatus | null> {
    try {
      const response = await fetchWithTimeout(this.healthUrl);
      if (!response.ok) return null;
      return (await response.json()) as DaemonStatus;
    } catch {
      return null;
    }
  }

  private classifyDaemon(status: DaemonStatus | null): DaemonClassification {
    const classification = classifyDaemon(this.expectedPairId, status, BUILD_INFO);
    if (
      process.env.AGENTBRIDGE_ALLOW_BUILD_DRIFT === "1" &&
      (classification.verdict === "replace-drifted" || classification.verdict === "unreachable")
    ) {
      return { verdict: "reuse", reason: "build drift replacement disabled by AGENTBRIDGE_ALLOW_BUILD_DRIFT" };
    }
    return classification;
  }

  private manualConflictError(status: DaemonStatus | null): Error {
    return new Error(
      `Control port ${this.controlPort} is owned by registered pair ${status?.pairId}. ` +
        `This session has no pair identity (manual mode) and will not reuse or replace it — ` +
        `start with \`agentbridge claude\` from that pair's directory, or set AGENTBRIDGE_CONTROL_PORT to a free port.`,
    );
  }

  /** Ensure daemon is running: reuse a healthy one, replace a bad/foreign one, else launch. */
  async ensureRunning(): Promise<void> {
    // Fast path: something answers /healthz on our control port. But healthz 200 only
    // proves the control server is alive — NOT that codex bootstrapped, nor that the
    // daemon belongs to THIS pair. Distinguish reuse-able from replace-able:
    if (await this.isHealthy()) {
      const status = await this.fetchStatus();
      const classification = this.classifyDaemon(status);
      switch (classification.verdict) {
        case "manual-conflict":
          throw this.manualConflictError(status);
        case "replace-foreign":
          this.log(
            `Control port ${this.controlPort} held by a daemon for pair ${status?.pairId ?? "<none>"}, ` +
              `but this pair is ${this.expectedPairId} — replacing foreign daemon`,
          );
          await this.replaceUnhealthyDaemon(status?.pid);
          return;
        case "replace-drifted":
        case "unreachable":
          this.log(
            `Daemon on control port ${this.controlPort} is running build ${formatBuildInfo(status?.build)} ` +
              `but launcher is ${formatBuildInfo(BUILD_INFO)} — replacing drifted daemon`,
          );
          await this.replaceUnhealthyDaemon(status?.pid);
          return;
        case "reuse-despite-drift":
          this.log(
            `Daemon on control port ${this.controlPort} is running build ${formatBuildInfo(status?.build)} ` +
              `(launcher ${formatBuildInfo(BUILD_INFO)}) but a live Codex TUI is attached — reusing instead of ` +
              `replacing; the new build is picked up at the next restart (abg kill, then relaunch)`,
          );
          break;
        case "reuse":
          break;
      }
      try {
        // Short window: a sane daemon (or a legit slow boot) reports ready within ~3s.
        await this.waitForReady(this.timing.reuseReadyRetries, this.timing.reuseReadyDelayMs);
        return; // healthy + ready → reuse
      } catch {
        // healthz-OK but never ready within the reuse window → bad/zombie daemon
        // (e.g. codex bootstrap failed: healthz 200 / readyz 503 forever). Replace it
        // instead of the old behaviour of hanging ~10s then abandoning it in place.
        this.log(
          `Daemon on control port ${this.controlPort} is healthy but not ready within reuse window — replacing`,
        );
        await this.replaceUnhealthyDaemon(status?.pid);
        return;
      }
    }

    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        // Verify the live process is actually our daemon, not an OS-reused PID
        if (isAgentBridgeDaemon(existingPid)) {
          try {
            await this.waitForReady(this.timing.reuseReadyRetries, this.timing.reuseReadyDelayMs);
            return;
          } catch {
            // Live daemon process but control port never became ready → replace it
            // (old behaviour threw and left the zombie in place).
            this.log(`Existing daemon process ${existingPid} never became ready — replacing`);
            await this.replaceUnhealthyDaemon(existingPid);
            return;
          }
        }
        // Live process but NOT our daemon — stale PID reused by OS
        this.log(`Pid ${existingPid} is alive but not an AgentBridge daemon, removing stale pid file`);
      }
      this.removeStalePidFile();
    }

    // Nothing usable running — launch a fresh daemon under the strict lock.
    await this.withStartupLockStrict(async (locked) => {
      if (!locked) {
        await this.waitForContendedStartupLock();
        return;
      }
      // Re-check under the lock: a concurrent launcher may have just started one.
      if (await this.isHealthy()) {
        const status = await this.fetchStatus();
        const classification = this.classifyDaemon(status);
        if (classification.verdict === "manual-conflict") {
          throw this.manualConflictError(status);
        }
        if (!isReuseVerdict(classification.verdict)) {
          this.log(
            `Daemon on control port ${this.controlPort} is not reusable under startup lock ` +
              `(pair=${status?.pairId ?? "<none>"}, build=${formatBuildInfo(status?.build)}, ` +
              `reason=${classification.reason}) — replacing`,
          );
          await this.kill(3000, status?.pid);
        } else {
          try {
            await this.waitForReady(this.timing.reuseReadyRetries, this.timing.reuseReadyDelayMs);
            return;
          } catch {
            this.log(
              `Daemon on control port ${this.controlPort} is healthy but not ready under startup lock — replacing`,
            );
            await this.kill(3000, status?.pid);
          }
        }
      }
      this.launch();
      await this.waitForReady(this.timing.waitReadyRetries, this.timing.waitReadyDelayMs);
    });
  }

  /** Check if daemon health endpoint responds. */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(this.healthUrl);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Wait for daemon to become healthy. */
  async waitForHealthy(maxRetries = 40, delayMs = 250): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.isHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon health on ${this.healthUrl}`);
  }

  /** Check if daemon is ready to accept Codex TUI connections. */
  async isReady(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(this.readyUrl);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Wait for daemon to become ready. */
  async waitForReady(maxRetries = WAIT_READY_RETRIES, delayMs = WAIT_READY_DELAY_MS): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.isReady()) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Timed out waiting for AgentBridge daemon readiness on ${this.readyUrl}`);
  }

  /**
   * Wait for the daemon to be ready AND belong to this pair. Used in contended-lock
   * branches where another launcher is the one doing the fix-up — we must not return
   * just because the daemon reported ready, since that daemon may be foreign (the
   * other pair repairing their own daemon). In manual mode (no expected pairId) this
   * is equivalent to waitForReady.
   */
  async waitForReadyAndOurs(maxRetries = WAIT_READY_RETRIES, delayMs = WAIT_READY_DELAY_MS): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.isReady()) {
        const status = await this.fetchStatus();
        // Accept ready + ours + (current build OR a drifted daemon that the reuse
        // policy keeps alive — same contract with a live TUI). Without the latter,
        // this loop spins to a 10s timeout against a perfectly usable daemon
        // (observed live as "Timed out waiting for readiness+identity").
        const classification = this.classifyDaemon(status);
        if (classification.verdict === "manual-conflict") {
          throw this.manualConflictError(status);
        }
        if (isReuseVerdict(classification.verdict)) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(
      `Timed out waiting for AgentBridge daemon readiness+identity on ${this.readyUrl} (control port ${this.controlPort})`,
    );
  }

  /**
   * Read the UNIFIED daemon identity (arch-review P2 #536): prefer `daemon.json`,
   * fall back to the legacy `daemon.pid` + `status.json` pair. This is the
   * single source consumers should use for proxyUrl / ports / pid / phase.
   */
  readDaemonRecord(): DaemonRecord | null {
    return readUnifiedDaemonRecord({
      daemonRecordFile: this.stateDir.daemonRecordFile,
      pidFile: this.stateDir.pidFile,
      statusFile: this.stateDir.statusFile,
    });
  }

  /** Atomically write the unified daemon.json (tmp+rename). */
  writeDaemonRecord(record: DaemonRecord): void {
    writeDaemonRecord(this.stateDir.daemonRecordFile, record);
  }

  /** Remove the unified daemon.json. */
  removeDaemonRecord(): void {
    try {
      unlinkSync(this.stateDir.daemonRecordFile);
    } catch {}
  }

  /**
   * Read daemon status from status.json (LEGACY pair). Kept for one version cycle
   * so an older on-disk daemon (no daemon.json) is still readable. New callers
   * should prefer {@link readDaemonRecord}, which reads daemon.json first and
   * falls back to this file.
   */
  readStatus(): { proxyUrl?: string; controlPort?: number; pid?: number } | null {
    try {
      const raw = readFileSync(this.stateDir.statusFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Write daemon status to status.json (LEGACY pair, kept in sync for compat). */
  writeStatus(status: Record<string, unknown>): void {
    atomicWriteJson(this.stateDir.statusFile, status);
  }

  /** Read daemon PID from pid file. */
  readPid(): number | null {
    try {
      const raw = readFileSync(this.stateDir.pidFile, "utf-8").trim();
      if (!raw) return null;
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /** Write daemon PID to pid file. */
  writePid(pid?: number): void {
    atomicWriteText(this.stateDir.pidFile, `${pid ?? process.pid}\n`);
  }

  /** Remove stale pid file. */
  removePidFile(): void {
    try {
      unlinkSync(this.stateDir.pidFile);
    } catch {}
  }

  /** Remove status file. */
  removeStatusFile(): void {
    try {
      unlinkSync(this.stateDir.statusFile);
    } catch {}
  }

  /** Write killed sentinel — prevents auto-reconnect from relaunching daemon. */
  markKilled(): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.killedFile, `${Date.now()}\n`, "utf-8");
  }

  /** Remove killed sentinel — allows daemon to be launched again. */
  clearKilled(): void {
    try {
      unlinkSync(this.stateDir.killedFile);
    } catch {}
  }

  /** Check if daemon was intentionally killed by the user. */
  wasKilled(): boolean {
    return existsSync(this.stateDir.killedFile);
  }

  /** Launch daemon as detached background process. */
  private launch(): void {
    this.stateDir.ensure();
    this.log(`Launching detached daemon on control port ${this.controlPort}`);

    const daemonProc = spawn(process.execPath, ["run", DAEMON_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTBRIDGE_CONTROL_PORT: String(this.controlPort),
        AGENTBRIDGE_STATE_DIR: this.stateDir.dir,
      },
      detached: true,
      stdio: "ignore",
    });
    daemonProc.unref();
  }

  private removeStalePidFile(): void {
    this.log("Removing stale daemon identity files");
    // Remove ALL three identity files so a recycled/stale pid does not leave a
    // half-state behind (symmetric with cleanup()/kill()). Previously this
    // removed only daemon.pid, leaving status.json (and now daemon.json) with
    // the stale pid until the next launch overwrote them — a bounded leak we
    // close here.
    this.removePidFile();
    this.removeStatusFile();
    this.removeDaemonRecord();
  }

  /**
   * Replace a bad/foreign daemon holding our control port. Done under a STRICT startup
   * lock so two concurrent launchers never kill each other's fresh daemon. Inside the
   * lock we RE-CHECK whether the daemon is still bad (another launcher may have already
   * fixed it) before killing. `statusPid` (from the /healthz body) is preferred for the
   * kill so a foreign daemon whose pid file we don't own is still reachable.
   */
  private async replaceUnhealthyDaemon(statusPid?: number): Promise<void> {
    await this.withStartupLockStrict(async (locked) => {
      if (!locked) {
        await this.waitForContendedStartupLock();
        return;
      }
      // Re-check under the lock: the daemon may have readied or been replaced already.
      if (await this.isHealthy()) {
        const status = await this.fetchStatus();
        const classification = this.classifyDaemon(status);
        if (classification.verdict === "manual-conflict") {
          throw this.manualConflictError(status);
        }
        if (isReuseVerdict(classification.verdict)) {
          try {
            await this.waitForReady(this.timing.reuseReadyRetries, this.timing.reuseReadyDelayMs);
            return; // someone else already fixed it — don't kill
          } catch {
            // still not ready → fall through to kill + relaunch
          }
        }
      }
      this.log(`Killing unhealthy daemon on control port ${this.controlPort} and relaunching`);
      await this.kill(3000, statusPid);
      this.launch();
      await this.waitForReady(this.timing.waitReadyRetries, this.timing.waitReadyDelayMs);
    });
  }

  private async waitForContendedStartupLock(): Promise<void> {
    // Another launcher holds the lock and will replace/launch — just wait.
    this.log("Another process holds the startup lock, waiting for readiness+identity...");
    // Contended branch: the lock holder is doing the fix-up. Wait for a daemon
    // that is BOTH ready AND ours — a foreign daemon becoming ready behind the
    // lock holder is the other pair repairing their own daemon; adopting it
    // would squat the wrong pair.
    await this.waitForReadyAndOurs(this.timing.waitReadyRetries, this.timing.waitReadyDelayMs);
  }

  /**
   * Run `fn` while holding the startup lock, serializing destructive replace/launch.
   * Unlike the old acquireLock's depth>1 bypass, this NEVER proceeds destructively
   * without the lock: if a LIVE process holds it, `fn` is invoked with locked=false
   * (the caller should just wait for readiness, not kill/launch). Stale locks (dead
   * holder) are reclaimed once.
   */
  private async withStartupLockStrict<T>(fn: (locked: boolean) => Promise<T>): Promise<T> {
    const locked = this.acquireLockStrict();
    try {
      return await fn(locked);
    } finally {
      if (locked) this.releaseLock();
    }
  }

  /**
   * Acquire the startup lock WITHOUT bypass-on-contention. Returns false if a live
   * holder exists (so destructive replacement stays serialized); reclaims a stale lock
   * left by a dead holder, retrying exactly once. On a non-EEXIST error (permissions,
   * etc.) returns false — strict mode refuses to proceed destructively unlocked.
   */
  private acquireLockStrict(reclaimed = false): boolean {
    this.stateDir.ensure();
    let fd: number | null = null;
    try {
      fd = openSync(this.stateDir.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (err: any) {
      if (fd !== null && err.code !== "EEXIST") {
        // O_EXCL create succeeded but the pid write/close failed (e.g. ENOSPC):
        // without cleanup we'd leave an EMPTY lock file that parses to NaN and
        // can never be reclaimed — a permanent wedge for this pair.
        try {
          closeSync(fd);
        } catch {}
        this.releaseLock();
      }
      if (err.code === "EEXIST") {
        if (reclaimed) return false; // already retried once after reclaiming
        try {
          const holderPid = Number.parseInt(readFileSync(this.stateDir.lockFile, "utf-8").trim(), 10);
          if (Number.isFinite(holderPid) && !isProcessAlive(holderPid)) {
            this.log(`Stale startup lock from dead process ${holderPid}, reclaiming`);
            this.releaseLock();
            return this.acquireLockStrict(true);
          }
          // Alive pid but NOT an AgentBridge process — the lock holder died and
          // the OS recycled its pid into something unrelated. Treating that as
          // a live holder wedges the pair forever. Identity is only consulted
          // for STALE locks: pid recycling takes far longer than any legitimate
          // lock hold (seconds), and the command-line heuristic must not veto a
          // fresh, genuinely-live holder (e.g. a test runner invoked with
          // relative paths carries no agentbridge marker).
          if (
            Number.isFinite(holderPid) &&
            this.lockAgeMs() > LOCK_IDENTITY_GRACE_MS &&
            !isAgentBridgeProcess(holderPid)
          ) {
            this.log(
              `Startup lock is ${Math.round(this.lockAgeMs() / 1000)}s old and holder pid ${holderPid} ` +
                `is an unrelated process (pid recycled), reclaiming`,
            );
            this.releaseLock();
            return this.acquireLockStrict(true);
          }
        } catch {
          // Can't read the lock holder — treat as contended; do NOT bypass.
          return false;
        }
        return false; // live holder — contended
      }
      this.log(`Could not acquire strict startup lock: ${err.message}`);
      return false;
    }
  }

  /** Age of the current lock file in ms (Infinity-safe: 0 when unreadable). */
  private lockAgeMs(): number {
    try {
      return Date.now() - statSync(this.stateDir.lockFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Release the startup lock file. */
  private releaseLock(): void {
    try {
      unlinkSync(this.stateDir.lockFile);
    } catch {}
  }

  /**
   * Kill daemon process precisely.
   * Returns true if a process was found and killed.
   */
  async kill(gracefulTimeoutMs = 3000, pidOverride?: number): Promise<boolean> {
    // pidOverride lets us target a daemon reported via /healthz body whose pid file
    // we don't own (e.g. a foreign daemon squatting our control port). Falls back to
    // the pid file. The isAgentBridgeDaemon() guard below still prevents killing a
    // non-AgentBridge process if the OS reused the pid.
    const pid = pidOverride ?? this.readPid();
    if (!pid) {
      this.log("No daemon pid file found");
      this.cleanup();
      return false;
    }

    if (!isProcessAlive(pid)) {
      this.log(`Daemon pid ${pid} is not alive, cleaning up stale files`);
      this.cleanup();
      return false;
    }

    // Verify the PID actually belongs to an AgentBridge daemon.
    // If the PID file is stale and the OS has reused the PID,
    // we must NOT kill an unrelated process.
    if (!isAgentBridgeDaemon(pid)) {
      this.log(`Pid ${pid} is alive but is NOT an AgentBridge daemon — refusing to kill. Cleaning up stale pid file.`);
      this.cleanup();
      return false;
    }

    // Try graceful shutdown first (SIGTERM)
    this.log(`Sending SIGTERM to daemon pid ${pid}`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.cleanup();
      return false;
    }

    // Wait for graceful shutdown
    const deadline = Date.now() + gracefulTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        this.log(`Daemon pid ${pid} stopped gracefully`);
        this.cleanup();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Force kill (SIGKILL)
    this.log(`Daemon pid ${pid} did not stop gracefully, sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}

    this.cleanup();
    return true;
  }

  /**
   * Clean up daemon state files (pid + status). Does NOT touch the startup lock:
   * kill() runs INSIDE withStartupLockStrict's held section during a replace, and
   * releasing the lock here would let a concurrent launcher grab it mid-replace and
   * double-launch (the bug a strict lock exists to prevent). The lock's lifecycle is
   * owned solely by withStartupLockStrict's finally; stale locks left by a dead holder
   * are reclaimed by acquireLockStrict.
   */
  private cleanup(): void {
    this.removePidFile();
    this.removeStatusFile();
    // Unified daemon.json (arch-review P2 #536) must be removed in lockstep with
    // the legacy pair — otherwise a killed daemon would leave a daemon.json with
    // a (now-dead) pid that readDaemonRecord/pairDirDaemonAlive could still read.
    this.removeDaemonRecord();
  }
}

async function fetchWithTimeout(url: string, timeoutMs = HEALTH_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Re-exported for the existing daemon-lifecycle.test.ts import surface. The
// implementation now lives in process-lifecycle.ts (single source of truth).
export { isProcessAlive };
