import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Trace files older than this (by mtime) are pruned when a new day's file is created. */
export const TRACE_RETENTION_DAYS = 7;
const TRACE_FILE_RE = /^trace-\d{4}-\d{2}-\d{2}\.jsonl$/;

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|auth|cookie|session)/i;
const SECRET_ARG_RE = /^--?(?:token|secret|password|passwd|apikey|api-key|api_key|auth|cookie|session)(?:=.*)?$/i;

/** Only these env-key prefixes are eligible to appear in a trace event. */
const RELEVANT_ENV_RE = /^(AGENTBRIDGE_|CODEX_)/;

export interface TraceEventInput {
  cwd: string;
  event: string;
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export function redactEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string | undefined> {
  const redacted: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SECRET_KEY_RE.test(key) && value !== undefined ? "<redacted>" : value;
  }
  return redacted;
}

/**
 * Allowlist an env snapshot down to AgentBridge/Codex-owned keys, then redact.
 *
 * A full `process.env` must never be written to a trace file — it commonly
 * holds `DATABASE_URL`, `*_DSN`, cloud credentials, etc. that no AgentBridge
 * diagnostic needs. Keep only `AGENTBRIDGE_*` / `CODEX_*` keys, and still run
 * those through secret redaction (e.g. a hypothetical `CODEX_API_KEY`).
 */
export function pickRelevantEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!RELEVANT_ENV_RE.test(key)) continue;
    picked[key] = SECRET_KEY_RE.test(key) && value !== undefined ? "<redacted>" : value;
  }
  return picked;
}

export function redactArgv(argv: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of argv) {
    if (redactNext) {
      redacted.push("<redacted>");
      redactNext = false;
      continue;
    }
    if (SECRET_ARG_RE.test(arg)) {
      if (arg.includes("=")) {
        const [key] = arg.split("=", 1);
        redacted.push(`${key}=<redacted>`);
      } else {
        redacted.push(arg);
        redactNext = true;
      }
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

export function traceLogPath(cwd: string, timestamp: string): string {
  const day = timestamp.slice(0, 10);
  return join(cwd, ".agentbridge", "logs", `trace-${day}.jsonl`);
}

export function appendTraceEvent(input: TraceEventInput): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const path = traceLogPath(input.cwd, timestamp);
  const event = {
    timestamp,
    event: input.event,
    cwd: input.cwd,
    pid: input.pid ?? process.pid,
    ...(input.argv ? { argv: redactArgv(input.argv) } : {}),
    ...(input.env ? { env: pickRelevantEnv(input.env) } : {}),
    ...(input.data ? { data: redactData(input.data) } : {}),
  };

  const logsDir = join(input.cwd, ".agentbridge", "logs");
  // Built-in retention: trace-<day>.jsonl files have no maxBytes and accumulate
  // one per day forever. We prune only when a NEW day's file is about to be
  // created (a cheap, self-limiting trigger that runs at most once per UTC day
  // per process), deleting same-dir trace files whose mtime predates the
  // retention window. `now` is derived from the event timestamp so callers can
  // drive deterministic tests.
  const isNewDayFile = !existsSync(path);
  mkdirSync(logsDir, { recursive: true });
  if (isNewDayFile) {
    pruneOldTraceLogs(logsDir, path, Date.parse(timestamp));
  }
  appendFileSync(path, JSON.stringify(event) + "\n", "utf-8");
  return path;
}

/**
 * Delete trace-*.jsonl files in `logsDir` whose mtime is older than
 * TRACE_RETENTION_DAYS relative to `nowMs`. Best-effort: never throws (it runs
 * inside the best-effort logging path). The just-created file (`keepPath`) and
 * any non-trace file are always left untouched.
 */
function pruneOldTraceLogs(logsDir: string, keepPath: string, nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  const cutoff = nowMs - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!TRACE_FILE_RE.test(name)) continue;
    const filePath = join(logsDir, name);
    if (filePath === keepPath) continue;
    try {
      if (statSync(filePath).mtimeMs < cutoff) {
        unlinkSync(filePath);
      }
    } catch {
      // A peer process may have removed it first, or stat raced — ignore.
    }
  }
}

/** A `data` field that is an env snapshot (key ends in "env", value is a plain object). */
function isEnvSnapshot(key: string, value: unknown): boolean {
  return /env$/i.test(key) && !!value && typeof value === "object" && !Array.isArray(value);
}

function redactData(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return SECRET_KEY_RE.test(key) ? "<redacted>" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactData(item, key));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(childKey)) {
        redacted[childKey] = "<redacted>";
      } else if (isEnvSnapshot(childKey, childValue)) {
        // A nested env snapshot (env / originalEnv / effectiveEnv) must be
        // allowlisted, never written in full — `redactData`'s key-name redaction
        // alone would pass DATABASE_URL/*_DSN through verbatim.
        redacted[childKey] = pickRelevantEnv(childValue as Record<string, string | undefined>);
      } else {
        redacted[childKey] = redactData(childValue, childKey);
      }
    }
    return redacted;
  }
  return value;
}
