import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { isAgentBridgeDaemon, pidLooksAlive } from "./process-lifecycle";

/**
 * Pair registry — the single shared resource of the multi-pair feature.
 *
 * Each Claude+Codex pair runs as an isolated daemon instance with its own
 * port triple (slot) and state dir. This module owns:
 *   - deterministic slot -> port arithmetic (slot 0 == the classic 4500/4501/4502)
 *   - cross-process slot allocation guarded by an atomic lock file (temp + link(2))
 *   - pairId validation / derivation (filesystem-path safe)
 *   - legacy-root daemon detection (pre-multi-pair installs)
 *   - port probing to surface external squatters without silently shifting slots
 *
 * It is intentionally free of any process.env / argv / StateDirResolver coupling
 * so it can be unit-tested with a temp base dir and real concurrent processes.
 * The base dir is always passed in explicitly.
 */

export const PAIR_BASE_PORT = 4500;
export const PAIR_SLOT_STRIDE = 10;
export const PAIR_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;
/** Friendly pair name used when no `--pair <name>` is given. Scoped to the cwd. */
export const DEFAULT_PAIR_NAME = "main";

/**
 * Minimum age a registry entry must reach before `abg pairs prune` will consider
 * it for entry-level reclamation (cwd-gone + dead daemon). This guards against a
 * just-created pair whose cwd is briefly unavailable (e.g. an unmounted volume, a
 * transient rename) being reaped before the user has even used it — see
 * {@link isEntryReclaimable}. One day is deliberately conservative: reclaiming a
 * permanently-stranded entry a day late is harmless, reaping a live workflow's
 * entry is not.
 */
export const RECLAIMABLE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const LOCK_FILE_NAME = ".registry.lock";
const REGISTRY_FILE_NAME = "registry.json";
const LOCK_DEADLINE_MS = 10_000;
/** Grace before a lock file with unreadable owner content is treated as orphaned (vs corrupt/transient). */
const ORPHAN_GRACE_MS = 3_000;
const LEGACY_ROOT_CONTROL_PORT = 4502;

/** Windows reserved device names — rejected so a pairId is portable as a path segment. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface PairPorts {
  /** Codex app-server port (CODEX_WS_PORT). */
  appPort: number;
  /** Codex proxy port (CODEX_PROXY_PORT). */
  proxyPort: number;
  /** Control WS / health port (AGENTBRIDGE_CONTROL_PORT). */
  controlPort: number;
}

export interface PairEntry {
  pairId: string;
  slot: number;
  cwd: string;
  /**
   * Friendly, cwd-scoped name the user typed (or {@link DEFAULT_PAIR_NAME} when
   * none was given). Display-only — the `pairId` remains the canonical key.
   * Optional so registries written before this field shipped still read cleanly.
   */
  name?: string;
  source: "flag" | "cwd";
  createdAt: string;
}

export interface RegistryFile {
  version: 1;
  pairs: PairEntry[];
}

export interface ResolvedPair {
  pairId: string;
  slot: number;
  ports: PairPorts;
  stateDir: string;
  /** Friendly, cwd-scoped name ({@link DEFAULT_PAIR_NAME} when no `--pair` given). */
  name: string;
  entry: PairEntry;
  /**
   * Non-blocking advisory the CLI prints to stderr (never thrown, never persisted).
   * Set when a raw pairId matched a pair from a DIFFERENT cwd (reused, but project
   * context differs), or when the flag LOOKS like a full pairId yet matched nothing
   * so a new pair was allocated (likely a pasted/typed pairId mistaken for a name).
   */
  warning?: string;
}

export type PairErrorCode =
  | "PAIR_PORTS_BUSY"
  | "PAIR_ID_INVALID"
  | "PAIR_LOCK_TIMEOUT"
  | "PAIR_REGISTRY_CORRUPT"
  | "PAIR_LEGACY_ROOT_DAEMON"
  | "PAIR_CROSS_CWD";

export class PairError extends Error {
  readonly code: PairErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PairErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PairError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Highest slot whose control port (base + slot*stride + 2) still fits in a uint16. */
export const MAX_PAIR_SLOT = Math.floor((65535 - 2 - PAIR_BASE_PORT) / PAIR_SLOT_STRIDE);

/** Deterministic slot -> port triple. slot 0 == classic 4500/4501/4502. */
export function portsForSlot(slot: number): PairPorts {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new PairError("PAIR_ID_INVALID", `Invalid slot: ${slot}`);
  }
  if (slot > MAX_PAIR_SLOT) {
    throw new PairError(
      "PAIR_ID_INVALID",
      `Slot ${slot} exceeds the maximum (${MAX_PAIR_SLOT}); ports would overflow 65535.`,
      { slot, maxSlot: MAX_PAIR_SLOT },
    );
  }
  const base = PAIR_BASE_PORT + slot * PAIR_SLOT_STRIDE;
  return { appPort: base, proxyPort: base + 1, controlPort: base + 2 };
}

/**
 * Validate an explicit `--pair <name>`. Returns the canonical id.
 * Rejects path separators, `.`/`..`, whitespace, empty, and over-length names
 * so the id is always safe to use as a directory name.
 */
