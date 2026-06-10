import { afterEach, describe, expect, test } from "bun:test";
import {
  commandMatchesManagedCodexTui,
  parsePsProcessList,
  findManagedCodexTuiProcessesFromList,
  listManagedCodexTuiProcessesFromList,
  pidLooksAlive,
  isProcessAlive,
  isAgentBridgeDaemon,
  isAgentBridgeProcess,
} from "../process-lifecycle";

describe("process lifecycle helpers", () => {
  test("matches only Codex TUI processes for the exact AgentBridge proxy", () => {
    const proxyUrl = "ws://127.0.0.1:4501";

    expect(commandMatchesManagedCodexTui(
      "/usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501",
      proxyUrl,
    )).toBe(true);

    expect(commandMatchesManagedCodexTui(
      "/usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4511",
      proxyUrl,
    )).toBe(false);

    expect(commandMatchesManagedCodexTui(
      "/usr/bin/codex --remote ws://127.0.0.1:4501",
      proxyUrl,
    )).toBe(false);

    expect(commandMatchesManagedCodexTui(
      "/usr/bin/node other-tool --enable tui_app_server --remote ws://127.0.0.1:4501",
      proxyUrl,
    )).toBe(false);
  });

  test("rejects unrelated processes that merely mention codex in their arguments", () => {
    const proxyUrl = "ws://127.0.0.1:4501";
    // Real-world false positive: another agent's long argv carrying log/prompt
    // text that happens to contain all three substrings. argv[0] is NOT codex.
    expect(commandMatchesManagedCodexTui(
      "SkyComputerUseClient turn-ended input='run codex --enable tui_app_server --remote ws://127.0.0.1:4501'",
      proxyUrl,
    )).toBe(false);
    expect(commandMatchesManagedCodexTui(
      "/bin/zsh -c echo codex tui_app_server --remote ws://127.0.0.1:4501",
      proxyUrl,
    )).toBe(false);
    // But a node/bun-launched codex script IS accepted.
    expect(commandMatchesManagedCodexTui(
      "node /opt/codex/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501",
      proxyUrl,
    )).toBe(true);
  });

  test("finds only matching orphan TUI candidates from ps output", () => {
    const processes = parsePsProcessList(`
      101 /usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501
      102 /usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4511
      103 /usr/bin/codex app-server --listen ws://127.0.0.1:4500
      104 /usr/bin/node other-tool --enable tui_app_server --remote ws://127.0.0.1:4501
    `);

    expect(findManagedCodexTuiProcessesFromList(processes, "ws://127.0.0.1:4501")).toEqual([
      {
        pid: 101,
        command: "/usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501",
      },
    ]);
  });

  test("lists ALL managed TUIs (any proxy) annotated with their --remote target", () => {
    const processes = parsePsProcessList(`
      101 /usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501
      102 /usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4511
      103 /usr/bin/codex app-server --listen ws://127.0.0.1:4500
      104 /usr/bin/node other-tool --enable tui_app_server --remote ws://127.0.0.1:4501
    `);

    // Cross-pair view: both TUIs (4501 and 4511) are returned, the app-server
    // (no tui_app_server/--remote) and the non-codex tool are excluded.
    expect(listManagedCodexTuiProcessesFromList(processes)).toEqual([
      {
        pid: 101,
        command: "/usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501",
        remoteUrl: "ws://127.0.0.1:4501",
      },
      {
        pid: 102,
        command: "/usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4511",
        remoteUrl: "ws://127.0.0.1:4511",
      },
    ]);
  });

  test("classifying a cross-proxy TUI list separates this-pair from other-pair", () => {
    const all = listManagedCodexTuiProcessesFromList(
      parsePsProcessList(`
        201 /usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501
        202 /usr/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4511
      `),
    );
    const here = all.filter((t) => commandMatchesManagedCodexTui(t.command, "ws://127.0.0.1:4501"));
    const elsewhere = all.filter((t) => !commandMatchesManagedCodexTui(t.command, "ws://127.0.0.1:4501"));
    expect(here.map((t) => t.pid)).toEqual([201]);
    expect(elsewhere.map((t) => t.pid)).toEqual([202]);
  });
});

// ---------------------------------------------------------------------------
// Consolidated process-identity & liveness (P1 drift fix)
//
// These cover the three matchers that previously had drifted copies in
// daemon-lifecycle.ts and pair-registry.ts. The matchers take an injectable
// command lookup so they stay pure (no real `ps` / processes).
// ---------------------------------------------------------------------------

