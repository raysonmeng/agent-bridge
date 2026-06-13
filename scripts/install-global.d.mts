/** Type declarations for the testable helpers exported by install-global.mjs. */

export interface ActiveInstallPairInfo {
  pairId?: string;
  pairName?: string;
  cwd?: string;
  stateDir?: string;
  proxyUrl?: string;
}

export interface ActiveInstallSession {
  kind: "claude-frontend" | "codex-tui";
  pid: number;
  command: string;
  remoteUrl?: string | null;
  pair: ActiveInstallPairInfo & { label: string };
}

export function detectActiveInstallSessionsFromPsOutput(
  psOutput: string,
  pairInfos?: ActiveInstallPairInfo[],
): ActiveInstallSession[];

export function decideInstallPreflight(opts: {
  activeSessionCount: number;
  force: boolean;
  dryRun: boolean;
  isTTY: boolean;
}): { action: "allow" | "prompt" | "block"; reason: string };

/** Derive the install prefix from a resolved bin path like `<prefix>/bin/<name>`. */
export function installPrefixFromBinPath(binPath: string | null | undefined): string | null;

/** Result shape of the injectable `which` resolver (subset of spawnSync's return). */
export interface WhichResult {
  status: number | null;
  stdout: string;
}

/** Resolve the install prefix of the `agentbridge`/`abg` currently on PATH. */
export function resolveInstallPrefix(
  which?: (bin: string) => WhichResult,
): string | null;
