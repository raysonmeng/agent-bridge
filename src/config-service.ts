import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import type { AllocationConfig, BudgetConfig, CodexTierMap, CodexTurnOverrides, MaximizeConfig } from "./budget/types";

/** Machine-readable project config schema. */
export interface AgentBridgeConfig {
  version: string;
  codex: {
    appPort: number;
    proxyPort: number;
  };
  turnCoordination: {
    attentionWindowSeconds: number;
  };
  idleShutdownSeconds: number;
  budget: BudgetConfig;
}

const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  enabled: true,
  pollSeconds: 300,
  // v3.2: pauseAt/resumeBelow are the no-burn-data FALLBACK line (the dynamic
  // line is primary). pauseAt also floors the dynamic line (I1). Kept well below
  // the outer quota-guard hard line (99) so the bridge pauses first and leaves
  // wrap-up headroom; the guard 99 is the last-resort fuse.
  pauseAt: 90,
  resumeBelow: 30,
  syncDriftPct: 10,
  parallel: {
    minRemainingPct: 60,
    timeWindowSec: 3600,
  },
  codexTierControl: false,
  codexTiers: {
    // `full` is the explicit restore point for sticky turn/start overrides; tier
    // control only activates when the user configures it (see normalize below).
    full: null,
    balanced: { effort: "medium" },
    eco: { effort: "low" },
  },
  // v3.2: pauseAt(90)/resumeBelow(30) above are now the FALLBACK gateUtil line
  // (only used when per-window burn data is unavailable). The time-aware dynamic
  // line below is the sole, always-on strategy — the conserve|maximize selector
  // is gone. Burn-rate data is consumed from the guard probe.
  maximize: {
    // Reset-point target (asymptote). 98 leaves ~2% for provider metering jitter;
    // the bridge paces toward it, the outer guard hard line (99) is the last fuse.
    targetUtil: 98,
    reserveSlopePctPerHour: 0.4,
    reserveMaxPct: 7,
    finishingHorizonMinutes: 30,
    resumeHysteresisPct: 5,
    // v3 P3 (§3.2): admission gate. admissionAt is the 5h-util finishing line
    // (well below targetUtil so new tasks stop before the pace line); wrapUpQuota
    // bounds the wrap-up turns let through per 5h window.
    admissionAt: 85,
    wrapUpQuota: 2,
  },
  // v3 P4 (§3.4): runway-difference balance double gate. A balance directive
  // fires only when the shorter/longer runway ratio is below minRunwayRatio AND
  // the gap is at least minRunwayGapHours — keeps the criterion from being
  // over-sensitive (Codex acceptance). Advisory-only.
  allocation: {
    minRunwayRatio: 50,
    minRunwayGapHours: 2,
  },
};

const DEFAULT_CONFIG: AgentBridgeConfig = {
  version: "1.0",
  codex: {
    appPort: 4500,
    proxyPort: 4501,
  },
  turnCoordination: {
    attentionWindowSeconds: 15,
  },
  idleShutdownSeconds: 30,
  budget: DEFAULT_BUDGET_CONFIG,
};

const CONFIG_DIR = ".agentbridge";
const CONFIG_FILE = "config.json";

/**
 * Discriminated result of {@link ConfigService.load}. Distinguishes the three
 * states that the old `AgentBridgeConfig | null` conflated:
 *  - `parsed`  — a valid config was read and normalized.
 *  - `absent`  — the file does not exist (ENOENT); the normal, non-error case.
 *  - `corrupt` — the file exists but is unparseable JSON or shape-invalid; the
 *                caller falls back to defaults but MUST surface a warning, since
 *                the user's custom thresholds are silently NOT in effect.
 */
export type ConfigLoadResult =
  | { state: "parsed"; config: AgentBridgeConfig }
  | { state: "absent" }
  | { state: "corrupt"; reason: string };

