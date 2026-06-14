/**
 * Reader for agent-quota-guard's `pending` files (PR2: detection only — this
 * module performs NO injection, emits nothing, and is consumed by the daemon's
 * resume-candidate signal closure).
 *
 * Both writers (JS hook.mjs and bash budget_guard.sh) emit the CURRENT schema:
 *     { status, agent, session_id, cwd, reset_epoch, util, warn_util, at }
 *     Note: util === warn_util by contract (both = triggerUtil) — they are NOT
 *     independent hard/warn readings. (PR1 normalized the bash writer to emit
 *     reset_epoch + warn_util, so the two writers are schema-identical today.)
 *
 * The `?? .reset` / `?? .util` fallbacks below are DEFENSIVE compatibility for
 * OLD/historical pending files that predate PR1 — a legacy bash writer used
 * `reset` (not `reset_epoch`) and omitted `warn_util`:
 *     resetEpoch = (.reset_epoch ?? .reset ?? 0)
 *     warnUtil   = (.warn_util  ?? .util)
 * They are not load-bearing for the current writers; they guard against a stale
 * file left on disk from a prior guard version.
 *
 * File layout:
 *   stateDir = process.env.BUDGET_STATE_DIR ?? join(homeDir, ".budget-guard")
 *   per-scope: <stateDir>/pending/<agent>_<scope>.json
 *              (scope name differs per writer — JS sha16 hex / Bash cksum int —
 *               so the SAME (cwd,session) can land in two files)
 *   legacy:    <stateDir>/pending_<agent>.json   (flat fallback)
 * The reader globs pending/<agent>_*.json, adds the legacy flat file, and dedups
 * by session_id.
 *
 * Resilience contract: every filesystem touch and every JSON.parse is wrapped in
 * its own try/catch (ENOENT / TOCTOU / malformed / empty / array / scalar are all
 * log-and-skip). The function NEVER throws.
 *
 * `homeDir` is injected (never `homedir()` directly) so tests can isolate to a
 * throwaway temp dir without touching the real HOME — the same injection seam
 * QuotaSource uses.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { asFiniteNumber, asRecord, numberOr } from "./quota-source";
import type { AgentName } from "./types";

/**
 * Resolve the fs module via `require` at CALL time (not a static ESM import).
 *
 * In Bun the ESM namespace object (`import * as fs`) and the CJS object
 * (`require("node:fs")`) are DISTINCT objects, and mutating one does not affect
 * the other. Tests (and any runtime instrumentation) monkey-patch
 * `require("node:fs").readFileSync` to simulate TOCTOU ENOENT; reading through
 * the same require object honors that patch. A static `import { readFileSync }`
 * would bind to a frozen namespace copy and silently ignore the patch.
 */
type FsModule = Pick<typeof import("node:fs"), "readFileSync" | "readdirSync" | "realpathSync">;
function nodeFs(): FsModule {
  return require("node:fs") as FsModule;
}

/**
 * cwd equality that tolerates symlink / logical-path drift.
 *
 * The guard writer records `cwd` as whatever `process.cwd()` (node hook) or
 * `$(pwd)` (bash hook) returns — neither is guaranteed to be a realpath, so it
 * may be a symlink path (e.g. /tmp → /private/tmp on macOS, or a symlinked
 * checkout). The daemon, by contrast, passes an already-realpath-resolved
 * `opts.cwd`. A raw `===` between the two misses the match and yields a
 * false-negative pendingExists=false.
 *
 * Match rule:
 *   1. raw `entryCwd === optsCwd`            → true (cheap, no fs touch).
 *   2. else `realpathSync(entryCwd) === realpathSync(optsCwd)` → true.
 *   3. if EITHER realpathSync throws (ENOENT / perms / TOCTOU) → fall back to
 *      the raw compare result (which was already false at step 1, so → false).
 *
 * Cross-repo isolation is preserved: two genuinely different directories have
 * distinct realpaths, so step 2 still returns false for them.
 */
function cwdMatches(entryCwd: string, optsCwd: string): boolean {
  if (entryCwd === optsCwd) return true;
  try {
    const fs = nodeFs();
    return fs.realpathSync(entryCwd) === fs.realpathSync(optsCwd);
  } catch {
    // ENOENT (dir gone), EACCES, or any realpath failure → fall back to the raw
    // compare, which already failed at the top (→ false). Never throw.
    return false;
  }
}

/** Parsed pending entry (camelCase internal shape). */
export interface PendingEntry {
  /** Pending status, typically "paused". */
  status: string;
  /** Which agent the guard paused. */
  agent: AgentName;
  /** Source field session_id; absent → the whole entry is null (it is the dedup key). */
  sessionId: string;
  /** Source field cwd. */
  cwd: string;
  /** (.reset_epoch ?? .reset ?? 0) — bash writer uses `reset`. */
  resetEpoch: number;
  /** Trigger utilization (.util). */
  util: number;
  /** (.warn_util ?? .util) — bash writer omits warn_util. */
  warnUtil: number;
  /** Epoch seconds (.at) the pause was written. */
  at: number;
  /** Absolute path of the pending file this entry came from; empty for pure parser output. */
  sourcePath: string;
  /** sha256 of the trimmed pending file content; empty for pure parser output. */
  contentHash: string;
}

/**
 * Pure parser over `unknown` (no IO — the test seam, mirroring
 * normalizeProbeResult). Returns null (never throws) for any input that is not a
 * usable pending record: non-object / array / null / missing session_id /
 * non-finite util.
 */
