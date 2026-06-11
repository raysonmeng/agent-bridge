import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
// Same require-based loading as release-chain.test.ts uses for bundle-commit.cjs:
// scripts/ is outside the tsconfig include, so the module is consumed untyped.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeCodeHash, computeCodeHashFromEntries, listCodeHashInputFiles } = require(
  join(ROOT, "scripts/code-hash.cjs"),
);

/** Shape every stamped bundle must expose so doctor/extractors can read the hash. */
const CODEHASH_STAMP_RE = /codeHash:\s*defineString\("([^"]+)",\s*"source"\)/;

function seedFakeRepo(root: string) {
  mkdirSync(join(root, "src", "sub"), { recursive: true });
  mkdirSync(join(root, "src", "unit-test"), { recursive: true });
  mkdirSync(join(root, "src", "integration-test"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "sub", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "src", "inline.test.ts"), "// colocated test\n");
  writeFileSync(join(root, "src", "unit-test", "x.test.ts"), "// unit test\n");
  writeFileSync(join(root, "src", "integration-test", "y.test.ts"), "// integration test\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake", version: "1.0.0" }));
  writeFileSync(join(root, "bun.lock"), "lockfile-v1\n");
}

describe("computeCodeHashFromEntries (pure normalization + hash)", () => {
  const entries = [
    { path: "src/a.ts", content: "export const a = 1;\n" },
    { path: "src/b.ts", content: "export const b = 2;\n" },
  ];

  test("emits a 12-hex digest", () => {
    expect(computeCodeHashFromEntries(entries)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is order-independent (entries are canonically sorted)", () => {
    const reversed = [...entries].reverse();
    expect(computeCodeHashFromEntries(reversed)).toBe(computeCodeHashFromEntries(entries));
  });

  test("is content-sensitive", () => {
    const mutated = [entries[0]!, { path: "src/b.ts", content: "export const b = 3;\n" }];
    expect(computeCodeHashFromEntries(mutated)).not.toBe(computeCodeHashFromEntries(entries));
  });

  test("is path-sensitive (swapping contents between paths changes the hash)", () => {
    const swapped = [
      { path: "src/a.ts", content: entries[1]!.content },
      { path: "src/b.ts", content: entries[0]!.content },
    ];
    expect(computeCodeHashFromEntries(swapped)).not.toBe(computeCodeHashFromEntries(entries));
  });

  test("does not mutate its input (immutability)", () => {
    const input = [...entries].reverse();
    const snapshot = [...input];
    computeCodeHashFromEntries(input);
    expect(input).toEqual(snapshot);
  });
});

describe("listCodeHashInputFiles (build-input enumeration)", () => {
  test("real repo: includes build inputs, excludes every test file", () => {
    const files: string[] = listCodeHashInputFiles(ROOT);
    expect(files).toContain("src/build-info.ts");
    expect(files).toContain("src/daemon-lifecycle.ts");
    expect(files).toContain("package.json");
    expect(files).toContain("bun.lock");
    expect(files.some((f) => f.includes("unit-test/"))).toBe(false);
    expect(files.some((f) => f.includes("integration-test/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    // Canonical order so the hash is stable across platforms/readdir order.
    expect(files).toEqual([...files].sort());
  });

  test("fails fast when a required build input is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-codehash-missing-"));
    try {
      seedFakeRepo(root);
      rmSync(join(root, "bun.lock"));
      expect(() => listCodeHashInputFiles(root)).toThrow(/bun\.lock/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeCodeHash (source-tree identity)", () => {
  test("is deterministic; sensitive to source/package/lock/bun-version; blind to tests", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-codehash-repo-"));
    try {
      seedFakeRepo(root);
      const opts = { bunVersion: "1.0.0" };
      const baseline = computeCodeHash(root, opts);
      expect(baseline).toMatch(/^[0-9a-f]{12}$/);
      expect(computeCodeHash(root, opts)).toBe(baseline); // deterministic

      // Test-only edits must NOT move the hash (tests never enter the bundles).
      writeFileSync(join(root, "src", "unit-test", "x.test.ts"), "// changed unit test\n");
      writeFileSync(join(root, "src", "inline.test.ts"), "// changed colocated test\n");
      expect(computeCodeHash(root, opts)).toBe(baseline);

      // Any real source change MUST move the hash.
      writeFileSync(join(root, "src", "a.ts"), "export const a = 42;\n");
      const afterSource = computeCodeHash(root, opts);
      expect(afterSource).not.toBe(baseline);

      // Dependency surface changes move the hash (deps are bundled in).
      writeFileSync(join(root, "bun.lock"), "lockfile-v2\n");
      const afterLock = computeCodeHash(root, opts);
      expect(afterLock).not.toBe(afterSource);

      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake", version: "2.0.0" }));
      const afterPkg = computeCodeHash(root, opts);
      expect(afterPkg).not.toBe(afterLock);

      // The bundler itself is a build input: a different bun emits different bytes.
      expect(computeCodeHash(root, { bunVersion: "9.9.9" })).not.toBe(afterPkg);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Build integration: the invariant the whole fix rests on — two builds of the
 * SAME source with DIFFERENT commit stamps embed the SAME codeHash. This is
 * the squash-merge scenario (PR-branch sha vs squash-merged master sha).
 */
describe("build-bundles codeHash stamping", () => {
  test("two builds with different commit overrides embed the same non-sentinel codeHash", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "abg-codehash-build-"));
    try {
      const hashes: string[] = [];
      for (const override of ["feedc0de", "deadbeef"]) {
        const outfile = join(tempDir, `daemon-${override}.js`);
        const result = spawnSync(
          "node",
          ["scripts/build-bundles.mjs", "daemon-plugin", "--outfile", outfile],
          {
            cwd: ROOT,
            encoding: "utf-8",
            env: { ...process.env, AGENTBRIDGE_BUILD_COMMIT_OVERRIDE: override },
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const bundle = readFileSync(outfile, "utf-8");
        expect(bundle).toContain(`"${override}"`); // commit override still honored
        const match = bundle.match(CODEHASH_STAMP_RE);
        expect(match, "bundle must carry an extractable codeHash stamp").not.toBeNull();
        hashes.push(match![1]!);
      }
      expect(hashes[0]).toBe(hashes[1]!); // different stamps, same code → same codeHash
      expect(hashes[0]).toMatch(/^[0-9a-f]{12}$/);
      expect(hashes[0]).not.toBe("source");
      // And the embedded value is exactly the current source tree's identity.
      expect(hashes[0]).toBe(computeCodeHash(ROOT));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
