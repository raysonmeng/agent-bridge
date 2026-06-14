import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
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
    for (const entry of [...this.entries.values()]) {
      if (entry.state === "awaiting_confirm") {
        this.supersedeAwaiting(entry, "turn_tracking_reset");
      } else if (entry.state === "pending") {
        this.clearRetryTimer(entry);
      } else {
        continue;
      }
      this.countRealAttemptOrAbandon(entry, "turn tracking reset before turn/start confirmation");
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
    this.tryInjectNext();
  }

  onBridgeTurnRejected(event: { resumeId: string; requestId: number; error: string }): void {
    const entry = this.entries.get(event.resumeId);
    if (!entry || entry.state !== "awaiting_confirm" || entry.injectionId !== event.requestId) return;
    this.supersedeAwaiting(entry, "bridge_rejected");
    this.countRealAttemptOrAbandon(entry, event.error);
  }

  private tryInjectNext(): void {
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

export function tryClaimPendingResume(opts: {
  stateDir: string;
  agent: AgentName;
  pending: PendingEntry;
  checkpointPath: string;
  claimTtlSec?: number;
  now?: () => number;
  log?: (message: string) => void;
}): ResumeClaimResult {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const claimTtlSec = finitePositive(opts.claimTtlSec, DEFAULT_STALE_CLAIM_TTL_SEC);
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

  if (existsSync(consumedPath)) return { ok: false, reason: "consumed" };
  const nowSec = now();

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
