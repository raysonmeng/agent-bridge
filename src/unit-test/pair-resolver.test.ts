import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { derivePairId, writeRegistry, type PairEntry } from "../pair-registry";
import {
  applyPairEnv,
  computeBaseDir,
  findPair,
  findPairForFlag,
  listPairs,
  parseKillArgs,
  parsePairFlag,
  portsForEntry,
  removePair,
} from "../pair-resolver";

// ---------------------------------------------------------------------------
// Env isolation: pair env vars leak across tests otherwise.
// ---------------------------------------------------------------------------
const ENV_KEYS = [
  "AGENTBRIDGE_BASE_DIR",
  "AGENTBRIDGE_STATE_DIR",
  "AGENTBRIDGE_CONTROL_PORT",
  "AGENTBRIDGE_PAIR_ID",
  "AGENTBRIDGE_PAIR_NAME",
  "CODEX_WS_PORT",
  "CODEX_PROXY_PORT",
] as const;

let savedEnv: Record<string, string | undefined> = {};
const tempBases: string[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (tempBases.length > 0) {
    const base = tempBases.pop();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "agentbridge-resolver-"));
  tempBases.push(base);
  return base;
}

function entry(pairId: string, slot: number): PairEntry {
  return { pairId, slot, cwd: `/tmp/${pairId}`, source: "flag", createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("parsePairFlag", () => {
  test("extracts --pair <name> and leaves the rest in order", () => {
    const { pairFlag, rest } = parsePairFlag(["--pair", "work", "--resume", "-x"]);
    expect(pairFlag).toBe("work");
    expect(rest).toEqual(["--resume", "-x"]);
  });

  test("extracts --pair=<name>", () => {
    const { pairFlag, rest } = parsePairFlag(["--model", "o3", "--pair=review"]);
    expect(pairFlag).toBe("review");
    expect(rest).toEqual(["--model", "o3"]);
  });

  test("no flag → undefined, rest untouched", () => {
    const { pairFlag, rest } = parsePairFlag(["--resume", "foo"]);
    expect(pairFlag).toBeUndefined();
    expect(rest).toEqual(["--resume", "foo"]);
  });

  test("--pair with a missing value → empty string (forces a clear error downstream)", () => {
    const { pairFlag, rest } = parsePairFlag(["--pair"]);
    expect(pairFlag).toBe("");
    expect(rest).toEqual([]);
  });

  test("--pair followed by another flag does not consume the flag as a value", () => {
    const { pairFlag, rest } = parsePairFlag(["--pair", "--resume"]);
    expect(pairFlag).toBe("");
    expect(rest).toEqual(["--resume"]);
  });
});

describe("parseKillArgs", () => {
  test("no args → all:false, no pair (router treats as kill-all)", () => {
    expect(parseKillArgs([])).toEqual({ all: false, pairFlag: undefined });
  });
  test("--all", () => {
    expect(parseKillArgs(["--all"])).toEqual({ all: true, pairFlag: undefined });
  });
  test("--pair X", () => {
    expect(parseKillArgs(["--pair", "work"])).toEqual({ all: false, pairFlag: "work" });
  });
  test("--pair=X", () => {
    expect(parseKillArgs(["--pair=review"])).toEqual({ all: false, pairFlag: "review" });
  });
});

describe("computeBaseDir", () => {
  test("honours AGENTBRIDGE_STATE_DIR", () => {
    process.env.AGENTBRIDGE_STATE_DIR = "/tmp/custom-base";
    expect(computeBaseDir()).toBe("/tmp/custom-base");
  });
  test("falls back to the platform base dir when unset", () => {
    // Platform base ends in AgentBridge (macOS) or agentbridge (linux).
    expect(computeBaseDir().toLowerCase()).toContain("agentbridge");
  });
});

describe("applyPairEnv — manual/legacy mode", () => {
  test("explicit port env + no --pair → manual, ports from env, registry untouched", async () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;
    process.env.AGENTBRIDGE_CONTROL_PORT = "4502";
    process.env.CODEX_WS_PORT = "4500";
    process.env.CODEX_PROXY_PORT = "4501";

    const res = await applyPairEnv({});

    expect(res.manual).toBe(true);
    expect(res.pairId).toBe("(manual)");
    expect(res.slot).toBeNull();
    expect(res.ports).toEqual({ appPort: 4500, proxyPort: 4501, controlPort: 4502 });
    // Manual mode does not allocate a slot: no registry written under the base.
    expect(listPairs(base)).toEqual([]);
  });
});

describe("applyPairEnv — pair mode env injection", () => {
  test("an existing pair injects its slot's ports + state dir + pair id (no port probe)", async () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;
    // The friendly name "work" is scoped to the cwd; seed the composite id that
    // applyPairEnv (cwd = process.cwd()) will derive, at slot 3, so resolvePair
    // takes the existing branch (no port probe → deterministic regardless of host).
    const pairId = derivePairId(process.cwd(), "work");
    writeRegistry(base, {
      version: 1,
      pairs: [{ pairId, slot: 3, cwd: process.cwd(), name: "work", source: "flag", createdAt: "2026-01-01T00:00:00.000Z" }],
    });

    const res = await applyPairEnv({ pairFlag: "work" });

    expect(res.manual).toBe(false);
    expect(res.pairId).toBe(pairId);
    expect(res.name).toBe("work");
    expect(res.slot).toBe(3);
    expect(res.ports).toEqual({ appPort: 4530, proxyPort: 4531, controlPort: 4532 });

    // The env vars + pair id/name are injected for downstream / spawned children.
    expect(process.env.AGENTBRIDGE_PAIR_ID).toBe(pairId);
    expect(process.env.AGENTBRIDGE_PAIR_NAME).toBe("work");
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBe("4532");
    expect(process.env.CODEX_WS_PORT).toBe("4530");
    expect(process.env.CODEX_PROXY_PORT).toBe("4531");
    expect(process.env.AGENTBRIDGE_STATE_DIR).toBe(join(base, "pairs", pairId));
    expect(res.stateDir.dir).toBe(join(base, "pairs", pairId));
    // BASE_DIR is pinned to the registry base (NOT the per-pair state dir) so a
    // child `abg pairs`/`abg kill` resolves the same registry.
    expect(process.env.AGENTBRIDGE_BASE_DIR).toBe(base);
  });

  test("a child inheriting the pair env still resolves the registry base", async () => {
    // Simulate a child of `abg claude --pair work`: BASE_DIR=base, STATE_DIR=pair dir.
    const base = makeBase();
    writeRegistry(base, { version: 1, pairs: [entry("work", 0)] });
    process.env.AGENTBRIDGE_BASE_DIR = base;
    process.env.AGENTBRIDGE_STATE_DIR = join(base, "pairs", "work");
    // computeBaseDir must prefer BASE_DIR over the (per-pair) STATE_DIR.
    expect(computeBaseDir()).toBe(base);
    expect(findPair(computeBaseDir(), "work")?.pairId).toBe("work");
  });

  test("an invalid --pair name is rejected", async () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;
    await expect(applyPairEnv({ pairFlag: "../escape" })).rejects.toThrow();
  });

  test("an explicit-but-empty --pair (missing value) is rejected, not cwd-derived", async () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;
    await expect(applyPairEnv({ pairFlag: "" })).rejects.toThrow();
  });
});