export function parsePendingPayload(value: unknown): PendingEntry | null {
  const record = asRecord(value);
  if (!record) return null;

  // session_id is the dedup key — a record without it is unusable.
  const sessionId = record.session_id;
  if (typeof sessionId !== "string" || sessionId === "") return null;

  // util must be a real reading; a missing/non-finite util cannot be trusted.
  const util = asFiniteNumber(record.util);
  if (util === null) return null;

  // (.warn_util ?? .util) — bash records have no warn_util.
  const warnUtil = numberOr(record.warn_util, util);
  // (.reset_epoch ?? .reset ?? 0) — bash records use `reset`.
  const resetEpoch = numberOr(record.reset_epoch ?? record.reset, 0);
  const at = numberOr(record.at, 0);
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const status = typeof record.status === "string" ? record.status : "";
  const agent = record.agent === "claude" || record.agent === "codex"
    ? record.agent
    : null;
  if (agent === null) return null;

  return { status, agent, sessionId, cwd, resetEpoch, util, warnUtil, at, sourcePath: "", contentHash: "" };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Resolve the guard state dir: BUDGET_STATE_DIR env override, else ~/.budget-guard. */
function resolveStateDir(homeDir: string): string {
  const override = process.env.BUDGET_STATE_DIR;
  if (override && override.trim() !== "") return override.trim();
  return join(homeDir, ".budget-guard");
}

/**
 * Read one pending file and parse it. Every step (readFileSync, trim,
 * JSON.parse, parsePendingPayload) is fault-isolated: ENOENT / TOCTOU /
 * malformed JSON / empty / array / scalar all return null (log-and-skip),
 * never throw.
 */
function readPendingFile(path: string, log: (msg: string) => void): PendingEntry | null {
  let raw: string;
  try {
    // Require at call time so a monkey-patched fs.readFileSync (TOCTOU ENOENT in
    // tests, or any runtime instrumentation) is honored — see nodeFs().
    raw = nodeFs().readFileSync(path, "utf-8");
  } catch (error) {
    // ENOENT (TOCTOU — file unlinked between listing and read) and any other
    // read failure are swallowed; the survivors are still returned.
    log(`pending reader: skip unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const text = String(raw).trim();
  if (text === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log(`pending reader: skip malformed JSON ${path}`);
    return null;
  }

  const entry = parsePendingPayload(parsed);
  if (!entry) return null;
  return { ...entry, sourcePath: path, contentHash: sha256(text) };
}

/** List per-scope pending files for the agent: pending/<agent>_*.json. */
function listScopeFiles(stateDir: string, agent: AgentName, log: (msg: string) => void): string[] {
  const pendingDir = join(stateDir, "pending");
  let names: string[];
  try {
    names = nodeFs().readdirSync(pendingDir) as string[];
  } catch {
    // Missing pending dir is the common cold-start case — not an error.
    return [];
  }
  const prefix = `${agent}_`;
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => join(pendingDir, name));
}

/**
 * Read all guard pending records for one agent.
 *
 * Globs <stateDir>/pending/<agent>_*.json, appends the legacy flat
 * <stateDir>/pending_<agent>.json, parses each (log-and-skip on any failure),
 * and dedups by sessionId. Returns [] when nothing is readable; NEVER throws.
 *
 * Filtering (defense in depth — the filename prefix already scopes by agent, but
 * a mislabeled or hand-edited file must not leak through):
 *   - `entry.agent !== opts.agent`  → dropped (cross-agent record).
 *   - `entry.status !== "paused"`   → dropped (only an active pause is a resume
 *     signal; a stale "resumed"/"cleared" record must NOT count as pending).
 *   - `opts.cwd` (when supplied)    → keep only entries whose `cwd` matches via
 *     `cwdMatches`, so a pending file from an UNRELATED repo cannot satisfy this
 *     pair's predicate. The match tolerates symlink / logical-path drift: a raw
 *     compare first, then a `realpathSync` fallback (the guard writer may record
 *     a symlink cwd while the daemon passes a realpath-resolved cwd). The
 *     realpath touch is fault-isolated (any error → raw-compare fallback, never
 *     throws); distinct repos keep distinct realpaths so cross-repo isolation
 *     holds.
 */
export function readGuardPending(opts: {
  homeDir: string;
  agent: AgentName;
  cwd?: string;
  log?: (message: string) => void;
}): PendingEntry[] {
  const log = opts.log ?? (() => {});
  const stateDir = resolveStateDir(opts.homeDir);

  const paths = [
    ...listScopeFiles(stateDir, opts.agent, log),
    // Legacy flat fallback — always attempted (readPendingFile swallows ENOENT).
    join(stateDir, `pending_${opts.agent}.json`),
  ];

  // Dedup by sessionId: the same (cwd,session) may be written under two scope
  // names (JS sha16 vs Bash cksum) or under both a scope file and the legacy file.
  const bySession = new Map<string, PendingEntry>();
  for (const path of paths) {
    const entry = readPendingFile(path, log);
    if (!entry) continue;
    // Cross-agent record (mislabeled file): reject — the prefix should already
    // exclude these, but a hand-edited file could carry the wrong agent.
    if (entry.agent !== opts.agent) continue;
    // Only an active pause is a resume signal.
    if (entry.status !== "paused") continue;
    // Scope to the current pair's cwd when requested (cross-repo isolation).
    // cwdMatches tolerates symlink / logical-path drift (raw compare first, then
    // realpath fallback) so a guard-recorded symlink cwd still matches the
    // daemon's realpath-resolved cwd; distinct repos keep distinct realpaths.
    if (opts.cwd !== undefined && !cwdMatches(entry.cwd, opts.cwd)) continue;
    if (!bySession.has(entry.sessionId)) {
      bySession.set(entry.sessionId, entry);
    }
  }

  return [...bySession.values()];
}