export function validatePairId(raw: string): string {
  const id = raw.trim();
  // Windows treats `CON`, `CON.txt`, `NUL.log`, … all as the reserved device —
  // check the segment before the first dot, not just the whole string.
  const deviceBase = id.split(".")[0] ?? "";
  if (
    id === "." ||
    id === ".." ||
    !PAIR_ID_REGEX.test(id) ||
    id.endsWith(".") || // trailing dot is illegal on Windows path segments
    WINDOWS_RESERVED_RE.test(deviceBase)
  ) {
    throw new PairError(
      "PAIR_ID_INVALID",
      `Invalid --pair name: ${JSON.stringify(raw)}. Allowed: letters, digits, "." "_" "-", 1-64 chars ` +
        `(not "." / ".." / a trailing dot / a reserved name like CON, NUL, COM1).`,
      { raw },
    );
  }
  return id;
}

/**
 * Derive a stable, fs-safe pairId from the current working directory.
 * Uses realpath so symlinked cwds map to the same id; appends a short hash
 * of the real path to guarantee uniqueness across same-basename projects.
 */
export function derivePairIdFromCwd(cwd: string): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    real = cwd;
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 8);
  const rawBase = basename(real) || "root";
  // Slugify the basename through the allowed charset; collapse runs of illegal chars.
  const slug = rawBase
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const id = slug ? `${slug}-${hash}` : hash;
  // Guaranteed to satisfy validatePairId by construction.
  return id;
}

/**
 * Derive a stable, fs-safe pairId for a NAMED pair scoped to a directory.
 *
 * The id is `<name-slug>-<8-char hash of realpath(cwd)>`. Scoping the hash to the
 * cwd is the whole point: the SAME friendly name (e.g. "main") in two different
 * directories resolves to two DISTINCT pairs, so they never collide on a slot /
 * daemon / set of ports. Two different names in the SAME directory also stay
 * distinct (different slug prefix, same hash suffix).
 *
 * `name` must already be validated via {@link validatePairId} (or be
 * {@link DEFAULT_PAIR_NAME}). The slug is re-sanitised + length-capped defensively
 * so the composite always satisfies {@link PAIR_ID_REGEX} (≤ 41 chars).
 */
export function derivePairId(cwd: string, name: string): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    real = cwd;
  }
  // Hash BOTH the cwd AND the (already validated) name. Hashing the name is what
  // makes two distinct names in the same directory provably distinct even when
  // their cosmetic slug sanitises to the same string — e.g. "main" vs "-main-"
  // both slug to "main", and "---" slugs to empty. Without the name in the hash
  // those would collide on one slot/daemon. The NUL separator stops (cwd, name)
  // pairs from aliasing across the boundary.
  // Lowercase the name in the hash so casing variants ("Foo" vs "foo") map to
  // the SAME pair (the registry canonicalises by lowercased pairId). The slug
  // below keeps the original case purely for display.
  const hash = createHash("sha256").update(real).update("\0").update(name.toLowerCase()).digest("hex").slice(0, 8);
  const slug =
    name
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "pair";
  // The hex hash suffix guarantees the id never ends in a dot and is never
  // a pure "." / "..", so the only invariant left to the slug is the charset.
  // The slug is purely cosmetic now; the hash alone guarantees uniqueness.
  return `${slug}-${hash}`;
}

/**
 * Smallest non-negative slot not present in the entry set.
 * Uses the SET of used slots (not entry count) so a freed middle slot is reused.
 */
