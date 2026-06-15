import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingEntry } from "./pending-reader";
import type { AgentName } from "./types";
import { RESUME_PROMPT } from "./resume-prompt";

export type ResumeInjectionState = "pending" | "awaiting_confirm";

export interface ResumeClaim {
  identity: string;
  claimPath: string;
  consumedPath: string;
  consume: () => void;
  release: () => void;
}

export type ResumeClaimResult =
  | { ok: true; claim: ResumeClaim }
  | { ok: false; reason: "claimed" | "consumed" | "error"; error?: string };

export interface ResumeInjectionEntry {
  resumeId: string;
  prompt: string;
  state: ResumeInjectionState;
  attempts: number;
  injectionId?: number;
  claim?: ResumeClaim;
}

export interface ResumeInjectionQueueOptions {
  inject: (prompt: string) => number | null;
  scheduler?: ResumeScheduler;
  retryMs?: number;
  confirmTimeoutMs?: number;
  maxAttempts?: number;
  log?: (message: string) => void;
  onInjectionAccepted?: (event: { resumeId: string; requestId: number }) => void;
  onInjectionSuperseded?: (event: { resumeId: string; requestId: number; reason: string }) => void;
  onConfirmed?: (event: { resumeId: string; requestId: number; turnId: string }) => void;
  onAbandoned?: (event: { resumeId: string; reason: string }) => void;
}

export interface ResumeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface InternalEntry extends ResumeInjectionEntry {
  retryTimer?: unknown;
  confirmTimer?: unknown;
}

const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_STALE_CLAIM_TTL_SEC = 300;
// consumed/ markers are idempotency tombstones: they keep the SAME pending
// (identity = agent+session+cwd+contentHash) from being re-injected after a
// confirmed resume. A new degrade rewrites the guard pending with a fresh
// contentHash, so a marker is moot once superseded — 7 days is far beyond any
// plausible pending lifetime yet bounds unbounded growth.
const DEFAULT_CONSUMED_TTL_SEC = 7 * 24 * 3600;

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

export class ResumeInjectionQueue {
  private readonly inject: ResumeInjectionQueueOptions["inject"];
  private readonly scheduler: ResumeScheduler;
  private readonly retryMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly log: (message: string) => void;
  private readonly onInjectionAccepted: NonNullable<ResumeInjectionQueueOptions["onInjectionAccepted"]>;
  private readonly onInjectionSuperseded: NonNullable<ResumeInjectionQueueOptions["onInjectionSuperseded"]>;
  private readonly onConfirmed: NonNullable<ResumeInjectionQueueOptions["onConfirmed"]>;
  private readonly onAbandoned: NonNullable<ResumeInjectionQueueOptions["onAbandoned"]>;
  private readonly entries = new Map<string, InternalEntry>();
  // Reentrancy guard: while > 0 we are inside an onTurnTrackingReset sweep (a
  // teardown boundary). tryInjectNext() is a no-op during the sweep so a cleanup
  // path (abandon → tryInjectNext) can never "jump the queue" and inject the next
  // pending mid-reset; surviving pending entries advance at the next real drain.
  private resetSweepDepth = 0;

