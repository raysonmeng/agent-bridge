import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyReclaimableEntries,
  DEFAULT_PAIR_NAME,
  derivePairId,
  derivePairIdFromCwd,
  detectLegacyRootDaemon,
  isEntryReclaimable,
  listPairDirs,
  MAX_PAIR_SLOT,
  pairDirPath,
  pairsRootDir,
  PairError,
  pickLowestFreeSlot,
  portsForSlot,
  probePortFree,
  readRegistry,
  RECLAIMABLE_MIN_AGE_MS,
  removePairDir,
  removePairEntry,
  removePairEntryAndDir,
  removeUnregisteredPairDir,
  resolvePair,
  validatePairId,
  writeRegistry,
  type EntryReclaimSignals,
  type PairEntry,
  type RegistryFile,
} from "../pair-registry";

// Helper: build a minimal PairEntry with a given slot (other fields are
// irrelevant for slot-allocation logic).
function entry(slot: number, pairId = `p${slot}`): PairEntry {
  return {
    pairId,
    slot,
    cwd: `/tmp/${pairId}`,
    source: "cwd",
    createdAt: new Date().toISOString(),
  };
}

// Helper: bind a TCP port on 127.0.0.1 and resolve once listening.
function bindPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function bindFirstAvailableAppPortSlot(): Promise<{ slot: number; server: Server }> {
  for (let slot = 0; slot <= MAX_PAIR_SLOT; slot++) {
    try {
      return { slot, server: await bindPort(portsForSlot(slot).appPort) };
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES") continue;
      throw err;
    }
  }
  throw new Error("No bindable AgentBridge app port slot found for test");
}

describe("portsForSlot", () => {
  test("slot 0 maps to the classic 4500/4501/4502 triple", () => {
    expect(portsForSlot(0)).toEqual({ appPort: 4500, proxyPort: 4501, controlPort: 4502 });
  });

  test("slot 1 maps to 4510/4511/4512", () => {
    expect(portsForSlot(1)).toEqual({ appPort: 4510, proxyPort: 4511, controlPort: 4512 });
  });

  test("slot 3 maps to 4530/4531/4532", () => {
    expect(portsForSlot(3)).toEqual({ appPort: 4530, proxyPort: 4531, controlPort: 4532 });
  });

  test("negative slot throws PairError", () => {
    expect(() => portsForSlot(-1)).toThrow(PairError);
  });

  test("non-integer slot throws PairError", () => {
    expect(() => portsForSlot(1.5)).toThrow(PairError);
  });

  test("the thrown error is a PairError (slot guard reuses PAIR_ID_INVALID code)", () => {
    try {
      portsForSlot(-1);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PairError);
      // NOTE: the source reuses code "PAIR_ID_INVALID" for invalid slots
      // (there is no dedicated slot code). Asserting the actual behavior.
      expect((err as PairError).code).toBe("PAIR_ID_INVALID");
    }
  });
});

describe("pickLowestFreeSlot", () => {
  test("empty set returns 0", () => {
    expect(pickLowestFreeSlot([])).toBe(0);
  });

  test("slot 0 used returns 1", () => {
    expect(pickLowestFreeSlot([entry(0)])).toBe(1);
  });

  test("slots {0,2} used fills the gap -> 1 (not 3)", () => {
    expect(pickLowestFreeSlot([entry(0), entry(2)])).toBe(1);
  });

  test("slots {1,2} used returns 0", () => {
    expect(pickLowestFreeSlot([entry(1), entry(2)])).toBe(0);
  });
});