/** Diagnostic summary of config parseability, surfaced by `abg doctor`. */
export interface ConfigDescription {
  state: ConfigLoadResult["state"];
  /** Resolved path to the config file (whether or not it exists). */
  path: string;
  /** True only when a parsed config sets a decision-grade value away from defaults. */
  customValues: boolean;
  /** Present only when state is "corrupt". */
  reason?: string;
}

/**
 * Minimal logger surface threaded through {@link ConfigService.loadOrDefault}
 * so daemon/CLI can surface a corrupt-config warning in their own channel
 * (daemon: processLogger; CLI: stderr). A no-op default keeps existing call
 * sites working unchanged.
 */
export type ConfigWarnLogger = (message: string) => void;

const NOOP_LOGGER: ConfigWarnLogger = () => {};

interface LegacyAgentBridgeConfig {
  version?: unknown;
  daemon?: {
    port?: unknown;
    proxyPort?: unknown;
  };
  codex?: {
    appPort?: unknown;
    proxyPort?: unknown;
  };
  turnCoordination?: {
    attentionWindowSeconds?: unknown;
  };
  idleShutdownSeconds?: unknown;
  budget?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a value is a finite number OR a string that parses to one. Mirrors
 * `normalizeInteger`'s coercion so the shape check accepts exactly the inputs
 * normalize accepts (env-style string-numbers, out-of-range numbers) — a value
 * is "shape invalid" only when it is genuinely uncoercible (e.g. "ninety").
 */
function isCoercibleNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return Number.isFinite(Number(value));
  return false;
}

/**
 * Decision-grade fields whose PRESENCE-with-garbage must fail loud (config is
 * "shape invalid"), instead of silently reverting to defaults. We only flag a
 * field that is PRESENT but uncoercible: an ABSENT field is a legacy/partial
 * config and is normalized to defaults as before. Scope is deliberately the
 * numeric thresholds the P1 proposal calls out (budget thresholds, idle
 * shutdown) — booleans and tier-override sub-objects keep their lenient
 * normalize-to-default behavior so a typo in those is not startup-affecting.
 *
 * Returns a human-readable reason string when invalid, else null.
 */
function findShapeViolation(raw: Record<string, unknown>): string | null {
  if ("idleShutdownSeconds" in raw && !isCoercibleNumber(raw.idleShutdownSeconds)) {
    return "idleShutdownSeconds is present but not a number";
  }
  if ("budget" in raw) {
    const budget = raw.budget;
    if (!isRecord(budget)) {
      return "budget is present but not an object";
    }
    const numericKeys = ["pauseAt", "resumeBelow", "pollSeconds", "syncDriftPct"] as const;
    for (const key of numericKeys) {
      if (key in budget && !isCoercibleNumber(budget[key])) {
        return `budget.${key} is present but not a number`;
      }
    }
    if ("parallel" in budget) {
      const parallel = budget.parallel;
      if (!isRecord(parallel)) {
        return "budget.parallel is present but not an object";
      }
      for (const key of ["minRemainingPct", "timeWindowSec"] as const) {
        if (key in parallel && !isCoercibleNumber(parallel[key])) {
          return `budget.parallel.${key} is present but not a number`;
        }
      }
    }
    if ("maximize" in budget) {
      const maximize = budget.maximize;
      if (!isRecord(maximize)) {
        return "budget.maximize is present but not an object";
      }
      // Symmetric to budget.parallel: a present-but-garbage maximize numeric
      // (e.g. targetUtil:"ninety") fails loud instead of silently reverting to
      // the design default, matching the other decision-grade thresholds.
      for (const key of [
        "targetUtil",
        "reserveSlopePctPerHour",
        "reserveMaxPct",
        "finishingHorizonMinutes",
        "resumeHysteresisPct",
        "admissionAt",
        "wrapUpQuota",
      ] as const) {
        if (key in maximize && !isCoercibleNumber(maximize[key])) {
          return `budget.maximize.${key} is present but not a number`;
        }
      }
    }
    if ("allocation" in budget) {
      const allocation = budget.allocation;
      if (!isRecord(allocation)) {
        return "budget.allocation is present but not an object";
      }
      // Symmetric to budget.maximize: decision-grade numerics fail loud on garbage.
      for (const key of ["minRunwayRatio", "minRunwayGapHours"] as const) {
        if (key in allocation && !isCoercibleNumber(allocation[key])) {
          return `budget.allocation.${key} is present but not a number`;
        }
      }
    }
  }
  return null;
}

