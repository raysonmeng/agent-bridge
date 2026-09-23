import { derivePairId } from "./pair-registry";
import { posix as posixPath, win32 as win32Path } from "node:path";

export type EnvGuardMode = "off" | "warn" | "fix" | "strict";

export interface EnvGuardInspection {
  ok: boolean;
  expectedPairId: string | null;
  actualPairId: string | null;
  pairName: string | null;
  reasons: string[];
}

export interface EnvGuardResult extends EnvGuardInspection {
  action: "none" | "warned" | "fixed" | "strict_failed";
}

const GENERATED_ENV_KEYS = [
  "AGENTBRIDGE_BASE_DIR",
  "AGENTBRIDGE_PAIR_ID",
  "AGENTBRIDGE_PAIR_NAME",
  "AGENTBRIDGE_STATE_DIR",
  "AGENTBRIDGE_CONTROL_PORT",
  "AGENTBRIDGE_MODE",
  "AGENTBRIDGE_FILTER_MODE",
  "AGENTBRIDGE_MAX_BUFFERED_MESSAGES",
  "AGENTBRIDGE_CODEX_TRANSPORT",
  "CODEX_WS_PORT",
  "CODEX_PROXY_PORT",
] as const;

export function normalizeEnvGuardMode(raw: string | undefined, fallback: EnvGuardMode = "fix"): EnvGuardMode {
  if (raw === "off" || raw === "warn" || raw === "fix" || raw === "strict") return raw;
  return fallback;
}

export function inspectAgentBridgeEnv(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): EnvGuardInspection {
  const env = opts.env ?? process.env;
  const actualPairId = nonEmpty(env.AGENTBRIDGE_PAIR_ID);
  const pairName = nonEmpty(env.AGENTBRIDGE_PAIR_NAME) ?? "main";
  const stateDir = nonEmpty(env.AGENTBRIDGE_STATE_DIR);
  const baseDir = nonEmpty(env.AGENTBRIDGE_BASE_DIR);
  const manualOptIn = env.AGENTBRIDGE_MANUAL === "1";
  const manualRuntimeEnv =
    !!stateDir ||
    !!nonEmpty(env.AGENTBRIDGE_CONTROL_PORT) ||
    !!nonEmpty(env.CODEX_WS_PORT) ||
    !!nonEmpty(env.CODEX_PROXY_PORT);
  const expectedPairId = actualPairId ? derivePairId(opts.cwd, pairName) : null;
  const reasons: string[] = [];

  if (!actualPairId && manualRuntimeEnv && !manualOptIn) {
    reasons.push("AgentBridge runtime env is set without AGENTBRIDGE_PAIR_ID or AGENTBRIDGE_MANUAL=1");
  }

  if (actualPairId && expectedPairId && actualPairId !== expectedPairId) {
    reasons.push(`AGENTBRIDGE_PAIR_ID=${actualPairId} does not match cwd-derived ${expectedPairId}`);
  }

  if (actualPairId && stateDir && !stateDirMatchesPair(stateDir, actualPairId)) {
    reasons.push(`AGENTBRIDGE_STATE_DIR does not end with /pairs/${actualPairId}`);
  }

  if (actualPairId && baseDir && stateDir && !isPathWithin(stateDir, baseDir)) {
    reasons.push("AGENTBRIDGE_BASE_DIR and AGENTBRIDGE_STATE_DIR disagree");
  }

  return {
    ok: reasons.length === 0,
    expectedPairId,
    actualPairId,
    pairName,
    reasons,
  };
}

export function guardAgentBridgeEnv(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  mode?: EnvGuardMode;
  allowStrict?: boolean;
  log?: (message: string) => void;
}): EnvGuardResult {
  const env = opts.env ?? process.env;
  const mode = normalizeEnvGuardMode(opts.mode, "fix");
  const effectiveMode = mode === "strict" && opts.allowStrict === false ? "fix" : mode;
  const inspection = inspectAgentBridgeEnv({ cwd: opts.cwd, env });

  if (effectiveMode === "off" || inspection.ok) {
    return { ...inspection, action: "none" };
  }

  const message =
    `stale AgentBridge environment detected for ${opts.cwd}: ${inspection.reasons.join("; ")}`;

  if (effectiveMode === "strict") {
    throw new Error(message);
  }

  opts.log?.(`[agentbridge] ${message}`);

  if (effectiveMode === "warn") {
    return { ...inspection, action: "warned" };
  }

  for (const key of GENERATED_ENV_KEYS) {
    delete env[key];
  }
  opts.log?.("[agentbridge] cleared stale AgentBridge environment variables");
  return { ...inspection, action: "fixed" };
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

/** Normalize paths independently of the host OS so Windows paths can be checked in tests on POSIX too. */
function normalizePathForComparison(value: string): { path: string; windows: boolean } {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  const normalized = windows
    ? win32Path.normalize(value).replaceAll("\\", "/")
    : posixPath.normalize(value);
  return { path: windows ? normalized.toLowerCase() : normalized, windows };
}

function stateDirMatchesPair(stateDir: string, pairId: string): boolean {
  const normalizedPath = normalizePathForComparison(stateDir);
  const normalized = normalizedPath.path.replace(/\/+$/, "");
  const normalizedPairId = normalizedPath.windows ? pairId.toLowerCase() : pairId;
  return normalized.endsWith(`/pairs/${normalizedPairId}`);
}

function isPathWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedParent = normalizePathForComparison(parent);
  if (normalizedCandidate.windows !== normalizedParent.windows) return false;

  const parentPath = normalizedParent.path.replace(/\/+$/, "");
  const prefix = parentPath === "" ? "/" : `${parentPath}/`;
  return normalizedCandidate.path.startsWith(prefix);
}
