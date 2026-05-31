import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { derivePairId, readRegistry, resolvePair } from "../pair-registry";

// Absolute path to the module under test, so the throwaway child script can
// import it regardless of where the OS drops the temp dir.
const PAIR_REGISTRY_PATH = fileURLToPath(new URL("../pair-registry.ts", import.meta.url));

const tempBases: string[] = [];

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "agentbridge-pair-conc-"));
  tempBases.push(base);
  return base;
}

afterEach(() => {
  while (tempBases.length > 0) {
    const base = tempBases.pop();
    if (base) {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function waitForChild(child: ChildProcess, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const err: string[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => out.push(chunk.toString()));
    child.stderr?.on("data", (chunk) => err.push(chunk.toString()));

    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Child timed out after ${timeoutMs}ms\nstdout: ${out.join("")}\nstderr: ${err.join("")}`));
        return;
      }
      resolve({ code, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

/**
 * Throwaway script run by an independent `bun` process. It calls resolvePair
 * against the shared base and prints the resolved slot. A port-probe failure
 * (PAIR_PORTS_BUSY) is caught and reported with the slot that *was* allocated
 * in the registry, so the test can distinguish "allocation collided" (a real
 * bug) from "a real daemon already squats the probed port" (environmental).
 */
function buildChildScript(): string {
  // JSON.stringify the import path so backslashes / quotes survive embedding.
  const importPath = JSON.stringify(PAIR_REGISTRY_PATH);
  return `import { resolvePair, PairError } from ${importPath};

const base = process.env.PAIR_BASE;
const pairFlag = process.argv[2];
const cwd = process.argv[3];

if (!base) {
  console.error("PAIR_BASE env is required");
  process.exit(2);
}

try {
  // probePorts:false — this test exercises pure slot-allocation mutual
  // exclusion, not port binding, so it must not depend on which ports happen
  // to be free on the host (a real local daemon may squat 4500-4502).
  const resolved = await resolvePair(base, { pairFlag, cwd, probePorts: false });
  process.stdout.write(JSON.stringify({ slot: resolved.slot, pairId: resolved.pairId }));
  process.exit(0);
} catch (err) {
  if (err instanceof PairError) {
    const slot = typeof err.details?.slot === "number" ? err.details.slot : null;
    process.stdout.write(JSON.stringify({ slot, error: err.code }));
    // Exit 0 even on PairError: the test inspects parsed stdout, and the
    // registry (read by the parent) is the source of truth for allocation.
    process.exit(0);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(3);
}
`;
}

interface ChildOutput {
  slot: number | null;
  pairId?: string;
  error?: string;
}

describe("pair-registry concurrency", () => {
  test(
    "parallel independent processes never collide on a slot",
    async () => {
      const base = makeBase();
      const scriptPath = join(base, "resolve-pair-child.ts");
      writeFileSync(scriptPath, buildChildScript(), "utf-8");

      const CHILD_COUNT = 8;
      // Distinct deterministic pair ids => each child is a distinct pair and
      // must therefore receive a distinct slot.
      const children: ChildProcess[] = [];
      for (let i = 0; i < CHILD_COUNT; i++) {
        const childCwd = join(base, `proj-${i}`);
        mkdirSync(childCwd, { recursive: true });
        // Spawn ALL at once — do NOT await between spawns — to actually
        // exercise the cross-process lock under contention.
        children.push(
          spawn(process.execPath, ["run", scriptPath, `p${i}`, childCwd], {
            cwd: base,
            env: { ...process.env, PAIR_BASE: base },
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      }

      const results = await Promise.all(children.map((c) => waitForChild(c, 25000)));

      // All children exited cleanly (PairError is caught and exits 0 in the script).
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        expect(r.code, `child p${i} exit code (stderr: ${r.stderr})`).toBe(0);
      }

      const outputs: ChildOutput[] = results.map((r, i) => {
        try {
          return JSON.parse(r.stdout.trim()) as ChildOutput;
        } catch {
          throw new Error(`child p${i} produced unparseable stdout: ${JSON.stringify(r.stdout)}`);
        }
      });

      // Only PAIR_PORTS_BUSY is environmentally tolerated (a real daemon may
      // already squat slot-0's ports 4500-4502 on a dev machine). Any other
      // PairError code is a real failure — surface it loudly.
      const errored = outputs.filter((o) => o.error !== undefined);
      for (let i = 0; i < outputs.length; i++) {
        const o = outputs[i]!;
        if (o.error !== undefined) {
          expect(
            o.error,
            `child p${i} returned an unexpected error code: ${JSON.stringify(o)}`,
          ).toBe("PAIR_PORTS_BUSY");
        }
      }

      // ===== THE CRITICAL CORRECTNESS PROPERTY =====
      // Each child's *returned* slot is the authoritative record of what the
      // allocator assigned it (captured at return, before any later writer can
      // clobber the on-disk registry). 8 distinct pairs MUST receive 8 DISTINCT
      // slots. Two children sharing a slot means two pairs would bind the same
      // port triple — a real cross-process-lock failure. We assert on the child
      // return values (not the on-disk registry) because a lost-write race can
      // hide a duplicate-allocation by clobbering one of the colliding entries,
      // making the registry *look* clean while the collision really happened.
      const childSlots = outputs
        .map((o) => o.slot)
        .filter((s): s is number => typeof s === "number");

      // Every child resolved to a numeric slot (busy children still report the
      // slot they were allocated via PairError.details.slot).
      expect(
        childSlots.length,
        `every child must report an allocated slot. outputs: ${JSON.stringify(outputs)}`,
      ).toBe(CHILD_COUNT);

      const sortedChildSlots = [...childSlots].sort((a, b) => a - b);
      expect(
        new Set(childSlots).size,
        `SLOT COLLISION — two independent processes were assigned the SAME slot. ` +
          `This is a real cross-process-lock bug (mutual exclusion failed). ` +
          `assigned slots: ${JSON.stringify(sortedChildSlots)}`,
      ).toBe(CHILD_COUNT);

      // With no collision, the 8 distinct slots are exactly {0..7}.
      expect(
        sortedChildSlots,
        `assigned slots must be exactly 0..7. got: ${JSON.stringify(sortedChildSlots)}`,
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      // ===== Registry consistency (secondary) =====
      // The on-disk registry is the persisted view of allocation. In the
      // absence of any lock race it should hold all 8 entries with slots
      // {0..7}. We assert NO DUPLICATE slot in the registry (a duplicate here
      // would be an even more severe corruption than a lost write). The exact
      // entry count is verified above via child return values; if the registry
      // holds fewer than CHILD_COUNT entries that indicates a lost-write race
      // (entries silently clobbered), so we surface it as an explicit failure
      // rather than masking it.
      const reg = readRegistry(base);
      const registrySlots = reg.pairs.map((p) => p.slot);
      expect(
        new Set(registrySlots).size,
        `DUPLICATE SLOT persisted in registry — registry corruption. ` +
          `pairs: ${JSON.stringify(reg.pairs)}`,
      ).toBe(registrySlots.length);
      expect(
        reg.pairs.length,
        `registry lost entries (lost-write race under the registry lock). ` +
          `expected ${CHILD_COUNT}, got ${reg.pairs.length}. pairs: ${JSON.stringify(reg.pairs)}`,
      ).toBe(CHILD_COUNT);

      // Sanity: errored children, if any, were only the slot-0 port squatter.
      for (const e of errored) {
        expect(e.slot === null || typeof e.slot === "number").toBe(true);
      }
    },
    30000,
  );

  // The lock is a FILE (created via temp + linkSync), not a directory. Seeding a
  // file with a DEAD owner pid exercises the dead-pid reclaim branch specifically
  // (not the orphan-grace fallback).
  test("reclaims a stale lock held by a DEAD owner pid and succeeds", async () => {
    const base = makeBase();
    const pairsDir = join(base, "pairs");
    mkdirSync(pairsDir, { recursive: true });
    const lockFile = join(pairsDir, ".registry.lock");
    // 2147483646 is effectively never a live pid → dead-pid reclaim.
    writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, createdAt: 0, nonce: "stale-owner" }), "utf-8");

    const cwd = join(base, "stale-proj");
    mkdirSync(cwd, { recursive: true });

    const resolved = await resolvePair(base, { pairFlag: "x", cwd, probePorts: false });

    const expectedId = derivePairId(cwd, "x");
    expect(resolved.pairId).toBe(expectedId);
    expect(resolved.slot).toBe(0);
    expect(resolved.ports.appPort).toBe(4500);
    // The lock must be released after the call returns.
    expect(existsSync(lockFile)).toBe(false);
    expect(readRegistry(base).pairs.map((p) => p.pairId)).toContain(expectedId);
  });

  // A corrupt lock with pid:0 must be treated as dead (process.kill(0,0) targets
  // the process GROUP and would otherwise falsely look "alive" → deadlock).
  test("reclaims a corrupt lock with pid:0 instead of deadlocking", async () => {
    const base = makeBase();
    const pairsDir = join(base, "pairs");
    mkdirSync(pairsDir, { recursive: true });
    writeFileSync(join(pairsDir, ".registry.lock"), JSON.stringify({ pid: 0, createdAt: 0, nonce: "bad" }), "utf-8");

    const cwd = join(base, "pid0-proj");
    mkdirSync(cwd, { recursive: true });

    const resolved = await resolvePair(base, { pairFlag: "y", cwd, probePorts: false });
    expect(resolved.pairId).toBe(derivePairId(cwd, "y"));
    expect(existsSync(join(pairsDir, ".registry.lock"))).toBe(false);
  });

  test("same cwd resolves idempotently to one slot / one registry entry", async () => {
    const base = makeBase();
    const cwd = join(base, "same-proj");
    mkdirSync(cwd, { recursive: true });

    const first = await resolvePair(base, { cwd, probePorts: false });
    const second = await resolvePair(base, { cwd, probePorts: false });

    expect(second.slot).toBe(first.slot);
    expect(second.pairId).toBe(first.pairId);

    const reg = readRegistry(base);
    expect(reg.pairs.length).toBe(1);
    expect(reg.pairs[0]?.pairId).toBe(first.pairId);
  });

  // Regression for the round-2 finding: a PRE-EXISTING dead lock + many concurrent
  // acquirers previously let two reclaimers evict each other's fresh lock and enter
  // the critical section together (duplicate slot). The serialized reclaim lock must
  // make the dead lock reclaimed exactly once with NO slot collision.
  test(
    "concurrent acquirers with a seeded DEAD lock never collide on a slot",
    async () => {
      const base = makeBase();
      const pairsDir = join(base, "pairs");
      mkdirSync(pairsDir, { recursive: true });
      // Seed a stale primary lock held by a dead pid — forces the reclaim path.
      writeFileSync(
        join(pairsDir, ".registry.lock"),
        JSON.stringify({ pid: 2147483646, createdAt: 0, nonce: "dead-seed" }),
        "utf-8",
      );

      const scriptPath = join(base, "resolve-pair-child.ts");
      writeFileSync(scriptPath, buildChildScript(), "utf-8");

      const CHILD_COUNT = 8;
      const children: ChildProcess[] = [];
      for (let i = 0; i < CHILD_COUNT; i++) {
        const childCwd = join(base, `dproj-${i}`);
        mkdirSync(childCwd, { recursive: true });
        children.push(
          spawn(process.execPath, ["run", scriptPath, `d${i}`, childCwd], {
            cwd: base,
            env: { ...process.env, PAIR_BASE: base },
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
      }

      const results = await Promise.all(children.map((c) => waitForChild(c, 25000)));
      for (let i = 0; i < results.length; i++) {
        expect(results[i]!.code, `child d${i} (stderr: ${results[i]!.stderr})`).toBe(0);
      }

      const slots = results
        .map((r) => (JSON.parse(r.stdout.trim()) as ChildOutput).slot)
        .filter((s): s is number => typeof s === "number");

      expect(slots.length, `outputs: ${JSON.stringify(results.map((r) => r.stdout))}`).toBe(CHILD_COUNT);
      expect(
        new Set(slots).size,
        `SLOT COLLISION under dead-lock reclaim — got ${JSON.stringify([...slots].sort((a, b) => a - b))}`,
      ).toBe(CHILD_COUNT);

      // Registry is the persisted truth: 8 entries, no duplicate slot, dead lock gone.
      const reg = readRegistry(base);
      expect(reg.pairs.length).toBe(CHILD_COUNT);
      expect(new Set(reg.pairs.map((p) => p.slot)).size).toBe(CHILD_COUNT);
      expect(existsSync(join(pairsDir, ".registry.lock"))).toBe(false);
    },
    30000,
  );
});
