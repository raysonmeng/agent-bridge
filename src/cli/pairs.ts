import { join } from "node:path";
import { DaemonLifecycle } from "../daemon-lifecycle";
import {
  classifyReclaimableEntries,
  detectLegacyRootDaemon,
  listPairDirs,
  pairDirDaemonAlive,
  removePairEntryAndDir,
  removeUnregisteredPairDir,
  validatePairId,
  type PairEntry,
  type PairPorts,
  type ReclaimableEntry,
} from "../pair-registry";
import {
  computeBaseDir,
  findPairForFlag,
  listPairs,
  portsForEntry,
} from "../pair-resolver";
import { StateDirResolver } from "../state-dir";
import { readRawCurrentThread } from "../thread-state";
import { stopPairEntry } from "./kill";

interface PairRow {
  pairId: string;
  name: string;
  slot: number | null;
  ports: PairPorts;
  source: PairEntry["source"] | "legacy";
  cwd: string;
  running: boolean;
  pid: number | null;
  threadId: string | null;
  threadStatus: string | null;
  threadUpdatedAt: string | null;
}

export async function runPairs(args: string[] = []) {
  const [command, ...rest] = args;

  if (command === "rm") {
    await runRemove(rest);
    return;
  }

  if (command === "prune") {
    await runPrune(rest);
    return;
  }

  if (command && command !== "list" && command !== "--json" && command !== "--threads") {
    console.error(`Unknown pairs command: ${command}`);
    console.error(
      "Usage: abg pairs [--json] [--threads] | abg pairs rm <name|id> | abg pairs prune [--apply]",
    );
    process.exit(1);
  }

  const json = command === "--json" || rest.includes("--json");
  const includeThreads = rest.includes("--threads") || args.includes("--threads");
  const rows = await collectRows();
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  printTable(rows, { includeThreads });
}

