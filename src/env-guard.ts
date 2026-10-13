import { derivePairId } from "./pair-registry";

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
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
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

  // Compare on a separator-normalised form: on win32 `applyPairEnv` writes
  // `C:\...\pairs\<id>`, and a literal "/" check flagged every healthy pair env
  // as stale, so `fix` mode wiped it and the plugin frontend fell back to the
  // default control port (a different daemon than `abg codex` attached to).
  const normStateDir = stateDir ? normalizeEnvPath(stateDir, opts.platform) : null;
  const normBaseDir = baseDir ? normalizeEnvPath(baseDir, opts.platform) : null;

  if (actualPairId && normStateDir && !normStateDir.endsWith(normalizeEnvPath(`/pairs/${actualPairId}`, opts.platform))) {
    reasons.push(`AGENTBRIDGE_STATE_DIR does not end with /pairs/${actualPairId}`);
  }

  if (actualPairId && normBaseDir && normStateDir && !normStateDir.startsWith(`${normBaseDir}/`)) {
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
  platform?: NodeJS.Platform;
}): EnvGuardResult {
  const env = opts.env ?? process.env;
  const mode = normalizeEnvGuardMode(opts.mode, "fix");
  const effectiveMode = mode === "strict" && opts.allowStrict === false ? "fix" : mode;
  const inspection = inspectAgentBridgeEnv({ cwd: opts.cwd, env, platform: opts.platform });

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

/**
 * Path form used only for the guard's prefix/suffix checks: "/" separators, no
 * trailing separator, and case-folded on win32 (NTFS paths are case-insensitive,
 * so `c:\x` and `C:\X` name the same dir). POSIX keeps exact case.
 */
export function normalizeEnvPath(value: string, platform: NodeJS.Platform = process.platform): string {
  let out = value.replace(/\\/g, "/");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return platform === "win32" ? out.toLowerCase() : out;
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}
