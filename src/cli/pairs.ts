import { join } from "node:path";
import { DaemonLifecycle } from "../daemon-lifecycle";
import {
  detectLegacyRootDaemon,
  listPairDirs,
  pairDirDaemonAlive,
  removePairEntryAndDir,
  removeUnregisteredPairDir,
  validatePairId,
  type PairEntry,
  type PairPorts,
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
      "Usage: abg pairs [--json] [--threads] | abg pairs rm <name|id> | abg pairs prune [--dry-run]",
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
 * `abg pairs prune [--dry-run]` — remove orphan pair state directories left under
 * `<base>/pairs` that have no registry entry and no live daemon. These accumulate
 * from older builds (and `abg pairs rm` before this change) that dropped the
 * registry entry without deleting the directory. Registered or live dirs are
 * never touched; `--dry-run` reports what would be removed without deleting.
 */
async function runPrune(args: string[]) {
  const dryRun = args.includes("--dry-run");
  for (const arg of args) {
    if (arg !== "--dry-run") {
      console.error(`Unknown prune argument: ${arg}`);
      console.error("Usage: abg pairs prune [--dry-run]");
      process.exit(1);
    }
  }

  const base = computeBaseDir();
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
    if (registered.has(id.toLowerCase())) {
      kept.push({ name, reason: "registered — use `abg pairs rm`" });
      continue;
    }
    // Cheap pre-filter using the SAME conservative liveness probe as the
    // authoritative in-lock gate (pairDirDaemonAlive), so a --dry-run preview
    // matches what a real prune would do and the pid logic lives in one place.
    if (pairDirDaemonAlive(base, id)) {
      kept.push({ name, reason: "daemon still alive" });
      continue;
    }
    if (dryRun) {
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

  printPruneSummary(removed, kept, dryRun);
}

function printPruneSummary(
  removed: string[],
  kept: Array<{ name: string; reason: string }>,
  dryRun: boolean,
) {
  if (removed.length === 0 && kept.length === 0) {
    console.log("No pair directories found.");
    return;
  }
  if (removed.length > 0) {
    console.log(dryRun ? "Would remove orphan pair directories:" : "Removed orphan pair directories:");
    for (const name of removed) console.log(`  ${name}`);
  } else {
    console.log(dryRun ? "No orphan pair directories to remove." : "No orphan pair directories removed.");
  }
  if (kept.length > 0) {
    console.log("Kept:");
    for (const { name, reason } of kept) console.log(`  ${name} (${reason})`);
  }
  if (dryRun) {
    console.log("\n(dry run — nothing was deleted. Re-run without --dry-run to apply.)");
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