  constructor(options: ResumeInjectionQueueOptions) {
    this.inject = options.inject;
    this.scheduler = options.scheduler ?? globalThis;
    this.retryMs = finitePositive(options.retryMs, DEFAULT_RETRY_MS);
    this.confirmTimeoutMs = finitePositive(options.confirmTimeoutMs, DEFAULT_CONFIRM_TIMEOUT_MS);
    this.maxAttempts = finitePositive(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.log = options.log ?? (() => {});
    this.onInjectionAccepted = options.onInjectionAccepted ?? (() => {});
    this.onInjectionSuperseded = options.onInjectionSuperseded ?? (() => {});
    this.onConfirmed = options.onConfirmed ?? (() => {});
    this.onAbandoned = options.onAbandoned ?? (() => {});
  }

  get size(): number {
    return this.entries.size;
  }

  get(resumeId: string): ResumeInjectionEntry | undefined {
    const entry = this.entries.get(resumeId);
    if (!entry) return undefined;
    const { retryTimer: _retryTimer, confirmTimer: _confirmTimer, claim: _claim, ...publicEntry } = entry;
    return { ...publicEntry };
  }

  enqueue(input: { resumeId: string; prompt?: string; claim?: ResumeClaim }): void {
    if (this.entries.has(input.resumeId)) {
      this.log(`resume injection deduped: ${input.resumeId}`);
      try {
        input.claim?.release();
      } catch (error) {
        this.log(`resume claim release failed (${input.resumeId} dedup): ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    // B6 fix: identity-level dedup. The stale-claim TTL (tryClaimPendingResume)
    // exists to recover a CRASHED owner, but it cannot tell a crashed owner from
    // THIS live daemon's still-queued resume: after claimTtlSec a second recovery
    // for the same pending unlinks the live claim file and re-grants the SAME
    // identity under a NEW resumeId. claimPath/consumedPath derive solely from
    // identity, so resume-1 and resume-2 point at the same on-disk files —
    // enqueuing both would inject AND confirm the same checkpoint twice. Keep the
    // existing entry and ADOPT the freshly-granted claim (its write is the current
    // file on disk, with a fresh non-stale timestamp), dropping the old claim
    // OBJECT without release(): release() unlinks the shared claim file the
    // surviving entry still needs, and consume() must fire exactly once.
    if (input.claim) {
      const identity = input.claim.identity;
      for (const existing of this.entries.values()) {
        if (existing.claim && existing.claim.identity === identity) {
          this.log(
            `resume injection identity-deduped: ${input.resumeId} ~ existing ${existing.resumeId} (identity ${identity})`,
          );
          existing.claim = input.claim;
          return;
        }
      }
    }
    this.entries.set(input.resumeId, {
      resumeId: input.resumeId,
      prompt: input.prompt ?? RESUME_PROMPT,
      state: "pending",
      attempts: 0,
      ...(input.claim ? { claim: input.claim } : {}),
    });
    this.tryInjectNext();
  }

  onTurnDrained(): void {
    this.tryInjectNext();
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      const requestId = entry.injectionId;
      this.clearRetryTimer(entry);
      this.clearConfirmTimer(entry);
      if (requestId !== undefined) {
        this.onInjectionSuperseded({ resumeId: entry.resumeId, requestId, reason: "stop" });
      }
      try {
        entry.claim?.release();
      } catch (error) {
        this.log(`resume claim release failed (${entry.resumeId}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.entries.clear();
  }

  onTurnTrackingReset(): void {
    // A reset (app-server close / reconnect / stop) is a teardown boundary. Clean up
    // every entry — supersede awaiting → pending, clear pending timers,
    // count-or-abandon — but do NOT inject the next pending mid-sweep: the
    // resetSweepDepth guard makes any tryInjectNext() reached via abandon() during
    // the loop a no-op, so a cleanup never "jumps the queue" and fires a spurious
    // turn/start that the rest of this sweep would just supersede.
    //
    // No explicit post-sweep injection is needed (and Option B deliberately does NOT
    // drain on the daemon `turnAborted` event, which fires BEFORE this reset): each
    // swept entry that is not abandoned goes through countRealAttemptOrAbandon →
    // scheduleRetry, so it carries a retry timer that advances it after the reset.
    // The normal-completion path advances via turnCompleted → onTurnDrained; the
    // injected-turn-rejected path (turnAborted WITHOUT a reset) advances via
    // onBridgeTurnRejected. So every lifecycle path advances exactly once — no stall,
    // no spurious injection.
    this.resetSweepDepth++;
    try {
      for (const entry of [...this.entries.values()]) {
        if (entry.state === "awaiting_confirm") {
          // A real injection was in flight (turn/start sent, awaiting confirm);
          // the reset tore it down → count it as a real failed attempt (which
          // re-arms retry, or abandons at maxAttempts).
          this.supersedeAwaiting(entry, "turn_tracking_reset");
          this.countRealAttemptOrAbandon(entry, "turn tracking reset before turn/start confirmation");
        } else if (entry.state === "pending") {
          // B3 fix: a `pending` entry has NO injection in flight — it is either
          // soft-deferred (inject() returned null: no TUI/no WS, which by design
          // does NOT count an attempt) or waiting between retries (its attempt was
          // already counted when it left awaiting_confirm). Counting an attempt
          // here violated the soft-defer contract: repeated app-server
          // reconnects (each fires onTurnTrackingReset) burned maxAttempts and
          // abandoned a resume that never actually injected. Just re-arm the
          // retry timer so it still advances after the reset.
          this.clearRetryTimer(entry);
          this.scheduleRetry(entry);
        }
      }
    } finally {
      this.resetSweepDepth--;
    }
  }

  onBridgeTurnStarted(event: { resumeId: string; requestId: number; turnId: string }): void {
    const entry = this.entries.get(event.resumeId);
    if (!entry || entry.state !== "awaiting_confirm" || entry.injectionId !== event.requestId) return;
    this.clearConfirmTimer(entry);
    try {
      entry.claim?.consume();
    } catch (error) {
      this.log(`resume claim consume failed (${event.resumeId}): ${error instanceof Error ? error.message : String(error)}`);
    }
    this.entries.delete(event.resumeId);
    this.onConfirmed({ resumeId: event.resumeId, requestId: event.requestId, turnId: event.turnId });
    // Option B (drain-only): do NOT advance the queue here. A turn just STARTED in
    // Codex, and codex-rs does not guarantee the turn/start response orders before
    // its turn/started notification — injecting the next pending now could race the
    // just-started turn. The next pending advances only at a terminal boundary, never
    // here: normal completion → daemon `turnCompleted` → onTurnDrained(); abort /
    // reconnect / close → daemon `turnTrackingReset` → onTurnTrackingReset(), whose
    // sweep arms a per-entry retry timer that advances it. (The daemon `turnAborted`
    // event deliberately does NOT drain — it fires BEFORE turnTrackingReset, so
    // draining there would inject a turn the sweep then supersedes; see
    // onTurnTrackingReset.) Injection-rejection advances via onBridgeTurnRejected. So
    // the queue never injects while a turn is active and the ordering is irrelevant to
    // correctness. (`turnStalled` has no terminal boundary and intentionally does not
    // drain — an active stalled turn must not get a second resume.)
  }

  onBridgeTurnRejected(event: { resumeId: string; requestId: number; error: string }): void {
    const entry = this.entries.get(event.resumeId);
    if (!entry || entry.state !== "awaiting_confirm" || entry.injectionId !== event.requestId) return;
    this.supersedeAwaiting(entry, "bridge_rejected");
    this.countRealAttemptOrAbandon(entry, event.error);
  }

  private tryInjectNext(): void {
    // Never advance the queue from inside a reset sweep (see resetSweepDepth).
    if (this.resetSweepDepth > 0) return;
    for (const entry of this.entries.values()) {
      if (entry.state === "awaiting_confirm") return;
    }
    for (const entry of this.entries.values()) {
      if (entry.state !== "pending") continue;
      this.clearRetryTimer(entry);
      let requestId: number | null;
      try {
        requestId = this.inject(entry.prompt);
      } catch (error) {
        this.countRealAttemptOrAbandon(entry, error instanceof Error ? error.message : String(error));
        return;
      }
      if (requestId === null) {
        this.scheduleRetry(entry);
        return;
      }
      entry.state = "awaiting_confirm";
      entry.injectionId = requestId;
      this.onInjectionAccepted({ resumeId: entry.resumeId, requestId });
      this.scheduleConfirmTimeout(entry);
      return;
    }
  }

  private countRealAttemptOrAbandon(entry: InternalEntry, reason: string): void {
    entry.attempts += 1;
    if (entry.attempts >= this.maxAttempts) {
      this.abandon(entry, reason);
      return;
    }
    this.scheduleRetry(entry);
  }

  private abandon(entry: InternalEntry, reason: string): void {
    this.clearRetryTimer(entry);
    this.clearConfirmTimer(entry);
    this.entries.delete(entry.resumeId);
    try {
      entry.claim?.release();
    } catch (error) {
      this.log(`resume claim release failed (${entry.resumeId}): ${error instanceof Error ? error.message : String(error)}`);
    }
    this.onAbandoned({ resumeId: entry.resumeId, reason });
    this.tryInjectNext();
  }

  private supersedeAwaiting(entry: InternalEntry, reason: string): void {
    this.clearConfirmTimer(entry);
    const requestId = entry.injectionId;
    delete entry.injectionId;
    entry.state = "pending";
    if (requestId !== undefined) {
      this.onInjectionSuperseded({ resumeId: entry.resumeId, requestId, reason });
    }
  }

  private scheduleRetry(entry: InternalEntry): void {
    if (!this.entries.has(entry.resumeId)) return;
    this.clearRetryTimer(entry);
    entry.retryTimer = this.scheduler.setTimeout(() => {
      delete entry.retryTimer;
      this.tryInjectNext();
    }, this.retryMs);
    (entry.retryTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  private scheduleConfirmTimeout(entry: InternalEntry): void {
    this.clearConfirmTimer(entry);
    entry.confirmTimer = this.scheduler.setTimeout(() => {
      delete entry.confirmTimer;
      if (entry.state !== "awaiting_confirm") return;
      this.supersedeAwaiting(entry, "confirm_timeout");
      this.countRealAttemptOrAbandon(entry, "turn/start confirmation timed out");
    }, this.confirmTimeoutMs);
    (entry.confirmTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  private clearRetryTimer(entry: InternalEntry): void {
    if (entry.retryTimer === undefined) return;
    this.scheduler.clearTimeout(entry.retryTimer);
    delete entry.retryTimer;
  }

  private clearConfirmTimer(entry: InternalEntry): void {
    if (entry.confirmTimer === undefined) return;
    this.scheduler.clearTimeout(entry.confirmTimer);
    delete entry.confirmTimer;
  }
}

function realpathOrRaw(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJsonWx(path: string, value: unknown): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
  } finally {
    closeSync(fd);
  }
  return true;
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function readClaimedAt(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const claimedAt = parsed?.claimed_at;
    return typeof claimedAt === "number" && Number.isFinite(claimedAt) ? claimedAt : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort GC of stale resume idempotency artifacts: removes `<dir>/*.json`
 * whose `tsField` timestamp (epoch seconds) is older than `ttlSec`. Unreadable /
 * corrupt / timestamp-less files are LEFT untouched (never aggressively delete
 * what we can't reason about). Called opportunistically on each claim attempt —
 * claims happen only on budget recovery, so this keeps `consumed/` and orphaned
 * `claims/` from growing without bound on a long-lived daemon, with no extra
 * timer or startup wiring.
 */
function pruneStaleResumeArtifacts(
  dir: string,
  tsField: string,
  ttlSec: number,
  nowSec: number,
  log?: (message: string) => void,
): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir absent yet — nothing to prune
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const p = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      const ts = parsed?.[tsField];
      if (typeof ts === "number" && Number.isFinite(ts) && nowSec - ts > ttlSec) {
        unlinkIfExists(p);
      }
    } catch (error) {
      log?.(`resume artifact prune skipped ${p}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function tryClaimPendingResume(opts: {
  stateDir: string;
  agent: AgentName;
  pending: PendingEntry;
  checkpointPath: string;
  claimTtlSec?: number;
  consumedTtlSec?: number;
  now?: () => number;
  log?: (message: string) => void;
}): ResumeClaimResult {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const claimTtlSec = finitePositive(opts.claimTtlSec, DEFAULT_STALE_CLAIM_TTL_SEC);
  const consumedTtlSec = finitePositive(opts.consumedTtlSec, DEFAULT_CONSUMED_TTL_SEC);
  const cwd = realpathOrRaw(opts.pending.cwd);
  const sourcePath = opts.pending.sourcePath ?? "";
  const contentHash = opts.pending.contentHash ?? "";
  const identity = sha256([
    opts.agent,
    opts.pending.sessionId,
    cwd,
    contentHash,
  ].join("\0"));
  const claimsDir = join(opts.stateDir, "claims");
  const consumedDir = join(opts.stateDir, "consumed");
  const claimPath = join(claimsDir, `${identity}.json`);
  const consumedPath = join(consumedDir, `${identity}.json`);
  mkdirSync(claimsDir, { recursive: true });
  mkdirSync(consumedDir, { recursive: true });

  const nowSec = now();
  // GC stale idempotency artifacts first so a long-lived daemon's consumed/ and
  // orphaned claims/ stay bounded. Uses the same claimTtlSec the per-identity
  // stale-claim reclaim below already trusts, so the risk profile is unchanged.
  pruneStaleResumeArtifacts(consumedDir, "consumed_at", consumedTtlSec, nowSec, opts.log);
  pruneStaleResumeArtifacts(claimsDir, "claimed_at", claimTtlSec, nowSec, opts.log);

  if (existsSync(consumedPath)) return { ok: false, reason: "consumed" };

  if (existsSync(claimPath)) {
    const claimedAt = readClaimedAt(claimPath);
    if (claimedAt !== null && nowSec - claimedAt > claimTtlSec) {
      try {
        unlinkIfExists(claimPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        opts.log?.(`stale resume claim cleanup failed: ${message}`);
        return { ok: false, reason: "error", error: message };
      }
    } else {
      return { ok: false, reason: "claimed" };
    }
  }

  const payload = {
    identity,
    agent: opts.agent,
    session_id: opts.pending.sessionId,
    cwd,
    pending_path: sourcePath,
    pending_hash: contentHash,
    checkpoint_path: opts.checkpointPath,
    claimed_at: nowSec,
  };

  try {
    if (!writeJsonWx(claimPath, payload)) return { ok: false, reason: "claimed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opts.log?.(`resume claim failed: ${message}`);
    return { ok: false, reason: "error", error: message };
  }

  return {
    ok: true,
    claim: {
      identity,
      claimPath,
      consumedPath,
      consume: () => {
        mkdirSync(consumedDir, { recursive: true });
        writeFileSync(consumedPath, JSON.stringify({ ...payload, consumed_at: now() }, null, 2));
        unlinkIfExists(claimPath);
      },
      release: () => {
        unlinkIfExists(claimPath);
      },
    },
  };
}