describe("registry helpers", () => {
  test("listPairs / findPair / portsForEntry / removePair", async () => {
    const base = makeBase();
    writeRegistry(base, { version: 1, pairs: [entry("a", 0), entry("b", 1)] });

    expect(listPairs(base).map((p) => p.pairId).sort()).toEqual(["a", "b"]);

    const b = findPair(base, "B"); // case-insensitive
    expect(b?.pairId).toBe("b");
    expect(b?.slot).toBe(1);
    expect(portsForEntry(b!)).toEqual({ appPort: 4510, proxyPort: 4511, controlPort: 4512 });

    expect(findPair(base, "missing")).toBeNull();

    const removed = await removePair(base, "a");
    expect(removed?.pairId).toBe("a");
    expect(listPairs(base).map((p) => p.pairId)).toEqual(["b"]);
  });
});

describe("findPairForFlag — cwd-scoped name resolution (used by kill / pairs rm)", () => {
  function seed(base: string, cwd: string, name: string, slot = 0) {
    const pairId = derivePairId(cwd, name);
    writeRegistry(base, {
      version: 1,
      pairs: [{ pairId, slot, cwd, name, source: "flag", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    return pairId;
  }

  test("matches a friendly name scoped to the cwd", () => {
    const base = makeBase();
    const cwd = "/tmp/projX";
    const pairId = seed(base, cwd, "work");
    expect(findPairForFlag(base, cwd, "work")?.pairId).toBe(pairId);
  });

  test("the same name from a DIFFERENT cwd does not match (different pair)", () => {
    const base = makeBase();
    const cwd = "/tmp/projX";
    seed(base, cwd, "work");
    expect(findPairForFlag(base, "/tmp/projY", "work")).toBeNull();
  });

  test("falls back to a raw composite pairId regardless of cwd", () => {
    const base = makeBase();
    const cwd = "/tmp/projX";
    const pairId = seed(base, cwd, "work");
    // From an unrelated cwd the friendly name won't resolve, but the raw id does.
    expect(findPairForFlag(base, "/tmp/unrelated", pairId)?.pairId).toBe(pairId);
  });

  test("reaches an OLD verbatim-id entry (no name field) via the raw fallback", () => {
    const base = makeBase();
    writeRegistry(base, { version: 1, pairs: [entry("work", 0)] }); // legacy shape
    expect(findPairForFlag(base, "/tmp/anything", "work")?.pairId).toBe("work");
  });

  test("throws PAIR_ID_INVALID for a malformed flag", () => {
    const base = makeBase();
    expect(() => findPairForFlag(base, "/tmp/x", "../escape")).toThrow();
  });
});
