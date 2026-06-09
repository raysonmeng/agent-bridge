import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILD_INFO, compatibleContractVersion, formatBuildInfo, sameRuntimeContract } from "./build-info";
import { StateDirResolver } from "./state-dir";
import { parsePositiveIntEnv } from "./env-utils";
import type { DaemonStatus } from "./control-protocol";

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
const HEALTH_FETCH_TIMEOUT_MS = 500;
// A legitimate startup-lock hold lasts seconds (launch + waitForReady, plus a
// 3s graceful kill during a replace). Only locks far older than that get the
// pid-recycling identity check — see acquireLockStrict.
const LOCK_IDENTITY_GRACE_MS = parsePositiveIntEnv("AGENTBRIDGE_LOCK_IDENTITY_GRACE_MS", 120_000);

export interface DaemonLifecycleOptions {
  stateDir: StateDirResolver;
  controlPort: number;
  log: (msg: string) => void;
}

/**
 * Shared daemon lifecycle management.
 * Used by both CLI (agentbridge codex) and plugin frontend (bridge.ts).
 */
export class DaemonLifecycle {
  private readonly stateDir: StateDirResolver;
  private readonly controlPort: number;
  private readonly log: (msg: string) => void;

  constructor(opts: DaemonLifecycleOptions) {
    this.stateDir = opts.stateDir;
    this.controlPort = opts.controlPort;
    this.log = opts.log;
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

  /**
   * True when this pair expects a specific pairId and the live daemon is NOT ours —
   * a foreign daemon squatting our control port. In pair mode (expected pairId set),
   * a missing/null reported pairId is ALSO foreign: an old daemon built before pairId
   * shipped, or a manual daemon, must not be silently reused by a named pair — that is
   * exactly the squatting the hardening exists to prevent. In manual/legacy mode
   * (no expected pairId), any reported pairId is acceptable.
   */
  private isForeignDaemon(status: DaemonStatus | null): boolean {
    const expected = this.expectedPairId;
    if (!expected) return false; // manual/legacy — no enforcement
    if (!status) return false; // unreachable/unparseable status — don't force-replace
    const reported = status.pairId;
    if (reported == null) return true; // pair-mode + no reported identity = foreign
    return reported !== expected;
  }

  /**
   * A MANUAL-mode launcher (no AGENTBRIDGE_PAIR_ID) found a daemon that belongs
   * to a REGISTERED pair on its control port. Manual mode waives the foreign
   * check above, but adopting (or worse, drift-replacing) a registered pair's
   * daemon is squatting: an unwrapped `claude` session defaults to the root
   * control port, which aliases registered slot 0. Neither reuse nor replace is
   * acceptable here — the caller must abort with guidance.
   */
  private isRegisteredPairDaemonInManualMode(status: DaemonStatus | null): boolean {
    return !this.expectedPairId && status?.pairId != null;
  }

  private isBuildDrifted(status: DaemonStatus | null): boolean {
    if (process.env.AGENTBRIDGE_ALLOW_BUILD_DRIFT === "1") return false;
    const runtime = status?.build;
    if (!runtime) return true;
    // Compare the runtime CONTRACT (version/commit/contractVersion), NOT `bundle`:
    // the dist CLI and the Claude Code plugin launch co-equal daemons from the same
    // source for the same pair, so a bundle-kind difference must not trigger a
    // destructive replace (that would replace-war the two launchers).
    return !sameRuntimeContract(runtime, BUILD_INFO);
  }

  /**
   * Can a build-drifted daemon be REUSED instead of replaced? Replacing a daemon
   * is destructive: SIGTERM tears down the codex app-server proxy, which severs
   * any attached Codex TUI mid-session (observed live: the TUI dies with
   * "WebSocket protocol error: Connection reset without closing handshake").
   * Commit/version drift alone is an upgrade-hygiene concern, never worth that:
   *  - contractVersion mismatch → NOT reusable (the frontend cannot speak to it);
   *  - same contract + live Codex TUI attached → reusable (warn; the new build is
   *    picked up at the next natural restart instead of by killing live work);
   *  - same contract + no TUI → not reusable (replace in the safe window, keeping
   *    the auto-upgrade behavior when it costs nothing).
   */
  private canReuseDespiteDrift(status: DaemonStatus | null): boolean {
    if (!compatibleContractVersion(status?.build, BUILD_INFO)) return false;
    return status?.tuiConnected === true;
  }

  /** Ensure daemon is running: reuse a healthy one, replace a bad/foreign one, else launch. */
  async ensureRunning(): Promise<void> {
    // Fast path: something answers /healthz on our control port. But healthz 200 only
    // proves the control server is alive — NOT that codex bootstrapped, nor that the
    // daemon belongs to THIS pair. Distinguish reuse-able from replace-able:
    if (await this.isHealthy()) {
      const status = await this.fetchStatus();
      if (this.isRegisteredPairDaemonInManualMode(status)) {
        throw new Error(
          `Control port ${this.controlPort} is owned by registered pair ${status?.pairId}. ` +
            `This session has no pair identity (manual mode) and will not reuse or replace it — ` +
            `start with \`agentbridge claude\` from that pair's directory, or set AGENTBRIDGE_CONTROL_PORT to a free port.`,
        );
      }
      if (this.isForeignDaemon(status)) {
        this.log(
          `Control port ${this.controlPort} held by a daemon for pair ${status?.pairId ?? "<none>"}, ` +
            `but this pair is ${this.expectedPairId} — replacing foreign daemon`,
        );
        await this.replaceUnhealthyDaemon(status?.pid);
        return;
      }
      if (this.isBuildDrifted(status)) {
        if (this.canReuseDespiteDrift(status)) {
          this.log(
            `Daemon on control port ${this.controlPort} is running build ${formatBuildInfo(status?.build)} ` +
              `(launcher ${formatBuildInfo(BUILD_INFO)}) but a live Codex TUI is attached — reusing instead of ` +
              `replacing; the new build is picked up at the next restart (abg kill, then relaunch)`,
          );
          // fall through to the readiness check + reuse path below
        } else {
          this.log(
            `Daemon on control port ${this.controlPort} is running build ${formatBuildInfo(status?.build)} ` +
              `but launcher is ${formatBuildInfo(BUILD_INFO)} — replacing drifted daemon`,
          );
          await this.replaceUnhealthyDaemon(status?.pid);
          return;
        }
      }
      try {
        // Short window: a sane daemon (or a legit slow boot) reports ready within ~3s.
        await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
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
        if (this.isDaemonProcess(existingPid)) {
          try {
            await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
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
        // Another process holds the lock and is launching/replacing — just wait.
        this.log("Another process holds the startup lock, waiting for readiness+identity...");
        // Contended branch: the lock holder is doing the fix-up. Wait for a daemon
        // that is BOTH ready AND ours — a foreign daemon becoming ready behind the
        // lock holder is the other pair repairing their own daemon; adopting it
        // would squat the wrong pair. Manual mode is handled by waitForReadyAndOurs
        // (it short-circuits the identity check).
        await this.waitForReadyAndOurs();
        return;
      }
      // Re-check under the lock: a concurrent launcher may have just started one.
      if (await this.isHealthy()) {
        const status = await this.fetchStatus();
        if (this.isForeignDaemon(status) || (this.isBuildDrifted(status) && !this.canReuseDespiteDrift(status))) {
          this.log(
            `Daemon on control port ${this.controlPort} is not reusable under startup lock ` +
              `(pair=${status?.pairId ?? "<none>"}, build=${formatBuildInfo(status?.build)}) — replacing`,
          );
          await this.kill(3000, status?.pid);
        } else {
          try {
            await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
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
      await this.waitForReady();
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
  async waitForReady(maxRetries = 40, delayMs = 250): Promise<void> {
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
  async waitForReadyAndOurs(maxRetries = 40, delayMs = 250): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (await this.isReady()) {
        const status = await this.fetchStatus();
        // Accept ready + ours + (current build OR a drifted daemon that the reuse
        // policy keeps alive — same contract with a live TUI). Without the latter,
        // this loop spins to a 10s timeout against a perfectly usable daemon
        // (observed live as "Timed out waiting for readiness+identity").
        if (
          !this.isForeignDaemon(status) &&
          (!this.isBuildDrifted(status) || this.canReuseDespiteDrift(status))
        ) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(
      `Timed out waiting for AgentBridge daemon readiness+identity on ${this.readyUrl} (control port ${this.controlPort})`,
    );
  }

  /** Read daemon status from status.json. */
  readStatus(): { proxyUrl?: string; controlPort?: number; pid?: number } | null {
    try {
      const raw = readFileSync(this.stateDir.statusFile, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Write daemon status to status.json. */
  writeStatus(status: Record<string, unknown>): void {
    this.stateDir.ensure();
    writeFileSync(this.stateDir.statusFile, JSON.stringify(status, null, 2) + "\n", "utf-8");
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
    this.stateDir.ensure();
    writeFileSync(this.stateDir.pidFile, `${pid ?? process.pid}\n`, "utf-8");
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
    this.log("Removing stale pid file");
    this.removePidFile();
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
        // Another launcher holds the lock and will replace/launch — just wait.
        this.log("Another process holds the startup lock, waiting for readiness+identity...");
        // Contended branch: the lock holder is doing the fix-up. Wait for a daemon
        // that is BOTH ready AND ours — a foreign daemon becoming ready behind the
        // lock holder is the other pair repairing their own daemon; adopting it
        // would squat the wrong pair. Manual mode is handled by waitForReadyAndOurs
        // (it short-circuits the identity check).
        await this.waitForReadyAndOurs();
        return;
      }
      // Re-check under the lock: the daemon may have readied or been replaced already.
      if (await this.isHealthy()) {
        const status = await this.fetchStatus();
        if (
          !this.isForeignDaemon(status) &&
          (!this.isBuildDrifted(status) || this.canReuseDespiteDrift(status))
        ) {
          try {
            await this.waitForReady(REUSE_READY_RETRIES, REUSE_READY_DELAY_MS);
            return; // someone else already fixed it — don't kill
          } catch {
            // still not ready → fall through to kill + relaunch
          }
        }
      }
      this.log(`Killing unhealthy daemon on control port ${this.controlPort} and relaunching`);
      await this.kill(3000, statusPid);
      this.launch();
      await this.waitForReady();
    });
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
            !this.isAgentBridgeProcess(holderPid)
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

  /**
   * Loose identity check for lock holders: launchers (CLI / plugin frontend)
   * and daemons all carry agentbridge markers in their command line. Used only
   * to detect OS pid recycling — NOT for kill decisions (kill() keeps the
   * stricter daemon-entry match).
   */
  private isAgentBridgeProcess(pid: number): boolean {
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      return cmd.includes("agentbridge") || cmd.includes("agent_bridge");
    } catch {
      return false;
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
    // the pid file. The isDaemonProcess() guard below still prevents killing a
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
    if (!this.isDaemonProcess(pid)) {
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
   * Verify that a live PID actually belongs to an AgentBridge daemon
   * by checking the process command line. Prevents killing an unrelated
   * process when the OS has reused a stale PID.
   */
  private isDaemonProcess(pid: number): boolean {
    // Verify via process command line that this PID is actually our daemon, not
    // an OS-reused PID belonging to some unrelated process. Match on the
    // executable basename being a daemon-role script (`daemon.{ts,js}` for
    // production, `*-daemon.{ts,js}` for the e2e harness's fake) — NOT on the
    // loose substring "daemon", which would also match e.g. a test file named
    // `daemon-self-heal.test.ts` invoked by an IDE runner.
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      // Match: .../<anything>-daemon.js or .../<anything>-daemon.ts as a runnable
      // argument (preceded by whitespace/path-sep, followed by whitespace or EOL).
      // We additionally require the command to mention the agentbridge package OR
      // the repo dir to avoid matching some unrelated `*-daemon.js` from another
      // project.
      const hasDaemonEntry = /(?:^|[\s/\\])[\w.-]*-?daemon\.(?:ts|js)(?:\s|$)/.test(cmd);
      const hasAgentbridge = cmd.includes("agentbridge") || cmd.includes("agent_bridge");
      return hasDaemonEntry && hasAgentbridge;
    } catch {
      // ps failed — process may have exited between our check and the ps call
      return false;
    }
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { isProcessAlive };