/**
 * True when a parsed config sets any decision-grade field away from the
 * defaults. Used only for the doctor diagnostic — lets the user confirm their
 * custom thresholds are actually live (vs. a config that exists but matches
 * defaults, in which case "custom values" is honestly false).
 */
function hasCustomDecisionValues(config: AgentBridgeConfig): boolean {
  const d = DEFAULT_CONFIG;
  const b = config.budget;
  const db = d.budget;
  return (
    config.idleShutdownSeconds !== d.idleShutdownSeconds ||
    config.turnCoordination.attentionWindowSeconds !== d.turnCoordination.attentionWindowSeconds ||
    config.codex.appPort !== d.codex.appPort ||
    config.codex.proxyPort !== d.codex.proxyPort ||
    b.enabled !== db.enabled ||
    b.pollSeconds !== db.pollSeconds ||
    b.pauseAt !== db.pauseAt ||
    b.resumeBelow !== db.resumeBelow ||
    b.syncDriftPct !== db.syncDriftPct ||
    b.parallel.minRemainingPct !== db.parallel.minRemainingPct ||
    b.parallel.timeWindowSec !== db.parallel.timeWindowSec ||
    b.codexTierControl !== db.codexTierControl ||
    // v3.2: dynamic-line (maximize) parameters are decision-grade — surface them
    // so `abg doctor` reports "custom values in effect" when the user tunes the
    // line, not a misleading "all values match defaults".
    b.maximize.targetUtil !== db.maximize.targetUtil ||
    b.maximize.reserveSlopePctPerHour !== db.maximize.reserveSlopePctPerHour ||
    b.maximize.reserveMaxPct !== db.maximize.reserveMaxPct ||
    b.maximize.finishingHorizonMinutes !== db.maximize.finishingHorizonMinutes ||
    b.maximize.resumeHysteresisPct !== db.maximize.resumeHysteresisPct ||
    // v3 P3: admission gate parameters are decision-grade (they gate new-turn
    // admission), so a tuned value should report as "custom values in effect".
    b.maximize.admissionAt !== db.maximize.admissionAt ||
    b.maximize.wrapUpQuota !== db.maximize.wrapUpQuota ||
    // v3 P4: allocation thresholds are decision-grade (they gate the balance
    // directive), so a tuned value should report as "custom values in effect".
    b.allocation.minRunwayRatio !== db.allocation.minRunwayRatio ||
    b.allocation.minRunwayGapHours !== db.allocation.minRunwayGapHours
  );
}

function normalizeInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Like normalizeInteger but rejects values outside [min, max] (falls back to default). */
function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = normalizeInteger(value, fallback);
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Bounded validation for FRACTIONAL config parameters (v3 Q6 consensus:
 * upcoming keys like reserveSlopePctPerHour are decimals, so the ×10-integer
 * hack is rejected in favor of first-class number support). Signature mirrors
 * {@link normalizeBoundedInteger}; unlike normalizeInteger's coercion, an
 * empty/whitespace string falls back instead of coercing to 0.
 */
export function normalizeBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value);
  } else {
    return fallback;
  }
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Normalize the v3 maximize parameter block. Each field is bounds-checked
 * (out-of-range → fallback). Two relation constraints reset the WHOLE block to
 * defaults when violated (§4.1): `targetUtil > pauseAt` (the dynamic line floor
 * is pauseAt, so a target at/below it leaves no maximize band) and `admissionAt
 * < targetUtil` (P3 §3.2 — admission must fire BEFORE the pace target, else the
 * finishing gate is degenerate). Silent reset mirrors the existing
 * pauseAt<=resumeBelow handling in normalizeBudgetConfig (both keep normalize
 * pure / logger-free).
 */
