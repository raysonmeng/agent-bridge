import { StateDirResolver } from "./state-dir";
import {
  type PairEntry,
  type PairPorts,
  derivePairId,
  portsForSlot,
  readRegistry,
  removePairEntry,
  resolvePair,
  validatePairId,
} from "./pair-registry";

/**
 * Pair resolution glue — the env-injection seam between the pure pair registry
 * and the CLI's process-env world.
 *
 * The CLI entrypoints (`runClaude` / `runCodex`) call `applyPairEnv` at the very
 * top: it allocates/looks-up the pair's slot and sets the four env vars that the
 * rest of the system already reads (state dir + the three ports). The existing
 * StateDirResolver / DaemonLifecycle / daemon then "just work", and the spawned
 * `claude` / `codex` children inherit the env, so the plugin's MCP server and
 * the Codex proxy connect to the right per-pair daemon.
 */

export interface PairResolution {
  pairId: string;
  slot: number | null;
  ports: PairPorts;
  stateDir: StateDirResolver;
  /** Friendly, cwd-scoped name ("main" by default; "(manual)" in legacy mode). */
  name: string;
  /** True when running in legacy/manual single-pair mode (env pinned, no --pair). */
  manual: boolean;
}

/**
 * The registry base dir (the dir that contains `pairs/`).
 *
 * `AGENTBRIDGE_BASE_DIR` is the dedicated, unambiguous base override. It is
 * preferred over `AGENTBRIDGE_STATE_DIR` precisely because `applyPairEnv`
 * rewrites `AGENTBRIDGE_STATE_DIR` to the PER-PAIR dir (`<base>/pairs/<id>`):
 * a child process (`abg pairs`, `abg kill`) that inherits the pair env must
 * still resolve the registry at the real base, not at the pair's own state dir.
 * Falls back to `AGENTBRIDGE_STATE_DIR` (relocated single base) then the platform default.
 */
export function computeBaseDir(): string {
  // `||` (not `??`) so an empty-string env is treated as unset rather than a
  // valid relative path.
  return (
    process.env.AGENTBRIDGE_BASE_DIR ||
    process.env.AGENTBRIDGE_STATE_DIR ||
    StateDirResolver.platformBaseDir()
  );
}

/** Extract `--pair <name>` / `--pair=<name>`, returning the remaining args untouched. */
export function parsePairFlag(args: string[]): { pairFlag?: string; rest: string[] } {
  const rest: string[] = [];
  let pairFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--pair") {
      const next = args[i + 1];
      // Consume the value only if it looks like a value (not another flag / EOL).
      // A missing value becomes "" so resolution throws a clear PAIR_ID_INVALID
      // instead of silently falling back to a cwd-derived pair.
      if (next !== undefined && !next.startsWith("-")) {
        pairFlag = next;
        i++;
      } else {
        pairFlag = "";
      }
      continue;
    }
    if (a.startsWith("--pair=")) {
      pairFlag = a.slice("--pair=".length);
      continue;
    }
    rest.push(a);
  }
  return { pairFlag, rest };
}

/** Parse `abg kill` flags: `--all` and/or `--pair <name>`. No flag ⇒ kill all. */
export function parseKillArgs(args: string[]): { all: boolean; pairFlag?: string } {
  let all = false;
  let pairFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--all") {
      all = true;
      continue;
    }
    if (a === "--pair") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        pairFlag = next;
        i++;
      } else {
        pairFlag = "";
      }
      continue;
    }
    if (a.startsWith("--pair=")) {
      pairFlag = a.slice("--pair=".length);
    }
  }
  return { all, pairFlag };
}

/**
 * Resolve the pair for this invocation and inject its env so downstream code and
 * spawned children pick up the right state dir + ports.
 *
 * Manual/legacy mode: if the caller explicitly pinned the state dir or any port
 * via env AND gave no `--pair`, behave exactly like the classic single pair
 * (no registry, no slot) — this preserves power-user overrides and the existing
 * e2e harness. An explicit `--pair` always forces multi-pair resolution.
 */
export async function applyPairEnv(opts: { pairFlag?: string }): Promise<PairResolution> {
  // Truthiness (not `!= null`) so an empty-string env counts as unset.
  const explicitEnv =
    !!process.env.AGENTBRIDGE_STATE_DIR ||
    !!process.env.AGENTBRIDGE_CONTROL_PORT ||
    !!process.env.CODEX_WS_PORT ||
    !!process.env.CODEX_PROXY_PORT;

  if (opts.pairFlag === undefined && explicitEnv) {
    const stateDir = new StateDirResolver();
    const controlPort = Number.parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
    const appPort = Number.parseInt(process.env.CODEX_WS_PORT ?? "4500", 10);
    const proxyPort = Number.parseInt(process.env.CODEX_PROXY_PORT ?? "4501", 10);
    return {
      pairId: "(manual)",
      slot: null,
      ports: { appPort, proxyPort, controlPort },
      stateDir,
      name: "(manual)",
      manual: true,
    };
  }

  const base = computeBaseDir();
  const resolved = await resolvePair(base, { pairFlag: opts.pairFlag, cwd: process.cwd() });

  // Pin the base explicitly so child processes (abg pairs / kill, spawned tools)
  // resolve the SAME registry even though AGENTBRIDGE_STATE_DIR below is rewritten
  // to the per-pair dir.
  process.env.AGENTBRIDGE_BASE_DIR = base;
  process.env.AGENTBRIDGE_PAIR_ID = resolved.pairId;
  process.env.AGENTBRIDGE_PAIR_NAME = resolved.name;
  process.env.AGENTBRIDGE_STATE_DIR = resolved.stateDir;
  process.env.AGENTBRIDGE_CONTROL_PORT = String(resolved.ports.controlPort);
  process.env.CODEX_WS_PORT = String(resolved.ports.appPort);
  process.env.CODEX_PROXY_PORT = String(resolved.ports.proxyPort);

  return {
    pairId: resolved.pairId,
    slot: resolved.slot,
    ports: resolved.ports,
    stateDir: new StateDirResolver(resolved.stateDir),
    name: resolved.name,
    manual: false,
  };
}

/** All registered pairs (for `abg pairs`). */
export function listPairs(base: string): PairEntry[] {
  return readRegistry(base).pairs;
}

/** Look up a single pair entry by id (case-insensitive), without allocating. */
export function findPair(base: string, pairId: string): PairEntry | null {
  const lower = pairId.toLowerCase();
  return readRegistry(base).pairs.find((p) => p.pairId.toLowerCase() === lower) ?? null;
}

/**
 * Resolve `--pair <flag>` to a registry entry the way a launch would.
 *
 * The friendly name is scoped to `cwd` (same name in another directory is a
 * different pair), so kill/pairs must compose it with the cwd hash first. Falls
 * back to a raw pairId match so an explicit composite id copied from `abg pairs`
 * (which is cwd-independent) also resolves regardless of where it is run.
 *
 * Throws PAIR_ID_INVALID (via validatePairId) for a malformed flag.
 */
export function findPairForFlag(base: string, cwd: string, flag: string): PairEntry | null {
  const name = validatePairId(flag);
  const scopedId = derivePairId(cwd, name);
  return findPair(base, scopedId) ?? findPair(base, flag);
}

/** Ports for a pair entry (convenience for kill/pairs). */
export function portsForEntry(entry: PairEntry): PairPorts {
  return portsForSlot(entry.slot);
}

/** Remove a pair entry from the registry, freeing its slot. */
export async function removePair(base: string, pairId: string): Promise<PairEntry | null> {
  return removePairEntry(base, pairId);
}
