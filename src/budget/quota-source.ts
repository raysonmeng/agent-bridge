import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentName, AgentUsage, BudgetWindow, ProbeParsedVia } from "./types";

export interface ProbeRunOptions {
  env: Record<string, string | undefined>;
  timeoutMs: number;
  agent: AgentName;
}

export interface ProbeRunResult {
  stdout: string | Buffer;
}

export type ProbeRunner = (
  command: string,
  args: string[],
  options: ProbeRunOptions,
) => Promise<ProbeRunResult>;

export interface QuotaSourceOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  timeoutMs?: number;
  runner?: ProbeRunner;
  log?: (message: string) => void;
  /** Unix-seconds clock, injectable for tests (degradation freshness checks). */
  now?: () => number;
}

interface ProbeCandidate {
  command: string;
  kind: "budget-probe" | "probe-mjs";
}

interface RawBucket {
  id: string;
  util: number;
  resetEpoch: number;
  resetAfterSeconds: number | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 1024 * 1024;

function defaultRunner(
  command: string,
  args: string[],
  options: ProbeRunOptions,
): Promise<ProbeRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout) => {
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

function commandKind(command: string): ProbeCandidate["kind"] {
  return basename(command) === "probe.mjs" ? "probe-mjs" : "budget-probe";
}

function argsFor(candidate: ProbeCandidate, agent: AgentName): string[] {
  if (candidate.kind === "probe-mjs") return [agent, "probe"];
  return ["--agent", agent];
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  return asFiniteNumber(value) ?? fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeBucket(value: unknown, fetchedAt: number): RawBucket | null {
  const bucket = asRecord(value);
  if (!bucket) return null;

  const id = typeof bucket.id === "string" ? bucket.id : "";
  const util = asFiniteNumber(bucket.util);
  if (util === null) return null;

  const resetAfter = asFiniteNumber(bucket.reset_after_seconds ?? bucket.resetAfterSeconds);
  let resetEpoch = numberOr(bucket.reset_epoch ?? bucket.resetEpoch, 0);
  if (resetEpoch <= 0 && resetAfter !== null && fetchedAt > 0) {
    resetEpoch = fetchedAt + resetAfter;
  }

  return {
    id,
    util: clamp(util, 0, 100),
    resetEpoch: Math.max(0, resetEpoch),
    resetAfterSeconds: resetAfter === null ? null : Math.max(0, resetAfter),
  };
}

function normalizeTopLevelBucket(record: Record<string, unknown>, util: number, fetchedAt: number): RawBucket | null {
  const resetAfter = asFiniteNumber(record.reset_after_seconds ?? record.resetAfterSeconds);
  let resetEpoch = numberOr(record.reset_epoch ?? record.resetEpoch, 0);
  if (resetEpoch <= 0 && resetAfter !== null && fetchedAt > 0) {
    resetEpoch = fetchedAt + resetAfter;
  }
  // Unknown reset (claude's non-resettable bucket shape emits reset_epoch:null,
  // see agent-bridge#103) is still a DISPLAYABLE reading: keep the window with
  // resetEpoch=0 — render shows 重置 未知, and isDecisionGrade() rejects it for
  // interventions (no fresh window), so the degraded record is display-only.
  // The information floor against fabricated readings lives in the caller: a
  // record with no actual util field never reaches this point.
  return {
    id: "top_level",
    util: clamp(util, 0, 100),
    resetEpoch: Math.max(0, resetEpoch),
    resetAfterSeconds: resetAfter === null ? null : Math.max(0, resetAfter),
  };
}

function toWindow(bucket: RawBucket | null | undefined): BudgetWindow | null {
  if (!bucket) return null;
  return { util: bucket.util, resetEpoch: bucket.resetEpoch };
}

function bucketSortKey(bucket: RawBucket): number {
  if (bucket.resetAfterSeconds !== null) return bucket.resetAfterSeconds;
  if (bucket.resetEpoch > 0) return bucket.resetEpoch;
  return Number.POSITIVE_INFINITY;
}

function sameBucketWindow(bucket: RawBucket, window: BudgetWindow | null): boolean {
  return !!window && bucket.util === window.util && bucket.resetEpoch === window.resetEpoch;
}

function pickHighestUtil(buckets: RawBucket[]): RawBucket | null {
  if (buckets.length === 0) return null;
  return buckets.reduce((best, current) => {
    if (current.util > best.util) return current;
    if (current.util === best.util && bucketSortKey(current) < bucketSortKey(best)) return current;
    return best;
  });
}

function identifyWindows(buckets: RawBucket[]): {
  fiveHour: BudgetWindow | null;
  weekly: BudgetWindow | null;
  parsedVia: Exclude<ProbeParsedVia, "top-level">;
} {
  const fiveHourMatches = buckets.filter((bucket) =>
    bucket.id.includes("five_hour") || bucket.id.includes("primary_window")
  );
  const weeklyMatches = buckets.filter((bucket) =>
    bucket.id.includes("seven_day") || bucket.id.includes("secondary_window")
  );

  let fiveHour = toWindow(pickHighestUtil(fiveHourMatches));
  let weekly = toWindow(pickHighestUtil(weeklyMatches));
  let parsedVia: Exclude<ProbeParsedVia, "top-level"> = "id-match";

  const sorted = [...buckets].sort((a, b) => bucketSortKey(a) - bucketSortKey(b));
  if (!fiveHour && sorted.length > 0) {
    fiveHour = toWindow(sorted[0]);
    parsedVia = "positional";
  }
  if (!weekly && sorted.length > 1) {
    const latestDistinct = [...sorted].reverse().find((bucket) => !sameBucketWindow(bucket, fiveHour));
    weekly = toWindow(latestDistinct);
    if (latestDistinct) parsedVia = "positional";
  }

  return { fiveHour, weekly, parsedVia };
}

interface ProbeNormalization {
  usage: AgentUsage | null;
  unknownSchemaVersion: string | null;
}

type ProbeParser = (record: Record<string, unknown>) => AgentUsage | null;

function normalizeTolerantProbeRecord(record: Record<string, unknown>): AgentUsage | null {
  const fetchedAt = numberOr(record.fetched_at ?? record.fetchedAt ?? record.now_epoch ?? record.nowEpoch, 0);
  // Information floor: a record that carries no actual util reading at all
  // (e.g. a transient `{ok:true}` shell) must stay a probe miss — its
  // defaulted 0% would be a fabricated reading, not a degraded one.
  const hasFiniteUtil =
    asFiniteNumber(record.util ?? record.hard_util ?? record.hardUtil) !== null ||
    asFiniteNumber(record.warn_util ?? record.warnUtil) !== null;
  const gateUtil = clamp(numberOr(record.util ?? record.hard_util ?? record.hardUtil, 0), 0, 100);
  const warnUtil = clamp(numberOr(record.warn_util ?? record.warnUtil, gateUtil), 0, 100);
  const rawBuckets = Array.isArray(record.buckets) ? record.buckets : [];
  const buckets = rawBuckets
    .map((bucket) => normalizeBucket(bucket, fetchedAt))
    .filter((bucket): bucket is RawBucket => bucket !== null);
  let parsedVia: ProbeParsedVia = "id-match";
  if (buckets.length === 0 && hasFiniteUtil) {
    const topLevelBucket = normalizeTopLevelBucket(record, gateUtil, fetchedAt);
    if (topLevelBucket) {
      buckets.push(topLevelBucket);
      parsedVia = "top-level";
    }
  }
  const rateLimitedUntil = Math.max(
    0,
    numberOr(record.rate_limited_until ?? record.rateLimitedUntil, 0),
  );
  const ok = record.ok === true;

  if (!ok && rateLimitedUntil <= 0 && buckets.length === 0) return null;

  const { fiveHour, weekly, parsedVia: bucketParsedVia } = identifyWindows(buckets);
  // Truly unusable = no windows, no rate-limit gate AND no actual util
  // reading. Degraded-but-usable records (stale cache during a 429 gate,
  // unknown-reset buckets) flow through for DISPLAY — the decision layer
  // (isDecisionGrade) independently rejects anything without a fresh window,
  // so accepting them here cannot flip interventions. (agent-bridge#103)
  if (!fiveHour && !weekly && rateLimitedUntil === 0 && !hasFiniteUtil) return null;
  if (parsedVia !== "top-level") parsedVia = bucketParsedVia;

  return {
    ok,
    stale: record.stale === true,
    gateUtil,
    warnUtil,
    fiveHour,
    weekly,
    remaining: clamp(100 - gateUtil, 0, 100),
    rateLimitedUntil,
    fetchedAt,
    parsedVia,
  };
}

const PROBE_SCHEMA_PARSERS: Record<string, ProbeParser> = {
  "1": normalizeTolerantProbeRecord,
};

function schemaVersionKey(record: Record<string, unknown>): string | null {
  const value = record.schema_version ?? record.schemaVersion;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function normalizeProbeResultWithDiagnostics(raw: unknown): ProbeNormalization {
  const record = asRecord(raw);
  if (!record) return { usage: null, unknownSchemaVersion: null };

  const schemaVersion = schemaVersionKey(record);
  if (schemaVersion) {
    const parser = PROBE_SCHEMA_PARSERS[schemaVersion];
    if (parser) return { usage: parser(record), unknownSchemaVersion: null };
    return {
      usage: normalizeTolerantProbeRecord(record),
      unknownSchemaVersion: schemaVersion,
    };
  }

  return { usage: normalizeTolerantProbeRecord(record), unknownSchemaVersion: null };
}

/** Normalize one raw agent-quota-guard probe JSON object into AgentBridge's internal shape. */
export function normalizeProbeResult(raw: unknown): AgentUsage | null {
  return normalizeProbeResultWithDiagnostics(raw).usage;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`budget probe timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Is this usage record degraded (usable for display, not for decisions)?
 * Freshness uses `resetEpoch > now` — the same standard as isDecisionGrade —
 * so an expired-window record cannot log a premature "recovered" transition.
 */
export function isDegradedUsage(usage: AgentUsage, now: number = Math.floor(Date.now() / 1000)): boolean {
  if (usage.stale || !usage.ok) return true;
  const hasFreshWindow =
    (usage.fiveHour !== null && usage.fiveHour.resetEpoch > now) ||
    (usage.weekly !== null && usage.weekly.resetEpoch > now);
  return !hasFreshWindow;
}

export class QuotaSource {
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string;
  private readonly timeoutMs: number;
  private readonly runner: ProbeRunner;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  /** Last degraded-state per agent — degradation is logged on TRANSITIONS only
   *  (a stale period spans many 60s polls; per-poll lines are log spam). */
  private readonly degradedLogged = new Map<AgentName, boolean>();
  private positionalFallbackLogged = false;
  private readonly unknownSchemaVersionsLogged = new Set<string>();

  constructor(options: QuotaSourceOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runner = options.runner ?? defaultRunner;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async fetchBoth(): Promise<{ claude: AgentUsage | null; codex: AgentUsage | null } | null> {
    const candidates = this.findProbeCandidates();
    if (candidates.length === 0) return null;

    const [claude, codex] = await Promise.all([
      this.fetchAgent(candidates, "claude"),
      this.fetchAgent(candidates, "codex"),
    ]);

    return { claude, codex };
  }

  private findProbeCandidates(): ProbeCandidate[] {
    const candidates: ProbeCandidate[] = [];
    const seen = new Set<string>();
    const add = (command: string, kind: ProbeCandidate["kind"]) => {
      const key = `${kind}:${command}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ command, kind });
    };

    const explicit = this.env.AGENTBRIDGE_QUOTA_PROBE || this.env.BUDGET_PROBE;
    if (explicit && explicit.trim() !== "") {
      const command = explicit.trim();
      add(command, commandKind(command));
      return candidates;
    }

    const binDir = join(this.homeDir, ".budget-guard/bin");
    const installedBudgetProbe = join(binDir, "budget-probe");
    if (existsSync(installedBudgetProbe)) add(installedBudgetProbe, "budget-probe");
    const installedProbeMjs = join(binDir, "probe.mjs");
    if (existsSync(installedProbeMjs)) add(installedProbeMjs, "probe-mjs");
    return candidates;
  }

  private async fetchAgent(candidates: ProbeCandidate[], agent: AgentName): Promise<AgentUsage | null> {
    for (const candidate of candidates) {
      try {
        const result = await withTimeout(
          this.runner(candidate.command, argsFor(candidate, agent), {
            env: this.env,
            timeoutMs: this.timeoutMs,
            agent,
          }),
          this.timeoutMs,
        );
        const text = String(result.stdout).trim();
        if (!text) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Unparseable output gets the same triage snippet as unusable data —
          // the outer catch only sees the parse error message otherwise.
          this.log(`budget probe output unparseable for ${agent}: ${candidate.command} — raw: ${text.slice(0, 200)}`);
          continue;
        }
        const normalized = normalizeProbeResultWithDiagnostics(parsed);
        this.noteParserDiagnostics(agent, normalized);
        const usage = normalized.usage;
        if (usage) {
          this.noteDegradation(agent, usage);
          return usage;
        }
        // Genuinely unusable (no windows, no rate-limit gate, no util reading)
        // — include a raw snippet so the next triage doesn't have to guess
        // which output shape the daemon actually saw. Degraded-but-usable
        // records no longer land here; they return above. (agent-bridge#103)
        this.log(
          `budget probe returned no usable data for ${agent}: ${candidate.command} — raw: ${text.slice(0, 200)}`,
        );
      } catch (error) {
        this.log(`budget probe failed for ${agent}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }

  private noteParserDiagnostics(agent: AgentName, normalized: ProbeNormalization): void {
    if (normalized.unknownSchemaVersion && !this.unknownSchemaVersionsLogged.has(normalized.unknownSchemaVersion)) {
      this.unknownSchemaVersionsLogged.add(normalized.unknownSchemaVersion);
      this.log(
        `unknown budget probe schema_version ${normalized.unknownSchemaVersion} for ${agent}; using tolerant legacy parser`,
      );
    }
    if (normalized.usage?.parsedVia === "positional" && !this.positionalFallbackLogged) {
      this.positionalFallbackLogged = true;
      this.log(
        `budget probe positional bucket fallback for ${agent}: bucket ids did not identify quota windows; check probe schema_version/bucket ids`,
      );
    }
  }

  private noteDegradation(agent: AgentName, usage: AgentUsage): void {
    const degraded = isDegradedUsage(usage, this.now());
    const wasDegraded = this.degradedLogged.get(agent) === true;
    if (degraded && !wasDegraded) {
      const gate = usage.rateLimitedUntil > 0 ? `, rate-limit gated until ${usage.rateLimitedUntil}` : "";
      this.log(`budget probe degraded data accepted for ${agent} (stale=${usage.stale}, ok=${usage.ok}${gate}) — display only, decisions hold`);
    } else if (!degraded && wasDegraded) {
      this.log(`budget probe recovered to fresh data for ${agent}`);
    }
    this.degradedLogged.set(agent, degraded);
  }
}

export function createQuotaSource(options?: QuotaSourceOptions): QuotaSource {
  return new QuotaSource(options);
}
