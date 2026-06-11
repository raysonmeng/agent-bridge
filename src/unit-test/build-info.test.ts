import { describe, expect, test } from "bun:test";
import {
  BUILD_INFO,
  daemonStatusBuildInfo,
  formatBuildInfo,
  hasValidCodeHash,
  runtimeContractComparisonBasis,
  sameBuildInfo,
  sameRuntimeContract,
  type AgentBridgeBuildInfo,
} from "../build-info";

const base: AgentBridgeBuildInfo = {
  version: "0.1.6",
  commit: "6c24127",
  bundle: "dist",
  contractVersion: 1,
};

// A stamped build that ALSO carries the build-input code hash (new builds).
const hashed: AgentBridgeBuildInfo = { ...base, codeHash: "abc123def456" };

describe("build info", () => {
  test("exposes stable runtime build metadata for daemon status", () => {
    expect(BUILD_INFO.version).toBeString();
    expect(BUILD_INFO.commit).toBeString();
    expect(BUILD_INFO.bundle).toMatch(/^(source|dist|plugin)$/);
    expect(BUILD_INFO.contractVersion).toBeNumber();
  });

  test("serializes into the daemon status payload shape", () => {
    expect(daemonStatusBuildInfo()).toEqual({
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      bundle: BUILD_INFO.bundle,
      contractVersion: BUILD_INFO.contractVersion,
      codeHash: BUILD_INFO.codeHash,
    });
  });

  test("sameRuntimeContract ignores bundle kind (dist vs plugin are interchangeable)", () => {
    expect(sameRuntimeContract(base, { ...base, bundle: "plugin" })).toBe(true);
    expect(sameRuntimeContract(base, { ...base, bundle: "source" })).toBe(true);
    // sameBuildInfo, used only for diagnostics, still distinguishes the bundle.
    expect(sameBuildInfo(base, { ...base, bundle: "plugin" })).toBe(false);
  });

  test("sameRuntimeContract still detects a real upgrade (version/commit/contract)", () => {
    expect(sameRuntimeContract(base, { ...base, commit: "deadbee" })).toBe(false);
    expect(sameRuntimeContract(base, { ...base, version: "0.1.7" })).toBe(false);
    expect(sameRuntimeContract(base, { ...base, contractVersion: 2 })).toBe(false);
    expect(sameRuntimeContract(base, null)).toBe(false);
    expect(sameRuntimeContract(base, { ...base })).toBe(true);
  });
});

/**
 * codeHash identity truth table — the squash-merge stamp-lag fix.
 *
 * A bundle committed in commit X can only ever embed X's PARENT as its commit
 * stamp, so under squash-merge the stamp lags the master sha by exactly one
 * even though the CODE is byte-identical. When BOTH sides carry a valid
 * codeHash (hash of the build-input source tree), code identity is decided by
 * codeHash and the commit stamp is IGNORED. Legacy builds without a codeHash
 * fall back to the historical commit-stamp comparison.
 */
describe("sameRuntimeContract codeHash identity (squash stamp-lag fix)", () => {
  test("identical codeHash with DIFFERENT commit stamps is the same contract (reuse)", () => {
    // The release-blocker scenario: PR-branch stamp vs squash-merged master
    // stamp, identical source — must NOT be classified as drift.
    expect(sameRuntimeContract(hashed, { ...hashed, commit: "fffffff" })).toBe(true);
  });

  test("different codeHash with the SAME commit stamp is drift", () => {
    expect(sameRuntimeContract(hashed, { ...hashed, codeHash: "000000000000" })).toBe(false);
  });

  test("one side missing codeHash falls back to commit comparison (both branches)", () => {
    const legacy = { ...base }; // no codeHash field at all (old daemon)
    expect(sameRuntimeContract(hashed, { ...legacy })).toBe(true); // commit equal → reuse
    expect(sameRuntimeContract(hashed, { ...legacy, commit: "deadbee" })).toBe(false); // commit differs → drift
    expect(sameRuntimeContract(legacy, { ...hashed, commit: "deadbee" })).toBe(false); // symmetric
    expect(sameRuntimeContract(legacy, { ...hashed })).toBe(true);
  });

  test("sentinel/empty codeHash is not a valid identity and falls back to commit", () => {
    const sourceMode = { ...base, codeHash: "source" };
    expect(sameRuntimeContract(sourceMode, { ...sourceMode })).toBe(true);
    expect(sameRuntimeContract(sourceMode, { ...sourceMode, commit: "deadbee" })).toBe(false);
    const empty = { ...base, codeHash: "" };
    expect(sameRuntimeContract(empty, { ...empty, commit: "deadbee" })).toBe(false);
    // valid on one side + sentinel on the other → still the commit fallback
    expect(sameRuntimeContract(hashed, { ...base, codeHash: "source" })).toBe(true);
    expect(sameRuntimeContract(hashed, { ...base, codeHash: "source", commit: "deadbee" })).toBe(false);
  });

  test("version/contractVersion mismatch is never the same contract even with identical codeHash", () => {
    expect(sameRuntimeContract(hashed, { ...hashed, version: "9.9.9" })).toBe(false);
    expect(sameRuntimeContract(hashed, { ...hashed, contractVersion: base.contractVersion + 1 })).toBe(false);
  });

  test("hasValidCodeHash rejects null/missing/empty/sentinel and accepts a real hash", () => {
    expect(hasValidCodeHash(hashed)).toBe(true);
    expect(hasValidCodeHash(base)).toBe(false);
    expect(hasValidCodeHash({ ...base, codeHash: "" })).toBe(false);
    expect(hasValidCodeHash({ ...base, codeHash: "source" })).toBe(false);
    expect(hasValidCodeHash(null)).toBe(false);
    expect(hasValidCodeHash(undefined)).toBe(false);
  });

  test("runtimeContractComparisonBasis reports which identity decided the verdict", () => {
    expect(runtimeContractComparisonBasis(hashed, { ...hashed, commit: "fffffff" })).toBe("codeHash");
    expect(runtimeContractComparisonBasis(hashed, base)).toBe("commit");
    expect(runtimeContractComparisonBasis(base, base)).toBe("commit");
    expect(runtimeContractComparisonBasis(null, hashed)).toBe("commit");
  });

  test("formatBuildInfo surfaces a valid codeHash and omits the sentinel", () => {
    expect(formatBuildInfo(hashed)).toContain("abc123def456");
    expect(formatBuildInfo(base)).not.toContain("code-");
    expect(formatBuildInfo({ ...base, codeHash: "source" })).not.toContain("code-");
  });
});
