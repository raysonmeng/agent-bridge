import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/**
 * The subset of node:fs the rotation path touches, behind an injectable seam.
 *
 * Production code always uses {@link REAL_FS_OPS} (the real node:fs functions).
 * The seam exists ONLY so tests can deterministically inject the ENOENT that a
 * concurrent cross-process writer would produce mid-rotation — a static ESM
 * `import { renameSync }` binding cannot be monkey-patched after load, so a
 * test reassigning `fs.renameSync` would never reach this code and would
 * silently validate nothing. Default = real fs ⇒ no behavioral change.
 */
export interface FsOps {
  statSync: typeof statSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  appendFileSync: typeof appendFileSync;
  existsSync: typeof existsSync;
}

const REAL_FS_OPS: FsOps = { statSync, renameSync, unlinkSync, appendFileSync, existsSync };

export function appendRotatingLog(
  path: string,
  content: string,
  options: { maxBytes?: number; keep?: number } = {},
  fsOps: FsOps = REAL_FS_OPS,
): void {
  const maxBytes = options.maxBytes ?? positiveIntFromEnv("AGENTBRIDGE_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
  const keep = options.keep ?? positiveIntFromEnv("AGENTBRIDGE_LOG_ROTATE_KEEP", DEFAULT_KEEP);
  // Logging must NEVER recreate a deleted directory: every process owning a
  // pair calls stateDir.ensure() at startup, so a missing parent here means
  // the pair was removed (abg pairs rm / prune) while this process survived.
  // The old unconditional mkdir resurrected removed pair dirs as unregistered
  // orphans on every log line. Best-effort logging drops the line instead.
  if (!fsOps.existsSync(dirname(path))) return;
  // Crash-safe rotation race handling:
  // The SAME agentbridge.log is appended by TWO cross-process writers (the
  // daemon process and the foreground bridge process). Single-writer rotation
  // is not safe here because the daemon does not own the file's growth — a
  // foreground burst can blow past maxBytes between daemon writes. So instead
  // we make the rotation ACTION race-tolerant: every step ignores ENOENT (the
  // peer already moved that file), so a concurrent rotation can neither throw
  // out of the append path nor skip/over-unlink a generation. No retry is
  // needed: even if a peer rotated `path` away mid-flight, the appendFileSync
  // below recreates it, so no log line is ever lost.
  rotateIfNeeded(path, Buffer.byteLength(content), maxBytes, keep, fsOps);
  fsOps.appendFileSync(path, content, "utf-8");
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isEnoent(error: unknown): boolean {
  return !!error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** rename that treats a vanished source as a benign no-op (peer already moved it). */
function renameIfPresent(from: string, to: string, fsOps: FsOps): void {
  try {
    fsOps.renameSync(from, to);
  } catch (error) {
    // A concurrent writer rotated `from` out from under us. The generation it
    // represents has already advanced; silently skipping keeps the cascade
    // crash-safe without over-unlinking or throwing.
    if (!isEnoent(error)) throw error;
  }
}

/** unlink that treats a vanished target as a benign no-op (peer already removed it). */
function unlinkIfPresent(path: string, fsOps: FsOps): void {
  try {
    fsOps.unlinkSync(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function rotateIfNeeded(
  path: string,
  incomingBytes: number,
  maxBytes: number,
  keep: number,
  fsOps: FsOps,
): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || keep <= 0) return;

  let size: number;
  try {
    size = fsOps.statSync(path).size;
  } catch (error) {
    // No current log yet (or a peer just rotated it away): nothing to rotate.
    if (isEnoent(error)) return;
    throw error;
  }
  if (size + incomingBytes <= maxBytes) return;

  for (let index = keep; index >= 1; index--) {
    const current = `${path}.${index}`;
    const next = `${path}.${index + 1}`;
    if (index === keep) {
      unlinkIfPresent(current, fsOps);
    } else {
      renameIfPresent(current, next, fsOps);
    }
  }
  // The head rename is the one that races hardest: two writers can both decide
  // to rotate, and only the first `path -> path.1` wins. If our rename finds
  // the head already gone (peer rotated it), that is success, not a lost line —
  // the append below recreates `path` fresh.
  renameIfPresent(path, `${path}.1`, fsOps);
}
