import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { basename, join } from "node:path";

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
}

export type PairErrorCode =
  | "PAIR_PORTS_BUSY"
  | "PAIR_ID_INVALID"
  | "PAIR_LOCK_TIMEOUT"
  | "PAIR_REGISTRY_CORRUPT"
  | "PAIR_LEGACY_ROOT_DAEMON";

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

/** `process.kill(pid, 0)` liveness, but treat EPERM (exists, not signalable by us) as ALIVE. */
function pidLooksAlive(pid: number): boolean {
  // pid <= 0 is never a real holder: process.kill(0, 0) targets the current
  // process GROUP and "succeeds", which would wrongly mark a corrupt
  // `{pid:0}` lock as live and deadlock acquisition. Negatives are signal-broadcast
  // semantics, not a pid. Treat all of these as dead so the lock is reclaimable.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
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

function isDaemonProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
    return cmd.includes("daemon") && (cmd.includes("agentbridge") || cmd.includes("agent_bridge"));
  } catch {
    return false;
  }
}

/**
 * Detect a pre-multi-pair daemon that wrote its pid directly at <base>/daemon.pid
 * (the classic single-pair layout) and is still alive on control port 4502.
 * Returns its pid, or null.
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
  if (!Number.isFinite(pid) || !pidLooksAlive(pid) || !isDaemonProcess(pid)) return null;
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
 * Resolve (and, if new, allocate) the pair for this invocation.
 *
 * Allocation happens under the cross-process lock; port probing happens after
 * releasing it (probing is slow and must not serialize all CLI starts). Re-running
 * for the same pair is idempotent — the slot is reused and a healthy daemon on the
 * control port is treated as "already running", not a conflict.
 *
 * UPGRADE NOTE: the pairId scheme changed to the cwd-scoped `<name>-<hash>` form.
 * Entries written by an older build (verbatim `--pair` ids, or a different
 * cwd-derivation) will NOT be matched here, so a launch allocates a fresh slot
 * rather than reusing the legacy one. The legacy entry remains visible in
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

  const { slot, entry, isNew } = await withRegistryLock(base, () => {
    const reg = readRegistry(base);
    const existing = reg.pairs.find((p) => p.pairId.toLowerCase() === lower);
    if (existing) return { slot: existing.slot, entry: existing, isNew: false };

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
    return { slot: newSlot, entry: newEntry, isNew: true };
  });

  const ports = portsForSlot(slot);

  // Probe ports ONLY for a brand-new slot allocation. For an existing pair
  // (idempotent re-run) the daemon may already own these ports, or a concurrent
  // same-pair launch may be mid-bind — so we defer conflict detection to the
  // daemon's own bind + health check rather than risk a false PAIR_PORTS_BUSY.
  //
  // Note: a new entry is durably committed (under the lock) before this probe.
  // A probe failure leaves a reserved "ghost" slot that a re-run reuses
  // idempotently or that `abg pairs rm` clears. Probing is a best-effort
  // external-squatter check, not a correctness guarantee (port use is TOCTOU);
  // the daemon's bind is the final arbiter.
  if (isNew && opts.probePorts !== false) {
    for (const port of [ports.appPort, ports.proxyPort, ports.controlPort]) {
      if (!(await probePortFree(port))) {
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
  return {
    pairId: entry.pairId,
    slot,
    ports,
    stateDir: join(pairsDir(base), entry.pairId),
    name: entry.name ?? name,
    entry,
  };
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
