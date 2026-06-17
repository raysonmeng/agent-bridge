/**
 * Persistent per-5h-window quota for the P3 admission gate (§3.2).
 *
 * Two counters live here, both keyed to the CURRENT 5h window's reset epoch so a
 * window change (resetEpoch jump) automatically zeroes them — Q9 consensus: the
 * counts must survive a daemon restart WITHIN a window, but never carry across
 * one (a restart must not become a back door for extra wrap-ups / batons):
 *   - `wrapUpUsed`        — wrap-up turns let through `admission-closed`
 *                           (capped at `maximize.wrapUpQuota`).
 *   - `checkpointBatonUsed` — whether the system-initiated checkpoint baton has
 *                           already fired in the fully-`closed` state (REAL-2:
 *                           at most once per 5h window).
 *
 * Single-writer model: exactly one daemon per pair owns this file, so the
 * read-modify-write below needs no locking. Stored as a single current-window
 * record (not a map) — a stale window is detected on read by resetEpoch mismatch
 * and discarded, so the file never grows.
 *
 * Resilience contract (mirrors pending-reader.ts): every READ fs touch and
 * JSON.parse is fault-isolated — ENOENT / TOCTOU / malformed / empty / wrong-shape
 * all degrade to a fresh zero state, never throw.
 *
 * WRITE failures are FAIL-CLOSED, not fail-open: a grant is returned ONLY when the
 * incremented record was durably persisted. This is deliberate — swallowing a
 * write error and still returning a grant would OVER-grant the rationed resource
 * (the next read sees the un-incremented count and re-allows; the once-per-window
 * baton would re-fire every poll), bypassing the wrap-up cap and breaking the
 * baton's "at most once per 5h window" invariant. So consumeWrapUp returns
 * allowed:false and consumeCheckpointBaton returns false when the write fails —
 * denying that one grant (the daemon rejects the turn / withholds the baton, then
 * retries next poll) rather than risk an unbounded over-grant. Writes never throw
 * to the caller either way (the gate never crashes on a disk error).
 *
 * A non-finite `fiveHourResetEpoch` (NaN/Infinity from a degraded caller) is
 * treated as non-decision-grade: no grant, no persist (I2 self-enforced here).
 *
 * `fs` is resolved via require() at call time (not a static import) so tests can
 * monkey-patch readFileSync to simulate TOCTOU — the same seam pending-reader.ts
 * uses (Bun keeps the ESM namespace and the CJS object distinct).
 */
import { atomicWriteJson } from "../atomic-json";

type FsModule = Pick<typeof import("node:fs"), "readFileSync">;
function nodeFs(): FsModule {
  return require("node:fs") as FsModule;
}

/** Persisted admission-quota record for one 5h window. */
export interface AdmissionQuotaState {
  version: 1;
  /** The 5h window's reset epoch this record belongs to; mismatch ⇒ stale ⇒ reset. */
  fiveHourResetEpoch: number;
  /** Wrap-up turns let through `admission-closed` in this window. */
  wrapUpUsed: number;
  /** Whether the system checkpoint baton has fired in this window (REAL-2). */
  checkpointBatonUsed: boolean;
}

function freshState(fiveHourResetEpoch: number): AdmissionQuotaState {
  return { version: 1, fiveHourResetEpoch, wrapUpUsed: 0, checkpointBatonUsed: false };
}

/**
 * Pure parser over `unknown` (no IO — the test seam). Returns null for anything
 * that is not a usable v1 record; callers map null to a fresh zero state.
 */
export function parseAdmissionQuota(value: unknown): AdmissionQuotaState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const epoch = record.fiveHourResetEpoch;
  const used = record.wrapUpUsed;
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) return null;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  return {
    version: 1,
    fiveHourResetEpoch: epoch,
    wrapUpUsed: Math.floor(used),
    checkpointBatonUsed: record.checkpointBatonUsed === true,
  };
}