describe("pidLooksAlive / isProcessAlive (unified liveness)", () => {
  const realKill = process.kill;
  afterEach(() => {
    process.kill = realKill;
  });

  test("isProcessAlive is the same implementation as pidLooksAlive", () => {
    expect(isProcessAlive).toBe(pidLooksAlive);
  });

  test("returns true for the current process", () => {
    expect(pidLooksAlive(process.pid)).toBe(true);
  });

  test("returns false for a definitely-dead pid", () => {
    expect(pidLooksAlive(2147483646)).toBe(false);
  });

  test("guards pid <= 0 — short-circuits BEFORE process.kill (never signals the group)", () => {
    // process.kill(0, 0) signals the current process GROUP and would "succeed",
    // so the guard MUST short-circuit before that call. Mock kill to throw EPERM
    // (= ALIVE) AND record whether it ran: without the guard, pid<=0 would reach
    // kill and be reported alive, so asserting BOTH returns-false AND kill-never-
    // called makes a removed guard fail the test (the old plain-Error mock
    // collapsed to false either way and let the mutation survive).
    let killCalled = false;
    process.kill = ((_pid: number, _signal?: string | number) => {
      killCalled = true;
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;
    for (const pid of [0, -1, -process.pid]) {
      killCalled = false;
      expect(pidLooksAlive(pid)).toBe(false);
      expect(killCalled).toBe(false);
    }
  });

  test("rejects non-integer pids", () => {
    expect(pidLooksAlive(Number.NaN)).toBe(false);
    expect(pidLooksAlive(1.5)).toBe(false);
  });

  test("EPERM (exists but unsignalable) is treated as ALIVE", () => {
    process.kill = ((_pid: number, _signal?: string | number) => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;
    expect(pidLooksAlive(4242)).toBe(true);
  });

  test("ESRCH (no such process) is treated as DEAD", () => {
    process.kill = ((_pid: number, _signal?: string | number) => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as typeof process.kill;
    expect(pidLooksAlive(4242)).toBe(false);
  });
});

describe("isAgentBridgeDaemon (single strict daemon matcher)", () => {
  const cmd = (command: string | null) => () => command;

  test("matches a dev daemon.ts command line", () => {
    expect(
      isAgentBridgeDaemon(1, cmd("/usr/local/bin/bun run /Users/x/repo/agentbridge/src/daemon.ts")),
    ).toBe(true);
  });

  test("matches a bundled daemon.js command line (agentbridge path marker)", () => {
    expect(
      isAgentBridgeDaemon(1, cmd("bun run /Users/x/.claude/plugins/agentbridge/server/daemon.js")),
    ).toBe(true);
  });

  test("matches the legacy single-pair-root daemon shape (agent_bridge repo dir)", () => {
    // Pre-multi-pair daemon spawned exactly like today: `<bun> run <…>/daemon.{ts,js}`.
    // The path carries an agent_bridge marker, so the anchored matcher still catches it.
    expect(
      isAgentBridgeDaemon(1, cmd("/opt/homebrew/bin/bun run /Users/x/agent_bridge/src/daemon.ts")),
    ).toBe(true);
    expect(
      isAgentBridgeDaemon(1, cmd("bun run /Users/x/agent_bridge/dist/daemon.js --foo")),
    ).toBe(true);
  });

  test("matches the e2e harness's *-daemon fake", () => {
    expect(
      isAgentBridgeDaemon(1, cmd("bun run /tmp/agentbridge-e2e/fake-daemon.ts")),
    ).toBe(true);
  });

  test("REJECTS the loose-substring false positive (a daemon-*.test.ts process)", () => {
    // The pre-consolidation pair-registry copy used `cmd.includes("daemon")`,
    // which would have classified this IDE-launched test process as the daemon.
    // The anchored matcher must reject it: `daemon-self-heal.test.ts` is not a
    // `*-daemon.{ts,js}` entry.
    expect(
      isAgentBridgeDaemon(1, cmd("bun test /Users/x/agentbridge/src/unit-test/daemon-self-heal.test.ts")),
    ).toBe(false);
  });

  test("rejects a daemon.js from an unrelated project (no agentbridge marker)", () => {
    expect(isAgentBridgeDaemon(1, cmd("node /opt/other-app/daemon.js"))).toBe(false);
  });

  test("rejects when the command lookup fails (process gone / ps error)", () => {
    expect(isAgentBridgeDaemon(1, cmd(null))).toBe(false);
  });
});

describe("isAgentBridgeProcess (general loose matcher)", () => {
  const cmd = (command: string | null) => () => command;

  test("matches any process carrying an agentbridge marker (launcher OR daemon)", () => {
    expect(isAgentBridgeProcess(1, cmd("bun run /Users/x/agentbridge/src/cli.ts codex"))).toBe(true);
    expect(isAgentBridgeProcess(1, cmd("node /Users/x/agent_bridge/bridge-server.js"))).toBe(true);
  });

  test("does not match an unrelated process", () => {
    expect(isAgentBridgeProcess(1, cmd("/usr/bin/vim foo.txt"))).toBe(false);
  });

  test("rejects when the command lookup fails", () => {
    expect(isAgentBridgeProcess(1, cmd(null))).toBe(false);
  });
});
