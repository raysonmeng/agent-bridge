import { describe, expect, test } from "bun:test";
import {
  commandMatchesManagedCodexTui,
  parsePsProcessList,
  findManagedCodexTuiProcessesFromList,
  listManagedCodexTuiProcessesFromList,
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
