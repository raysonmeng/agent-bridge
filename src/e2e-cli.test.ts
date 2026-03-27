import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));
const BRIDGE_PATH = fileURLToPath(new URL("./bridge.ts", import.meta.url));

interface HarnessOptions {
  daemonDelayMs?: number;
  configProxyPort?: number;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface TrackedProcess {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
}

interface PortReservation {
  port: number;
  release: () => Promise<void>;
}

class CliE2EHarness {
  readonly rootDir: string;
  readonly projectDir: string;
  readonly stateDir: string;
  readonly binDir: string;
  readonly shimLogDir: string;
  readonly fakeDaemonPath: string;
  readonly fakeDaemonLaunchLog: string;
  readonly controlPort: number;
  readonly appPort: number;
  readonly proxyPort: number;
  readonly env: NodeJS.ProcessEnv;

  private readonly trackedProcesses: TrackedProcess[] = [];
  private readonly portReservations: PortReservation[];
  private daemonPortReservations: PortReservation[];
  private daemonPortReleasePromise: Promise<void> | null = null;

  private constructor(
    rootDir: string,
    projectDir: string,
    stateDir: string,
    binDir: string,
    shimLogDir: string,
    fakeDaemonPath: string,
    fakeDaemonLaunchLog: string,
    controlPort: number,
    appPort: number,
    proxyPort: number,
    portReservations: PortReservation[],
    env: NodeJS.ProcessEnv,
  ) {
    this.rootDir = rootDir;
    this.projectDir = projectDir;
    this.stateDir = stateDir;
    this.binDir = binDir;
    this.shimLogDir = shimLogDir;
    this.fakeDaemonPath = fakeDaemonPath;
    this.fakeDaemonLaunchLog = fakeDaemonLaunchLog;
    this.controlPort = controlPort;
    this.appPort = appPort;
    this.proxyPort = proxyPort;
    this.portReservations = portReservations;
    this.daemonPortReservations = [
      portReservations[0],
      portReservations[1],
      portReservations[2],
    ].filter((reservation): reservation is PortReservation => !!reservation);
    this.env = env;
  }

