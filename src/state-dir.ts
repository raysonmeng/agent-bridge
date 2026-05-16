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
 * This directory stores daemon pid, managed TUI pid, lock, status, ports, and logs.
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

  get tuiPidFile(): string {
    return join(this.stateDir, "codex-tui.pid");
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

  // ── STM v2.3 §D5 P3d — per-pair file paths ────────────────────────────
  //
  // The pair registry already lives under `pairs/` (see PairRegistry).
  // P3d adds the per-pair subdirectories and file accessors so a future
  // commit (and P4's CLI `--pair` flag) can populate them. Until that
  // commit lands, the root-level `tuiPidFile` and `codexWrapperLogFile`
  // accessors are retained as the canonical paths so v2.2 behavior is
  // preserved end-to-end. Both v2.2 and v2.3 readers will coexist during
  // the transition (the kill walker reads both).

  /** Subdirectory for a specific pair's runtime state. */
  pairDir(pairId: string): string {
    return join(this.stateDir, "pairs", pairId);
  }

  /** Per-pair Codex app-server / TUI pid file. */
  pairCodexPidFile(pairId: string): string {
    return join(this.pairDir(pairId), "codex.pid");
  }

  /** Per-pair codex-wrapper log (matches the format of root codexWrapperLogFile). */
  pairCodexWrapperLogFile(pairId: string): string {
    return join(this.pairDir(pairId), "codex-wrapper.log");
  }

  /** Ensure a pair's subdirectory exists; safe to call repeatedly. */
  ensurePairDir(pairId: string): void {
    const dir = this.pairDir(pairId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
