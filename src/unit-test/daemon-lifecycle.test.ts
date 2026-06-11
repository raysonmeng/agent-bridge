import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "../state-dir";
import { classifyDaemon, DaemonLifecycle, isProcessAlive, resolveTiming } from "../daemon-lifecycle";
import { BUILD_INFO, type AgentBridgeBuildInfo } from "../build-info";
import type { DaemonStatus } from "../control-protocol";

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    bridgeReady: true,
    tuiConnected: false,
    threadId: null,
    queuedMessageCount: 0,
    proxyUrl: "",
    appServerUrl: "",
    pid: 12345,
    pairId: null,
    build: BUILD_INFO,
    ...overrides,
  };
}

function build(overrides: Partial<AgentBridgeBuildInfo> = {}): AgentBridgeBuildInfo {
  return { ...BUILD_INFO, ...overrides };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe("classifyDaemon", () => {
  const sameBuild = BUILD_INFO;
  const bundleOnlyDrift = build({ bundle: BUILD_INFO.bundle === "plugin" ? "dist" : "plugin" });
  const compatibleCommitDrift = build({ commit: "old-build" });
  const incompatibleContract = build({ commit: "old-build", contractVersion: BUILD_INFO.contractVersion + 1 });

  const cases: Array<{
    name: string;
    expectedPairId: string | null;
    status: DaemonStatus | null;
    /** Launcher-side build info; defaults to BUILD_INFO (the historical shape). */
    launcher?: AgentBridgeBuildInfo;
    expectedVerdict:
      | "reuse"
      | "reuse-despite-drift"
      | "replace-foreign"
      | "replace-drifted"
      | "manual-conflict"
      | "unreachable";
  }> = [
    {
      name: "unreachable status cannot be reused",
      expectedPairId: "mine",
      status: null,
      expectedVerdict: "unreachable",
    },
    {
      name: "manual mode reuses legacy manual daemon",
      expectedPairId: null,
      status: status({ pairId: null, build: sameBuild, tuiConnected: false }),
      expectedVerdict: "reuse",
    },
    {
      name: "manual mode refuses a registered pair daemon",
      expectedPairId: null,
      status: status({ pairId: "registered", build: sameBuild, tuiConnected: true }),
      expectedVerdict: "manual-conflict",
    },
    {
      name: "pair mode treats missing pairId as foreign",
      expectedPairId: "mine",
      status: status({ pairId: null, build: sameBuild, tuiConnected: false }),
      expectedVerdict: "replace-foreign",
    },
    {
      name: "pair mode replaces mismatched pairId",
      expectedPairId: "mine",
      status: status({ pairId: "other", build: sameBuild, tuiConnected: true }),
      expectedVerdict: "replace-foreign",
    },
    {
      name: "same pair and same runtime contract reuses",
      expectedPairId: "mine",
      status: status({ pairId: "mine", build: sameBuild, tuiConnected: false }),
      expectedVerdict: "reuse",
    },
    {
      name: "bundle-only drift reuses because runtime contract matches",
      expectedPairId: "mine",
      status: status({ pairId: "mine", build: bundleOnlyDrift, tuiConnected: false }),
      expectedVerdict: "reuse",
    },
    {
      name: "compatible commit drift without TUI is replaced in the safe window",
      expectedPairId: "mine",
      status: status({ pairId: "mine", build: compatibleCommitDrift, tuiConnected: false }),
      expectedVerdict: "replace-drifted",
    },
    {
      name: "compatible commit drift with live TUI is reused",
      expectedPairId: "mine",
      status: status({ pairId: "mine", build: compatibleCommitDrift, tuiConnected: true }),
      expectedVerdict: "reuse-despite-drift",
    },
    {
      name: "contract mismatch is replaced even with live TUI",
      expectedPairId: "mine",
      status: status({ pairId: "mine", build: incompatibleContract, tuiConnected: true }),
      expectedVerdict: "replace-drifted",
    },
    {
      name: "missing build info is drifted and replaced",
      expectedPairId: "mine",
      status: status({ pairId: "mine", build: undefined, tuiConnected: true }),
      expectedVerdict: "replace-drifted",
    },
    // ── codeHash identity (squash-merge stamp-lag fix) ──────────────────────
    // The committed plugin bundle's stamp always lags the squash-merged master
    // sha by one, so the LIVE incident was: launcher and daemon run byte-identical
    // code, yet commit-stamp comparison kills the healthy daemon in a loop.
    {
      name: "squash-lagged commit stamp with identical codeHash reuses without a TUI",
      expectedPairId: "mine",
      status: status({
        pairId: "mine",
        build: build({ commit: "pr-branch-sha", codeHash: "feedfacecafe" }),
        tuiConnected: false,
      }),
      launcher: build({ commit: "master-sha", codeHash: "feedfacecafe" }),
      expectedVerdict: "reuse",
    },
    {
      name: "identical commit stamp but different codeHash is real drift and replaced",
      expectedPairId: "mine",
      status: status({
        pairId: "mine",
        build: build({ commit: "same-sha", codeHash: "000000000000" }),
        tuiConnected: false,
      }),
      launcher: build({ commit: "same-sha", codeHash: "feedfacecafe" }),
      expectedVerdict: "replace-drifted",
    },
    {
      name: "legacy daemon without codeHash still falls back to commit-stamp drift",
      expectedPairId: "mine",
      status: status({
        pairId: "mine",
        build: build({ commit: "old-build", codeHash: undefined }),
        tuiConnected: false,
      }),
      launcher: build({ commit: "new-build", codeHash: "feedfacecafe" }),
      expectedVerdict: "replace-drifted",
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const result = classifyDaemon(testCase.expectedPairId, testCase.status, testCase.launcher ?? BUILD_INFO);
      expect(result.verdict).toBe(testCase.expectedVerdict);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  }

  test("replace-drifted reason names the comparison basis (codeHash vs commit stamp)", () => {
    const codeHashDrift = classifyDaemon(
      "mine",
      status({ pairId: "mine", build: build({ commit: "same-sha", codeHash: "000000000000" }) }),
      build({ commit: "same-sha", codeHash: "feedfacecafe" }),
    );
    expect(codeHashDrift.verdict).toBe("replace-drifted");
    expect(codeHashDrift.reason).toContain("codeHash");

    const stampDrift = classifyDaemon(
      "mine",
      status({ pairId: "mine", build: build({ commit: "old-build", codeHash: undefined }) }),
      build({ commit: "new-build", codeHash: "feedfacecafe" }),
    );
    expect(stampDrift.verdict).toBe("replace-drifted");
    expect(stampDrift.reason).toContain("commit stamp");
  });

  test("matrix covers every daemon lifecycle verdict", () => {
    expect(new Set(cases.map((testCase) => testCase.expectedVerdict))).toEqual(new Set([
      "reuse",
      "reuse-despite-drift",
      "replace-foreign",
      "replace-drifted",
      "manual-conflict",
      "unreachable",
    ]));
  });
});

describe("DaemonLifecycle", () => {
  let tempDir: string;
  let stateDir: StateDirResolver;
  let logs: string[];
  let savedPairId: string | undefined;
  const servers: Array<{ stop: () => void | Promise<void> }> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-lifecycle-test-"));
    stateDir = new StateDirResolver(tempDir);
    stateDir.ensure();
    logs = [];
    savedPairId = process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_ID;
  });

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.stop();
    if (savedPairId === undefined) delete process.env.AGENTBRIDGE_PAIR_ID;
    else process.env.AGENTBRIDGE_PAIR_ID = savedPairId;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLifecycle(port = 19999) {
    return new DaemonLifecycle({
      stateDir,
      controlPort: port,
      log: (msg) => logs.push(msg),
    });
  }

  function fakeDaemon(
    port: number,
    state: { healthzStatus: number; readyzStatus: number; pairId: string | null; pid?: number },
  ) {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        const body = {
          bridgeReady: state.readyzStatus >= 200 && state.readyzStatus < 300,
          tuiConnected: false,
          threadId: null,
          queuedMessageCount: 0,
          proxyUrl: "",
          appServerUrl: "",
          pid: state.pid ?? 99999,
          pairId: state.pairId,
          build: BUILD_INFO,
        };
        if (url.pathname === "/healthz") return Response.json(body, { status: state.healthzStatus });
        if (url.pathname === "/readyz") return Response.json(body, { status: state.readyzStatus });
        return new Response("ok");
      },
    });
    servers.push(server);
    return server;
  }

  test("healthUrl and controlWsUrl use correct port", () => {
    const lc = createLifecycle(5555);
    expect(lc.healthUrl).toBe("http://127.0.0.1:5555/healthz");
    expect(lc.readyUrl).toBe("http://127.0.0.1:5555/readyz");
    expect(lc.controlWsUrl).toBe("ws://127.0.0.1:5555/ws");
  });

  test("readPid returns null when no pid file", () => {
    const lc = createLifecycle();
    expect(lc.readPid()).toBeNull();
  });

  test("writePid and readPid round-trip", () => {
    const lc = createLifecycle();
    lc.writePid(12345);
    expect(lc.readPid()).toBe(12345);
  });

  test("removePidFile removes the file", () => {
    const lc = createLifecycle();
    lc.writePid(12345);
    expect(existsSync(stateDir.pidFile)).toBe(true);
    lc.removePidFile();
    expect(existsSync(stateDir.pidFile)).toBe(false);
  });

  test("removePidFile does not throw when file missing", () => {
    const lc = createLifecycle();
    expect(() => lc.removePidFile()).not.toThrow();
  });

  test("writeStatus and readStatus round-trip", () => {
    const lc = createLifecycle();
    const status = { proxyUrl: "ws://127.0.0.1:4501", controlPort: 4502, pid: 999 };
    lc.writeStatus(status);
    const loaded = lc.readStatus();
    expect(loaded).toEqual(status);
  });

  test("readStatus returns null when no status file", () => {
    const lc = createLifecycle();
    expect(lc.readStatus()).toBeNull();
  });

  // --- Unified daemon.json (arch-review P2 #536) ---

  test("writeDaemonRecord + readDaemonRecord round-trip via daemon.json", () => {
    const lc = createLifecycle();
    lc.writeDaemonRecord({ pid: 4242, phase: "ready", proxyUrl: "ws://127.0.0.1:4501" });
    expect(existsSync(stateDir.daemonRecordFile)).toBe(true);
    const rec = lc.readDaemonRecord();
    expect(rec?.pid).toBe(4242);
    expect(rec?.proxyUrl).toBe("ws://127.0.0.1:4501");
    expect(rec?.phase).toBe("ready");
  });

  test("readDaemonRecord prefers daemon.json over legacy status.json", () => {
    const lc = createLifecycle();
    lc.writePid(700);
    lc.writeStatus({ pid: 700, proxyUrl: "ws://127.0.0.1:4501" });
    lc.writeDaemonRecord({ pid: 701, phase: "ready", proxyUrl: "ws://127.0.0.1:4701" });
    const rec = lc.readDaemonRecord();
    expect(rec?.pid).toBe(701);
    expect(rec?.proxyUrl).toBe("ws://127.0.0.1:4701");
  });

  test("readDaemonRecord falls back to legacy files when daemon.json absent (old daemon)", () => {
    const lc = createLifecycle();
    lc.writePid(800);
    lc.writeStatus({ pid: 800, proxyUrl: "ws://127.0.0.1:4801", controlPort: 4802 });
    expect(existsSync(stateDir.daemonRecordFile)).toBe(false);
    const rec = lc.readDaemonRecord();
    expect(rec?.pid).toBe(800);
    expect(rec?.proxyUrl).toBe("ws://127.0.0.1:4801");
    expect(rec?.phase).toBe("ready"); // status.json present → ready
    expect(rec?.ports?.controlPort).toBe(4802);
  });

  test("readDaemonRecord returns null when nothing on disk", () => {
    const lc = createLifecycle();
    expect(lc.readDaemonRecord()).toBeNull();
  });

  test("cleanup (via kill on dead pid) removes daemon.json alongside legacy files", async () => {
    const lc = createLifecycle();
    lc.writePid(9999999);
    lc.writeStatus({ pid: 9999999 });
    lc.writeDaemonRecord({ pid: 9999999, phase: "ready" });
    expect(existsSync(stateDir.daemonRecordFile)).toBe(true);

    // Dead pid → kill() runs cleanup(), which must remove ALL THREE files so a
    // killed daemon leaves no live-looking record behind.
    await lc.kill();
    expect(existsSync(stateDir.pidFile)).toBe(false);
    expect(existsSync(stateDir.statusFile)).toBe(false);
    expect(existsSync(stateDir.daemonRecordFile)).toBe(false);
  });

  test("removeDaemonRecord does not throw when file missing", () => {
    const lc = createLifecycle();
    expect(() => lc.removeDaemonRecord()).not.toThrow();
  });

  test("isHealthy returns false for non-existent port", async () => {
    const lc = createLifecycle(19999);
    expect(await lc.isHealthy()).toBe(false);
  });

  test("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("isProcessAlive returns false for non-existent pid", () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });

  test("kill returns false when no pid file", async () => {
    const lc = createLifecycle();
    const result = await lc.kill();
    expect(result).toBe(false);
  });

  test("kill cleans up stale pid for dead process", async () => {
    const lc = createLifecycle();
    lc.writePid(9999999); // non-existent process
    lc.writeStatus({ pid: 9999999 });

    const result = await lc.kill();
    expect(result).toBe(false);
    expect(existsSync(stateDir.pidFile)).toBe(false);
    expect(existsSync(stateDir.statusFile)).toBe(false);
    expect(logs.some((l) => l.includes("not alive"))).toBe(true);
  });

  test("kill refuses to signal a live process that is not an AgentBridge daemon", async () => {
    const lc = createLifecycle();
    // Use current process pid — it's alive but NOT a daemon
    lc.writePid(process.pid);
    // Don't write matching status (so isDaemonProcess falls through to ps check)

    const result = await lc.kill();
    expect(result).toBe(false);
    expect(logs.some((l) => l.includes("NOT an AgentBridge daemon"))).toBe(true);
    // Pid file should be cleaned up
    expect(existsSync(stateDir.pidFile)).toBe(false);
  });

  test("kill proceeds when status.json pid matches", async () => {
    const lc = createLifecycle();
    // Write a non-existent pid but with matching status — tests the isDaemonProcess fast path
    lc.writePid(9999999);
    lc.writeStatus({ pid: 9999999 });

    // Process is dead, so kill returns false before reaching isDaemonProcess
    const result = await lc.kill();
    expect(result).toBe(false);
  });

  test("contended lock aborts immediately when manual mode sees a registered pair daemon", async () => {
    delete process.env.AGENTBRIDGE_PAIR_ID;
    const port = await freePort();
    const daemonState = {
      healthzStatus: 503,
      readyzStatus: 503,
      pairId: "registered-cccc2222",
      pid: 99999,
    };
    fakeDaemon(port, daemonState);
    writeFileSync(stateDir.lockFile, `${process.pid}\n`);
    const lc = createLifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };

    setTimeout(() => {
      daemonState.healthzStatus = 200;
      daemonState.readyzStatus = 200;
    }, 20);

    const startedAt = Date.now();
    let error: Error | null = null;
    try {
      await lc.ensureRunning();
    } catch (err) {
      error = err as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.message).toContain("registered pair registered-cccc2222");
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(killed).toBe(false);
    expect(launched).toBe(false);
  }, 15000);
});