  static async create(options: HarnessOptions = {}): Promise<CliE2EHarness> {
    const rootDir = mkdtempSync(join(tmpdir(), "agentbridge-cli-e2e-"));
    const projectDir = join(rootDir, "project");
    const stateDir = join(rootDir, "state");
    const binDir = join(rootDir, "bin");
    const shimLogDir = join(rootDir, "shim-logs");
    const fakeDaemonPath = join(rootDir, "agentbridge-fake-daemon.ts");
    const fakeDaemonLaunchLog = join(rootDir, "fake-daemon-launches.jsonl");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(shimLogDir, { recursive: true });

    const portReservations = await Promise.all([
      reservePort(),
      reservePort(),
      reservePort(),
    ]);
    const [controlPort, appPort, proxyPort] = portReservations.map((reservation) => reservation.port);

    writeFileSync(
      fakeDaemonPath,
      buildFakeDaemonScript(),
      "utf-8",
    );
    writeExecutable(join(binDir, "claude"), buildShimScript("claude"));
    writeExecutable(join(binDir, "codex"), buildShimScript("codex"));

    const configProxyPort = options.configProxyPort ?? 45991;
    mkdirSync(join(projectDir, ".agentbridge"), { recursive: true });
    writeFileSync(
      join(projectDir, ".agentbridge", "config.json"),
      JSON.stringify(
        {
          version: "1.0",
          daemon: {
            port: appPort,
            proxyPort: configProxyPort,
          },
          agents: {
            claude: {
              role: "Reviewer, Planner",
              mode: "push",
            },
            codex: {
              role: "Implementer, Executor",
            },
          },
          markers: ["IMPORTANT", "STATUS", "FYI"],
          turnCoordination: {
            attentionWindowSeconds: 15,
            busyGuard: true,
          },
          idleShutdownSeconds: 30,
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      AGENTBRIDGE_STATE_DIR: stateDir,
      AGENTBRIDGE_CONTROL_PORT: String(controlPort),
      AGENTBRIDGE_DAEMON_ENTRY: fakeDaemonPath,
      AGENTBRIDGE_MODE: "pull",
      AGENTBRIDGE_FAKE_DAEMON_LAUNCH_LOG: fakeDaemonLaunchLog,
      AGENTBRIDGE_FAKE_DAEMON_DELAY_MS: String(options.daemonDelayMs ?? 0),
      AGENTBRIDGE_SHIM_LOG_DIR: shimLogDir,
      CODEX_WS_PORT: String(appPort),
      CODEX_PROXY_PORT: String(proxyPort),
    };

    return new CliE2EHarness(
      rootDir,
      projectDir,
      stateDir,
      binDir,
      shimLogDir,
      fakeDaemonPath,
      fakeDaemonLaunchLog,
      controlPort,
      appPort,
      proxyPort,
      portReservations,
      env,
    );
  }

  async runCli(args: string[], timeoutMs = 20000): Promise<RunResult> {
    return this.runCliWithEnv(args, {}, timeoutMs);
  }

  async runCliWithEnv(
    args: string[],
    extraEnv: NodeJS.ProcessEnv,
    timeoutMs = 20000,
  ): Promise<RunResult> {
    if (args[0] === "codex") {
      await this.releaseDaemonPortReservations();
    }

    const proc = this.spawnProcess(process.execPath, ["run", CLI_PATH, ...args], {
      cwd: this.projectDir,
      env: {
        ...this.env,
        ...extraEnv,
      },
    });
    return waitForExit(proc, timeoutMs);
  }

  async spawnCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<TrackedProcess> {
    if (args[0] === "codex") {
      await this.releaseDaemonPortReservations();
    }

    return this.spawnProcess(process.execPath, ["run", CLI_PATH, ...args], {
      cwd: this.projectDir,
      env: {
        ...this.env,
        ...extraEnv,
      },
    });
  }

  async spawnBridge(): Promise<TrackedProcess> {
    await this.releaseDaemonPortReservations();
    return this.spawnProcess(process.execPath, ["run", BRIDGE_PATH], {
      cwd: this.projectDir,
      env: this.env,
    });
  }

  async startManagedFakeDaemon(): Promise<TrackedProcess> {
    await this.releaseDaemonPortReservations();
    const proc = this.spawnProcess(process.execPath, ["run", this.fakeDaemonPath], {
      cwd: this.projectDir,
      env: this.env,
    });
    await this.waitForHealth();
    return proc;
  }

  async waitForHealth(maxRetries = 80, delayMs = 50): Promise<void> {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${this.controlPort}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    }, maxRetries, delayMs);
  }

  async waitForOutput(proc: TrackedProcess, needle: string, timeoutMs = 10000): Promise<void> {
    await waitFor(
      () => proc.stdout.join("").includes(needle) || proc.stderr.join("").includes(needle),
      Math.max(1, Math.ceil(timeoutMs / 50)),
      50,
    );
  }

  readShimCalls(command: "claude" | "codex"): Array<{ args: string[]; cwd: string }> {
    const logPath = join(this.shimLogDir, `${command}.jsonl`);
    return readJsonLines(logPath);
  }

  readLaunches(): Array<{ pid: number }> {
    return readJsonLines(this.fakeDaemonLaunchLog);
  }

  readPid(): number | null {
    const pidPath = join(this.stateDir, "daemon.pid");
    if (!existsSync(pidPath)) {
      return null;
    }
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  }

  readStatus(): Record<string, unknown> | null {
    const statusPath = join(this.stateDir, "status.json");
    if (!existsSync(statusPath)) {
      return null;
    }
    return JSON.parse(readFileSync(statusPath, "utf-8"));
  }

  readTuiPid(): number | null {
    const pidPath = join(this.stateDir, "codex-tui.pid");
    if (!existsSync(pidPath)) {
      return null;
    }
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  }

  async cleanup(): Promise<void> {
    for (const proc of this.trackedProcesses) {
      await stopProcess(proc);
    }

    const tuiPid = this.readTuiPid();
    if (tuiPid && isProcessAlive(tuiPid)) {
      try {
        process.kill(tuiPid, "SIGKILL");
      } catch {}
      await sleep(100);
    }

    const pid = this.readPid();
    if (pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      await sleep(100);
    }

    for (const reservation of this.portReservations) {
      try {
        await reservation.release();
      } catch {}
    }

    rmSync(this.rootDir, { recursive: true, force: true });
  }

