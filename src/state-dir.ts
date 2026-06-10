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
 * This directory stores daemon pid, managed TUI pid, lock, status, and logs.
 * It is NOT for project-level config (that lives in .agentbridge/).
 */
export class StateDirResolver {
  private readonly stateDir: string;

  /**
   * The platform default base directory, with NO override applied.
   *
   * Single source of truth for both the resolver and the multi-pair layer
   * (`pair-resolver.ts`), which nests each pair under `<base>/pairs/<id>/`.
   * Keeping this static avoids the base-dir logic drifting between the two.
   */
  static platformBaseDir(): string {
    if (platform() === "darwin") {
      return join(homedir(), "Library", "Application Support", "AgentBridge");
    }
    const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(xdgState, "agentbridge");
  }

  constructor(envOverride?: string) {
    const override = envOverride ?? process.env.AGENTBRIDGE_STATE_DIR;
    // Treat an empty string as "unset" (master behaviour) — `??` alone would
    // accept "" and resolve all state files relative to cwd.
    this.stateDir = override && override.length > 0 ? override : StateDirResolver.platformBaseDir();
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

  get tuiPidFile(): string {
    return join(this.stateDir, "codex-tui.pid");
  }

  get lockFile(): string {
    return join(this.stateDir, "daemon.lock");
  }

  get statusFile(): string {
    return join(this.stateDir, "status.json");
  }

  get currentThreadFile(): string {
    return join(this.stateDir, "current-thread.json");
  }

  get logFile(): string {
    return join(this.stateDir, "agentbridge.log");
  }

  /**
   * Dedicated log for `agentbridge codex` wrapper.
   *
   * Separate from agentbridge.log so we can see the child codex TUI's
   * exit code, signal, runtime, args, and the last 64KB of its stderr
   * without it being drowned in daemon noise. Critical for diagnosing
   * silent exits (FatalExitRequest / ThreadClosed) where the TUI's
   * "ERROR:" line on stderr is normally lost to stdio inherit.
   */
  get codexWrapperLogFile(): string {
    return join(this.stateDir, "codex-wrapper.log");
  }

  get killedFile(): string {
    return join(this.stateDir, "killed");
  }

  /**
   * Cache for the update-notifier: `{ lastCheckMs, latest }`. Machine/user-global
   * (not per-project) so the daily npm check runs once per machine, not once per
   * project — see src/update-notifier.ts.
   */
  get updateCheckFile(): string {
    return join(this.stateDir, "update-check.json");
  }
}
