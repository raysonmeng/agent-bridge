/**
 * Unified daemon disk identity (arch-review P2 #536).
 *
 * BEFORE: the daemon's on-disk identity was split across two non-atomic,
 * lifecycle-desynchronized files:
 *   - `daemon.pid`   — written at process start (pid only).
 *   - `status.json`  — written ONLY after codex bootstrap succeeded
 *     (proxyUrl/ports/build/turnPhase/...), via a bare writeFileSync.
 * A crash could leave a "pid present, status from a previous generation"
 * combination state, and consumers had to read BOTH files and take the union.
 *
 * AFTER: a single atomically-written `daemon.json` carries the full identity
 * with an explicit `phase`:
 *   - `phase: "booting"` is written atomically at process start (pid known,
 *     codex not yet ready — proxyUrl/ports/build may be absent or partial).
 *   - `phase: "ready"`   atomically replaces it once codex bootstrap completes
 *     (full proxyUrl/ports/build present).
 * The explicit phase turns "pid present but status missing" from a guess
 * ("just started? crashed last time?") into a declared state.
 *
 * BACKWARD COMPATIBILITY (one version cycle): the daemon ALSO keeps writing the
 * legacy `daemon.pid` + `status.json` (so an older reader still works), and all
 * readers PREFER `daemon.json`, falling back to synthesizing an equivalent
 * record from the legacy files when `daemon.json` is absent (so a NEW reader
 * still understands an OLD daemon that only wrote the legacy pair).
 *
 * This module is the single source of truth for the schema, the atomic writer,
 * and the read-with-fallback. It is pure/IO-injectable so it can be unit-tested
 * across the three states (legacy-only / daemon.json-only / both present).
 */

import { readFileSync } from "node:fs";
import { atomicWriteJson } from "./atomic-json";
import type { AgentBridgeBuildInfo } from "./build-info";
import type { TurnPhase } from "./control-protocol";

/** Lifecycle phase of the daemon's disk record. */
export type DaemonRecordPhase = "booting" | "ready";

/** Port triple the daemon owns, mirrored for kill-side port recovery. */
export interface DaemonRecordPorts {
  appPort?: number;
  proxyPort?: number;
  controlPort?: number;
}

/**
 * The unified daemon.json schema. Fields are deliberately optional where the
 * legacy fallback (or the booting phase) cannot supply them, so a synthesized
 * record from `daemon.pid` + `status.json` and a real `daemon.json` are the
 * same shape and every reader takes one code path.
 */
export interface DaemonRecord {
  /** Always present — the daemon's process pid (the liveness anchor). */
  pid: number;
  /** Lifecycle phase. Synthesized legacy records use "ready" iff status.json existed (see below). */
  phase: DaemonRecordPhase;
  /** Epoch ms the record was first written (booting). Absent for synthesized legacy records. */
  startedAt?: number;
  /**
   * Per-start random identity nonce. Lets a launcher confirm "this is the exact
   * process I registered" more strongly than a ps regex (the daemon can echo it
   * on /healthz). Absent for synthesized legacy records (old daemons had none).
   */
  nonce?: string;
  /** Multi-pair identity; null/undefined in legacy/manual single-pair mode. */
  pairId?: string | null;
  cwd?: string | null;
  stateDir?: string | null;
  /** Codex proxy WS URL the TUI attaches to (the kill-side orphan scan matches it). */
  proxyUrl?: string;
  appServerUrl?: string;
  ports?: DaemonRecordPorts;
  build?: AgentBridgeBuildInfo;
  /** Turn lifecycle phase mirror (kept in step with /healthz). */
  turnPhase?: TurnPhase;
  /** COMPAT mapping turnPhase ∈ {running,stalled}; read by the TUI-exit classifier. */
  turnInProgress?: boolean;
  attentionWindowActive?: boolean;
}

export type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, "utf-8");

/** Atomically write the unified daemon.json (tmp + rename). */
export function writeDaemonRecord(path: string, record: DaemonRecord): void {
  atomicWriteJson(path, record);
}

/**
 * Read the unified daemon.json. Returns the parsed record only when it is a
 * well-formed object with a finite numeric pid; otherwise null (a partially
 * written / corrupt file must NOT masquerade as a live record).
 */