  private async releaseDaemonPortReservations(): Promise<void> {
    if (this.daemonPortReservations.length === 0) {
      if (this.daemonPortReleasePromise) {
        await this.daemonPortReleasePromise;
      }
      return;
    }

    if (!this.daemonPortReleasePromise) {
      const reservations = this.daemonPortReservations;
      this.daemonPortReservations = [];
      this.daemonPortReleasePromise = Promise.all(
        reservations.map((reservation) => reservation.release()),
      ).then(() => {});
    }

    await this.daemonPortReleasePromise;
  }

  private spawnProcess(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): TrackedProcess {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const proc: TrackedProcess = {
      child,
      stdout: [],
      stderr: [],
    };

    child.stdout?.on("data", (chunk) => {
      proc.stdout.push(chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      proc.stderr.push(chunk.toString());
    });

    this.trackedProcesses.push(proc);
    return proc;
  }
}

describe("E2E: CLI surface", () => {
  test("agentbridge init creates project config and collaboration rules", async () => {
    await withHarness(async (harness) => {
      rmSync(join(harness.projectDir, ".agentbridge"), { recursive: true, force: true });

      const result = await harness.runCli(["init"]);

      expect(result.code).toBe(0);
      expect(existsSync(join(harness.projectDir, ".agentbridge", "config.json"))).toBe(true);
      expect(existsSync(join(harness.projectDir, ".agentbridge", "collaboration.md"))).toBe(true);

      const config = JSON.parse(
        readFileSync(join(harness.projectDir, ".agentbridge", "config.json"), "utf-8"),
      ) as { daemon: { port: number; proxyPort: number } };
      expect(config.daemon.port).toBe(4500);
      expect(config.daemon.proxyPort).toBe(4501);

      const collaboration = readFileSync(
        join(harness.projectDir, ".agentbridge", "collaboration.md"),
        "utf-8",
      );
      expect(collaboration).toContain("# Collaboration Rules");
      expect(result.stdout).toContain("Setup complete!");
      expect(harness.readShimCalls("claude").some((entry) => entry.args[0] === "plugin")).toBe(true);
      expect(harness.readShimCalls("codex").some((entry) => entry.args[0] === "--version")).toBe(true);
    });
  }, 20000);

  test("agentbridge claude injects channel flags", async () => {
    await withHarness(async (harness) => {
      const result = await harness.runCli(["claude", "--resume"]);

      expect(result.code).toBe(0);

      const invocations = harness
        .readShimCalls("claude")
        .filter((entry) => entry.args[0] !== "--version" && entry.args[0] !== "plugin");
      expect(invocations.length).toBe(1);
      expect(invocations[0]?.args).toEqual([
        "--dangerously-load-development-channels",
        "plugin:agentbridge@agentbridge",
        "--resume",
      ]);
    });
  });

  test("agentbridge claude rejects owned flags", async () => {
    await withHarness(async (harness) => {
      const result = await harness.runCli(["claude", "--channels", "manual"]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("\"--channels\" is automatically set by agentbridge claude");
      expect(harness.readShimCalls("claude")).toHaveLength(0);
    });
  });

  test("agentbridge codex ensures daemon is running and injects remote args", async () => {
    await withHarness(async (harness) => {
      const result = await harness.runCli(["codex", "--model", "o3"]);

      expect(result.code).toBe(0);
      await harness.waitForHealth();

      expect(harness.readLaunches()).toHaveLength(1);
      expect(harness.readPid()).not.toBeNull();
      expect(harness.readStatus()?.proxyUrl).toBe(`ws://127.0.0.1:${harness.proxyPort}`);
      expect(harness.readTuiPid()).toBeNull();

      const invocations = harness
        .readShimCalls("codex")
        .filter((entry) => entry.args[0] !== "--version");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.args).toEqual([
        "--enable",
        "tui_app_server",
        "--remote",
        `ws://127.0.0.1:${harness.proxyPort}`,
        "--model",
        "o3",
      ]);
    });
  }, 20000);

  test("agentbridge codex rejects owned flags", async () => {
    await withHarness(async (harness) => {
      const remoteConflict = await harness.runCli(["codex", "--remote", "ws://127.0.0.1:7777"]);
      expect(remoteConflict.code).toBe(1);
      expect(remoteConflict.stderr).toContain("\"--remote\" is automatically set by agentbridge codex");

      const enableConflict = await harness.runCli(["codex", "--enable", "tui_app_server"]);
      expect(enableConflict.code).toBe(1);
      expect(enableConflict.stderr).toContain("\"--enable tui_app_server\" is automatically set");

      expect(harness.readShimCalls("codex")).toHaveLength(0);
      expect(harness.readLaunches()).toHaveLength(0);
    });
  });

  test("agentbridge codex reuses healthy daemon and prefers status.json proxyUrl", async () => {
    await withHarness({ configProxyPort: 49991 }, async (harness) => {
      const daemonProc = await harness.startManagedFakeDaemon();
      const pidBefore = harness.readPid();

      expect(pidBefore).not.toBeNull();
      expect(harness.readLaunches()).toHaveLength(1);

      const result = await harness.runCli(["codex", "--profile", "default"]);

      expect(result.code).toBe(0);
      expect(harness.readPid()).toBe(pidBefore);

      const invocations = harness
        .readShimCalls("codex")
        .filter((entry) => entry.args[0] !== "--version");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.args).toEqual([
        "--enable",
        "tui_app_server",
        "--remote",
        `ws://127.0.0.1:${harness.proxyPort}`,
        "--profile",
        "default",
      ]);

      await stopProcess(daemonProc);
    });
  }, 20000);

  test("concurrent codex starts launch only one daemon", async () => {
    await withHarness({ daemonDelayMs: 1200 }, async (harness) => {
      const [first, second] = await Promise.all([
        harness.runCli(["codex", "--model", "o3-mini"], 25000),
        harness.runCli(["codex", "--model", "o3"], 25000),
      ]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(harness.readLaunches()).toHaveLength(1);

      const invocations = harness
        .readShimCalls("codex")
        .filter((entry) => entry.args[0] !== "--version");
      expect(invocations).toHaveLength(2);
      for (const invocation of invocations) {
        expect(invocation.args[0]).toBe("--enable");
        expect(invocation.args[2]).toBe("--remote");
        expect(invocation.args[3]).toBe(`ws://127.0.0.1:${harness.proxyPort}`);
      }
    });
  }, 30000);

  test("agentbridge kill stops daemon, cleans state, and writes killed sentinel", async () => {
    await withHarness(async (harness) => {
      const codexProc = await harness.spawnCli(
        ["codex"],
        { AGENTBRIDGE_CODEX_SHIM_HOLD_MS: "30000" },
      );
      await harness.waitForHealth();
      await waitFor(() => harness.readTuiPid() !== null, 80, 50);

      const pid = harness.readPid();
      const tuiPid = harness.readTuiPid();
      expect(pid).not.toBeNull();
      expect(tuiPid).not.toBeNull();
      expect(pid && isProcessAlive(pid)).toBe(true);
      expect(tuiPid && isProcessAlive(tuiPid)).toBe(true);

      const result = await harness.runCli(["kill"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("AgentBridge stopped.");
      expect(result.stdout).toContain("Please restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to fully disconnect.");
      await waitFor(() => (pid ? !isProcessAlive(pid) : true), 60, 50);
      await waitFor(() => (tuiPid ? !isProcessAlive(tuiPid) : true), 60, 50);
      await waitFor(() => codexProc.child.exitCode !== null, 60, 50);
      expect(existsSync(join(harness.stateDir, "daemon.pid"))).toBe(false);
      expect(existsSync(join(harness.stateDir, "codex-tui.pid"))).toBe(false);
      expect(existsSync(join(harness.stateDir, "status.json"))).toBe(false);
      expect(existsSync(join(harness.stateDir, "killed"))).toBe(true);
    });
  }, 20000);

  test("bridge stays idle and does not relaunch daemon after kill writes the killed sentinel", async () => {
    await withHarness(async (harness) => {
      const bridge = await harness.spawnBridge();

      await harness.waitForHealth();
      await harness.waitForOutput(bridge, "Daemon status:");
      expect(harness.readLaunches()).toHaveLength(1);

      const killResult = await harness.runCli(["kill"]);
      expect(killResult.code).toBe(0);

      await harness.waitForOutput(bridge, "not reconnecting");
      await sleep(1200);
      expect(bridge.child.exitCode).toBeNull();
      expect(harness.readLaunches()).toHaveLength(1);
      expect(existsSync(join(harness.stateDir, "killed"))).toBe(true);
    });
  }, 30000);

  test("happy path: init -> claude -> codex -> kill", async () => {
    await withHarness(async (harness) => {
      rmSync(join(harness.projectDir, ".agentbridge"), { recursive: true, force: true });

      const initResult = await harness.runCli(["init"]);
      expect(initResult.code).toBe(0);

      const claudeResult = await harness.runCli(["claude", "--resume"]);
      expect(claudeResult.code).toBe(0);

      const codexResult = await harness.runCli(["codex", "--model", "o3"]);
      expect(codexResult.code).toBe(0);
      await harness.waitForHealth();

      const pid = harness.readPid();
      expect(pid).not.toBeNull();

      const killResult = await harness.runCli(["kill"]);
      expect(killResult.code).toBe(0);

      await waitFor(() => (pid ? !isProcessAlive(pid) : true), 60, 50);
      expect(existsSync(join(harness.projectDir, ".agentbridge", "config.json"))).toBe(true);
      expect(existsSync(join(harness.projectDir, ".agentbridge", "collaboration.md"))).toBe(true);
      expect(existsSync(join(harness.stateDir, "daemon.pid"))).toBe(false);
      expect(existsSync(join(harness.stateDir, "status.json"))).toBe(false);
      expect(existsSync(join(harness.stateDir, "killed"))).toBe(true);

      const claudeRun = harness
        .readShimCalls("claude")
        .find((entry) => entry.args[0] === "--dangerously-load-development-channels");
      expect(claudeRun?.args[1]).toBe("plugin:agentbridge@agentbridge");

      const codexRun = harness
        .readShimCalls("codex")
        .find((entry) => entry.args[0] === "--enable");
      expect(codexRun?.args[3]).toBe(`ws://127.0.0.1:${harness.proxyPort}`);
    });
  }, 30000);
});

async function withHarness(
  fnOrOptions: HarnessOptions | ((harness: CliE2EHarness) => Promise<void>),
  fnMaybe?: (harness: CliE2EHarness) => Promise<void>,
) {
  const options = typeof fnOrOptions === "function" ? {} : fnOrOptions;
  const fn = typeof fnOrOptions === "function" ? fnOrOptions : fnMaybe;
  if (!fn) {
    throw new Error("Harness callback is required");
  }

  const harness = await CliE2EHarness.create(options);
  try {
    await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

async function waitForExit(proc: TrackedProcess, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      try {
        proc.child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    proc.child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        code,
        stdout: proc.stdout.join(""),
        stderr: proc.stderr.join(""),
      });
    });
  });
}

async function stopProcess(proc: TrackedProcess | null): Promise<void> {
  if (!proc || proc.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (proc.child.exitCode === null) {
        try {
          proc.child.kill("SIGKILL");
        } catch {}
      }
    }, 1000);

