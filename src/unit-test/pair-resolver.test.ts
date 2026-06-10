import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { derivePairId, writeRegistry, type PairEntry } from "../pair-registry";
import {
  applyPairEnv,
  computeBaseDir,
  findPair,
  findPairForFlag,
  listPairsForCwd,
  listPairs,
  parseKillArgs,
  parsePairFlag,
  portsForEntry,
  removePair,
  resolvePairReadOnly,
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
  "AGENTBRIDGE_MANUAL",
  "CODEX_WS_PORT",
  "CODEX_PROXY_PORT",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let previousCwd: string;
const tempBases: string[] = [];

beforeEach(() => {
  previousCwd = process.cwd();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (tempBases.length > 0) {
    const base = tempBases.pop();
    if (base) rmSync(base, { recursive: true, force: true });
  }
});

describe("resolvePairReadOnly", () => {
  test("returns an unregistered derived pair without allocating a registry entry", () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;

    const res = resolvePairReadOnly(undefined);

    expect(res.registered).toBe(false);
    expect(res.pair.pairId).toBe(derivePairId(process.cwd(), "main"));
    expect(res.pair.slot).toBeNull();
    expect(res.pair.ports).toEqual({ appPort: 0, proxyPort: 0, controlPort: 0 });
    expect(res.pair.stateDir.dir).toBe(join(base, "pairs", res.pair.pairId));
    expect(listPairs(base)).toEqual([]);
    expect(process.env.AGENTBRIDGE_PAIR_ID).toBeUndefined();
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBeUndefined();
  });

  test("resolves an existing pair without injecting child env", () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;
    const pairId = derivePairId(process.cwd(), "work");
    writeRegistry(base, {
      version: 1,
      pairs: [{ pairId, slot: 2, cwd: process.cwd(), name: "work", source: "flag", createdAt: "2026-01-01T00:00:00.000Z" }],
    });

    const res = resolvePairReadOnly("work");

    expect(res.registered).toBe(true);
    expect(res.pair.pairId).toBe(pairId);
    expect(res.pair.slot).toBe(2);
    expect(res.pair.ports).toEqual({ appPort: 4520, proxyPort: 4521, controlPort: 4522 });
    expect(res.pair.stateDir.dir).toBe(join(base, "pairs", pairId));
    expect(process.env.AGENTBRIDGE_PAIR_ID).toBeUndefined();
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBeUndefined();
  });

  test("preserves manual legacy mode semantics", () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_MANUAL = "1";
    process.env.AGENTBRIDGE_STATE_DIR = base;
    process.env.AGENTBRIDGE_CONTROL_PORT = "5502";
    process.env.CODEX_WS_PORT = "5500";
    process.env.CODEX_PROXY_PORT = "5501";

    const res = resolvePairReadOnly(undefined);

    expect(res.registered).toBe(true);
    expect(res.pair.manual).toBe(true);
    expect(res.pair.pairId).toBe("(manual)");
    expect(res.pair.ports).toEqual({ appPort: 5500, proxyPort: 5501, controlPort: 5502 });
    expect(listPairs(base)).toEqual([]);
  });

  test("falls back to a derived identity when the registry is corrupt", () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;
    mkdirSync(join(base, "pairs"), { recursive: true });
    writeFileSync(join(base, "pairs", "registry.json"), "{not-json", "utf-8");

    const res = resolvePairReadOnly("main");

    expect(res.registered).toBe(false);
    expect(res.pair.pairId).toBe(derivePairId(process.cwd(), "main"));
    expect(res.pair.ports).toEqual({ appPort: 0, proxyPort: 0, controlPort: 0 });
  });

  test("rejects invalid pair names instead of treating them as unregistered pairs", () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_STATE_DIR = base;

    expect(() => resolvePairReadOnly("../escape")).toThrow("Invalid --pair name");
    expect(listPairs(base)).toEqual([]);
  });
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
  test("no args → all:false, no pair (router treats as current-cwd kill)", () => {
    expect(parseKillArgs([])).toEqual({ all: false, pairFlag: undefined });
  });
  test("--all", () => {
    expect(parseKillArgs(["--all"])).toEqual({ all: true, pairFlag: undefined });
  });
  test("all", () => {
    expect(parseKillArgs(["all"])).toEqual({ all: true, pairFlag: undefined });
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
  test("explicit port env + AGENTBRIDGE_MANUAL=1 + no --pair → manual, ports from env, registry untouched", async () => {
    const base = makeBase();
    process.env.AGENTBRIDGE_MANUAL = "1";
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

  test("explicit port env without AGENTBRIDGE_MANUAL no longer enters implicit manual mode", async () => {
    const base = makeBase();
    const pairId = derivePairId(process.cwd(), "main");
    writeRegistry(base, {
      version: 1,
      pairs: [{ pairId, slot: 4, cwd: process.cwd(), name: "main", source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    process.env.AGENTBRIDGE_STATE_DIR = base;
    process.env.AGENTBRIDGE_CONTROL_PORT = "4502";
    process.env.CODEX_WS_PORT = "4500";
    process.env.CODEX_PROXY_PORT = "4501";

    const res = await applyPairEnv({});

    expect(res.manual).toBe(false);
    expect(res.pairId).toBe(pairId);
    expect(process.env.AGENTBRIDGE_STATE_DIR).toContain(join(base, "pairs"));
    expect(process.env.AGENTBRIDGE_CONTROL_PORT).toBe("4542");
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

describe("listPairsForCwd", () => {
  test("returns only pairs whose cwd realpath matches the requested cwd", () => {
    const base = makeBase();
    const project = mkdtempSync(join(tmpdir(), "agentbridge-project-"));
    const linked = `${project}-link`;
    tempBases.push(project, linked);
    symlinkSync(project, linked, "dir");
    const sameCwdPairId = derivePairId(project, "main");
    const otherCwd = mkdtempSync(join(tmpdir(), "agentbridge-other-project-"));
    tempBases.push(otherCwd);
    const otherCwdPairId = derivePairId(otherCwd, "main");
    writeRegistry(base, {
      version: 1,
      pairs: [
        { pairId: sameCwdPairId, slot: 0, cwd: project, name: "main", source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" },
        { pairId: otherCwdPairId, slot: 1, cwd: otherCwd, name: "main", source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });

    expect(listPairsForCwd(base, linked).map((p) => p.pairId)).toEqual([sameCwdPairId]);
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

  test("falls back to a raw composite pairId only in the same cwd", () => {
    const base = makeBase();
    const cwd = "/tmp/projX";
    const pairId = seed(base, cwd, "work");
    expect(findPairForFlag(base, cwd, pairId)?.pairId).toBe(pairId);
    expect(findPairForFlag(base, "/tmp/unrelated", pairId)).toBeNull();
  });

  test("trims a raw composite pairId flag for the same cwd (kill/pairs aligns with launch on whitespace)", () => {
    const base = makeBase();
    const cwd = "/tmp/projX";
    const pairId = seed(base, cwd, "work");
    // A flag with surrounding whitespace must resolve to the same pair as the trimmed
    // form — matching resolvePair (launch), which validates/trims before the raw match.
    expect(findPairForFlag(base, cwd, `  ${pairId}  `)?.pairId).toBe(pairId);
    expect(findPairForFlag(base, "/tmp/unrelated", `  ${pairId}  `)).toBeNull();
  });

  test("reaches an OLD verbatim-id entry (no name field) via the raw fallback only in the same cwd", () => {
    const base = makeBase();
    const cwd = "/tmp/anything";
    writeRegistry(base, {
      version: 1,
      pairs: [{ pairId: "work", slot: 0, cwd, source: "flag", createdAt: "2026-01-01T00:00:00.000Z" }],
    }); // legacy shape
    expect(findPairForFlag(base, cwd, "work")?.pairId).toBe("work");
    expect(findPairForFlag(base, "/tmp/other", "work")).toBeNull();
  });

  test("throws PAIR_ID_INVALID for a malformed flag", () => {
    const base = makeBase();
    expect(() => findPairForFlag(base, "/tmp/x", "../escape")).toThrow();
  });
});