describe("validatePairId", () => {
  test.each(["foo", "foo-bar_1.2", "A1"])("accepts valid id %p", (id) => {
    expect(validatePairId(id)).toBe(id);
  });

  test.each(["..", ".", "a/b", "a b", "", "foo/../bar"])(
    "throws PAIR_ID_INVALID for %p",
    (bad) => {
      try {
        validatePairId(bad);
        throw new Error(`expected throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PairError);
        expect((err as PairError).code).toBe("PAIR_ID_INVALID");
      }
    },
  );

  test("throws PAIR_ID_INVALID for a 65-char string", () => {
    const tooLong = "a".repeat(65);
    try {
      validatePairId(tooLong);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PairError);
      expect((err as PairError).code).toBe("PAIR_ID_INVALID");
    }
  });

  test("accepts a 64-char string (boundary)", () => {
    const ok = "a".repeat(64);
    expect(validatePairId(ok)).toBe(ok);
  });
});

describe("derivePairIdFromCwd", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("is stable for the same path (two calls are equal)", () => {
    const a = derivePairIdFromCwd(base);
    const b = derivePairIdFromCwd(base);
    expect(a).toBe(b);
  });

  test("two different paths produce different ids", () => {
    const dirA = mkdtempSync(join(tmpdir(), "abg-pair-test-A-"));
    const dirB = mkdtempSync(join(tmpdir(), "abg-pair-test-B-"));
    try {
      expect(derivePairIdFromCwd(dirA)).not.toBe(derivePairIdFromCwd(dirB));
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("result always passes validatePairId without throwing", () => {
    const id = derivePairIdFromCwd(base);
    expect(() => validatePairId(id)).not.toThrow();
    expect(validatePairId(id)).toBe(id);
  });

  test("resolves symlinks: a symlink to a dir yields the same id as the real dir", () => {
    const realDir = mkdtempSync(join(tmpdir(), "abg-pair-test-real-"));
    const linkPath = join(base, "link-to-real");
    try {
      symlinkSync(realDir, linkPath);
      // Confirm the symlink actually points at the real dir.
      expect(realpathSync(linkPath)).toBe(realpathSync(realDir));
      expect(derivePairIdFromCwd(linkPath)).toBe(derivePairIdFromCwd(realDir));
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

describe("readRegistry / writeRegistry", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("missing file returns an empty registry", () => {
    expect(readRegistry(base)).toEqual({ version: 1, pairs: [] });
  });

  test("round-trips a registry with 2 entries", () => {
    const reg: RegistryFile = { version: 1, pairs: [entry(0, "alpha"), entry(1, "beta")] };
    writeRegistry(base, reg);
    expect(readRegistry(base)).toEqual(reg);
  });

  test("corrupt JSON throws PAIR_REGISTRY_CORRUPT", () => {
    // Seed a valid registry first so the pairs dir exists, then clobber the file.
    writeRegistry(base, { version: 1, pairs: [] });
    const regPath = join(base, "pairs", "registry.json");
    writeFileSync(regPath, "{ not valid json ");
    try {
      readRegistry(base);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PairError);
      expect((err as PairError).code).toBe("PAIR_REGISTRY_CORRUPT");
    }
  });

  test("wrong shape ({version:2}) throws PAIR_REGISTRY_CORRUPT", () => {
    writeRegistry(base, { version: 1, pairs: [] });
    const regPath = join(base, "pairs", "registry.json");
    writeFileSync(regPath, JSON.stringify({ version: 2 }));
    try {
      readRegistry(base);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PairError);
      expect((err as PairError).code).toBe("PAIR_REGISTRY_CORRUPT");
    }
  });

  test("no leftover *.tmp.* files remain after writeRegistry", () => {
    writeRegistry(base, { version: 1, pairs: [entry(0)] });
    const files = readdirSync(join(base, "pairs"));
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });
});

describe("probePortFree", () => {
  // Use a high port unlikely to collide; bind it to confirm busy detection.
  const probePort = 47213;

  test("a freshly chosen high port is free", async () => {
    expect(await probePortFree(probePort)).toBe(true);
  });

  test("a bound port reports as not free, and frees up after close", async () => {
    const server = await bindPort(probePort);
    try {
      expect(await probePortFree(probePort)).toBe(false);
    } finally {
      await closeServer(server);
    }
    // After close the port is free again.
    expect(await probePortFree(probePort)).toBe(true);
  });
});

describe("detectLegacyRootDaemon", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("empty base returns null", () => {
    expect(detectLegacyRootDaemon(base)).toBeNull();
  });

  test("daemon.pid with a definitely-dead pid returns null", () => {
    writeFileSync(join(base, "daemon.pid"), "2147483646");
    expect(detectLegacyRootDaemon(base)).toBeNull();
  });
});

describe("resolvePair", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // These tests exercise pure pair/slot allocation. Disable port probing so
  // they do not depend on whether a developer-machine daemon currently owns
  // the classic 4500/4501/4502 ports; port conflicts are covered separately.

  async function resolveTolerant(
    cwd: string,
    pairFlag?: string,
  ): Promise<{ ok: true; resolved: Awaited<ReturnType<typeof resolvePair>> } | { ok: false; busy: PairError }> {
    try {
      const resolved = await resolvePair(base, pairFlag ? { pairFlag, cwd, probePorts: false } : { cwd, probePorts: false });
      return { ok: true, resolved };
    } catch (err) {
      if (err instanceof PairError && err.code === "PAIR_PORTS_BUSY") {
        return { ok: false, busy: err };
      }
      throw err;
    }
  }

  test("fresh base + cwd -> slot 0, default name 'main', stateDir ends with pairId, 1 entry", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-cwd-A-"));
    try {
      // No flag → default name "main", scoped to this cwd.
      const expectedId = derivePairId(tmpA, DEFAULT_PAIR_NAME);
      const r = await resolveTolerant(tmpA);

      const reg = readRegistry(base);
      expect(reg.pairs).toHaveLength(1);
      expect(reg.pairs[0]!.slot).toBe(0);
      expect(reg.pairs[0]!.pairId).toBe(expectedId);
      expect(reg.pairs[0]!.name).toBe(DEFAULT_PAIR_NAME);
      expect(reg.pairs[0]!.source).toBe("cwd");

      if (r.ok) {
        expect(r.resolved.slot).toBe(0);
        expect(r.resolved.pairId).toBe(expectedId);
        expect(r.resolved.name).toBe(DEFAULT_PAIR_NAME);
        expect(r.resolved.ports).toEqual({ appPort: 4500, proxyPort: 4501, controlPort: 4502 });
        expect(r.resolved.stateDir.endsWith(expectedId)).toBe(true);
      } else {
        // Ports 4500-4502 busy on this machine; allocation still correct.
        expect(r.busy.details?.slot).toBe(0);
      }
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });

  test("calling again with the SAME cwd is idempotent (same pairId/slot, still 1 entry)", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-cwd-A-"));
    try {
      const expectedId = derivePairId(tmpA, DEFAULT_PAIR_NAME);
      await resolveTolerant(tmpA);
      await resolveTolerant(tmpA);

      const reg = readRegistry(base);
      expect(reg.pairs).toHaveLength(1);
      expect(reg.pairs[0]!.slot).toBe(0);
      expect(reg.pairs[0]!.pairId).toBe(expectedId);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });

  test("a second distinct cwd allocates slot 1 (same default name, different dir = different pair)", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-cwd-A-"));
    const tmpB = mkdtempSync(join(tmpdir(), "abg-pair-cwd-B-"));
    try {
      const idA = derivePairId(tmpA, DEFAULT_PAIR_NAME);
      const idB = derivePairId(tmpB, DEFAULT_PAIR_NAME);
      // Same friendly name "main", different directories → distinct ids.
      expect(idA).not.toBe(idB);
      await resolveTolerant(tmpA);
      const rB = await resolveTolerant(tmpB);

      const reg = readRegistry(base);
      expect(reg.pairs).toHaveLength(2);
      const entryA = reg.pairs.find((p) => p.pairId === idA)!;
      const entryB = reg.pairs.find((p) => p.pairId === idB)!;
      expect(entryA.slot).toBe(0);
      expect(entryB.slot).toBe(1);

      // Slot 1 ports are 4510-4512, almost certainly free on a dev machine, so
      // this resolve normally succeeds — but stay tolerant just in case.
      if (rB.ok) {
        expect(rB.resolved.slot).toBe(1);
        expect(rB.resolved.ports).toEqual({ appPort: 4510, proxyPort: 4511, controlPort: 4512 });
      } else {
        expect(rB.busy.details?.slot).toBe(1);
      }
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  test("explicit pairFlag scopes the name to the cwd (id = name + cwd hash)", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-cwd-A-"));
    try {
      const expectedId = derivePairId(tmpA, "myname");
      const r = await resolveTolerant(tmpA, "myname");
      const reg = readRegistry(base);
      expect(reg.pairs).toHaveLength(1);
      expect(reg.pairs[0]!.pairId).toBe(expectedId);
      expect(reg.pairs[0]!.name).toBe("myname");
      expect(reg.pairs[0]!.source).toBe("flag");
      if (r.ok) {
        expect(r.resolved.pairId).toBe(expectedId);
        expect(r.resolved.name).toBe("myname");
      }
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });

  test("the same name in two directories resolves to two distinct pairs", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-same-A-"));
    const tmpB = mkdtempSync(join(tmpdir(), "abg-pair-same-B-"));
    try {
      await resolveTolerant(tmpA, "work");
      await resolveTolerant(tmpB, "work");
      const reg = readRegistry(base);
      expect(reg.pairs).toHaveLength(2);
      expect(reg.pairs[0]!.pairId).not.toBe(reg.pairs[1]!.pairId);
      // Both carry the same friendly name though.
      expect(reg.pairs.every((p) => p.name === "work")).toBe(true);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  // --- raw-pairId fallback: the double-hash strand fix ---
  // A launch must reuse a pair when the flag IS an already-registered pairId,
  // mirroring findPairForFlag() (used by kill/pairs). All these resolves hit an
  // existing entry (no probe) or pass probePorts:false, so they never flake on
  // ports. Reuse/precedence cases seed non-zero slots; the one allocation case
  // seeds slot 0 so the new pair lands on slot 1, avoiding the slot-0
  // detectLegacyRootDaemon path on a dev machine.

  test("--pair <an already-registered pairId> reuses that pair, no double-hash allocation", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-raw-A-"));
    try {
      const pairId = derivePairId(tmpA, DEFAULT_PAIR_NAME); // e.g. "main-<hashA>"
      writeRegistry(base, {
        version: 1,
        pairs: [{ pairId, slot: 5, cwd: tmpA, name: DEFAULT_PAIR_NAME, source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      const resolved = await resolvePair(base, { pairFlag: pairId, cwd: tmpA, probePorts: false });

      expect(readRegistry(base).pairs).toHaveLength(1); // NO second double-hashed entry
      expect(resolved.pairId).toBe(pairId);
      expect(resolved.slot).toBe(5);
      expect(resolved.warning).toBeUndefined(); // same cwd → unremarkable reuse
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });

  test("a current-cwd scoped name wins over a same-string raw pairId", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-prec-A-"));
    try {
      const flag = "foo-1a2b3c4d"; // itself shaped like a pairId
      const scopedId = derivePairId(tmpA, flag); // "foo-1a2b3c4d-<hash>"
      expect(scopedId).not.toBe(flag);
      writeRegistry(base, {
        version: 1,
        pairs: [
          { pairId: scopedId, slot: 2, cwd: tmpA, name: flag, source: "flag", createdAt: "2026-01-01T00:00:00.000Z" },
          { pairId: flag, slot: 7, cwd: tmpA, name: "foo", source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
      const resolved = await resolvePair(base, { pairFlag: flag, cwd: tmpA, probePorts: false });
      // Scoped (name+cwd) match has priority over the raw pairId entry.
      expect(resolved.pairId).toBe(scopedId);
      expect(resolved.slot).toBe(2);
      expect(readRegistry(base).pairs).toHaveLength(2); // nothing allocated
      expect(resolved.warning).toBeUndefined();
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });

  test("a cross-cwd raw pairId match THROWS PAIR_CROSS_CWD (a pair is scoped to its directory)", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-xcwd-A-"));
    const tmpB = mkdtempSync(join(tmpdir(), "abg-pair-xcwd-B-"));
    try {
      const pairId = derivePairId(tmpA, DEFAULT_PAIR_NAME);
      writeRegistry(base, {
        version: 1,
        pairs: [{ pairId, slot: 6, cwd: tmpA, name: DEFAULT_PAIR_NAME, source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      // Resolve the SAME pairId from a DIFFERENT directory: must be an error, not a
      // silent reuse — the identity layer would reject a cross-cwd attach anyway.
      let err: unknown;
      try {
        await resolvePair(base, { pairFlag: pairId, cwd: tmpB, probePorts: false });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PairError);
      expect((err as PairError).code).toBe("PAIR_CROSS_CWD");
      const message = (err as PairError).message;
      expect(message).toContain(tmpA); // the pair's home cwd
      expect(message).toContain(tmpB); // where the user actually is
      // Guard the flag→text spacing (a replace_all once ate this space).
      expect(message).toContain(`--pair ${pairId} refers to`);
      // Nothing reused, nothing reallocated, registry untouched.
      expect(readRegistry(base).pairs).toHaveLength(1);
      expect((err as PairError).details).toMatchObject({ pairId, registeredCwd: tmpA, cwd: tmpB });
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  test("a same-cwd full pairId recovers (reuses) the entry without a warning", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-samecwd-A-"));
    try {
      // The pairId-shaped flag IS the registered pair's id AND we are in its dir:
      // this is the `abg --pair <pairId>` same-dir recovery path (commit 400b737).
      const pairId = derivePairId(tmpA, DEFAULT_PAIR_NAME);
      writeRegistry(base, {
        version: 1,
        pairs: [{ pairId, slot: 5, cwd: tmpA, name: DEFAULT_PAIR_NAME, source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      const resolved = await resolvePair(base, { pairFlag: pairId, cwd: tmpA, probePorts: false });

      expect(resolved.pairId).toBe(pairId);
      expect(resolved.slot).toBe(5); // reused, not reallocated
      expect(readRegistry(base).pairs).toHaveLength(1); // nothing allocated
      expect(resolved.warning).toBeUndefined(); // same-cwd recovery is silent
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });

  test("a pairId-shaped flag matching nothing allocates a new pair WITH a warning", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "abg-pair-ghost-A-"));
    try {
      // Seed slot 0 so the new pair lands on slot 1 (skips the slot-0 legacy probe).
      writeRegistry(base, {
        version: 1,
        pairs: [{ pairId: "occupied-00000000", slot: 0, cwd: "/occupied", name: "occupied", source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" }],
      });
      const flag = "ghost-1a2b3c4d"; // looks like a pairId, but unregistered
      const resolved = await resolvePair(base, { pairFlag: flag, cwd: tmpA, probePorts: false });

      const reg = readRegistry(base);
      expect(reg.pairs).toHaveLength(2); // occupied + the newly created pair
      const created = reg.pairs.find((p) => p.pairId === derivePairId(tmpA, flag));
      expect(created).toBeDefined();
      expect(created!.slot).toBe(1);
      expect(resolved.warning).toBeDefined();
      // Assert the full flag→text fragment incl. the space, to catch spacing regressions.
      expect(resolved.warning!).toContain(`--pair ${flag} looks like a full pair id`);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  });
});

describe("removePairEntry", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // Drive allocation through the registry directly (writeRegistry) so the test
  // is independent of port-probe outcome for slot 0. removePairEntry only
  // touches the registry under the lock, never probes ports.
  test("removes the slot-0 entry and returns it; a new cwd then reuses slot 0", async () => {
    const idA = derivePairIdFromCwd("/tmp/projectA");
    const idB = derivePairIdFromCwd("/tmp/projectB");
    writeRegistry(base, {
      version: 1,
      pairs: [
        { pairId: idA, slot: 0, cwd: "/tmp/projectA", source: "cwd", createdAt: new Date().toISOString() },
        { pairId: idB, slot: 1, cwd: "/tmp/projectB", source: "cwd", createdAt: new Date().toISOString() },
      ],
    });

    const removed = await removePairEntry(base, idA);
    expect(removed).not.toBeNull();
    expect(removed!.slot).toBe(0);
    expect(removed!.pairId).toBe(idA);

    // Slot 0 is now free; the lowest-free-slot logic should hand it to a new pair.
    const reg = readRegistry(base);
    expect(reg.pairs.map((p) => p.slot).sort()).toEqual([1]);
    expect(pickLowestFreeSlot(reg.pairs)).toBe(0);
  });

  test("removing a non-existent pair returns null", async () => {
    writeRegistry(base, { version: 1, pairs: [] });
    expect(await removePairEntry(base, "nope")).toBeNull();
  });
});

// Regression coverage for the cross-review round-1 fixes.
describe("cross-review regression fixes", () => {
  const bases: string[] = [];
  afterEach(() => {
    while (bases.length > 0) {
      const b = bases.pop();
      if (b) rmSync(b, { recursive: true, force: true });
    }
  });
  function tmpBase(): string {
    const b = mkdtempSync(join(tmpdir(), "abg-rgr-"));
    bases.push(b);
    return b;
  }

  test("#3 case-insensitive match returns the registry's canonical pairId/state dir", async () => {
    const base = tmpBase();
    // The composite id is name-scoped to the cwd; seed the canonical (mixed-case)
    // id for name "Foo" in /tmp/x, then resolve --pair foo from the SAME cwd.
    const canonicalId = derivePairId("/tmp/x", "Foo");
    writeRegistry(base, { version: 1, pairs: [entry(0, canonicalId)] });
    // Resolve with different casing — must canonicalize to the seeded id, not the
    // lowercased "foo-<hash>" variant.
    const r = await resolvePair(base, { pairFlag: "foo", cwd: "/tmp/x", probePorts: false });
    expect(r.pairId).toBe(canonicalId);
    expect(r.slot).toBe(0);
    expect(r.stateDir).toBe(join(base, "pairs", canonicalId));
  });

  test("#5 slot exhaustion throws WITHOUT persisting an invalid entry", async () => {
    const base = tmpBase();
    const full: PairEntry[] = [];
    for (let s = 0; s <= MAX_PAIR_SLOT; s++) full.push(entry(s, `p${s}`));
    writeRegistry(base, { version: 1, pairs: full });
    const before = readRegistry(base).pairs.length;
    await expect(resolvePair(base, { pairFlag: "overflow", cwd: "/tmp/x", probePorts: false })).rejects.toThrow();
    // The failed allocation must not leave an out-of-range slot in the registry.
    expect(readRegistry(base).pairs.length).toBe(before);
    expect(readRegistry(base).pairs.some((p) => p.slot > MAX_PAIR_SLOT)).toBe(false);
  });

  test("#6 validatePairId rejects Windows reserved device names with extensions", () => {
    expect(() => validatePairId("CON.txt")).toThrow(PairError);
    expect(() => validatePairId("NUL.log")).toThrow(PairError);
    expect(() => validatePairId("com1.x")).toThrow(PairError);
    // Not reserved: the device-base check only matches exact device words.
    expect(validatePairId("conduit")).toBe("conduit");
    expect(validatePairId("console")).toBe("console");
  });

  test("#7 readRegistry rejects a tampered pairId that could escape the pairs dir", () => {
    const base = tmpBase();
    const pairsDir = join(base, "pairs");
    mkdirSync(pairsDir, { recursive: true });
    writeFileSync(
      join(pairsDir, "registry.json"),
      JSON.stringify({ version: 1, pairs: [{ pairId: "../../etc", slot: 0, cwd: "/", source: "flag", createdAt: "x" }] }),
      "utf-8",
    );
    expect(() => readRegistry(base)).toThrow(PairError);
    try {
      readRegistry(base);
    } catch (e) {
      expect((e as PairError).code).toBe("PAIR_REGISTRY_CORRUPT");
    }
  });

  test("a brand-new pair whose port is squatted reports PAIR_PORTS_BUSY (deterministic)", async () => {
    const base = tmpBase();
    const { slot, server } = await bindFirstAvailableAppPortSlot();
    const ports = portsForSlot(slot);
    // Occupy all lower slots in the registry so the new pair deterministically
    // lands on the app port we are squatting, without assuming any fixed port is
    // free on the developer machine.
    writeRegistry(base, {
      version: 1,
      pairs: Array.from({ length: slot }, (_, s) => entry(s, `occupied-${s}`)),
    });
    try {
      let caught: unknown;
      try {
        await resolvePair(base, { pairFlag: "c", cwd: "/tmp/x" }); // probePorts defaults true
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PairError);
      expect((caught as PairError).code).toBe("PAIR_PORTS_BUSY");
      expect((caught as PairError).details?.port).toBe(ports.appPort);
      const registryAfterFailure = readRegistry(base);
      expect(registryAfterFailure.pairs.some((pair) => pair.name === "c")).toBe(false);
      expect(registryAfterFailure.pairs.some((pair) => pair.slot === slot)).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

describe("removePairDir / listPairDirs / pairDirPath — pair state-dir cleanup (B1)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-rmdir-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("removePairDir deletes an existing pair dir and returns true", () => {
    const dir = join(base, "pairs", "main-deadbeef");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agentbridge.log"), "x", "utf-8");
    expect(existsSync(dir)).toBe(true);

    expect(removePairDir(base, "main-deadbeef")).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("removePairDir returns false when the dir does not exist", () => {
    expect(removePairDir(base, "main-nope1234")).toBe(false);
  });

  test("removePairDir rejects path-traversal ids without deleting anything outside pairs/", () => {
    // A sibling directory outside <base>/pairs that a traversal id could target.
    const outside = join(base, "outside-secret");
    mkdirSync(outside, { recursive: true });

    for (const evil of ["..", "../..", "../outside-secret", "a/b", "."]) {
      expect(() => removePairDir(base, evil)).toThrow(PairError);
    }
    // Nothing outside <base>/pairs was touched.
    expect(existsSync(outside)).toBe(true);
  });

  test("pairDirPath validates the id and resolves inside <base>/pairs", () => {
    expect(pairDirPath(base, "main-abcd1234")).toBe(join(pairsRootDir(base), "main-abcd1234"));
    expect(() => pairDirPath(base, "..")).toThrow(PairError);
  });

  test("listPairDirs returns only subdirectories, excluding the registry file and stray files", () => {
    const pairs = join(base, "pairs");
    mkdirSync(join(pairs, "main-aaaa1111"), { recursive: true });
    mkdirSync(join(pairs, "work-bbbb2222"), { recursive: true });
    // writeRegistry drops pairs/registry.json (a FILE), which must NOT be listed.
    writeRegistry(base, { version: 1, pairs: [] });
    writeFileSync(join(pairs, "stray.txt"), "x", "utf-8");

    expect(listPairDirs(base).sort()).toEqual(["main-aaaa1111", "work-bbbb2222"]);
  });

  test("listPairDirs returns [] when pairs/ is absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "abg-pair-empty-"));
    try {
      expect(listPairDirs(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("removePairEntryAndDir / removeUnregisteredPairDir — locked atomic cleanup (B1)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-lockrm-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("removePairEntryAndDir removes a dead pair's entry and dir", async () => {
    const id = "main-deadbeef";
    const dir = join(base, "pairs", id);
    mkdirSync(dir, { recursive: true });
    writeRegistry(base, { version: 1, pairs: [entry(0, id)] });

    const res = await removePairEntryAndDir(base, id);
    expect(res.keptLive).toBe(false);
    expect(res.dirRemoved).toBe(true);
    expect(res.entry?.pairId).toBe(id);
    expect(existsSync(dir)).toBe(false);
    expect(readRegistry(base).pairs.some((p) => p.pairId === id)).toBe(false);
  });

  test("removePairEntryAndDir keeps a LIVE pair's entry and dir (keptLive)", async () => {
    const id = "main-livebeef";
    const dir = join(base, "pairs", id);
    mkdirSync(dir, { recursive: true });
    // process.pid is alive → the in-lock liveness guard must refuse to delete.
    writeFileSync(join(dir, "daemon.pid"), `${process.pid}\n`, "utf-8");
    writeRegistry(base, { version: 1, pairs: [entry(0, id)] });

    const res = await removePairEntryAndDir(base, id);
    expect(res.keptLive).toBe(true);
    expect(res.dirRemoved).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(readRegistry(base).pairs.some((p) => p.pairId === id)).toBe(true);
  });

  test("removeUnregisteredPairDir removes an orphan but skips registered and live dirs", async () => {
    const orphan = "main-orph0001";
    const registered = "main-reg00002";
    const live = "main-live0003";
    for (const id of [orphan, registered, live]) {
      mkdirSync(join(base, "pairs", id), { recursive: true });
    }
    writeFileSync(join(base, "pairs", live, "daemon.pid"), `${process.pid}\n`, "utf-8");
    writeRegistry(base, { version: 1, pairs: [entry(0, registered)] });

    expect(await removeUnregisteredPairDir(base, orphan)).toEqual({ removed: true });
    expect(existsSync(join(base, "pairs", orphan))).toBe(false);

    expect(await removeUnregisteredPairDir(base, registered)).toEqual({ removed: false, reason: "registered" });
    expect(existsSync(join(base, "pairs", registered))).toBe(true);

    expect(await removeUnregisteredPairDir(base, live)).toEqual({ removed: false, reason: "live" });
    expect(existsSync(join(base, "pairs", live))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entry-level reclamation (P1 #9)
// ---------------------------------------------------------------------------

describe("isEntryReclaimable — pure reclaim predicate (P1 #9)", () => {
  const signals = (over: Partial<EntryReclaimSignals> = {}): EntryReclaimSignals => ({
    cwdGone: true,
    dead: true,
    old: true,
    ageMs: RECLAIMABLE_MIN_AGE_MS,
    ...over,
  });

  test("cwd-gone + dead + old → reclaimable", () => {
    expect(isEntryReclaimable(signals())).toBe(true);
  });

  test("cwd still exists → NOT reclaimable", () => {
    expect(isEntryReclaimable(signals({ cwdGone: false }))).toBe(false);
  });

  test("daemon alive (not dead) → NOT reclaimable", () => {
    expect(isEntryReclaimable(signals({ dead: false }))).toBe(false);
  });

  test("too young (not old) → NOT reclaimable", () => {
    expect(isEntryReclaimable(signals({ old: false }))).toBe(false);
  });

  test("only ALL three guards together reclaim — any single veto blocks it", () => {
    // Exhaustively: any one false flag must veto.
    expect(isEntryReclaimable(signals({ cwdGone: false, dead: true, old: true }))).toBe(false);
    expect(isEntryReclaimable(signals({ cwdGone: true, dead: false, old: true }))).toBe(false);
    expect(isEntryReclaimable(signals({ cwdGone: true, dead: true, old: false }))).toBe(false);
  });
});

describe("classifyReclaimableEntries — signal gathering over the registry (P1 #9)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-reclaim-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // A createdAt comfortably older than the min age (used by the "old" cases).
  const oldCreatedAt = new Date(Date.now() - 5 * RECLAIMABLE_MIN_AGE_MS).toISOString();
  // Now used for deterministic age math in the assertions below.
  const fixedNow = Date.now();

  function entryWith(over: Partial<PairEntry>): PairEntry {
    return {
      pairId: over.pairId ?? "main-aaaa0001",
      slot: over.slot ?? 1,
      cwd: over.cwd ?? join(base, "gone-project"),
      name: over.name ?? "main",
      source: over.source ?? "cwd",
      createdAt: over.createdAt ?? oldCreatedAt,
    };
  }

  test("cwd-gone + dead + old entry is classified reclaimable", () => {
    const e = entryWith({ pairId: "main-deadbeef", cwd: join(base, "vanished") });
    writeRegistry(base, { version: 1, pairs: [e] });

    const out = classifyReclaimableEntries(base, fixedNow);
    expect(out).toHaveLength(1);
    expect(out[0]!.entry.pairId).toBe("main-deadbeef");
    expect(out[0]!.signals).toMatchObject({ cwdGone: true, dead: true, old: true });
  });

  test("entry whose cwd still EXISTS is not reclaimable", () => {
    const livingCwd = join(base, "still-here");
    mkdirSync(livingCwd, { recursive: true });
    writeRegistry(base, { version: 1, pairs: [entryWith({ pairId: "main-exist001", cwd: livingCwd })] });

    expect(classifyReclaimableEntries(base, fixedNow)).toHaveLength(0);
  });

  test("entry with a LIVE daemon is not reclaimable even if cwd is gone", () => {
    const id = "main-alive001";
    mkdirSync(join(base, "pairs", id), { recursive: true });
    // process.pid is alive → pairDirDaemonAlive=true → dead=false → vetoed.
    writeFileSync(join(base, "pairs", id, "daemon.pid"), `${process.pid}\n`, "utf-8");
    writeRegistry(base, { version: 1, pairs: [entryWith({ pairId: id, cwd: join(base, "vanished") })] });

    expect(classifyReclaimableEntries(base, fixedNow)).toHaveLength(0);
  });

  test("entry younger than RECLAIMABLE_MIN_AGE_MS is not reclaimable", () => {
    // Created 1 hour ago → well under the 1-day floor.
    const fresh = new Date(fixedNow - 60 * 60 * 1000).toISOString();
    writeRegistry(base, {
      version: 1,
      pairs: [entryWith({ pairId: "main-fresh001", cwd: join(base, "vanished"), createdAt: fresh })],
    });

    expect(classifyReclaimableEntries(base, fixedNow)).toHaveLength(0);
  });

  test("age boundary: exactly RECLAIMABLE_MIN_AGE_MS old is reclaimable; one ms younger is not", () => {
    const atFloor = new Date(fixedNow - RECLAIMABLE_MIN_AGE_MS).toISOString();
    writeRegistry(base, {
      version: 1,
      pairs: [entryWith({ pairId: "main-floor001", cwd: join(base, "vanished"), createdAt: atFloor })],
    });
    expect(classifyReclaimableEntries(base, fixedNow)).toHaveLength(1);

    // Re-evaluate the SAME entry against a `now` one ms earlier than the floor.
    const justUnderNow = fixedNow - 1;
    expect(classifyReclaimableEntries(base, justUnderNow)).toHaveLength(0);
  });

  test("malformed/unparseable createdAt is treated as NOT old (never reaped on age)", () => {
    writeRegistry(base, {
      version: 1,
      pairs: [entryWith({ pairId: "main-badtime1", cwd: join(base, "vanished"), createdAt: "not-a-date" })],
    });
    const out = classifyReclaimableEntries(base, fixedNow);
    expect(out).toHaveLength(0);
  });

  test("classifies a mix: only the cwd-gone + dead + old entry is selected", () => {
    const goneId = "main-gone0001";
    const liveCwd = join(base, "live-cwd");
    mkdirSync(liveCwd, { recursive: true });
    writeRegistry(base, {
      version: 1,
      pairs: [
        entryWith({ pairId: goneId, slot: 1, cwd: join(base, "vanished") }), // reclaimable
        entryWith({ pairId: "main-keepcwd1", slot: 2, cwd: liveCwd }), // cwd exists → kept
        entryWith({ pairId: "main-young001", slot: 3, cwd: join(base, "vanished"), createdAt: new Date(fixedNow).toISOString() }), // too young → kept
      ],
    });

    const out = classifyReclaimableEntries(base, fixedNow);
    expect(out.map((c) => c.entry.pairId)).toEqual([goneId]);
  });
});

describe("pruneReclaimableEntries via removePairEntryAndDir — apply deletes entry + dir (P1 #9)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "abg-pair-reclaim-apply-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("removePairEntryAndDir on a reclaimable entry removes BOTH the entry and its dir", async () => {
    const id = "main-strand01";
    const oldCreatedAt = new Date(Date.now() - 5 * RECLAIMABLE_MIN_AGE_MS).toISOString();
    const dir = join(base, "pairs", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agentbridge.log"), "x", "utf-8");
    writeRegistry(base, {
      version: 1,
      pairs: [{ pairId: id, slot: 1, cwd: join(base, "vanished"), name: "main", source: "cwd", createdAt: oldCreatedAt }],
    });

    // Sanity: classify flags it as reclaimable.
    expect(classifyReclaimableEntries(base).map((c) => c.entry.pairId)).toEqual([id]);

    const res = await removePairEntryAndDir(base, id);
    expect(res.keptLive).toBe(false);
    expect(res.dirRemoved).toBe(true);
    expect(res.entry?.pairId).toBe(id);
    expect(existsSync(dir)).toBe(false);
    expect(readRegistry(base).pairs.some((p) => p.pairId === id)).toBe(false);
  });
});
