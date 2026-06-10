import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_VERSION } from "../contract-version";

const ROOT = process.cwd();

describe("contract version single source", () => {
  test("build-bundles extracts the same value src/contract-version.ts exports", () => {
    // Locks the two consumers of the single source against each other: the
    // TS import (source-mode fallback) and the build script's regex extract.
    const buildScript = readFileSync(join(ROOT, "scripts/build-bundles.mjs"), "utf-8");
    expect(buildScript).toContain("src/contract-version.ts");
    expect(buildScript).not.toMatch(/const CONTRACT_VERSION = \d+;/);

    const source = readFileSync(join(ROOT, "src/contract-version.ts"), "utf-8");
    const match = source.match(/export const CONTRACT_VERSION = (\d+);/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(CONTRACT_VERSION);
  });
});

describe("bundle-commit shared extractor", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { extractBuildCommit, trackedBundleCommit } = require(join(ROOT, "scripts/bundle-commit.cjs"));

  test("extracts the stamp from bundle text and tolerates absence", () => {
    expect(extractBuildCommit('commit: defineString("abc1234", "source")')).toBe("abc1234");
    expect(extractBuildCommit("no stamp here")).toBeNull();
    expect(extractBuildCommit(null)).toBeNull();
  });

  test("tracked daemon bundle carries an extractable stamp", () => {
    // The release bump rebuild and smoke-pack both depend on this; if the
    // bundle format ever changes the stamp shape, this fails loudly instead
    // of the release chain silently regressing to dirty-tree rebuilds.
    expect(trackedBundleCommit()).toMatch(/^[0-9a-f]{7,40}$/);
  });
});

describe("release chain rebuilds plugin bundles on version bump", () => {
  test("release.sh bumps bundles with the pinned commit stamp and commits them", () => {
    const script = readFileSync(join(ROOT, "scripts/release.sh"), "utf-8");
    expect(script).toContain("AGENTBRIDGE_BUILD_COMMIT_OVERRIDE=");
    expect(script).toContain("bundle-commit.cjs");
    // Per-file assertions (not one concatenated substring) so reformatting
    // the git-add line cannot silently drop a bundle from the bump commit.
    const gitAdd = script.slice(script.indexOf("git add"));
    expect(gitAdd).toContain("plugins/agentbridge/server/bridge-server.js");
    expect(gitAdd).toContain("plugins/agentbridge/server/daemon.js");
  });

  test("release-on-merge workflow does the same", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/release-on-merge.yml"), "utf-8");
    expect(wf).toContain("AGENTBRIDGE_BUILD_COMMIT_OVERRIDE=");
    expect(wf).toContain("bundle-commit.cjs");
    expect(wf).toContain("plugins/agentbridge/server/daemon.js");
  });
});

describe("postinstall hardening", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { skipPluginRegistration } = require(join(ROOT, "scripts/postinstall.cjs"));

  test("AGENTBRIDGE_POSTINSTALL_PLUGIN=0 opts out of plugin registration", () => {
    expect(skipPluginRegistration({ AGENTBRIDGE_POSTINSTALL_PLUGIN: "0" })).toBe(true);
    expect(skipPluginRegistration({ AGENTBRIDGE_POSTINSTALL_PLUGIN: "1" })).toBe(false);
    expect(skipPluginRegistration({})).toBe(false);
  });

  test("every external command in postinstall carries a timeout", () => {
    const script = readFileSync(join(ROOT, "scripts/postinstall.cjs"), "utf-8");
    const calls = script.match(/execFileSync\([^;]+?\)/gs) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call).toContain("timeout");
    }
  });
});

describe("smoke-pack stays side-effect-free on tracked bundles", () => {
  test("plugin rebuild is pinned to the tracked commit stamp", () => {
    const script = readFileSync(join(ROOT, "scripts/smoke-pack.mjs"), "utf-8");
    expect(script).toContain("trackedBundleCommit");
    expect(script).toContain("AGENTBRIDGE_BUILD_COMMIT_OVERRIDE");
  });
});