    proc.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      proc.child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  maxRetries: number,
  delayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (await predicate()) {
      return;
    }
    await sleep(delayMs);
  }

  throw new Error("Timed out waiting for condition");
}

async function reservePort(): Promise<PortReservation> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free TCP port"));
        return;
      }

      server.unref();

      let released = false;
      resolve({
        port: address.port,
        release: () => new Promise<void>((releaseResolve, releaseReject) => {
          if (released) {
            releaseResolve();
            return;
          }

          released = true;
          server.close((err) => {
            if (err) {
              releaseReject(err);
              return;
            }
            releaseResolve();
          });
        }),
      });
    });
  });
}

function writeExecutable(filePath: string, content: string) {
  writeFileSync(filePath, content, "utf-8");
  chmodSync(filePath, 0o755);
}

function readJsonLines(filePath: string): any[] {
  if (!existsSync(filePath)) {
    return [];
  }

  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildShimScript(commandName: "claude" | "codex"): string {
  const versionOutput = commandName === "claude" ? "claude v2.1.80" : "codex 0.1.0";
  return `#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const logDir = process.env.AGENTBRIDGE_SHIM_LOG_DIR;
if (!logDir) {
  console.error("AGENTBRIDGE_SHIM_LOG_DIR is required");
  process.exit(1);
}

const logPath = join(logDir, "${commandName}.jsonl");
mkdirSync(dirname(logPath), { recursive: true });

const args = process.argv.slice(2);
appendFileSync(
  logPath,
  JSON.stringify({ args, cwd: process.cwd() }) + "\\n",
  "utf-8",
);

if (args[0] === "--version") {
  console.log("${versionOutput}");
  process.exit(0);
}

if ("${commandName}" === "claude" && args[0] === "plugin" && args[1] === "install") {
  process.exit(0);
}

if ("${commandName}" === "codex" && args[0] === "--enable" && args[1] === "tui_app_server") {
  const holdMs = Number.parseInt(process.env.AGENTBRIDGE_CODEX_SHIM_HOLD_MS ?? "0", 10);
  if (Number.isFinite(holdMs) && holdMs > 0) {
    await Bun.sleep(holdMs);
  }
}

process.exit(0);
`;
}

function buildFakeDaemonScript(): string {
  return `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.AGENTBRIDGE_STATE_DIR;
const controlPort = Number.parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const appPort = Number.parseInt(process.env.CODEX_WS_PORT ?? "4500", 10);
const proxyPort = Number.parseInt(process.env.CODEX_PROXY_PORT ?? "4501", 10);
const launchLog = process.env.AGENTBRIDGE_FAKE_DAEMON_LAUNCH_LOG;
const delayMs = Number.parseInt(process.env.AGENTBRIDGE_FAKE_DAEMON_DELAY_MS ?? "0", 10);

if (!stateDir || !launchLog) {
  console.error("Fake daemon requires AGENTBRIDGE_STATE_DIR and AGENTBRIDGE_FAKE_DAEMON_LAUNCH_LOG");
  process.exit(1);
}

const pidFile = join(stateDir, "daemon.pid");
const statusFile = join(stateDir, "status.json");
const killedFile = join(stateDir, "killed");
const proxyUrl = \`ws://127.0.0.1:\${proxyPort}\`;
const appServerUrl = \`ws://127.0.0.1:\${appPort}\`;

if (existsSync(killedFile)) {
  process.exit(0);
}

mkdirSync(stateDir, { recursive: true });
appendFileSync(launchLog, JSON.stringify({ pid: process.pid }) + "\\n", "utf-8");

if (delayMs > 0) {
  await Bun.sleep(delayMs);
}

writeFileSync(pidFile, \`\${process.pid}\\n\`, "utf-8");

function currentStatus() {
  return {
    bridgeReady: false,
    tuiConnected: false,
    threadId: null,
    queuedMessageCount: 0,
    proxyUrl,
    appServerUrl,
    pid: process.pid,
  };
}

writeFileSync(statusFile, JSON.stringify({
  proxyUrl,
  appServerUrl,
  controlPort,
  pid: process.pid,
}, null, 2) + "\\n", "utf-8");

let cleanedUp = false;
function cleanupFiles() {
  if (cleanedUp) {
    return;
  }
  cleanedUp = true;
  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(statusFile); } catch {}
}

const server = Bun.serve({
  port: controlPort,
  hostname: "127.0.0.1",
  fetch(req, serverInstance) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      return Response.json(currentStatus());
    }

    if (url.pathname === "/ws" && serverInstance.upgrade(req)) {
      return undefined;
    }

    return new Response("fake agentbridge daemon");
  },
  websocket: {
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }

      if (message.type === "claude_connect" || message.type === "status") {
        ws.send(JSON.stringify({ type: "status", status: currentStatus() }));
      }
    },
  },
});

const proxyServer = Bun.serve({
  port: proxyPort,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      return Response.json({ ok: true, proxyUrl });
    }
    return new Response("fake codex proxy");
  },
});

function shutdown() {
  cleanupFiles();
  server.stop();
  proxyServer.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", cleanupFiles);
`;
}
