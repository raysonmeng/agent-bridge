import { CONTRACT_VERSION } from "./contract-version";

declare const __AGENTBRIDGE_BUILD_VERSION__: string | undefined;
declare const __AGENTBRIDGE_BUILD_COMMIT__: string | undefined;
declare const __AGENTBRIDGE_BUILD_BUNDLE__: "source" | "dist" | "plugin" | undefined;
declare const __AGENTBRIDGE_CONTRACT_VERSION__: number | undefined;
declare const __AGENTBRIDGE_BUILD_CODEHASH__: string | undefined;

export type AgentBridgeBundleKind = "source" | "dist" | "plugin";

export interface AgentBridgeBuildInfo {
  version: string;
  commit: string;
  bundle: AgentBridgeBundleKind;
  contractVersion: number;
  /**
   * Deterministic hash of the BUILD-INPUT source tree (scripts/code-hash.cjs):
   * sha256 over src non-test .ts files + package.json + bun.lock + bun version,
   * truncated to 12 hex. Unlike the commit stamp it does not move when only the
   * git sha moves (squash-merge re-stamps), so it is the authoritative code
   * identity for drift detection. OPTIONAL because legacy daemons predate the
   * field; "source" is the unstamped sentinel (dev/source mode).
   */
  codeHash?: string;
}

/** Sentinel for an unstamped (source-mode) build — never a valid code identity. */
const CODE_HASH_SENTINEL = "source";

/** A codeHash is a usable code identity only when present, non-empty and not the sentinel. */
export function hasValidCodeHash(build: AgentBridgeBuildInfo | null | undefined): boolean {
  const hash = build?.codeHash;
  return typeof hash === "string" && hash.length > 0 && hash !== CODE_HASH_SENTINEL;
}

function defineString(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function defineBundle(value: string | undefined): AgentBridgeBundleKind {
  if (value === "source" || value === "dist" || value === "plugin") return value;
  return import.meta.url.endsWith(".ts") ? "source" : "dist";
}

function defineNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const BUILD_INFO: AgentBridgeBuildInfo = Object.freeze({
  version: defineString(
    typeof __AGENTBRIDGE_BUILD_VERSION__ === "string" ? __AGENTBRIDGE_BUILD_VERSION__ : undefined,
    "0.0.0-source",
  ),
  commit: defineString(
    typeof __AGENTBRIDGE_BUILD_COMMIT__ === "string" ? __AGENTBRIDGE_BUILD_COMMIT__ : undefined,
    "source",
  ),
  bundle: defineBundle(
    typeof __AGENTBRIDGE_BUILD_BUNDLE__ === "string" ? __AGENTBRIDGE_BUILD_BUNDLE__ : undefined,
  ),
  // Fallback imports the single source (src/contract-version.ts) — the build
  // define and this fallback previously hardcoded "1" independently, so a
  // contract bump touching only one side split source-mode and bundled builds
  // into mutually "incompatible" contracts.
  contractVersion: defineNumber(
    typeof __AGENTBRIDGE_CONTRACT_VERSION__ === "number" ? __AGENTBRIDGE_CONTRACT_VERSION__ : undefined,
    CONTRACT_VERSION,
  ),
  // The fallback MUST be the literal "source" (== CODE_HASH_SENTINEL), not the
  // constant: bundlers keep the literal inline, which preserves the extractable
  // stamp shape `codeHash: defineString("<hash>", "source")` that doctor's
  // artifact-alignment check (and the code-hash build test) regex out of
  // bundles — exactly like the commit stamp's `defineString("<sha>", "source")`.
  codeHash: defineString(
    typeof __AGENTBRIDGE_BUILD_CODEHASH__ === "string" ? __AGENTBRIDGE_BUILD_CODEHASH__ : undefined,
    "source",
  ),
});

export function daemonStatusBuildInfo(): AgentBridgeBuildInfo {
  return { ...BUILD_INFO };
}

export function sameBuildInfo(a: AgentBridgeBuildInfo | null | undefined, b: AgentBridgeBuildInfo | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.version === b.version &&
    a.commit === b.commit &&
    a.bundle === b.bundle &&
    a.contractVersion === b.contractVersion &&
    a.codeHash === b.codeHash
  );
}

