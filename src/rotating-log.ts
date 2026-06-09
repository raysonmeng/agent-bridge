import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

export function appendRotatingLog(
  path: string,
  content: string,
  options: { maxBytes?: number; keep?: number } = {},
): void {
  const maxBytes = options.maxBytes ?? positiveIntFromEnv("AGENTBRIDGE_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
  const keep = options.keep ?? positiveIntFromEnv("AGENTBRIDGE_LOG_ROTATE_KEEP", DEFAULT_KEEP);
  // Logging must NEVER recreate a deleted directory: every process owning a
  // pair calls stateDir.ensure() at startup, so a missing parent here means
  // the pair was removed (abg pairs rm / prune) while this process survived.
  // The old unconditional mkdir resurrected removed pair dirs as unregistered
  // orphans on every log line. Best-effort logging drops the line instead.
  if (!existsSync(dirname(path))) return;
  rotateIfNeeded(path, Buffer.byteLength(content), maxBytes, keep);
  appendFileSync(path, content, "utf-8");
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function rotateIfNeeded(path: string, incomingBytes: number, maxBytes: number, keep: number): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || keep <= 0) return;
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size + incomingBytes <= maxBytes) return;

  for (let index = keep; index >= 1; index--) {
    const current = `${path}.${index}`;
    const next = `${path}.${index + 1}`;
    if (!existsSync(current)) continue;
    if (index === keep) {
      unlinkSync(current);
    } else {
      renameSync(current, next);
    }
  }
  renameSync(path, `${path}.1`);
}
