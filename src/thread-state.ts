import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import type { StateDirResolver } from "./state-dir";

export type CurrentThreadStatus = "pending" | "current";

export interface CurrentThreadState {
  version: 1;
  status: CurrentThreadStatus;
  pairId: string | null;
  pairName?: string;
  cwd: string;
  threadId: string;
  updatedAt: string;
  reason?: string;
  rolloutPath?: string;
  rolloutVerifiedAt?: string;
  tag?: string;
}

export interface ThreadIdentity {
  stateDir: StateDirResolver;
  pairId: string | null;
  pairName?: string;
  cwd: string;
}

export interface CodexContractInjection {
  threadId: string;
  contractHash: string;
  injectedAt: string;
}

export interface CodexContractState {
  version: 1;
  injections: CodexContractInjection[];
}

const MAX_CODEX_CONTRACT_INJECTIONS = 256;
const CODEX_CONTRACT_HASH_RE = /^[0-9a-f]{12}$/;

function nowIso(): string {
  return new Date().toISOString();
}

function threadTag(identity: ThreadIdentity): string {
  const name = identity.pairName ?? identity.pairId ?? "manual";
  return `abg:${name}:${identity.cwd}`;
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homedir(), ".codex");
}

export function readRawCurrentThread(stateDir: StateDirResolver): CurrentThreadState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateDir.currentThreadFile, "utf-8"));
    if (
      parsed?.version === 1 &&
      typeof parsed.threadId === "string" &&
      parsed.threadId.length > 0 &&
      (parsed.status === "pending" || parsed.status === "current") &&
      typeof parsed.cwd === "string"
    ) {
      return parsed as CurrentThreadState;
    }
  } catch {
    // Missing/corrupt state is treated as no usable mapping. Doctor can report it later.
  }
  return null;
}

function parseCodexContractInjection(value: unknown): CodexContractInjection | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" || record.threadId.length === 0 ||
    typeof record.contractHash !== "string" || !CODEX_CONTRACT_HASH_RE.test(record.contractHash) ||
    typeof record.injectedAt !== "string" || record.injectedAt.length === 0
  ) {
    return null;
  }
  return {
    threadId: record.threadId,
    contractHash: record.contractHash,
    injectedAt: record.injectedAt,
  };
}

/** Read the bounded per-pair runtime-contract ledger. Missing/corrupt = empty. */
export function readCodexContractState(stateDir: StateDirResolver): CodexContractState {
  try {
    const parsed = JSON.parse(readFileSync(stateDir.codexContractStateFile, "utf-8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.injections)) {
      return { version: 1, injections: [] };
    }
    return {
      version: 1,
      injections: parsed.injections
        .map(parseCodexContractInjection)
        .filter((entry: CodexContractInjection | null): entry is CodexContractInjection => entry !== null)
        .slice(-MAX_CODEX_CONTRACT_INJECTIONS),
    };
  } catch {
    return { version: 1, injections: [] };
  }
}

export function readCodexContractHash(
  stateDir: StateDirResolver,
  threadId: string,
): string | null {
  const injections = readCodexContractState(stateDir).injections;
  for (let index = injections.length - 1; index >= 0; index--) {
    if (injections[index]?.threadId === threadId) {
      return injections[index]!.contractHash;
    }
  }
  return null;
}

/**
 * Atomically upsert the latest injected contract for a thread. The ledger is
 * bounded because pair state can outlive many archived Codex threads.
 */
export function persistCodexContractInjection(
  stateDir: StateDirResolver,
  threadId: string,
  contractHash: string,
): CodexContractState {
  if (!threadId || !CODEX_CONTRACT_HASH_RE.test(contractHash)) {
    throw new Error("Codex contract state requires a non-empty threadId and a 12-character lowercase hex hash");
  }
  const prior = readCodexContractState(stateDir).injections.filter(
    (entry) => entry.threadId !== threadId,
  );
  const state: CodexContractState = {
    version: 1,
    injections: [
      ...prior,
      { threadId, contractHash, injectedAt: nowIso() },
    ].slice(-MAX_CODEX_CONTRACT_INJECTIONS),
  };
  atomicWriteJson(stateDir.codexContractStateFile, state);
  return state;
}

export function findCodexRolloutFile(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
  maxEntries = 20000,
): string | null {
  const sessionsDir = join(codexHome(env), "sessions");
  if (!threadId || !existsSync(sessionsDir)) return null;

  const exactName = `rollout-${threadId}.jsonl`;
  const stack = [sessionsDir];
  let visited = 0;

  while (stack.length > 0 && visited < maxEntries) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited++;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;

      const name = basename(entry.name);
      if (name === exactName || (name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(threadId))) {
        return path;
      }
    }
  }

  return null;
}