/**
 * Whether two builds share the same RUNTIME CONTRACT — i.e. one daemon can be
 * reused in place of the other. This deliberately IGNORES `bundle`: the dist CLI
 * (`bundle: "dist"`) and the Claude Code plugin (`bundle: "plugin"`) are co-equal
 * artifacts built from the same source for the same pair and same control port,
 * so a daemon launched by one must NOT be treated as "drifted" by the other —
 * otherwise the two launchers replace-war each other's daemon on every
 * `ensureRunning` and the Codex TUI can never stay up.
 *
 * Code identity truth table (after version/contractVersion equality, which is
 * always required):
 *
 *   | a.codeHash | b.codeHash | decided by              | result            |
 *   |------------|------------|-------------------------|-------------------|
 *   | valid      | valid      | codeHash (commit IGNORED)| codeHash equality |
 *   | valid      | missing/sentinel | commit stamp (fallback) | commit equality |
 *   | missing/sentinel | valid | commit stamp (fallback) | commit equality   |
 *   | missing/sentinel | missing/sentinel | commit stamp (fallback) | commit equality |
 *
 * Why: the committed plugin bundle's commit stamp ALWAYS lags the squash-merged
 * master sha by one (a bundle committed in X can only embed X's parent), so two
 * byte-identical builds routinely carry different stamps — comparing stamps made
 * launchers replace-war perfectly healthy daemons (live incident). The codeHash
 * is a hash of the build-input source tree and is stable across re-stamps; when
 * both sides have one it is authoritative. Legacy builds (no codeHash) keep the
 * historical stamp comparison so old daemons stay classifiable.
 */
export function sameRuntimeContract(
  a: AgentBridgeBuildInfo | null | undefined,
  b: AgentBridgeBuildInfo | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.version !== b.version || a.contractVersion !== b.contractVersion) return false;
  if (hasValidCodeHash(a) && hasValidCodeHash(b)) return a.codeHash === b.codeHash;
  return a.commit === b.commit;
}

/**
 * Which identity {@link sameRuntimeContract} used (or would use) for the code
 * comparison — "codeHash" only when BOTH sides carry a valid one, otherwise the
 * legacy "commit" stamp fallback. Surfaced in drift logs/doctor output so a
 * verdict is auditable: a commit-basis drift on a legacy build may be a
 * squash-lag false positive, a codeHash-basis drift never is.
 */
export function runtimeContractComparisonBasis(
  a: AgentBridgeBuildInfo | null | undefined,
  b: AgentBridgeBuildInfo | null | undefined,
): "codeHash" | "commit" {
  return hasValidCodeHash(a) && hasValidCodeHash(b) ? "codeHash" : "commit";
}

/**
 * Protocol-level compatibility ONLY: can a frontend at build `a` talk to a daemon
 * at build `b` at all? This is the weakest of the build comparisons — commit and
 * version may differ (the daemon merely runs older code), but as long as the
 * control-protocol contractVersion matches, every message still parses. Used to
 * decide whether replacing a drifted daemon is MANDATORY (incompatible) or merely
 * desirable (upgrade hygiene).
 */
export function compatibleContractVersion(
  a: AgentBridgeBuildInfo | null | undefined,
  b: AgentBridgeBuildInfo | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.contractVersion === b.contractVersion;
}

export function formatBuildInfo(build: AgentBridgeBuildInfo | null | undefined): string {
  if (!build) return "<unknown>";
  const codeHash = hasValidCodeHash(build) ? `/code-${build.codeHash}` : "";
  return `${build.version}/${build.commit}/${build.bundle}/contract-v${build.contractVersion}${codeHash}`;
}
