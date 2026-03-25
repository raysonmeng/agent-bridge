import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/**
 * Resolves the shared runtime state directory for AgentBridge.
 *
 * macOS:  ~/Library/Application Support/AgentBridge
 * Linux:  ${XDG_STATE_HOME:-~/.local/state}/agentbridge
 * Override: AGENTBRIDGE_STATE_DIR env var
 *
 * This directory stores daemon pid, lock, status, ports, and logs.
 * It is NOT for project-level config (that lives in .agentbridge/).
 */
export class StateDirResolver {
  private readonly stateDir: string;

  constructor(envOverride?: string) {
    const override = envOverride ?? process.env.AGENTBRIDGE_STATE_DIR;
    if (override) {
      this.stateDir = override;
    } else if (platform() === "darwin") {
      this.stateDir = join(homedir(), "Library", "Application Support", "AgentBridge");
    } else {
      const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
      this.stateDir = join(xdgState, "agentbridge");
    }
  }

  /** Ensure the state directory exists. */
  ensure(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  get dir(): string {
    return this.stateDir;
  }

  get pidFile(): string {
    return join(this.stateDir, "daemon.pid");
  }

  get lockFile(): string {
    return join(this.stateDir, "daemon.lock");
  }

  get statusFile(): string {
    return join(this.stateDir, "status.json");
  }

  get portsFile(): string {
    return join(this.stateDir, "ports.json");
  }

  get logFile(): string {
    return join(this.stateDir, "agentbridge.log");
  }
}
