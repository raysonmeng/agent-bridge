import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StateDirResolver } from "./state-dir";

const DAEMON_PATH = fileURLToPath(new URL("./daemon.ts", import.meta.url));

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

  get controlWsUrl(): string {
    return `ws://127.0.0.1:${this.controlPort}/ws`;
  }

  /** Ensure daemon is running: check health, check pid, start if needed. */
  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      return;
    }

    const existingPid = this.readPid();
    if (existingPid) {
      if (isProcessAlive(existingPid)) {
        try {
          await this.waitForHealthy(12, 250);
          return;
        } catch {
          throw new Error(
            `Found existing daemon process ${existingPid}, but control port ${this.controlPort} never became healthy.`,
          );
        }
      }
      this.removeStalePidFile();
    }

    this.launch();
    await this.waitForHealthy();
  }

  /** Check if daemon health endpoint responds. */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(this.healthUrl);
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
   * Kill daemon process precisely.
   * Returns true if a process was found and killed.
   */
  async kill(gracefulTimeoutMs = 3000): Promise<boolean> {
    const pid = this.readPid();
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

  /** Clean up all state files. */
  private cleanup(): void {
    this.removePidFile();
    this.removeStatusFile();
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