export function readDaemonRecord(path: string, read: ReadFile = defaultRead): DaemonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== "number" || !Number.isFinite(obj.pid)) return null;
  const phase: DaemonRecordPhase = obj.phase === "ready" ? "ready" : "booting";
  return { ...(obj as unknown as DaemonRecord), pid: obj.pid, phase };
}

/**
 * Synthesize a DaemonRecord from the LEGACY `daemon.pid` + `status.json` pair,
 * for backward-compat reads of an old daemon that never wrote `daemon.json`.
 *
 * Liveness anchor (the pid) is taken from `daemon.pid` first, then from
 * `status.json`'s pid — the SAME union the legacy `pairDirDaemonAlive` took, so
 * a daemon that wrote either file is still seen as alive. Returns null only when
 * NEITHER file yields a finite pid.
 *
 * `phase` is synthesized as "ready" when status.json was present and parseable
 * (the old daemon only wrote status.json after bootstrap), else "booting" (pid
 * file alone = started-but-not-bootstrapped, the same meaning the new booting
 * phase carries).
 */
export function synthesizeLegacyRecord(
  pidFilePath: string,
  statusFilePath: string,
  read: ReadFile = defaultRead,
): DaemonRecord | null {
  let pidFromPidFile: number | null = null;
  try {
    const raw = read(pidFilePath).trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) pidFromPidFile = n;
  } catch {
    // no/unreadable daemon.pid
  }

  let status: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(read(statusFilePath));
    if (typeof parsed === "object" && parsed !== null) status = parsed as Record<string, unknown>;
  } catch {
    // no/unparseable status.json
  }

  const pidFromStatus =
    status && typeof status.pid === "number" && Number.isFinite(status.pid) ? status.pid : null;

  const pid = pidFromPidFile ?? pidFromStatus;
  if (pid === null) return null;

  const record: DaemonRecord = {
    pid,
    // status.json only ever existed post-bootstrap; its presence means "ready".
    phase: status ? "ready" : "booting",
  };
  if (status) {
    if (typeof status.proxyUrl === "string") record.proxyUrl = status.proxyUrl;
    if (typeof status.appServerUrl === "string") record.appServerUrl = status.appServerUrl;
    const controlPort = typeof status.controlPort === "number" ? status.controlPort : undefined;
    const proxyPort = portFromUrl(status.proxyUrl);
    const appPort = portFromUrl(status.appServerUrl);
    if (controlPort !== undefined || proxyPort !== undefined || appPort !== undefined) {
      record.ports = {};
      if (appPort !== undefined) record.ports.appPort = appPort;
      if (proxyPort !== undefined) record.ports.proxyPort = proxyPort;
      if (controlPort !== undefined) record.ports.controlPort = controlPort;
    }
    if (status.pairId === null || typeof status.pairId === "string") record.pairId = status.pairId;
    if (status.cwd === null || typeof status.cwd === "string") record.cwd = status.cwd;
    if (status.stateDir === null || typeof status.stateDir === "string") record.stateDir = status.stateDir;
    if (typeof status.build === "object" && status.build !== null) {
      record.build = status.build as AgentBridgeBuildInfo;
    }
    if (typeof status.turnPhase === "string") record.turnPhase = status.turnPhase as TurnPhase;
    if (typeof status.turnInProgress === "boolean") record.turnInProgress = status.turnInProgress;
    if (typeof status.attentionWindowActive === "boolean") {
      record.attentionWindowActive = status.attentionWindowActive;
    }
  }
  return record;
}

/**
 * Read the daemon's disk identity from the UNIFIED source, preferring
 * `daemon.json` and falling back to the legacy `daemon.pid` + `status.json`
 * pair. The single entry point every consumer should use.
 */
export function readUnifiedDaemonRecord(
  paths: { daemonRecordFile: string; pidFile: string; statusFile: string },
  read: ReadFile = defaultRead,
): DaemonRecord | null {
  return (
    readDaemonRecord(paths.daemonRecordFile, read) ??
    synthesizeLegacyRecord(paths.pidFile, paths.statusFile, read)
  );
}

/** Parse a `:PORT` out of a ws/http URL. Shared so kill-side recovery agrees. */
export function portFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(/:(\d+)(?:[/?]|$)/);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}
