/**
 * Shared semver helpers. Kept dependency-free (AgentBridge has zero runtime
 * deps) and deliberately conservative: we only ever reason about plain
 * `MAJOR.MINOR.PATCH` stable versions. Prerelease/build metadata is treated as
 * "not a stable version" so the update notifier never nags users about betas.
 */

/** A strict stable semver: exactly three numeric dot-segments, e.g. `0.1.6`. */
const STABLE_SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** True when `v` is a clean stable `X.Y.Z` (no prerelease/build suffix, no `v` prefix). */
export function isStableVersion(v: string): boolean {
  return STABLE_SEMVER_RE.test(v.trim());
}

/**
 * Compare two `X.Y.Z` version strings. Returns -1 if a<b, 0 if equal, 1 if a>b.
 * Missing segments are treated as 0; non-numeric segments collapse to NaN which
 * compares as neither `<` nor `>` (callers should pass stable versions — see
 * `isStableVersion`). Matches the original comparator extracted from init.ts.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * True only when `latest` is a STABLE version strictly greater than a STABLE
 * `current`. If either side is missing / prerelease / malformed, returns false —
 * we never surface a downgrade, an equal version, a beta, or a garbage tag.
 */
export function isStableUpgrade(current: string, latest: string): boolean {
  if (!isStableVersion(current) || !isStableVersion(latest)) return false;
  return compareVersions(latest, current) === 1;
}
