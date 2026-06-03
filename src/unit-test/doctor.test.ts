import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../cli/doctor";
import { derivePairId, writeRegistry } from "../pair-registry";

const ENV_KEYS = [
  "AGENTBRIDGE_BASE_DIR",
  "AGENTBRIDGE_PAIR_ID",
  "AGENTBRIDGE_PAIR_NAME",
  "AGENTBRIDGE_STATE_DIR",
  "AGENTBRIDGE_APP_PORT",
  "AGENTBRIDGE_PROXY_PORT",
  "AGENTBRIDGE_CONTROL_PORT",
  "AGENTBRIDGE_MANUAL",
];

const savedEnv = new Map<string, string | undefined>();
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

async function runDoctorJson(args: string[]) {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    await runDoctor([...args, "--json"]);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(lines.join("\n"));
}

function seedPair(root: string, base: string) {
  const pairId = derivePairId(root, "main");
  writeRegistry(base, {
    version: 1,
    pairs: [{
      pairId,
      slot: 1234,
      cwd: root,
      name: "main",
      source: "flag",
      createdAt: "2026-06-02T00:00:00.000Z",
    }],
  });
  return pairId;
}

describe("doctor command", () => {
  test("default doctor runs static local diagnostics for the selected pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      const pairId = seedPair(root, base);

      const report = await runDoctorJson(["--pair", "main"]);

      expect(report.pair.pairId).toBe(pairId);
      expect(report.pair.slot).toBe(1234);
      expect(report.env.ok).toBe(true);
      expect(report.checks.map((check: { name: string }) => check.name)).toEqual([
        "env",
        "daemon health",
        "daemon readiness",
        "build drift",
        "current thread",
        "codex tui (this pair)",
        "codex tui (other pairs)",
        "daemon log",
        "codex wrapper log",
      ]);
      expect(report.checks.some((check: { name: string }) => check.name === "agent backend")).toBe(false);
      // Cross-pair scan fields are always present (arrays, possibly empty).
      expect(Array.isArray(report.tui.attachedHere)).toBe(true);
      expect(Array.isArray(report.tui.attachedElsewhere)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("--agent remains explicit and reports static diagnostics in this build", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      seedPair(root, base);

      const report = await runDoctorJson(["--pair", "main", "--agent"]);
      const agentCheck = report.checks.find((check: { name: string }) => check.name === "agent backend");

      expect(agentCheck).toEqual({
        name: "agent backend",
        status: "warn",
        detail: "--agent is reserved for read-only delegated analysis; static diagnostics were run locally in this build.",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