async function runRemove(args: string[]) {
  const flag = args[0];
  if (!flag) {
    console.error("Error: `abg pairs rm <name|id>` requires a pair name or id.");
    process.exit(1);
  }

  const base = computeBaseDir();
  // Accept a cwd-scoped friendly name (e.g. "work") OR a raw composite id copied
  // from `abg pairs` — same resolution kill uses, for consistency.
  let pair: PairEntry | null;
  try {
    pair = findPairForFlag(base, process.cwd(), flag);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!pair) {
    console.log(`No such pair: "${flag}" in ${process.cwd()}`);
    printKnownPairs(base);
    return;
  }

  const stop = await stopPairEntry(base, pair);
  if (stop.error) {
    // Stopping failed (e.g. a process refused to die) — do NOT delete the
    // registry entry or its state dir, or we would orphan a still-running
    // daemon/TUI and leak its slot. Leave everything for a retry.
    console.error(
      `Error: failed to stop pair ${pair.pairId}; leaving it registered. ` +
        `${stop.error instanceof Error ? stop.error.message : String(stop.error)}`,
    );
    process.exit(1);
  }

  // Remove the registry entry AND the state dir atomically under the registry
  // lock (removePairEntryAndDir). Holding the lock across the delete closes the
  // re-register-DURING-delete window: a concurrent `abg claude/codex` re-registers
  // the same deterministic id under the SAME lock (in resolvePair), so it cannot
  // slip in between our membership/liveness check and the delete and have its
  // fresh dir removed. A live daemon in the dir aborts the delete (keptLive); a
  // dir-delete failure throws with the entry still registered (retryable via
  // prune). NOTE: a pre-existing launch-side window remains (a launcher that
  // reused the entry before we locked, pre-pid) — see removePairEntryAndDir.
  let result: { entry: PairEntry | null; dirRemoved: boolean; keptLive: boolean };
  try {
    result = await removePairEntryAndDir(base, pair.pairId);
  } catch (err) {
    console.error(
      `Error: could not delete state dir for ${pair.pairId}; registry entry kept — retry or run \`abg pairs prune\`. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (result.keptLive) {
    console.log(`Pair ${pair.pairId} is live again (relaunched concurrently); not removed. Stop it first, then retry.`);
    return;
  }

  const dirNote = result.dirRemoved ? " State directory deleted." : "";
  if (result.entry) {
    console.log(`Removed pair ${result.entry.pairId}; slot ${result.entry.slot} is now available.${dirNote}`);
  } else {
    console.log(`Pair ${pair.pairId} was already absent from the registry.${dirNote}`);
  }
}

/**
 * `abg pairs prune [--apply]` — reclaim two kinds of registry leak:
 *
 *   1. ORPHAN DIRS — a state dir under `<base>/pairs` with NO registry entry and
 *      no live daemon (older builds / pre-B1 `abg pairs rm` dropped the entry but
 *      left the dir). Reclaimed via removeUnregisteredPairDir.
 *   2. RECLAIMABLE ENTRIES (P1 #9) — a registry entry that is permanently invalid:
 *      its cwd is gone, no live daemon owns it, and it is older than
 *      RECLAIMABLE_MIN_AGE_MS. The canonical case is a double-hash-bug strand that
 *      permanently occupies a slot/port range. Reclaimed (entry + dir together)
 *      via removePairEntryAndDir.
 *
 * DRY RUN IS THE DEFAULT — the command only ever reports what it WOULD reclaim.
 * `--apply` is required to actually delete. Registered-and-valid, live, or
 * too-young entries/dirs are never touched.
 */
async function runPrune(args: string[]) {
  // Dry run is the default; deletion requires an explicit --apply. `--dry-run` is
  // still accepted as an explicit no-op alias for the default so older muscle
  // memory / scripts keep working.
  const apply = args.includes("--apply");
  for (const arg of args) {
    if (arg !== "--apply" && arg !== "--dry-run") {
      console.error(`Unknown prune argument: ${arg}`);
      console.error("Usage: abg pairs prune [--apply]");
      process.exit(1);
    }
  }
  if (apply && args.includes("--dry-run")) {
    console.error("Error: --apply and --dry-run are mutually exclusive.");
    console.error("Usage: abg pairs prune [--apply]");
    process.exit(1);
  }

  const base = computeBaseDir();

  // Classify reclaimable entries up front so the orphan-dir pass can SKIP the
  // dirs that the entry pass will reclaim — otherwise a stranded entry's dir is
  // double-reported (once as "registered" in Kept, once as a reclaimed entry).
  const reclaimable = classifyReclaimableEntries(base);
  const reclaimableIds = new Set(reclaimable.map((c) => c.entry.pairId.toLowerCase()));

  const dirResult = pruneOrphanDirs(base, apply, reclaimableIds);
  const entryResult = await pruneReclaimableEntries(reclaimable, base, apply);
  // The orphan-dir prune may itself perform locked deletes; await it after we
  // have its (synchronously-built) plan so both passes report coherently.
  const resolvedDirResult = await dirResult;

  printPruneSummary(resolvedDirResult, entryResult, apply);
}

interface OrphanDirResult {
  removed: string[];
  kept: Array<{ name: string; reason: string }>;
}

/**
 * Reclaim orphan pair state dirs (dir exists, no registry entry, not live).
 * `reclaimableIds` are the lowercased pairIds the ENTRY pass will reclaim — their
 * dirs are skipped here so they are not also reported as "registered" Kept dirs.
 */
async function pruneOrphanDirs(
  base: string,
  apply: boolean,
  reclaimableIds: ReadonlySet<string>,
): Promise<OrphanDirResult> {
  const registered = new Set(listPairs(base).map((pair) => pair.pairId.toLowerCase()));
  const removed: string[] = [];
  const kept: Array<{ name: string; reason: string }> = [];

  for (const name of listPairDirs(base)) {
    let id: string;
    try {
      id = validatePairId(name);
    } catch {
      kept.push({ name, reason: "not a managed pair-id directory" });
      continue;
    }
    // validatePairId trims surrounding whitespace; only ever act on a dir whose
    // raw on-disk name IS the canonical id, so a hand-crafted " main" can never
    // be trimmed into and delete a different real pair "main".
    if (id !== name) {
      kept.push({ name, reason: "directory name is not a canonical pair id" });
      continue;
    }
    // The entry pass owns this dir (it will reclaim the entry + dir together) —
    // don't report it here at all.
    if (reclaimableIds.has(id.toLowerCase())) {
      continue;
    }
    if (registered.has(id.toLowerCase())) {
      kept.push({ name, reason: "registered — use `abg pairs rm`" });
      continue;
    }
    // Cheap pre-filter using the SAME conservative liveness probe as the
    // authoritative in-lock gate (pairDirDaemonAlive), so the dry-run preview
    // matches what a real prune would do and the pid logic lives in one place.
    if (pairDirDaemonAlive(base, id)) {
      kept.push({ name, reason: "daemon still alive" });
      continue;
    }
    if (!apply) {
      removed.push(name);
      continue;
    }
    try {
      // Delete under the registry lock so a concurrent (re)registration or a
      // daemon start for this id cannot race the orphan check — under the lock
      // removeUnregisteredPairDir re-verifies membership AND liveness before it
      // removes anything (the initial gates above are just a cheap pre-filter).
      const outcome = await removeUnregisteredPairDir(base, id);
      if (outcome.removed) {
        removed.push(name);
      } else if (outcome.reason === "registered") {
        kept.push({ name, reason: "registered during prune — use `abg pairs rm`" });
      } else if (outcome.reason === "live") {
        kept.push({ name, reason: "daemon became live during prune" });
      } else {
        kept.push({ name, reason: "already gone" });
      }
    } catch (err) {
      kept.push({ name, reason: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return { removed, kept };
}

interface EntryReclaimResult {
  /** Entries reclaimed (--apply) or that WOULD be reclaimed (default dry run). */
  reclaimed: Array<{ pairId: string; slot: number; reason: string }>;
  /** Entries skipped at apply time because a concurrent relaunch made them live. */
  kept: Array<{ pairId: string; reason: string }>;
}

/**
 * Reclaim permanently-invalid registry entries (cwd-gone + dead + old).
 *
 * `candidates` is the read-only classification from `classifyReclaimableEntries`,
 * which also builds the dry-run preview. Under `--apply` each candidate is deleted
 * via `removePairEntryAndDir`, whose in-lock liveness gate is the authoritative
 * check: if a relaunch made the pair live between classify and delete, it is kept
 * (keptLive), never destroyed.
 */
async function pruneReclaimableEntries(
  candidates: ReclaimableEntry[],
  base: string,
  apply: boolean,
): Promise<EntryReclaimResult> {
  const reclaimed: Array<{ pairId: string; slot: number; reason: string }> = [];
  const kept: Array<{ pairId: string; reason: string }> = [];

  for (const candidate of candidates) {
    const reason = describeReclaimReason(candidate);
    if (!apply) {
      reclaimed.push({ pairId: candidate.entry.pairId, slot: candidate.entry.slot, reason });
      continue;
    }
    try {
      const res = await removePairEntryAndDir(base, candidate.entry.pairId);
      if (res.keptLive) {
        kept.push({ pairId: candidate.entry.pairId, reason: "became live during prune" });
      } else {
        reclaimed.push({ pairId: candidate.entry.pairId, slot: candidate.entry.slot, reason });
      }
    } catch (err) {
      kept.push({
        pairId: candidate.entry.pairId,
        reason: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { reclaimed, kept };
}

/** Human-readable reason string for a reclaimable entry (cwd-gone, dead, age). */
function describeReclaimReason(candidate: ReclaimableEntry): string {
  const { signals } = candidate;
  const age = signals.ageMs === null ? "age?" : `age ${formatAgeDays(signals.ageMs)}`;
  return `cwd-gone, dead, ${age}`;
}

/** Format a millisecond age as a compact "Nd" / "N.Nd" day count for the reason line. */
function formatAgeDays(ageMs: number): string {
  const days = ageMs / (24 * 60 * 60 * 1000);
  return days >= 10 ? `${Math.round(days)}d` : `${days.toFixed(1)}d`;
}

function printPruneSummary(dirResult: OrphanDirResult, entryResult: EntryReclaimResult, apply: boolean) {
  const { removed: dirsRemoved, kept: dirsKept } = dirResult;
  const { reclaimed: entriesReclaimed, kept: entriesKept } = entryResult;

  const nothingFound =
    dirsRemoved.length === 0 &&
    dirsKept.length === 0 &&
    entriesReclaimed.length === 0 &&
    entriesKept.length === 0;
  if (nothingFound) {
    console.log("Nothing to prune: no orphan pair directories or reclaimable entries found.");
    return;
  }

  // --- Orphan dirs ---
  if (dirsRemoved.length > 0) {
    console.log(apply ? "Removed orphan pair directories:" : "Would remove orphan pair directories:");
    for (const name of dirsRemoved) console.log(`  ${name}`);
  }

  // --- Reclaimable entries ---
  if (entriesReclaimed.length > 0) {
    console.log(apply ? "Reclaimed registry entries:" : "Would reclaim registry entries:");
    for (const { pairId, slot, reason } of entriesReclaimed) {
      console.log(`  ${pairId} (slot ${slot}) — ${reason}`);
    }
  }

  if (dirsRemoved.length === 0 && entriesReclaimed.length === 0) {
    console.log(apply ? "Nothing was reclaimed." : "Nothing to reclaim.");
  }

  // --- Kept (skipped) ---
  const keptLines = [
    ...dirsKept.map(({ name, reason }) => `  ${name} (${reason})`),
    ...entriesKept.map(({ pairId, reason }) => `  ${pairId} (${reason})`),
  ];
  if (keptLines.length > 0) {
    console.log("Kept:");
    for (const line of keptLines) console.log(line);
  }

  if (!apply) {
    console.log("\n(dry run — nothing was deleted. Re-run with --apply to reclaim.)");
  }
}

async function collectRows(): Promise<PairRow[]> {
  const base = computeBaseDir();
  const rows = await Promise.all(listPairs(base).map((pair) => rowForPair(base, pair)));
  const legacy = detectLegacyRootDaemon(base);
  if (legacy) {
    rows.push({
      pairId: "(legacy-root)",
      name: "-",
      slot: null,
      ports: { appPort: 4500, proxyPort: 4501, controlPort: legacy.controlPort },
      source: "legacy",
      cwd: base,
      running: true,
      pid: legacy.pid,
      threadId: null,
      threadStatus: null,
      threadUpdatedAt: null,
    });
  }
  return rows;
}

async function rowForPair(base: string, pair: PairEntry): Promise<PairRow> {
  const ports = portsForEntry(pair);
  const stateDir = new StateDirResolver(join(base, "pairs", pair.pairId));
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort: ports.controlPort,
    log: () => {},
  });
  const [running, status] = await Promise.all([
    lifecycle.isHealthy(),
    Promise.resolve(lifecycle.readStatus()),
  ]);
  const thread = readRawCurrentThread(stateDir);

  return {
    pairId: pair.pairId,
    name: pair.name ?? "-",
    slot: pair.slot,
    ports,
    source: pair.source,
    cwd: pair.cwd,
    running,
    pid: typeof status?.pid === "number" ? status.pid : null,
    threadId: thread?.threadId ?? null,
    threadStatus: thread?.status ?? null,
    threadUpdatedAt: thread?.updatedAt ?? null,
  };
}

function printTable(rows: PairRow[], options: { includeThreads?: boolean } = {}) {
  if (rows.length === 0) {
    console.log("No pairs registered.");
    return;
  }

  const data = rows.map((row) => ({
    name: row.name,
    pairId: row.pairId,
    slot: row.slot === null ? "-" : String(row.slot),
    ports: `${row.ports.appPort}/${row.ports.proxyPort}/${row.ports.controlPort}`,
    source: row.source,
    cwd: row.cwd,
    status: row.running ? "running" : "stopped",
    pid: row.pid === null ? "-" : String(row.pid),
    thread: row.threadId === null ? "-" : row.threadId,
    threadStatus: row.threadStatus === null ? "-" : row.threadStatus,
  }));

  const headers = {
    name: "name",
    pairId: "pairId",
    slot: "slot",
    ports: "app/proxy/control",
    source: "source",
    status: "status",
    pid: "pid",
    thread: "threadId",
    threadStatus: "thread",
    cwd: "cwd",
  };
  const visibleKeys = options.includeThreads
    ? ["name", "pairId", "slot", "ports", "source", "status", "pid", "thread", "threadStatus", "cwd"] as const
    : ["name", "pairId", "slot", "ports", "source", "status", "pid", "cwd"] as const;
  const widths = Object.fromEntries(
    visibleKeys.map((key) => [
      key,
      Math.max(
        headers[key as keyof typeof headers].length,
        ...data.map((row) => row[key as keyof typeof row].length),
      ),
    ]),
  ) as Record<keyof typeof headers, number>;

  const line = (row: Record<keyof typeof headers, string>) =>
    visibleKeys.map((key) => row[key].padEnd(widths[key])).join("  ");

  console.log(line(headers));
  console.log(
    visibleKeys.map((key) => "-".repeat(widths[key])).join("  "),
  );
  for (const row of data) {
    console.log(line(row));
  }
}

function printKnownPairs(base: string) {
  const pairs = listPairs(base);
  if (pairs.length === 0) {
    console.log("No pairs registered.");
    return;
  }
  console.log("Known pairs:");
  for (const pair of pairs) {
    console.log(`  ${pair.pairId}`);
  }
}
