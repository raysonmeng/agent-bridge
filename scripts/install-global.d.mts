/** Type declarations for the testable helpers exported by install-global.mjs. */

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
