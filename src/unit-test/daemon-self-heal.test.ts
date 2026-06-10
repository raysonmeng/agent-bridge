import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "../state-dir";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { BUILD_INFO } from "../build-info";

// Allocate an ephemeral free port so these tests never collide with a real
// dev-machine daemon (4500-45xx) or each other.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function selfAlive(): boolean {
  try {
    process.kill(process.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Covers the ensureRunning() self-heal contract: reuse a healthy/ready/matching-pair
 * daemon, but kill+replace a foreign-pair daemon or a healthz-OK/readyz-503 zombie —
 * while never killing a healthy-but-slow-to-boot daemon. launch()/kill() are mocked so
 * no real daemon is spawned and no real process is signalled; a fake control server
 * drives the healthz/readyz/pairId responses ensureRunning reacts to.
 */
describe("DaemonLifecycle self-heal (zombie / foreign daemon replacement)", () => {
  let tempDir: string;
  let stateDir: StateDirResolver;
  let savedPairId: string | undefined;
  const servers: Array<{ stop: () => void | Promise<void> }> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "abg-selfheal-test-"));
    stateDir = new StateDirResolver(tempDir);
    stateDir.ensure();
    savedPairId = process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_ID;
  });

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()!.stop();
    if (savedPairId === undefined) delete process.env.AGENTBRIDGE_PAIR_ID;
    else process.env.AGENTBRIDGE_PAIR_ID = savedPairId;
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Fake control server with a mutable readyz status + reported pairId.
  function fakeDaemon(port: number, state: { readyzStatus: number; pairId: string | null; pid?: number }) {
    const s = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        const body = {
          bridgeReady: false,
          tuiConnected: false,
          threadId: null,
          queuedMessageCount: 0,
          proxyUrl: "",
          appServerUrl: "",
          pid: state.pid ?? 99999,
          pairId: state.pairId,
          build: BUILD_INFO,
        };
        if (u.pathname === "/healthz") return Response.json(body);
        if (u.pathname === "/readyz") return Response.json(body, { status: state.readyzStatus });
        return new Response("ok");
      },
    });
    servers.push(s);
    return s;
  }

  function lifecycle(port: number) {
    return new DaemonLifecycle({ stateDir, controlPort: port, log: () => {} });
  }

  test("reuses a healthy, ready, matching-pair daemon (no kill, no launch)", async () => {
    const port = await freePort();
    fakeDaemon(port, { readyzStatus: 200, pairId: null });
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(false);
    expect(launched).toBe(false);
  });

  test("replaces a foreign-pair daemon squatting the control port (pairId mismatch)", async () => {
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    // Foreign daemon: reports ready, but a DIFFERENT pairId than this pair expects.
    fakeDaemon(port, { readyzStatus: 200, pairId: "other-bbbb1111", pid: 99999 });
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    let killPid: number | undefined;
    (lc as any).kill = async (_t?: number, pid?: number) => {
      killed = true;
      killPid = pid;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(true);
    expect(launched).toBe(true);
    expect(killPid).toBe(99999); // targeted kill via the /healthz body pid, not the pid file
  });

  // Drifted-daemon fixture: same pair, same contractVersion unless overridden.
  function driftedDaemon(
    port: number,
    opts: { tuiConnected: boolean; contractVersion?: number },
  ) {
    const s = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        const body = {
          bridgeReady: true,
          tuiConnected: opts.tuiConnected,
          threadId: opts.tuiConnected ? "thread" : null,
          queuedMessageCount: 0,
          proxyUrl: "",
          appServerUrl: "",
          pid: 99999,
          pairId: "mine-aaaa0000",
          build: {
            ...BUILD_INFO,
            commit: "old-build",
            contractVersion: opts.contractVersion ?? BUILD_INFO.contractVersion,
          },
        };
        if (u.pathname === "/healthz" || u.pathname === "/readyz") return Response.json(body);
        return new Response("ok");
      },
    });
    servers.push(s);
    return s;
  }

  test("replaces a drifted daemon when NO Codex TUI is attached (safe upgrade window)", async () => {
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    driftedDaemon(port, { tuiConnected: false });
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    let killPid: number | undefined;
    (lc as any).kill = async (_t?: number, pid?: number) => {
      killed = true;
      killPid = pid;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(true);
    expect(launched).toBe(true);
    expect(killPid).toBe(99999);
  });

  test("REUSES a drifted daemon (same contract) when a live Codex TUI is attached", async () => {
    // Replacing a live daemon severs the codex proxy and kills the user's TUI
    // session ("Connection reset without closing handshake") — the proven failure
    // mode behind "abg codex dies right after starting". Same-contract drift with
    // a live TUI must reuse, never replace.
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    driftedDaemon(port, { tuiConnected: true });
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(false);
    expect(launched).toBe(false);
  });

  test("replaces a contract-incompatible daemon even when a Codex TUI is attached", async () => {
    // contractVersion mismatch means the frontend literally cannot speak to the
    // daemon — reuse is impossible, so replacement is mandatory despite the cost.
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    driftedDaemon(port, { tuiConnected: true, contractVersion: BUILD_INFO.contractVersion + 1 });
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(true);
    expect(launched).toBe(true);
  });

  test("manual mode refuses to adopt or replace a REGISTERED pair's daemon (no squatting)", async () => {
    // No AGENTBRIDGE_PAIR_ID (manual/unwrapped session), but the daemon on the
    // port belongs to a registered pair. Reusing would squat it; replacing
    // would kill it. ensureRunning must abort with guidance instead.
    delete process.env.AGENTBRIDGE_PAIR_ID;
    const port = await freePort();
    fakeDaemon(port, { readyzStatus: 200, pairId: "registered-cccc2222", pid: 99999 });
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    let error: Error | null = null;
    try {
      await lc.ensureRunning();
    } catch (err) {
      error = err as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("registered pair registered-cccc2222");
    expect(killed).toBe(false);
    expect(launched).toBe(false);
  });

  test("waitForReadyAndOurs accepts a drifted daemon kept alive by the TUI-reuse policy", async () => {
    // The contended-lock wait must accept the same daemons the reuse policy keeps:
    // before this rule, a frontend waiting on a drifted-but-live daemon spun to a
    // 10s timeout ("Timed out waiting for readiness+identity") despite the daemon
    // being perfectly usable.
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    driftedDaemon(port, { tuiConnected: true });
    const lc = lifecycle(port);
    // Small retry budget: success must come from acceptance, not retries.
    await lc.waitForReadyAndOurs(3, 50);
  });

  test("does NOT replace a daemon that differs only by bundle kind (dist vs plugin)", async () => {
    // The dist CLI (`agentbridge codex`) and the Claude Code plugin bridge launch
    // co-equal daemons from the same source for the same pair + control port. Their
    // BUILD_INFO.bundle differs ("dist" vs "plugin") but version/commit/contract match.
    // This MUST be reused, not replaced — otherwise the two launchers replace-war.
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    const s = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        const body = {
          bridgeReady: true,
          tuiConnected: true,
          threadId: "thread",
          queuedMessageCount: 0,
          proxyUrl: "",
          appServerUrl: "",
          pid: 99999,
          pairId: "mine-aaaa0000",
          // Same version/commit/contractVersion as the launcher; only `bundle` differs.
          build: { ...BUILD_INFO, bundle: BUILD_INFO.bundle === "plugin" ? "dist" : "plugin" },
        };
        if (u.pathname === "/healthz" || u.pathname === "/readyz") return Response.json(body);
        return new Response("ok");
      },
    });
    servers.push(s);
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(false);
    expect(launched).toBe(false);
  });

  test("replaces a healthz-OK but readyz-503 zombie", async () => {
    const port = await freePort();
    const state = { readyzStatus: 503, pairId: null as string | null };
    fakeDaemon(port, state);
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
      state.readyzStatus = 200; // the freshly launched replacement becomes ready
    };
    await lc.ensureRunning();
    expect(killed).toBe(true);
    expect(launched).toBe(true);
  }, 15000);

  test("does NOT kill a healthy daemon that is merely slow to become ready", async () => {
    const port = await freePort();
    const state = { readyzStatus: 503, pairId: null as string | null };
    fakeDaemon(port, state);
    // Flip to ready well within the ~3s reuse window — a legit slow boot, not a zombie.
    setTimeout(() => {
      state.readyzStatus = 200;
    }, 600);
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
    };
    await lc.ensureRunning();
    expect(killed).toBe(false);
    expect(launched).toBe(false);
  }, 15000);

  test("acquireLockStrict returns false when a LIVE process holds the lock (no bypass)", () => {
    const lc = lifecycle(20001);
    // Simulate a live holder: write THIS (alive) process's pid into the lock file.
    writeFileSync(stateDir.lockFile, `${process.pid}\n`);
    expect((lc as any).acquireLockStrict()).toBe(false);
  });

  test("acquireLockStrict reclaims a stale lock left by a dead holder", () => {
    const lc = lifecycle(20002);
    writeFileSync(stateDir.lockFile, `9999999\n`); // not a live pid
    expect((lc as any).acquireLockStrict()).toBe(true);
  });

  test("kill(pidOverride) refuses to signal a non-AgentBridge process", async () => {
    const lc = lifecycle(20003);
    // Spawn an external `sleep` process — definitely NOT an AgentBridge daemon.
    // Using process.pid would not actually exercise the refusal path: the OLD loose
    // `cmd.includes("daemon")` guard happens not to match the test runner's
    // command line on current bun versions, and a real regression here could only
    // be caught with a pid that is unambiguously NOT us.
    const sleep = Bun.spawn(["/bin/sh", "-c", "while true; do sleep 60; done"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      const result = await lc.kill(200, sleep.pid);
      expect(result).toBe(false);
      expect(isProcessAliveLocal(sleep.pid)).toBe(true);
    } finally {
      sleep.kill("SIGKILL");
    }
  });

  // Regression guard for the cross-review C1 fix: kill() inside the strict lock must
  // NOT release the lock (cleanup no longer touches it), so two launchers racing to
  // replace the SAME zombie are serialized — exactly one wins the lock and launches.
  test("concurrent replacement of a zombie launches exactly once (strict lock serializes)", async () => {
    const port = await freePort();
    const state = { readyzStatus: 503, pairId: null as string | null };
    fakeDaemon(port, state);
    const lcA = lifecycle(port);
    const lcB = lifecycle(port); // shares the same stateDir → same lock file
    let launchCount = 0;
    const mockLaunch = () => {
      launchCount += 1;
      state.readyzStatus = 200; // the single winning launcher's daemon becomes ready
    };
    (lcA as any).kill = async () => true;
    (lcB as any).kill = async () => true;
    (lcA as any).launch = mockLaunch;
    (lcB as any).launch = mockLaunch;
    await Promise.all([lcA.ensureRunning(), lcB.ensureRunning()]);
    expect(launchCount).toBe(1); // strict lock → only one launcher replaces; the other waits
  }, 25000);

  // Regression guard for cross-review HIGH-1: in a contended-lock branch the launcher
  // losing the race must wait for ready+OURS, not just ready. A foreign-pair daemon
  // becoming ready behind the lock holder is the OTHER pair repairing its own daemon
  // and must not be adopted. We hold the lock externally (no daemon ever claims it)
  // so ensureRunning's `locked=false` path is the only branch that can run; without
  // the pairId check it would return in ms, with it the foreign daemon never matches
  // and waitForReadyAndOurs times out.
  test("contended lock wait refuses a foreign-pair daemon that became ready behind us", async () => {
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    // Foreign daemon: ready 200 from the start, but reports a DIFFERENT pairId.
    fakeDaemon(port, { readyzStatus: 200, pairId: "other-bbbb1111", pid: 99999 });
    // Pin the lock file from outside so acquireLockStrict returns false → ensureRunning
    // takes the `locked=false` branch inside withStartupLockStrict → waitForReadyAndOurs.
    writeFileSync(stateDir.lockFile, `${process.pid}\n`); // this test process holds the lock
    const lc = lifecycle(port);
    (lc as any).kill = async () => true;
    (lc as any).launch = () => {};
    const start = Date.now();
    let rejected: Error | null = null;
    try {
      await lc.ensureRunning();
    } catch (err: any) {
      rejected = err;
    }
    const elapsed = Date.now() - start;
    // Must reject (timed out waiting for ready+identity) and must have ACTUALLY waited,
    // not short-circuited because the foreign daemon is "ready".
    expect(rejected).not.toBeNull();
    expect(rejected!.message).toMatch(/Timed out waiting for AgentBridge daemon readiness\+identity/);
    expect(elapsed).toBeGreaterThanOrEqual(5000); // waitForReadyAndOurs default = 40×250ms=10s, ≥5s confirms we waited
  }, 20000);

  // Regression guard for cross-review HIGH-2: in pair mode, a missing/null reported
  // pairId is treated as FOREIGN (a hard-paired pair must not adopt a manual/old
  // daemon squatting its port). It is replaced with one that reports the right pairId.
  test("pair-mode treats null reported pairId as foreign and replaces it", async () => {
    process.env.AGENTBRIDGE_PAIR_ID = "mine-aaaa0000";
    const port = await freePort();
    const state = { readyzStatus: 200, pairId: null as string | null };
    fakeDaemon(port, state);
    const lc = lifecycle(port);
    let killed = false;
    let launched = false;
    (lc as any).kill = async () => {
      killed = true;
      return true;
    };
    (lc as any).launch = () => {
      launched = true;
      state.pairId = "mine-aaaa0000"; // the fresh replacement reports the right identity
    };
    await lc.ensureRunning();
    expect(killed).toBe(true);
    expect(launched).toBe(true);
  }, 15000);
});
