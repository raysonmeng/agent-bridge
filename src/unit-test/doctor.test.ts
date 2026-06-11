import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeBuildDrift, evaluateArtifactAlignment, runDoctor } from "../cli/doctor";
import { derivePairId, writeRegistry } from "../pair-registry";
import type { AgentBridgeBuildInfo } from "../build-info";

const ENV_KEYS = [
  "AGENTBRIDGE_BASE_DIR",
  "AGENTBRIDGE_PAIR_ID",
  "AGENTBRIDGE_PAIR_NAME",
  "AGENTBRIDGE_STATE_DIR",
  "AGENTBRIDGE_APP_PORT",
  "AGENTBRIDGE_PROXY_PORT",
  "AGENTBRIDGE_CONTROL_PORT",
  "AGENTBRIDGE_MANUAL",
  // The CODEX port pair is part of the env-vs-cwd consistency check too. The
  // old doctor masked leftovers by mutating env to match; the read-only doctor
  // reports them honestly, so tests must actually isolate them.
  "CODEX_WS_PORT",
  "CODEX_PROXY_PORT",
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
        "pair registration",
        "env",
        "config.json",
        "daemon health",
        "daemon readiness",
        "codex app-server",
        "build drift",
        "artifact alignment",
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

  test("warns when the daemon log is oversized", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      const pairId = seedPair(root, base);
      const logPath = join(base, "pairs", pairId, "agentbridge.log");
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, "", "utf-8");
      truncateSync(logPath, 101 * 1024 * 1024);

      const report = await runDoctorJson(["--pair", "main"]);
      const daemonLog = report.checks.find((check: { name: string }) => check.name === "daemon log");

      expect(daemonLog.status).toBe("warn");
      expect(daemonLog.detail).toContain("oversized");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("config.json check is OK and reports default-in-effect when no config exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      seedPair(root, base);

      const report = await runDoctorJson(["--pair", "main"]);
      const cfg = report.checks.find((c: { name: string }) => c.name === "config.json");

      expect(cfg.status).toBe("ok");
      expect(cfg.detail).toContain("no project config");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("config.json check is OK and reports custom-values-in-effect for a good custom config", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      seedPair(root, base);
      mkdirSync(join(root, ".agentbridge"), { recursive: true });
      writeFileSync(
        join(root, ".agentbridge", "config.json"),
        JSON.stringify({ budget: { pauseAt: 85, resumeBelow: 20 } }),
        "utf-8",
      );

      const report = await runDoctorJson(["--pair", "main"]);
      const cfg = report.checks.find((c: { name: string }) => c.name === "config.json");

      expect(cfg.status).toBe("ok");
      expect(cfg.detail).toContain("custom values in effect");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("config.json check WARNs on a corrupt config", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      seedPair(root, base);
      mkdirSync(join(root, ".agentbridge"), { recursive: true });
      writeFileSync(join(root, ".agentbridge", "config.json"), "{ broken json", "utf-8");

      const report = await runDoctorJson(["--pair", "main"]);
      const cfg = report.checks.find((c: { name: string }) => c.name === "config.json");

      expect(cfg.status).toBe("warn");
      expect(cfg.detail).toContain("NOT in effect");
      expect(cfg.hint).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("checks daemon health and readiness concurrently", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-doctor-"));
    const base = mkdtempSync(join(tmpdir(), "agentbridge-doctor-base-"));
    const originalFetch = globalThis.fetch;
    try {
      process.chdir(root);
      process.env.AGENTBRIDGE_BASE_DIR = base;
      seedPair(root, base);

      const paths: string[] = [];
      let markReadyRequested: () => void = () => {};
      const readyRequested = new Promise<void>((resolve) => {
        markReadyRequested = resolve;
      });
      const statusPayload = (path: string) => ({
        bridgeReady: true,
        tuiConnected: false,
        threadId: null,
        queuedMessageCount: 0,
        proxyUrl: "ws://127.0.0.1:16841",
        appServerUrl: "ws://127.0.0.1:16840",
        pid: 123,
        pairId: path,
      });

      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/healthz") {
          return new Promise<Response>((resolve, reject) => {
            const signal = init?.signal;
            const onAbort = () => reject(new Error("aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
            readyRequested.then(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve(Response.json(statusPayload(path)));
            });
          });
        }
        if (path === "/readyz") {
          markReadyRequested();
          return Promise.resolve(Response.json(statusPayload(path)));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as unknown as typeof fetch;

      const started = Date.now();
      const report = await runDoctorJson(["--pair", "main"]);

      expect(Date.now() - started).toBeLessThan(900);
      expect(paths).toEqual(["/healthz", "/readyz"]);
      expect(report.daemon.health?.pairId).toBe("/healthz");
      expect(report.daemon.ready?.pairId).toBe("/readyz");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/**
 * Artifact alignment must use the same code-identity basis as the runtime
 * drift detection (codeHash when available, commit stamp as legacy fallback) —
 * otherwise doctor keeps reporting the squash-lag FAIL the runtime fix removed
 * (observed live: repo-bundle=b53f10a FAIL on byte-identical code).
 */
describe("evaluateArtifactAlignment (codeHash basis)", () => {
  test("aligned codeHash with DIFFERENT commit stamps is OK (squash stamp lag)", () => {
    const check = evaluateArtifactAlignment([
      { label: "launcher(dist)", commit: "aaa1111", codeHash: "feedfacecafe" },
      { label: "repo-bundle", commit: "bbb2222", codeHash: "feedfacecafe" },
    ]);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("feedfacecafe");
  });

  test("split codeHash FAILs even when commit stamps agree", () => {
    const check = evaluateArtifactAlignment([
      { label: "launcher(dist)", commit: "aaa1111", codeHash: "feedfacecafe" },
      { label: "repo-bundle", commit: "aaa1111", codeHash: "000000000000" },
    ]);
    expect(check.status).toBe("fail");
    expect(check.hint).toBeDefined();
  });

  test("legacy artifact without codeHash falls back to the stamp basis, annotated", () => {
    const split = evaluateArtifactAlignment([
      { label: "launcher(dist)", commit: "aaa1111", codeHash: "feedfacecafe" },
      { label: "plugin-cache@0.1.0", commit: "bbb2222", codeHash: null },
    ]);
    expect(split.status).toBe("fail");
    expect(split.detail).toContain("stamp"); // basis is visible in the output
    expect(split.hint).toContain("squash"); // may be a stamp-lag false positive

    const aligned = evaluateArtifactAlignment([
      { label: "launcher(dist)", commit: "aaa1111", codeHash: "feedfacecafe" },
      { label: "plugin-cache@0.1.0", commit: "aaa1111", codeHash: null },
    ]);
    expect(aligned.status).toBe("ok");
  });

  test("fewer than two stamped artifacts skips", () => {
    expect(evaluateArtifactAlignment([]).status).toBe("skip");
    expect(
      evaluateArtifactAlignment([{ label: "launcher(dist)", commit: "aaa1111", codeHash: null }]).status,
    ).toBe("skip");
  });
});

describe("describeBuildDrift (basis annotation)", () => {
  const launcher: AgentBridgeBuildInfo = {
    version: "0.1.12",
    commit: "master-sha",
    bundle: "dist",
    contractVersion: 1,
    codeHash: "feedfacecafe",
  };

  test("codeHash-basis drift is annotated as a real code difference", () => {
    const runtime = { ...launcher, codeHash: "000000000000" };
    const described = describeBuildDrift(runtime, launcher);
    expect(described.detail).toContain("codeHash");
    expect(described.detail).not.toContain("stamp");
  });

  test("commit-stamp-basis drift (legacy daemon) is annotated as possibly squash-lag", () => {
    const runtime = { ...launcher, commit: "pr-branch-sha", codeHash: undefined };
    const described = describeBuildDrift(runtime, launcher);
    expect(described.detail).toContain("stamp");
    expect(described.hint).toContain("squash");
  });
});