/**
 * Read the persisted record and return the state for the CURRENT window: a fresh
 * zero state when the file is absent / unreadable / malformed, OR when its stored
 * `fiveHourResetEpoch` does not match `fiveHourResetEpoch` (a window change zeroes
 * the counters). Never throws.
 */
export function currentWindowState(
  path: string,
  fiveHourResetEpoch: number,
  log: (msg: string) => void = () => {},
): AdmissionQuotaState {
  let raw: string;
  try {
    raw = nodeFs().readFileSync(path, "utf-8");
  } catch {
    return freshState(fiveHourResetEpoch);
  }
  const text = String(raw).trim();
  if (text === "") return freshState(fiveHourResetEpoch);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log(`admission-quota: skip malformed JSON ${path}`);
    return freshState(fiveHourResetEpoch);
  }
  const state = parseAdmissionQuota(parsed);
  if (!state || state.fiveHourResetEpoch !== fiveHourResetEpoch) {
    return freshState(fiveHourResetEpoch);
  }
  return state;
}

/** Persist the record; returns true on durable write, false on any failure (never throws). */
function persist(path: string, state: AdmissionQuotaState, log: (msg: string) => void): boolean {
  try {
    atomicWriteJson(path, state);
    return true;
  } catch (error) {
    // Never crash the gate on a disk error — but report failure so the caller can
    // FAIL CLOSED (deny this grant) rather than over-grant against a stale count.
    log(`admission-quota: write failed ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Result of a wrap-up admission attempt. */
export interface WrapUpResult {
  /** Whether this wrap-up turn is allowed through `admission-closed`. */
  allowed: boolean;
  /** Wrap-ups used in this window AFTER this attempt (unchanged when rejected). */
  used: number;
  /** Wrap-ups still available after this attempt (0 when rejected at the cap). */
  remaining: number;
}

/**
 * Attempt to consume one wrap-up slot in the current 5h window. Allows + persists
 * the increment when `used < limit`; rejects (no write) at the cap. `limit` is
 * `maximize.wrapUpQuota` (0 disables wrap-ups entirely).
 */
export function consumeWrapUp(
  path: string,
  fiveHourResetEpoch: number,
  limit: number,
  log: (msg: string) => void = () => {},
): WrapUpResult {
  // Non-finite epoch (degraded caller) → non-decision-grade → no grant (I2).
  if (!Number.isFinite(fiveHourResetEpoch)) return { allowed: false, used: 0, remaining: 0 };
  const state = currentWindowState(path, fiveHourResetEpoch, log);
  if (state.wrapUpUsed >= limit) {
    return { allowed: false, used: state.wrapUpUsed, remaining: Math.max(0, limit - state.wrapUpUsed) };
  }
  const next: AdmissionQuotaState = { ...state, wrapUpUsed: state.wrapUpUsed + 1 };
  // FAIL CLOSED: grant only when the increment was durably persisted, else a write
  // failure would re-allow on the next read (over-grant, cap bypass).
  if (!persist(path, next, log)) {
    return { allowed: false, used: state.wrapUpUsed, remaining: Math.max(0, limit - state.wrapUpUsed) };
  }
  return { allowed: true, used: next.wrapUpUsed, remaining: Math.max(0, limit - next.wrapUpUsed) };
}

/**
 * Attempt to fire the system checkpoint baton in the current 5h window (REAL-2:
 * at most once per window). Returns true + persists the flag on the first call in
 * a window; false on every subsequent call until the window resets.
 */
export function consumeCheckpointBaton(
  path: string,
  fiveHourResetEpoch: number,
  log: (msg: string) => void = () => {},
): boolean {
  // Non-finite epoch (degraded caller) → non-decision-grade → do not fire (I2).
  if (!Number.isFinite(fiveHourResetEpoch)) return false;
  const state = currentWindowState(path, fiveHourResetEpoch, log);
  if (state.checkpointBatonUsed) return false;
  // FAIL CLOSED: fire ONLY when the flag was durably persisted — otherwise a write
  // failure would let the baton re-fire every poll (breaks once-per-window).
  return persist(path, { ...state, checkpointBatonUsed: true }, log);
}