export function pickLowestFreeSlot(entries: readonly PairEntry[]): number {
  const used = new Set(entries.map((e) => e.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

// ---------------------------------------------------------------------------
// Registry file I/O (integrity only — concurrency is the lock's job)
// ---------------------------------------------------------------------------

function pairsDir(base: string): string {
  return join(base, "pairs");
}

function registryPath(base: string): string {
  return join(pairsDir(base), REGISTRY_FILE_NAME);
}

/** Read the registry, returning an empty one if absent. Throws on corruption. */
export function readRegistry(base: string): RegistryFile {
  const path = registryPath(base);
  if (!existsSync(path)) return { version: 1, pairs: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new PairError("PAIR_REGISTRY_CORRUPT", `Registry JSON is not parseable at ${path}: ${(err as Error).message}`, {
      path,
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as RegistryFile).version !== 1 ||
    !Array.isArray((parsed as RegistryFile).pairs)
  ) {
    throw new PairError("PAIR_REGISTRY_CORRUPT", `Registry shape is invalid at ${path}`, { path });
  }

  // Validate entries: a tampered/corrupt registry with duplicate slots or pairIds
  // would silently put two pairs on the same ports — reject it loudly instead.
  const entries = (parsed as RegistryFile).pairs;
  const seenSlots = new Set<number>();
  const seenIds = new Set<string>();
  for (const e of entries) {
    // Charset-validate the stored pairId too: a tampered registry with
    // `"pairId": "../.."` flows straight into join(base,"pairs",pairId) in kill/pairs.
    const idValid =
      e && typeof e.pairId === "string" && e.pairId !== "." && e.pairId !== ".." && PAIR_ID_REGEX.test(e.pairId);
    if (!idValid || !Number.isInteger(e.slot) || e.slot < 0) {
      throw new PairError("PAIR_REGISTRY_CORRUPT", `Registry has a malformed entry at ${path}`, { path, entry: e });
    }
    const lower = e.pairId.toLowerCase();
    if (seenSlots.has(e.slot) || seenIds.has(lower)) {
      throw new PairError("PAIR_REGISTRY_CORRUPT", `Registry has duplicate slot/pairId at ${path}`, {
        path,
        pairId: e.pairId,
        slot: e.slot,
      });
    }
    seenSlots.add(e.slot);
    seenIds.add(lower);
  }
  return parsed as RegistryFile;
}

/** Atomically replace the registry file (temp + fsync + rename). */
export function writeRegistry(base: string, reg: RegistryFile): void {
  mkdirSync(pairsDir(base), { recursive: true });
  const target = registryPath(base);
  const tmp = `${target}.tmp.${process.pid}`;
  const data = JSON.stringify(reg, null, 2) + "\n";
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

interface LockOwner {
  pid: number;
  createdAt: number;
  nonce: string;
  hostname?: string;
  uid?: number;
}

function lockFilePath(base: string): string {
  return join(pairsDir(base), LOCK_FILE_NAME);
}

function readLockOwner(lockFile: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, "utf-8")) as LockOwner;
    if (typeof parsed.pid === "number" && typeof parsed.nonce === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function lockFileAgeMs(lockFile: string): number {
  try {
    return Date.now() - statSync(lockFile).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // gone — let the caller re-attempt acquire
  }
}

function safeHostname(): string | undefined {
  try {
    return hostname();
  } catch {
    return undefined;
  }
}

function safeUid(): number | undefined {
  try {
    return userInfo().uid;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the lock currently at `lockFile` is reclaimable: a DEAD owner, or
 * (defensively) unreadable content older than the orphan grace. A LIVE owner is
 * never stale — we never steal a live holder's lock.
 */
function lockIsStale(lockFile: string): boolean {
  const owner = readLockOwner(lockFile);
  if (owner) return !pidLooksAlive(owner.pid);
  // Atomic link-acquire means a live lock always has complete content, so an
  // unreadable owner is corruption — reclaim only once it's older than the grace.
  return lockFileAgeMs(lockFile) > ORPHAN_GRACE_MS;
}

/**
 * Remove a stale primary lock — race-free against a fresh acquirer, even when a
 * reclaimer stalls or crashes mid-reclaim.
 *
 * Earlier fixes could not close the hazard: a reclaimer's "owner is dead"
 * decision can go stale, and removing the primary lock can evict a lock a fresh
 * holder just acquired (duplicate-slot bug). The TTL-force-remove of the reclaim
 * lock reopened it for a >grace-stalled reclaimer.
 *
 * Final design (no TTL stealing anywhere):
 *   1. Serialize reclaimers through a reclaim lock acquired by atomic `link`,
 *      whose owner carries a pid + nonce — exactly like the primary lock.
 *   2. The reclaim lock is itself reclaimed ONLY when its owner is DEAD (or its
 *      content is unreadable and old) — NEVER stolen from a live (even wedged)
 *      reclaimer. A contended-but-live reclaim lock just makes us wait.
 *   3. While holding it, verify we still own it (nonce), then unlink the primary
 *      lock only if it is still stale.
 *
 * Why a stale unlink can never delete a LIVE primary lock:
 *   - A reclaimer wedged (alive) before its unlink is never preempted (rule 2),
 *     so its eventual unlink is still valid — the primary was the same dead lock
 *     the whole time (no one else could reclaim or acquire it while held).
 *   - A reclaimer that DIES before its unlink simply cannot resume to run a stale
 *     unlink; a later reclaimer reclaims the (now dead) reclaim lock and re-checks.
 *   There is no path where a preempted reclaimer resumes and removes a live lock.
 */
function attemptReclaim(lockFile: string): void {
  const reclaimLock = `${lockFile}.reclaim`;
  const myNonce = randomUUID();
  const ownerJson = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    nonce: myNonce,
    hostname: safeHostname(),
    uid: safeUid(),
  } satisfies LockOwner);

  const tmp = `${reclaimLock}.acq.${process.pid}.${randomUUID()}`;
  let held = false;
  try {
    writeFileSync(tmp, ownerJson);
    try {
      linkSync(tmp, reclaimLock); // atomic; EEXIST if another reclaimer holds it
      held = true;
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        // Clear it ONLY if its owner is dead/orphaned (never a live reclaimer),
        // then return so the next loop iteration re-acquires it cleanly — we never
        // unlink-then-link in one step, so two clearers can't both end up holding.
        if (lockIsStale(reclaimLock)) {
          try {
            unlinkSync(reclaimLock);
          } catch {}
        }
        return;
      }
      throw err;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }

  if (!held) return;
  try {
    // Confirm we still own the reclaim lock (guards the dead-lock acquisition
    // race), then remove the primary lock only if it is still stale.
    if (readLockOwner(reclaimLock)?.nonce !== myNonce) return;
    if (lockIsStale(lockFile)) {
      try {
        unlinkSync(lockFile);
      } catch {}
    }
  } finally {
    if (readLockOwner(reclaimLock)?.nonce === myNonce) {
      try {
        unlinkSync(reclaimLock);
      } catch {}
    }
  }
}

/**
 * Run `fn` while holding a cross-process lock on the registry.
 *
 * Acquire is a single atomic step with NO publication gap: the owner metadata is
 * written to a unique temp file first, then `link(2)`'d onto the canonical lock
 * path. `link` fails EEXIST if the lock is held, and the instant the lock path
 * exists its content (the owner) is already complete — so a contender can never
 * observe an "ownerless" live lock and wrongly reclaim it.
 *
 * Correctness rules (hardened via cross-review):
 *   - NEVER steal a lock from a LIVE owner — even a long-held one — because a
 *     paused/stalled owner could resume mid-critical-section and write a stale
 *     registry (lost update). A live holder past the deadline ⇒ PAIR_LOCK_TIMEOUT.
 *   - Reclaim only a DEAD owner, or (defensively) a lock whose content is
 *     unreadable AND older than ORPHAN_GRACE_MS (corruption / partial crash).
 *   - Reclamation is serialized through a dedicated reclaim lock and re-confirms
 *     staleness before removing the primary lock (see attemptReclaim), so racing
 *     reclaimers can't evict a fresh holder's lock.
 */
export async function withRegistryLock<T>(base: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(pairsDir(base), { recursive: true });
  const lockFile = lockFilePath(base);
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  const myNonce = randomUUID();
  const ownerJson = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    nonce: myNonce,
    hostname: safeHostname(),
    uid: safeUid(),
  } satisfies LockOwner);

  for (;;) {
    // Atomic acquire: write owner to a unique temp file, then link it onto the
    // canonical lock path. The temp name is unique per attempt so concurrent
    // acquirers never clash on it.
    const tmp = `${lockFile}.acq.${process.pid}.${randomUUID()}`;
    let acquired = false;
    try {
      writeFileSync(tmp, ownerJson);
      try {
        linkSync(tmp, lockFile); // atomic test-and-set; EEXIST if held
        acquired = true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }

    if (acquired) {
      try {
        return await fn();
      } finally {
        // A live owner is never reclaimed, so this is normally still our lock —
        // only remove it if we still own it (defense in depth).
        const current = readLockOwner(lockFile);
        if (!current || current.nonce === myNonce) {
          try {
            unlinkSync(lockFile);
          } catch {}
        }
      }
    }

    // Held by someone — reclaim if stale (serialized + re-confirmed under a
    // reclaim lock so we can't evict a fresh holder), otherwise wait.
    if (lockIsStale(lockFile)) {
      attemptReclaim(lockFile);
    }

    if (Date.now() >= deadline) {
      throw new PairError("PAIR_LOCK_TIMEOUT", `Timed out acquiring registry lock at ${lockFile}`, {
        holderPid: readLockOwner(lockFile)?.pid,
      });
    }
    await sleep(25 + Math.floor(Math.random() * 50));
  }
}

// ---------------------------------------------------------------------------
// Legacy-root daemon detection
// ---------------------------------------------------------------------------

/**
 * Detect a pre-multi-pair daemon that wrote its pid directly at <base>/daemon.pid
 * (the classic single-pair layout) and is still alive on control port 4502.
 * Returns its pid, or null.
 *
 * Identity uses the shared strict {@link isAgentBridgeDaemon} matcher (anchored
 * on a `daemon.{ts,js}` argv plus an agentbridge marker). This is a TIGHTENING
 * over the former loose `cmd.includes("daemon")` check: a legacy root daemon was
 * still spawned as `<bun> run <…>/daemon.{ts,js}` / `<…>/server/daemon.js` whose
 * path carries an agentbridge marker, so it still matches — while an OS-reused
 * pid that merely has "daemon" somewhere in its argv no longer false-positives.
 */
export function detectLegacyRootDaemon(base: string): { pid: number; controlPort: number } | null {
  const rootPidFile = join(base, "daemon.pid");
  if (!existsSync(rootPidFile)) return null;
  let pid: number;
  try {
    const raw = readFileSync(rootPidFile, "utf-8").trim();
    pid = Number.parseInt(raw, 10);
  } catch {
    return null;
  }
  if (!Number.isFinite(pid) || !pidLooksAlive(pid) || !isAgentBridgeDaemon(pid)) return null;
  return { pid, controlPort: LEGACY_ROOT_CONTROL_PORT };
}

// ---------------------------------------------------------------------------
// Port probing
// ---------------------------------------------------------------------------

/** Resolve true if the TCP port is free to bind on 127.0.0.1. */
export function probePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function pidOnPort(port: number): number | undefined {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
    const first = out.split(/\s+/)[0];
    const pid = Number.parseInt(first ?? "", 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public allocation entrypoint
// ---------------------------------------------------------------------------

export interface ResolvePairOptions {
  pairFlag?: string;
  cwd: string;
  /**
   * Probe the allocated ports for an external squatter after allocation
   * (default true). Production always probes; tests that exercise pure slot
   * allocation set this false so they don't depend on which ports happen to be
   * free on the host.
   */
  probePorts?: boolean;
}

/**
 * Outcome of the under-lock allocation pass. Either a resolved slot/entry, or a
 * cross-cwd sentinel that defers a PAIR_CROSS_CWD throw until the lock is released
 * (throwing while holding the registry lock would strand it).
 */
type PairAllocation =
  | { slot: number; entry: PairEntry; isNew: boolean; matchedRaw: boolean }
  | { crossCwd: PairEntry };

/**
 * Resolve (and, if new, allocate) the pair for this invocation.
 *
 * Allocation happens under the cross-process lock; port probing happens after
 * releasing it (probing is slow and must not serialize all CLI starts). Re-running
 * for the same pair is idempotent — the slot is reused and a healthy daemon on the
 * control port is treated as "already running", not a conflict.
 *
 * UPGRADE NOTE: the pairId scheme changed to the cwd-scoped `<name>-<hash>` form.
 * Entries written by an older build (a different cwd-derivation) will NOT match the
 * scoped (name + cwd) lookup, so a launch allocates a fresh slot rather than reusing
 * the legacy one — EXCEPT when an explicit `--pair <verbatim-id>` equals an existing
 * pairId verbatim: the step-2 raw fallback below then reuses that entry (the
 * `abg --pair <pairId>` recovery path). The legacy entry remains visible in
 * `abg pairs` and is reclaimable with `abg pairs rm <id>` or `abg kill`
 * (kill-all stops every registered pair regardless of id shape). We intentionally
 * do not auto-migrate: the old id format is ambiguous and this is pre-v1.
 */
export async function resolvePair(base: string, opts: ResolvePairOptions): Promise<ResolvedPair> {
  // `pairFlag != null` (rather than truthiness) so an explicit-but-empty `--pair`
  // (a missing value) surfaces a clear PAIR_ID_INVALID instead of silently
  // falling back to the default name.
  //
  // The friendly NAME is always scoped to the cwd: with a flag it is the
  // validated `--pair <name>`; without one it is DEFAULT_PAIR_NAME ("main").
  // The canonical pairId composes the name with a hash of the cwd, so the same
  // name in two directories is two distinct pairs (see derivePairId).
  const hasFlag = opts.pairFlag != null;
  const name = hasFlag ? validatePairId(opts.pairFlag as string) : DEFAULT_PAIR_NAME;
  const pairId = derivePairId(opts.cwd, name);
  const source: PairEntry["source"] = hasFlag ? "flag" : "cwd";
  const lower = pairId.toLowerCase();
  // Raw match key: the flag verbatim (validated/trimmed into `name`), in case it is
  // ALREADY a full pairId copied from `abg pairs` (reused only for the SAME cwd; a
  // cross-cwd raw match is rejected below).
  const flagLower = name.toLowerCase();

  const allocation = await withRegistryLock(base, (): PairAllocation => {
    const reg = readRegistry(base);
    // 1) Scoped (name + cwd) match first: a friendly name in THIS directory always
    //    wins, so normal `--pair main` is unaffected and a foreign raw pairId can
    //    never steal a legitimate current-cwd name.
    const scoped = reg.pairs.find((p) => p.pairId.toLowerCase() === lower);
    if (scoped) return { slot: scoped.slot, entry: scoped, isNew: false, matchedRaw: false };
    // 2) Raw pairId fallback: the flag itself IS an already-registered pairId.
    //    Mirrors findPairForFlag() so a launch (`abg --pair <id> codex`) agrees with
    //    kill/pairs, and fixes the double-hash strand where passing a full pairId
    //    silently spawned a brand-new empty pair with no peer.
    //
    //    A pair is scoped to its directory: only reuse a raw match when it belongs to
    //    THIS cwd (the `abg --pair <pairId>` same-dir recovery path). A raw match from a
    //    DIFFERENT cwd is an error — return a sentinel and throw AFTER releasing the lock
    //    (never throw while holding it). The identity layer would reject a cross-cwd
    //    attach anyway, so failing loud here keeps the two layers in agreement.
    if (hasFlag) {
      const raw = reg.pairs.find((p) => p.pairId.toLowerCase() === flagLower);
      if (raw) {
        if (raw.cwd === opts.cwd) {
          return { slot: raw.slot, entry: raw, isNew: false, matchedRaw: true };
        }
        return { crossCwd: raw };
      }
    }

    // 3) No match → allocate a fresh slot for the cwd-scoped pairId.
    const newSlot = pickLowestFreeSlot(reg.pairs);
    if (newSlot === 0) {
      const legacy = detectLegacyRootDaemon(base);
      if (legacy) {
        throw new PairError(
          "PAIR_LEGACY_ROOT_DAEMON",
          `A pre-multi-pair AgentBridge daemon is running at the legacy location ` +
            `(pid ${legacy.pid}, control port ${legacy.controlPort}). Run "abg kill" to stop it, then retry — ` +
            `your new session would otherwise collide on port ${legacy.controlPort}.`,
          { pid: legacy.pid, controlPort: legacy.controlPort },
        );
      }
    }
    // Validate the slot's ports BEFORE persisting, so slot exhaustion throws
    // without leaving an invalid (out-of-range) entry in the registry.
    portsForSlot(newSlot);
    const newEntry: PairEntry = {
      pairId,
      slot: newSlot,
      cwd: opts.cwd,
      name,
      source,
      createdAt: new Date().toISOString(),
    };
    writeRegistry(base, { version: 1, pairs: [...reg.pairs, newEntry] });
    return { slot: newSlot, entry: newEntry, isNew: true, matchedRaw: false };
  });

  // Cross-cwd raw match: thrown OUTSIDE the lock. A pair is scoped to its directory,
  // so passing a full pairId from another directory is an error, not a silent reuse.
  if ("crossCwd" in allocation) {
    const raw = allocation.crossCwd;
    throw new PairError(
      "PAIR_CROSS_CWD",
      `--pair ${opts.pairFlag ?? name} refers to pair "${raw.pairId}" registered for ${raw.cwd}, ` +
        `but you are in ${opts.cwd}. A pair is scoped to its directory — cd into that directory ` +
        `to use it, or pass a short name to create/use a pair here.`,
      { pairId: raw.pairId, registeredCwd: raw.cwd, cwd: opts.cwd },
    );
  }

  const { slot, entry, isNew, matchedRaw } = allocation;

  const ports = portsForSlot(slot);

  // Probe ports ONLY for a brand-new slot allocation. For an existing pair
  // (idempotent re-run) the daemon may already own these ports, or a concurrent
  // same-pair launch may be mid-bind — so we defer conflict detection to the
  // daemon's own bind + health check rather than risk a false PAIR_PORTS_BUSY.
  //
  // Note: probing is a best-effort external-squatter check, not a correctness
  // guarantee (port use is TOCTOU); the daemon's bind is the final arbiter.
  // If probing fails, remove the just-created registry entry under the lock so
  // a transient external squatter does not strand a ghost slot.
  if (isNew && opts.probePorts !== false) {
    for (const port of [ports.appPort, ports.proxyPort, ports.controlPort]) {
      if (!(await probePortFree(port))) {
        await removeAllocatedPairIfUnchanged(base, pairId, slot);
        throw new PairError(
          "PAIR_PORTS_BUSY",
          `Port ${port} (pair "${pairId}", slot ${slot}) is already in use by another process. ` +
            `Free it or remove the conflicting pair; AgentBridge will not silently move slots.`,
          { port, slot, pairId, pid: pidOnPort(port) },
        );
      }
    }
  }

  // Use the registry's canonical pairId (case preserved from first registration),
  // NOT the caller's casing — otherwise `--pair Foo` then `--pair foo` would split
  // one logical pair across two state dirs on a case-sensitive filesystem.
  // `entry.name` is backfilled for entries written before the `name` field shipped.
  // Non-blocking advisory (CLI prints to stderr; never thrown, never persisted).
  // A raw match is now only ever a SAME-cwd recovery (cross-cwd throws above), so the
  // sole remaining advisory is the pairId-shaped flag that matched nothing.
  let warning: string | undefined;
  if (isNew && hasFlag && /-[0-9a-f]{8}$/i.test(name)) {
    warning =
      `--pair ${opts.pairFlag ?? name} looks like a full pair id, but no registered pair matched; ` +
      `creating a NEW pair named "${name}". Pass a short name (e.g. "main") or run \`abg pairs\` ` +
      `to see existing pairs.`;
  }
  // matchedRaw (same-cwd recovery) intentionally produces no warning.
  void matchedRaw;

  return {
    pairId: entry.pairId,
    slot,
    ports,
    stateDir: join(pairsDir(base), entry.pairId),
    name: entry.name ?? name,
    entry,
    warning,
  };
}

async function removeAllocatedPairIfUnchanged(base: string, pairId: string, slot: number): Promise<void> {
  await withRegistryLock(base, () => {
    // Rollback guard: this runs when OUR allocation probe failed, but a
    // concurrent same-pair launcher may have already adopted the entry and
    // started using it — its state dir exists or its daemon is alive. We are
    // already under the registry lock, so these checks are race-safe; skipping
    // the rollback merely leaves a registered entry that the other launcher is
    // legitimately using.
    if (existsSync(pairDirPath(base, pairId)) || pairDirDaemonAlive(base, pairId)) return;
    const reg = readRegistry(base);
    const nextPairs = reg.pairs.filter((pair) => !(pair.pairId === pairId && pair.slot === slot));
    if (nextPairs.length === reg.pairs.length) return;
    writeRegistry(base, { version: 1, pairs: nextPairs });
  });
}

/** Remove a pair entry from the registry (frees its slot). Returns the removed entry or null. */
export async function removePairEntry(base: string, pairId: string): Promise<PairEntry | null> {
  const lower = pairId.toLowerCase();
  return withRegistryLock(base, () => {
    const reg = readRegistry(base);
    const found = reg.pairs.find((p) => p.pairId.toLowerCase() === lower) ?? null;
    if (!found) return null;
    writeRegistry(base, { version: 1, pairs: reg.pairs.filter((p) => p.pairId.toLowerCase() !== lower) });
    return found;
  });
}

/** Absolute path to the registry's `pairs/` root (the dir that holds per-pair state dirs). */
export function pairsRootDir(base: string): string {
  return pairsDir(base);
}

/**
 * Absolute path to a single pair's on-disk state directory.
 *
 * Validates `pairId` first (rejects "." / ".." / path separators / reserved
 * names) so the result can never escape `<base>/pairs`. Throws PAIR_ID_INVALID
 * on a malformed id.
 */
export function pairDirPath(base: string, pairId: string): string {
  const id = validatePairId(pairId);
  return join(pairsDir(base), id);
}

/**
 * Remove a pair's on-disk state directory. Does NOT touch the registry — callers
 * remove the registry entry (removePairEntry) separately so registry truth and
 * filesystem cleanup stay independently testable.
 *
 * Path-safe in depth: `validatePairId` already rejects traversal, but we also
 * assert the resolved path is strictly inside the canonical `<base>/pairs` root
 * before any `rmSync`, so a crafted id can never delete outside the registry.
 * Returns true if a directory was actually removed.
 */
export function removePairDir(base: string, pairId: string): boolean {
  const id = validatePairId(pairId);
  const root = pairsDir(base);
  const dir = join(root, id);
  const canonicalRoot = resolve(root);
  const canonicalDir = resolve(dir);
  if (canonicalDir === canonicalRoot || !canonicalDir.startsWith(canonicalRoot + sep)) {
    throw new PairError(
      "PAIR_ID_INVALID",
      `Refusing to remove a pair dir outside ${canonicalRoot}: ${canonicalDir}`,
      { pairId },
    );
  }
  // The lexical containment above passes even if `<base>/pairs` is itself a
  // symlink to an external directory; `rmSync` would then follow it and delete
  // the external target's child. Refuse to operate through a symlinked root.
  // (We deliberately check ONLY the `pairs` segment, not the whole path via
  // realpath — base components are legitimately symlinked, e.g. macOS /var.)
  assertPairsRootNotSymlinked(root);
  if (!existsSync(canonicalDir)) return false;
  rmSync(canonicalDir, { recursive: true, force: true });
  return true;
}

/** Throws if `<base>/pairs` exists and is a symlink (a delete/list traversal hazard). */
function assertPairsRootNotSymlinked(root: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch {
    return; // absent root — nothing to traverse
  }
  if (stat.isSymbolicLink()) {
    throw new PairError(
      "PAIR_ID_INVALID",
      `Refusing to operate through a symlinked pairs root: ${root}`,
      { root },
    );
  }
}

/**
 * List the pair-id subdirectories under `<base>/pairs` (directories only — the
 * registry file and any stray files are skipped). Used by `abg pairs prune` to
 * find orphan state dirs left behind by older builds that removed the registry
 * entry without deleting the dir. Returns raw dir names (callers validate).
 */
export function listPairDirs(base: string): string[] {
  const root = pairsDir(base);
  if (!existsSync(root)) return [];
  // A symlinked pairs root is a traversal hazard (see removePairDir) — never
  // enumerate through it.
  if (lstatSync(root).isSymbolicLink()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Conservative liveness probe for a pair dir: returns true if EITHER `daemon.pid`
 * OR `status.json`'s pid points at a living process. Conservative on purpose —
 * any sign of life keeps the dir, because wrongly deleting a live pair's state is
 * far worse than skipping an orphan we are unsure about. Shared by the prune
 * pre-filter and the in-lock delete gate so both agree on EPERM (= alive).
 *
 * Note: it does NOT confirm the pid is actually an AgentBridge daemon (no
 * isDaemonProcess/ps check), so a stale pid OS-reused by an unrelated live
 * process keeps an orphan dir un-pruned — a bounded disk leak. That is a
 * deliberate trade-off: adding an identity check would risk a false-negative
 * deleting a live pair, so reclaim hardening is left to the liveness follow-up.
 */
export function pairDirDaemonAlive(base: string, pairId: string): boolean {
  const dir = join(pairsDir(base), pairId);
  const pids: number[] = [];
  try {
    const pid = Number.parseInt(readFileSync(join(dir, "daemon.pid"), "utf-8").trim(), 10);
    if (Number.isFinite(pid)) pids.push(pid);
  } catch {
    // no/unreadable daemon.pid
  }
  try {
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf-8")) as { pid?: unknown };
    if (typeof status?.pid === "number") pids.push(status.pid);
  } catch {
    // no/unparseable status.json
  }
  return pids.some((pid) => pidLooksAlive(pid));
}

/**
 * Atomically (under the registry lock) remove a pair's registry entry AND its
 * state dir. Holding the lock across the delete closes the race where a
 * concurrent `abg claude/codex` re-registers the same deterministic id — which
 * also happens under this same lock in resolvePair — and would otherwise get its
 * fresh state dir deleted out from under it. The dir is removed FIRST so a delete
 * failure leaves the entry registered (retryable); a live daemon in the dir (a
 * racing relaunch that registered + started before we acquired the lock) aborts
 * the delete so a live pair's state is never destroyed.
 *
 * KNOWN LIMITATION (pre-existing, not closed here): this does NOT cover a
 * launcher that already *reused* the existing registry entry via resolvePair
 * BEFORE rm acquired the lock, but has not yet written its daemon.pid/status.json
 * — rm/prune cannot observe such a pending launch, so concurrent `abg pairs rm X`
 * + `abg claude --pair X` can still leave a live-but-unregistered state dir. The
 * old `abg pairs rm` (entry-only removal) already had this window; B1 only adds
 * the dir delete on top. A full fix needs a launch-side lease / registry
 * tombstone / per-pair lock so the launcher revalidates membership before
 * ensureRunning — see the reliability follow-up.
 */
export async function removePairEntryAndDir(
  base: string,
  pairId: string,
): Promise<{ entry: PairEntry | null; dirRemoved: boolean; keptLive: boolean }> {
  const lower = pairId.toLowerCase();
  return withRegistryLock(base, () => {
    const reg = readRegistry(base);
    const found = reg.pairs.find((p) => p.pairId.toLowerCase() === lower) ?? null;
    if (pairDirDaemonAlive(base, pairId)) {
      return { entry: found, dirRemoved: false, keptLive: true };
    }
    const dirRemoved = removePairDir(base, pairId);
    if (found) {
      writeRegistry(base, { version: 1, pairs: reg.pairs.filter((p) => p.pairId.toLowerCase() !== lower) });
    }
    return { entry: found, dirRemoved, keptLive: false };
  });
}

/**
 * Atomically (under the registry lock) remove an ORPHAN pair dir — one with no
 * registry entry and no live daemon. Used by `abg pairs prune`. The lock guards
 * against deleting a dir whose id is (re)registered or whose daemon starts
 * concurrently (both serialize on this lock).
 */
export async function removeUnregisteredPairDir(
  base: string,
  pairId: string,
): Promise<{ removed: boolean; reason?: "registered" | "live" }> {
  const lower = pairId.toLowerCase();
  return withRegistryLock(base, () => {
    const reg = readRegistry(base);
    if (reg.pairs.some((p) => p.pairId.toLowerCase() === lower)) {
      return { removed: false, reason: "registered" as const };
    }
    if (pairDirDaemonAlive(base, pairId)) {
      return { removed: false, reason: "live" as const };
    }
    return { removed: removePairDir(base, pairId) };
  });
}

// ---------------------------------------------------------------------------
// Entry-level reclamation (P1 #9)
//
// The dir-orphan prune above reclaims "dir exists but NO registry entry". The
// reverse leak — "entry exists but is permanently invalid" — is reclaimed here.
// The canonical example is a stranded entry left by the old double-hash bug: the
// code was fixed (resolvePair's three-tier match) but the DATA residue persists,
// permanently occupying a slot/port range that pickLowestFreeSlot still reads.
// ---------------------------------------------------------------------------

/** Why an entry is (or is not) reclaimable. Display-only; surfaced in the dry run. */
export interface EntryReclaimSignals {
  /** The entry's cwd no longer exists on disk (statSync ENOENT). */
  cwdGone: boolean;
  /** No live daemon is associated with the entry's pair dir (pairDirDaemonAlive=false). */
  dead: boolean;
  /** createdAt is older than {@link RECLAIMABLE_MIN_AGE_MS} relative to `now`. */
  old: boolean;
  /** Age of the entry in ms (now - createdAt), clamped to ≥0; null when createdAt is unparseable. */
  ageMs: number | null;
}

export interface ReclaimableEntry {
  entry: PairEntry;
  signals: EntryReclaimSignals;
}

/**
 * Pure reclaim predicate. An entry is RECLAIMABLE only when ALL three guards
 * hold: its cwd is gone, no live daemon owns it, and it is older than the
 * minimum age. Any one of "cwd exists" / "daemon alive" / "too young" vetoes
 * reclamation — the safety rails are conjunctive on purpose.
 *
 * Kept signal-only (no fs/clock access) so it is trivially unit-testable; the
 * caller gathers the live signals via {@link classifyReclaimableEntries}.
 */
export function isEntryReclaimable(signals: EntryReclaimSignals): boolean {
  return signals.cwdGone && signals.dead && signals.old;
}

/**
 * Whether an entry's cwd no longer exists. Returns true ONLY on ENOENT (the path
 * is genuinely gone). Any other stat error (EACCES, EPERM, a transient I/O error)
 * is treated as "present/unknown" so we never reap an entry whose cwd we merely
 * cannot inspect — failing closed protects a live workflow.
 */
function cwdMissing(cwd: string): boolean {
  try {
    statSync(cwd);
    return false;
  } catch (err: any) {
    return err?.code === "ENOENT";
  }
}

/** Parse an ISO createdAt into epoch ms; null when missing/unparseable (treated as NOT old). */
function parseCreatedAtMs(createdAt: string | undefined): number | null {
  if (typeof createdAt !== "string") return null;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Gather reclaim signals for every registry entry (read-only — no lock, no
 * deletes). Used by `abg pairs prune` to BOTH build the dry-run preview and pick
 * which entries to hand to {@link removePairEntryAndDir} under `--apply`.
 *
 * Reads the registry once; per entry it stats the cwd and probes liveness with
 * the SAME `pairDirDaemonAlive` the in-lock delete gate uses, so the preview
 * matches the eventual action. `now` is injectable for deterministic tests.
 */
export function classifyReclaimableEntries(base: string, now: number = Date.now()): ReclaimableEntry[] {
  const reg = readRegistry(base);
  const out: ReclaimableEntry[] = [];
  for (const entry of reg.pairs) {
    const createdMs = parseCreatedAtMs(entry.createdAt);
    const ageMs = createdMs === null ? null : Math.max(0, now - createdMs);
    const signals: EntryReclaimSignals = {
      cwdGone: cwdMissing(entry.cwd),
      dead: !pairDirDaemonAlive(base, entry.pairId),
      // A null/unparseable createdAt is treated as NOT old, so a malformed entry
      // is never reaped on age grounds — it stays visible for manual `pairs rm`.
      old: ageMs !== null && ageMs >= RECLAIMABLE_MIN_AGE_MS,
      ageMs,
    };
    if (isEntryReclaimable(signals)) out.push({ entry, signals });
  }
  return out;
}