export function writePendingCurrentThread(
  identity: ThreadIdentity,
  threadId: string,
  reason?: string,
): CurrentThreadState {
  const state: CurrentThreadState = {
    version: 1,
    status: "pending",
    pairId: identity.pairId,
    pairName: identity.pairName,
    cwd: identity.cwd,
    threadId,
    updatedAt: nowIso(),
    reason,
    tag: threadTag(identity),
  };
  atomicWriteJson(identity.stateDir.currentThreadFile, state);
  return state;
}

export function promoteCurrentThreadIfRolloutExists(
  identity: ThreadIdentity,
  threadId: string,
  reason?: string,
  env: NodeJS.ProcessEnv = process.env,
): CurrentThreadState {
  const rolloutPath = findCodexRolloutFile(threadId, env);
  const state: CurrentThreadState = {
    version: 1,
    status: rolloutPath ? "current" : "pending",
    pairId: identity.pairId,
    pairName: identity.pairName,
    cwd: identity.cwd,
    threadId,
    updatedAt: nowIso(),
    reason,
    tag: threadTag(identity),
    ...(rolloutPath ? { rolloutPath, rolloutVerifiedAt: nowIso() } : {}),
  };
  atomicWriteJson(identity.stateDir.currentThreadFile, state);
  return state;
}

export async function persistCurrentThreadWithRolloutRetry(
  identity: ThreadIdentity,
  threadId: string,
  reason: string,
  options: {
    env?: NodeJS.ProcessEnv;
    attempts?: number;
    delayMs?: number;
    log?: (message: string) => void;
    /**
     * Guard checked before every write. Return false to ABANDON a now-stale
     * loop: when a newer thread switch supersedes this one, the daemon fires a
     * fresh retry loop, and this (older) loop must stop writing — otherwise the
     * two loops race and the stale one can clobber current-thread.json with an
     * abandoned threadId (wrong/broken auto-resume). Default: always continue.
     */
    shouldContinue?: () => boolean;
  } = {},
): Promise<CurrentThreadState | null> {
  const env = options.env ?? process.env;
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 250;
  const shouldContinue = options.shouldContinue ?? (() => true);

  if (!shouldContinue()) return null;
  writePendingCurrentThread(identity, threadId, reason);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!shouldContinue()) {
      options.log?.(`Abandoned current-thread persistence for ${threadId}: a newer thread became active`);
      return null;
    }
    const state = promoteCurrentThreadIfRolloutExists(identity, threadId, reason, env);
    if (state.status === "current") {
      options.log?.(`Current Codex thread persisted: ${threadId} (${state.rolloutPath})`);
      return state;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!shouldContinue()) return null;
  options.log?.(`Current Codex thread left pending because no rollout file was found: ${threadId}`);
  return readRawCurrentThread(identity.stateDir) ?? writePendingCurrentThread(identity, threadId, reason);
}

export function readUsableCurrentThread(
  identity: ThreadIdentity,
  env: NodeJS.ProcessEnv = process.env,
): CurrentThreadState | null {
  const state = readRawCurrentThread(identity.stateDir);
  if (!state) return null;
  // Identity checks come FIRST: a record from another pair or cwd is never
  // usable here and must never be promoted/repaired by this reader.
  if (state.pairId !== identity.pairId) return null;
  if (state.cwd !== identity.cwd) return null;

  if (state.status === "pending") {
    // The daemon's rollout-retry window is short (~5s); Codex often writes the
    // rollout file later. Re-verify on the spot so a long-lived session is not
    // permanently locked out of resume by a slow first flush.
    const rolloutPath = findCodexRolloutFile(state.threadId, env);
    if (!rolloutPath) return null;

    const promoted: CurrentThreadState = {
      ...state,
      status: "current",
      rolloutPath,
      rolloutVerifiedAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      atomicWriteJson(identity.stateDir.currentThreadFile, promoted);
    } catch {
      // Persisting the promotion is best-effort: the rollout file itself was
      // just verified, so resume can proceed on the in-memory state — a disk
      // hiccup must not break the resume path. Doctor can report it later.
    }
    return promoted;
  }

  if (state.rolloutPath && existsSync(state.rolloutPath)) return state;

  const rolloutPath = findCodexRolloutFile(state.threadId, env);
  if (!rolloutPath) return null;

  const repaired: CurrentThreadState = {
    ...state,
    rolloutPath,
    rolloutVerifiedAt: nowIso(),
    updatedAt: nowIso(),
  };
  atomicWriteJson(identity.stateDir.currentThreadFile, repaired);
  return repaired;
}
