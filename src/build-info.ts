import { CONTRACT_VERSION } from "./contract-version";

declare const __AGENTBRIDGE_BUILD_VERSION__: string | undefined;
declare const __AGENTBRIDGE_BUILD_COMMIT__: string | undefined;
declare const __AGENTBRIDGE_BUILD_BUNDLE__: "source" | "dist" | "plugin" | undefined;
declare const __AGENTBRIDGE_CONTRACT_VERSION__: number | undefined;

export type AgentBridgeBundleKind = "source" | "dist" | "plugin";

export interface AgentBridgeBuildInfo {
  version: string;
  commit: string;
  bundle: AgentBridgeBundleKind;
  contractVersion: number;
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
    a.contractVersion === b.contractVersion
  );
}

/**
 * Whether two builds share the same RUNTIME CONTRACT — i.e. one daemon can be
 * reused in place of the other. This deliberately IGNORES `bundle`: the dist CLI
 * (`bundle: "dist"`) and the Claude Code plugin (`bundle: "plugin"`) are co-equal
 * artifacts built from the same source for the same pair and same control port,
 * so a daemon launched by one must NOT be treated as "drifted" by the other —
 * otherwise the two launchers replace-war each other's daemon on every
 * `ensureRunning` and the Codex TUI can never stay up. Drift that actually
 * matters (a real code change) moves version/commit/contractVersion, which this
 * still detects.
 */
export function sameRuntimeContract(
  a: AgentBridgeBuildInfo | null | undefined,
  b: AgentBridgeBuildInfo | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.version === b.version &&
    a.commit === b.commit &&
    a.contractVersion === b.contractVersion
  );
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
  return `${build.version}/${build.commit}/${build.bundle}/contract-v${build.contractVersion}`;
}
