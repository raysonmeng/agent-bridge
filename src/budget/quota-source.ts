import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentName, AgentUsage, BudgetWindow } from "./types";

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
  if (resetEpoch <= 0 && resetAfter === null) return null;
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
} {
  const fiveHourMatches = buckets.filter((bucket) =>
    bucket.id.includes("five_hour") || bucket.id.includes("primary_window")
  );
  const weeklyMatches = buckets.filter((bucket) =>
    bucket.id.includes("seven_day") || bucket.id.includes("secondary_window")
  );

  let fiveHour = toWindow(pickHighestUtil(fiveHourMatches));
  let weekly = toWindow(pickHighestUtil(weeklyMatches));

  const sorted = [...buckets].sort((a, b) => bucketSortKey(a) - bucketSortKey(b));
  if (!fiveHour && sorted.length > 0) {
    fiveHour = toWindow(sorted[0]);
  }
  if (!weekly && sorted.length > 1) {
    const latestDistinct = [...sorted].reverse().find((bucket) => !sameBucketWindow(bucket, fiveHour));
    weekly = toWindow(latestDistinct);
  }

  return { fiveHour, weekly };
}

/** Normalize one raw agent-quota-guard probe JSON object into AgentBridge's internal shape. */
export function normalizeProbeResult(raw: unknown): AgentUsage | null {
  const record = asRecord(raw);
  if (!record) return null;

  const fetchedAt = numberOr(record.fetched_at ?? record.fetchedAt ?? record.now_epoch ?? record.nowEpoch, 0);
  const gateUtil = clamp(numberOr(record.util ?? record.hard_util ?? record.hardUtil, 0), 0, 100);
  const warnUtil = clamp(numberOr(record.warn_util ?? record.warnUtil, gateUtil), 0, 100);
  const rawBuckets = Array.isArray(record.buckets) ? record.buckets : [];
  const buckets = rawBuckets
    .map((bucket) => normalizeBucket(bucket, fetchedAt))
    .filter((bucket): bucket is RawBucket => bucket !== null);
  if (buckets.length === 0) {
    const topLevelBucket = normalizeTopLevelBucket(record, gateUtil, fetchedAt);
    if (topLevelBucket) buckets.push(topLevelBucket);
  }
  const rateLimitedUntil = Math.max(
    0,
    numberOr(record.rate_limited_until ?? record.rateLimitedUntil, 0),
  );
  const ok = record.ok === true;

  if (!ok && rateLimitedUntil <= 0 && buckets.length === 0) return null;

  const { fiveHour, weekly } = identifyWindows(buckets);
  // A successful response with no resettable windows is not actionable budget
  // data. Treat it like a transient probe miss instead of trusting fake 0% util.
  if (!fiveHour && !weekly && rateLimitedUntil === 0) return null;

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
  };
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

export class QuotaSource {
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string;
  private readonly timeoutMs: number;
  private readonly runner: ProbeRunner;
  private readonly log: (message: string) => void;

  constructor(options: QuotaSourceOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runner = options.runner ?? defaultRunner;
    this.log = options.log ?? (() => {});
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
        const usage = normalizeProbeResult(JSON.parse(text));
        if (usage) return usage;
        this.log(`budget probe returned no usable data for ${agent}: ${candidate.command}`);
      } catch (error) {
        this.log(`budget probe failed for ${agent}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }
}

export function createQuotaSource(options?: QuotaSourceOptions): QuotaSource {
  return new QuotaSource(options);
}