function normalizeMaximizeConfig(
  raw: unknown,
  pauseAt: number,
  fallback: MaximizeConfig = DEFAULT_BUDGET_CONFIG.maximize,
): MaximizeConfig {
  const m = isRecord(raw) ? raw : {};
  const normalized: MaximizeConfig = {
    targetUtil: normalizeBoundedInteger(m.targetUtil, fallback.targetUtil, 90, 99),
    reserveSlopePctPerHour: normalizeBoundedNumber(
      m.reserveSlopePctPerHour,
      fallback.reserveSlopePctPerHour,
      0,
      5,
    ),
    reserveMaxPct: normalizeBoundedInteger(m.reserveMaxPct, fallback.reserveMaxPct, 0, 30),
    finishingHorizonMinutes: normalizeBoundedInteger(
      m.finishingHorizonMinutes,
      fallback.finishingHorizonMinutes,
      5,
      180,
    ),
    resumeHysteresisPct: normalizeBoundedInteger(
      m.resumeHysteresisPct,
      fallback.resumeHysteresisPct,
      1,
      30,
    ),
    admissionAt: normalizeBoundedInteger(m.admissionAt, fallback.admissionAt, 50, 99),
    // wrapUpQuota is a turn COUNT — floor a fractional input (normalizeBoundedInteger
    // accepts "1.5"); a non-integer cap would let consumeWrapUp admit ceil(quota) turns.
    wrapUpQuota: Math.floor(normalizeBoundedInteger(m.wrapUpQuota, fallback.wrapUpQuota, 0, 10)),
  };
  // Unsatisfiable relations → reset the whole block to the package defaults so a
  // typo cannot silently produce a maximize line that never pauses (or one that
  // collapses onto pauseAt for the wrong reason), nor an admission line at/above
  // the pace target (which would never fire its finishing protection in time).
  if (normalized.targetUtil <= pauseAt || normalized.admissionAt >= normalized.targetUtil) {
    return { ...DEFAULT_BUDGET_CONFIG.maximize };
  }
  return normalized;
}

/**
 * Normalize the v3 P4 allocation block. Both keys are integers, independently
 * bounds-checked (out-of-range → fallback); there is no cross-field relation to
 * enforce (unlike maximize's targetUtil > pauseAt), so no whole-block reset.
 */
