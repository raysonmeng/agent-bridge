import { realpathSync } from "node:fs";

/**
 * Cwd identity helpers shared by the pair registry (pair-id hashing), the
 * daemon identity gate and the thread-state reader. Dependency-free on purpose
 * so low-level modules can import it without cycles.
 */

/**
 * The realpath string that pair ids are hashed from.
 *
 * Keeps the historical `realpathSync` result exactly, with ONE win32 addition:
 * the drive letter is upper-cased. `realpathSync` echoes the caller's drive
 * case, and shells / IDEs / Claude Code disagree on it (`c:\proj` vs `C:\proj`),
 * so the two sides of a pair derived different ids for the same directory.
 *
 * Deliberately NOT `realpathSync.native`: that also rewrites the case of every
 * path component and resolves subst / mapped drives, which would silently
 * change the id of already-registered pairs and orphan their daemons. Only the
 * drive letter (whose lower-case spelling already produced a split pair) moves.
 */
export function realCwdForHash(cwd: string, platform: NodeJS.Platform = process.platform): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    real = cwd;
  }
  return platform === "win32" ? upperDriveLetter(real) : real;
}

/**
 * Same-directory test for two cwd strings (registry entry, client identity,
 * daemon cwd, thread record). win32 compares case-insensitively on the
 * drive-normalised realpath (NTFS is case-insensitive); POSIX stays exact.
 */
export function sameCwd(
  a: string | null | undefined,
  b: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (platform !== "win32") return false;
  return realCwdForHash(a, platform).toLowerCase() === realCwdForHash(b, platform).toLowerCase();
}

function upperDriveLetter(path: string): string {
  return path.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
}
