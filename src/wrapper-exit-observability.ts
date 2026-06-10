/**
 * TUI-wrapper exit observability (issue #102).
 *
 * A real outage triage showed every TUI exit in codex-wrapper.log classified
 * as the same `exit_0_empty_stderr` — indistinguishable user-quit vs
 * unexpected clean death, and the structured TUI logs (which live in
 * ~/.codex/logs_*.sqlite, NOT the empty ~/.codex/log/ decoy directory) were
 * keyed by the NATIVE child pid, which the wrapper never recorded.
 *
 * This module holds the pure/injectable pieces the wrapper exit hook uses:
 *  - native-child pid discovery (the spawned `codex` is an npm launcher whose
 *    child is the real TUI binary);
 *  - clean-exit refinement via the daemon's status.json turnInProgress field
 *    (refreshed by the daemon on every turn transition);
 *  - the sqlite tail query that freezes the TUI's last structured log lines
 *    into the wrapper log at exit time.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type RunCommand = (cmd: string, args: string[]) => string;

/**
 * Discover the native TUI child of the npm launcher process. Returns the
 * first child pid, or null when none is visible (already exited, or the
 * launcher IS the native binary).
 */
export function discoverNativeChildPid(launcherPid: number, run: RunCommand): number | null {
  try {
    const out = run("pgrep", ["-P", String(launcherPid)]);
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\d+$/.test(line));
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

/**
 * Read the daemon's turnInProgress from status.json. Returns null when the
 * file/field is unavailable (old daemon build, daemon gone) — callers must
 * treat null as "unknown", never as idle.
 *
 * Trust gate: status.json outlives a killed daemon, and a daemon killed
 * MID-TURN leaves `turnInProgress: true` behind — a later idle TUI exit would
 * misclassify as exit_0_during_turn. So the field is only trusted when the
 * writing daemon (status.pid) is still alive; a stale file degrades to
 * unknown.
 */
export function readTurnInProgress(
  statusFilePath: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf-8"),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): boolean | null {
  try {
    const status = JSON.parse(read(statusFilePath)) as Record<string, unknown>;
    if (typeof status.turnInProgress !== "boolean") return null;
    if (typeof status.pid === "number" && !isPidAlive(status.pid)) return null;
    return status.turnInProgress;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours (not the case for our own daemon, but err
    // on the side of "alive" like pair-registry's pidLooksAlive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Refine the clean-exit classification using the daemon-side turn state.
 * `exit_0_during_turn` is the alarming one: the user sees "Codex died", but
 * the agent loop lives app-server-side and the task usually completes.
 */
export function refineCleanExitClassification(turnInProgress: boolean | null): string {
  if (turnInProgress === true) return "exit_0_during_turn";
  if (turnInProgress === false) return "exit_0_idle";
  return "exit_0_turn_unknown";
}

/**
 * Locate the newest codex structured-log sqlite database. The filename is
 * versioned (logs_2.sqlite today) — pick the most recently modified match so
 * a future logs_3 keeps working. Returns null when none exist.
 */
export function findCodexSqliteLog(codexHome: string, fs: { readdir: typeof readdirSync; stat: typeof statSync } = { readdir: readdirSync, stat: statSync }): string | null {
  try {
    const entries = fs.readdir(codexHome).filter((name) => /^logs.*\.sqlite$/.test(String(name)));
    let best: { path: string; mtime: number } | null = null;
    for (const name of entries) {
      const path = join(codexHome, String(name));
      try {
        const mtime = fs.stat(path).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      } catch {
        // Race with deletion — skip.
      }
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * The sqlite tail query for one native pid's structured log records.
 * `process_uuid` is `pid:<pid>:<uuid>`; body is truncated per row and the row
 * count bounded so a wrapper exit appends a bounded block, not a dump.
 */
export function codexSqliteTailCommand(dbPath: string, nativePid: number, limit = 80): { cmd: string; args: string[] } {
  // Both interpolations are numbers by type, but NaN/Infinity are valid JS
  // numbers sqlite would reject — clamp to a sane integer before embedding.
  const rows = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 80;
  const pid = Math.max(0, Math.floor(nativePid));
  const sql =
    `select ts, level, target, substr(feedback_log_body,1,300) from logs ` +
    `where process_uuid like 'pid:${pid}:%' order by id desc limit ${rows};`;
  return { cmd: "sqlite3", args: ["-readonly", dbPath, sql] };
}

/**
 * Capture the TUI log tail for the exit block. Best-effort: any failure
 * (sqlite3 missing, db locked, no rows) degrades to a one-line explanation —
 * the wrapper exit path must never throw or block on this.
 */
export function captureTuiLogTail(options: {
  codexHome: string;
  nativePid: number | null;
  run: RunCommand;
}): string {
  if (options.nativePid === null) {
    return "(native child pid unknown — tui log tail unavailable)";
  }
  const db = findCodexSqliteLog(options.codexHome);
  if (!db) {
    return "(no codex sqlite log database found)";
  }
  try {
    const { cmd, args } = codexSqliteTailCommand(db, options.nativePid);
    const out = options.run(cmd, args).trim();
    return out.length > 0 ? out : `(no log rows for pid ${options.nativePid} in ${db})`;
  } catch (err) {
    return `(tui log tail capture failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}