function normalizeAllocationConfig(
  raw: unknown,
  fallback: AllocationConfig = DEFAULT_BUDGET_CONFIG.allocation,
): AllocationConfig {
  const a = isRecord(raw) ? raw : {};
  return {
    minRunwayRatio: normalizeBoundedInteger(a.minRunwayRatio, fallback.minRunwayRatio, 10, 100),
    minRunwayGapHours: normalizeBoundedInteger(a.minRunwayGapHours, fallback.minRunwayGapHours, 1, 168),
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  // Accept common env-var spellings ("1"/"0") alongside JSON-ish "true"/"false".
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

/** Normalize one tier override object: keep only non-empty string model/effort. */
function normalizeCodexOverride(raw: unknown): CodexTurnOverrides | null {
  if (!isRecord(raw)) return null;
  const override: CodexTurnOverrides = {};
  if (typeof raw.model === "string" && raw.model.trim() !== "") override.model = raw.model.trim();
  if (typeof raw.effort === "string" && raw.effort.trim() !== "") override.effort = raw.effort.trim();
  return Object.keys(override).length > 0 ? override : null;
}

function normalizeCodexTiers(
  raw: unknown,
  fallback: CodexTierMap = DEFAULT_BUDGET_CONFIG.codexTiers,
): CodexTierMap {
  const tiers = isRecord(raw) ? raw : {};
  return {
    full: normalizeCodexOverride(tiers.full),
    balanced:
      normalizeCodexOverride(tiers.balanced) ?? fallback.balanced,
    eco: normalizeCodexOverride(tiers.eco) ?? fallback.eco,
  };
}

/**
 * Normalize the budget section with boundary protection: out-of-range values
 * fall back to defaults, and an unsatisfiable pause lifecycle
 * (pauseAt <= resumeBelow) resets BOTH thresholds to defaults so the
 * coordinator can never enter a pause it cannot exit.
 *
 * Tier-control activation rule (single source of truth): `codexTierControl`
 * stays true ONLY when `codexTiers.full` is configured — sticky turn/start
 * overrides cannot be restored without an explicit restore point.
 */
function normalizeBudgetConfig(
  raw: unknown,
  fallback: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): BudgetConfig {
  const budget = isRecord(raw) ? raw : {};
  const parallel = isRecord(budget.parallel) ? budget.parallel : {};
  const codexTiers = normalizeCodexTiers(budget.codexTiers, fallback.codexTiers);

  let pauseAt = normalizeBoundedInteger(budget.pauseAt, fallback.pauseAt, 1, 100);
  let resumeBelow = normalizeBoundedInteger(
    budget.resumeBelow,
    fallback.resumeBelow,
    0,
    99,
  );
  if (pauseAt <= resumeBelow) {
    pauseAt = DEFAULT_BUDGET_CONFIG.pauseAt;
    resumeBelow = DEFAULT_BUDGET_CONFIG.resumeBelow;
  }

  return {
    enabled: normalizeBoolean(budget.enabled, fallback.enabled),
    pollSeconds: normalizeBoundedInteger(
      budget.pollSeconds,
      fallback.pollSeconds,
      5,
      3600,
    ),
    pauseAt,
    resumeBelow,
    syncDriftPct: normalizeBoundedInteger(
      budget.syncDriftPct,
      fallback.syncDriftPct,
      1,
      100,
    ),
    parallel: {
      minRemainingPct: normalizeBoundedInteger(
        parallel.minRemainingPct,
        fallback.parallel.minRemainingPct,
        1,
        100,
      ),
      timeWindowSec: normalizeBoundedInteger(
        parallel.timeWindowSec,
        fallback.parallel.timeWindowSec,
        60,
        604800,
      ),
    },
    codexTierControl:
      normalizeBoolean(budget.codexTierControl, fallback.codexTierControl) &&
      codexTiers.full !== null,
    codexTiers,
    // Pass the already-resolved pauseAt (post pauseAt<=resumeBelow reset) so the
    // targetUtil > pauseAt relation is checked against the effective floor.
    maximize: normalizeMaximizeConfig(budget.maximize, pauseAt, fallback.maximize),
    allocation: normalizeAllocationConfig(budget.allocation, fallback.allocation),
  };
}

/**
 * Overlay AGENTBRIDGE_BUDGET_* environment variables on a normalized budget
 * config (env wins; invalid env values are ignored via the same boundary rules).
 */
export function applyBudgetEnvOverrides(
  budget: BudgetConfig,
  env: Record<string, string | undefined> = process.env,
): BudgetConfig {
  const overlay: Record<string, unknown> = {
    enabled: env.AGENTBRIDGE_BUDGET_ENABLED ?? budget.enabled,
    pollSeconds: env.AGENTBRIDGE_BUDGET_POLL_SECONDS ?? budget.pollSeconds,
    pauseAt: env.AGENTBRIDGE_BUDGET_PAUSE_AT ?? budget.pauseAt,
    resumeBelow: env.AGENTBRIDGE_BUDGET_RESUME_BELOW ?? budget.resumeBelow,
    syncDriftPct: env.AGENTBRIDGE_BUDGET_SYNC_DRIFT_PCT ?? budget.syncDriftPct,
    parallel: {
      minRemainingPct:
        env.AGENTBRIDGE_BUDGET_PARALLEL_MIN_REMAINING_PCT ?? budget.parallel.minRemainingPct,
      timeWindowSec:
        env.AGENTBRIDGE_BUDGET_PARALLEL_TIME_WINDOW_SEC ?? budget.parallel.timeWindowSec,
    },
    codexTierControl: env.AGENTBRIDGE_BUDGET_CODEX_TIER_CONTROL ?? budget.codexTierControl,
    // Tier mapping is file-config only (nested structure doesn't fit env vars);
    // re-normalization re-applies the full-restore activation rule.
    codexTiers: budget.codexTiers,
    maximize: {
      targetUtil: env.AGENTBRIDGE_BUDGET_TARGET_UTIL ?? budget.maximize.targetUtil,
      reserveSlopePctPerHour:
        env.AGENTBRIDGE_BUDGET_RESERVE_SLOPE_PCT_PER_HOUR ?? budget.maximize.reserveSlopePctPerHour,
      reserveMaxPct: env.AGENTBRIDGE_BUDGET_RESERVE_MAX_PCT ?? budget.maximize.reserveMaxPct,
      finishingHorizonMinutes:
        env.AGENTBRIDGE_BUDGET_FINISHING_HORIZON_MINUTES ?? budget.maximize.finishingHorizonMinutes,
      resumeHysteresisPct:
        env.AGENTBRIDGE_BUDGET_RESUME_HYSTERESIS_PCT ?? budget.maximize.resumeHysteresisPct,
      admissionAt: env.AGENTBRIDGE_BUDGET_ADMISSION_AT ?? budget.maximize.admissionAt,
      wrapUpQuota: env.AGENTBRIDGE_BUDGET_WRAP_UP_QUOTA ?? budget.maximize.wrapUpQuota,
    },
    allocation: {
      minRunwayRatio:
        env.AGENTBRIDGE_BUDGET_MIN_RUNWAY_RATIO ?? budget.allocation.minRunwayRatio,
      minRunwayGapHours:
        env.AGENTBRIDGE_BUDGET_MIN_RUNWAY_GAP_HOURS ?? budget.allocation.minRunwayGapHours,
    },
  };
  return normalizeBudgetConfig(overlay, budget);
}

function normalizeConfig(raw: unknown): AgentBridgeConfig | null {
  if (!isRecord(raw)) return null;

  const config = raw as LegacyAgentBridgeConfig;
  const codex = isRecord(config.codex) ? config.codex : {};
  const daemon = isRecord(config.daemon) ? config.daemon : {};
  const turnCoordination = isRecord(config.turnCoordination) ? config.turnCoordination : {};

  return {
    version: typeof config.version === "string" ? config.version : DEFAULT_CONFIG.version,
    codex: {
      // Ports must be a valid TCP port (1..65535); a coercible negative/zero/
      // out-of-range value falls back to the default instead of passing through.
      appPort: normalizeBoundedInteger(
        codex.appPort ?? daemon.port,
        DEFAULT_CONFIG.codex.appPort,
        1,
        65535,
      ),
      proxyPort: normalizeBoundedInteger(
        codex.proxyPort ?? daemon.proxyPort,
        DEFAULT_CONFIG.codex.proxyPort,
        1,
        65535,
      ),
    },
    turnCoordination: {
      // 0 = no attention window is legitimate; negatives are not.
      attentionWindowSeconds: normalizeBoundedInteger(
        turnCoordination.attentionWindowSeconds,
        DEFAULT_CONFIG.turnCoordination.attentionWindowSeconds,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    // A negative idleShutdownSeconds becomes a negative *1000 ms timeout, which
    // setTimeout clamps to 0 → the daemon self-shuts ~immediately after boot,
    // before the Claude client attaches (即起即死). Floor at 1 second.
    idleShutdownSeconds: normalizeBoundedInteger(
      config.idleShutdownSeconds,
      DEFAULT_CONFIG.idleShutdownSeconds,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    budget: normalizeBudgetConfig(config.budget),
  };
}

export class ConfigService {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.cwd();
    this.configDir = join(root, CONFIG_DIR);
    this.configPath = join(this.configDir, CONFIG_FILE);
  }

  /** Check if project config exists. */
  hasConfig(): boolean {
    return existsSync(this.configPath);
  }

  /**
   * Load project config as a discriminated result distinguishing absence
   * (ENOENT, normal) from corruption (unparseable JSON or shape-invalid).
   * Unlike the old `null`-for-everything contract, a corrupt config is reported
   * as such so {@link loadOrDefault} can fail loud instead of silently
   * reverting the user's custom thresholds to defaults.
   */
  load(): ConfigLoadResult {
    let raw: string;
    try {
      raw = readFileSync(this.configPath, "utf-8");
    } catch (err) {
      // ENOENT is the normal "no project config" case; any other read error
      // (permissions, etc.) is reported as corrupt so it is not silently
      // mistaken for "absent" and masked behind defaults.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { state: "absent" };
      }
      return { state: "corrupt", reason: `config.json is unreadable: ${(err as Error).message}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        state: "corrupt",
        reason: `config.json is not valid JSON: ${(err as Error).message}`,
      };
    }

    if (!isRecord(parsed)) {
      return { state: "corrupt", reason: "config.json is not a JSON object" };
    }

    const violation = findShapeViolation(parsed);
    if (violation) {
      return { state: "corrupt", reason: `config.json is shape-invalid: ${violation}` };
    }

    const config = normalizeConfig(parsed);
    if (!config) {
      // Defensive: normalizeConfig only returns null for a non-record, already
      // handled above. Treat any residual null as corrupt rather than absent.
      return { state: "corrupt", reason: "config.json could not be normalized" };
    }
    return { state: "parsed", config };
  }

  /**
   * Load project config, falling back to defaults. On a CORRUPT config (not on
   * normal absence), emits exactly one clear warning via the injected logger so
   * the user knows their custom thresholds are NOT in effect — the bridge must
   * never silently drift to defaults, but a corrupt config must also never
   * wedge startup, so this still returns defaults.
   */
  loadOrDefault(log: ConfigWarnLogger = NOOP_LOGGER): AgentBridgeConfig {
    const result = this.load();
    if (result.state === "parsed") return result.config;
    if (result.state === "corrupt") {
      log(
        `config.json at ${this.configPath} is unusable (${result.reason}); ` +
          "falling back to defaults — your custom budget thresholds / idle-shutdown settings are NOT in effect. " +
          "Fix the file and restart to re-apply them.",
      );
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  /**
   * Diagnostic summary of config parseability for `abg doctor`. Reports the
   * load state and, for a parsed config, whether any decision-grade value
   * differs from the defaults (so the user can confirm their custom thresholds
   * are actually in effect, the exact thing a silent corrupt-fallback hides).
   */
  describeConfig(): ConfigDescription {
    const result = this.load();
    if (result.state === "absent") {
      return { state: "absent", path: this.configPath, customValues: false };
    }
    if (result.state === "corrupt") {
      return { state: "corrupt", path: this.configPath, reason: result.reason, customValues: false };
    }
    return {
      state: "parsed",
      path: this.configPath,
      customValues: hasCustomDecisionValues(result.config),
    };
  }

  /** Save project config. */
  save(config: AgentBridgeConfig): void {
    atomicWriteJson(this.configPath, config);
  }

  /** Generate default config files if they don't exist. Returns list of created files. */
  initDefaults(): string[] {
    this.ensureConfigDir();
    const created: string[] = [];

    if (!existsSync(this.configPath)) {
      this.save(DEFAULT_CONFIG);
      created.push(this.configPath);
    }

    return created;
  }

  get configFilePath(): string {
    return this.configPath;
  }

  private ensureConfigDir(): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }
  }
}

export { DEFAULT_CONFIG, DEFAULT_BUDGET_CONFIG };
