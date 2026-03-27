import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "./state-dir";
import { DaemonLifecycle, isProcessAlive } from "./daemon-lifecycle";

describe("DaemonLifecycle", () => {
  let tempDir: string;
  let stateDir: StateDirResolver;
  let logs: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-lifecycle-test-"));
    stateDir = new StateDirResolver(tempDir);
    stateDir.ensure();
    logs = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createLifecycle(port = 19999) {
    return new DaemonLifecycle({
      stateDir,
      controlPort: port,
      log: (msg) => logs.push(msg),
    });
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
});