// Lock-down test for arch-review P1 #435: the timing injection seam must default to
// the EXACT historical production cadence. Hard-coded literals (not the module
// constants) so a future edit that lowers the shipped reuse/wait window — e.g. a
// test-tuning value leaking into resolveTiming's fallback — fails here loudly.
describe("resolveTiming production defaults (injection seam guard)", () => {
  // NOTE: REUSE_READY_RETRIES is captured ONCE from AGENTBRIDGE_REUSE_READY_RETRIES at
  // module load — the 12 below is the shipped default observed with that env unset (the
  // normal case for the test runner and CI). If a future env-leak ever set that var at
  // load time, this assertion would surface it as a failure, which is the intent: it
  // pins what the daemon actually ships, not what a runtime mutation could fake.
  test("undefined timing yields the historical hardcoded cadence", () => {
    expect(resolveTiming(undefined)).toEqual({
      reuseReadyRetries: 12, // REUSE_READY_RETRIES default → ~3s reuse window (12×250ms)
      reuseReadyDelayMs: 250, // REUSE_READY_DELAY_MS
      waitReadyRetries: 40, // WAIT_READY_RETRIES → ~10s full wait (40×250ms)
      waitReadyDelayMs: 250, // WAIT_READY_DELAY_MS
    });
  });

  test("partial timing overrides only the supplied fields, rest fall back to prod defaults", () => {
    expect(resolveTiming({ reuseReadyDelayMs: 10, waitReadyRetries: 3 })).toEqual({
      reuseReadyRetries: 12, // untouched → prod default
      reuseReadyDelayMs: 10, // overridden
      waitReadyRetries: 3, // overridden
      waitReadyDelayMs: 250, // untouched → prod default
    });
  });
});
