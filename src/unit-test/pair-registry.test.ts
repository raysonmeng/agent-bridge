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
  DEFAULT_PAIR_NAME,
  derivePairId,
  derivePairIdFromCwd,
  detectLegacyRootDaemon,
  MAX_PAIR_SLOT,
  PairError,
  pickLowestFreeSlot,
  portsForSlot,
  probePortFree,
  readRegistry,
  removePairEntry,
  resolvePair,
  validatePairId,
  writeRegistry,
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

  // resolvePair probes the slot's ports AFTER releasing the lock. Slot 0 maps
  // to 4500/4501/4502, which may be occupied by a real dev-machine daemon — in
  // that case resolvePair throws PAIR_PORTS_BUSY. The registry/slot allocation
  // happens under the lock BEFORE probing, so allocation is durable regardless
  // of the probe outcome. These helpers assert allocation via the registry and
  // tolerate a PAIR_PORTS_BUSY thrown by the port probe.

  // Run resolvePair, returning either the resolved pair or the PairError it
  // threw. Re-throws anything that is not a PAIR_PORTS_BUSY PairError so real
  // failures still surface.
  async function resolveTolerant(
    cwd: string,
    pairFlag?: string,
  ): Promise<{ ok: true; resolved: Awaited<ReturnType<typeof resolvePair>> } | { ok: false; busy: PairError }> {
    try {
      const resolved = await resolvePair(base, pairFlag ? { pairFlag, cwd } : { cwd });
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

      // Allocation must have happened regardless of probe result.
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
    // Occupy slots 0 and 1 so the new pair deterministically lands on slot 2.
    writeRegistry(base, { version: 1, pairs: [entry(0, "a"), entry(1, "b")] });
    const slot2 = portsForSlot(2);
    const server = await bindPort(slot2.appPort); // squat 4520
    try {
      let caught: unknown;
      try {
        await resolvePair(base, { pairFlag: "c", cwd: "/tmp/x" }); // probePorts defaults true
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PairError);
      expect((caught as PairError).code).toBe("PAIR_PORTS_BUSY");
      expect((caught as PairError).details?.port).toBe(slot2.appPort);
    } finally {
      await closeServer(server);
    }
  });
});
