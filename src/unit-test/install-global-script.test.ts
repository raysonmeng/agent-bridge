import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideInstallPreflight,
  detectActiveInstallSessionsFromPsOutput,
  installPrefixFromBinPath,
  resolveInstallPrefix,
} from "../../scripts/install-global.mjs";

const SCRIPT = join(process.cwd(), "scripts/install-global.mjs");
const PACKAGE_NAME = "@raysonmeng/agentbridge";

/**
 * Run the REAL (non-dry-run) installer with `npm`/`node`/`bun` stubbed onto PATH.
 * Each stub appends its full argv to a record file so the test can assert the
 * command sequence AND prove a configured failure aborts BEFORE stop-running.
 *
 * `failWhen` is a substring matched against the joined argv of each stub call;
 * the matching call (and only it) exits non-zero, simulating e.g. an
 * unreachable registry (`npm view ...`) or a failed install.
 *
 * stop-running is observable because install-safety's stop spawns the real CLI:
 * we additionally stub it by matching `install-safety.cjs stop-running` and
 * `kill --all` against the recorded argv — if a failure aborted correctly,
 * neither ever appears in the record.
 */
function runRealWithStubs(
  mode: string,
  extraArgs: string[],
  failWhen: string,
  psOutput = "",
): { status: number | null; record: string[]; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "install-global-stub-"));
  const recordFile = join(dir, "record.log");
  const binDir = join(dir, "bin");
  // A single stub script reused for npm/node/bun: log argv, then exit 1 if the
  // joined argv contains FAIL_WHEN, else 0. It deliberately does NOT execute the
  // real tool — we only care about the call sequence and the abort behavior.
  const stub = `#!/usr/bin/env bash
name="$(basename "$0")"
echo "$name $*" >> "$RECORD_FILE"
joined="$name $*"
if [ -n "$FAIL_WHEN" ] && [[ "$joined" == *"$FAIL_WHEN"* ]]; then
  exit 1
fi
if [ "$name" = "ps" ]; then
  printf "%s" "$PS_OUTPUT"
  exit 0
fi
# 'npm pack' parses stdout for the tarball name — emit a plausible one so the
# local-mode flow can proceed past packing in the success-path-up-to-install case.
if [ "$name" = "npm" ] && [ "$1" = "pack" ]; then
  echo "agentbridge-0.0.0.tgz"
fi
exit 0
`;
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(binDir, { recursive: true });
  for (const name of ["npm", "node", "bun", "ps"]) {
    const p = join(binDir, name);
    writeFileSync(p, stub);
    chmodSync(p, 0o755);
  }
  try {
    // Launch the script with the REAL node (absolute path) so the script itself
    // runs, but with PATH pointing at the stubs so its child spawns hit them.
    const realNode = process.execPath;
    const res = Bun.spawnSync([realNode, SCRIPT, mode, ...extraArgs], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RECORD_FILE: recordFile,
        FAIL_WHEN: failWhen,
        PS_OUTPUT: psOutput,
      },
    });
    let record: string[] = [];
    try {
      record = readFileSync(recordFile, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      record = [];
    }
    return {
      status: res.exitCode,
      record,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordHasStop(record: string[]): boolean {
  return record.some(
    (line) => line.includes("install-safety.cjs stop-running") || line.includes("kill --all"),
  );
}

function runDry(mode: string, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["node", SCRIPT, mode, "--dry-run", ...extraArgs], {
    env: process.env,
  });
  return {
    status: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

function dryRunCommands(mode: string, extraArgs: string[] = []): string[] {
  const res = runDry(mode, extraArgs);
  expect(res.status).toBe(0);
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("$ "));
}

describe("scripts/install-global.mjs", () => {
  test("detects active Claude frontends and managed Codex TUIs from ps output", () => {
    const sessions = detectActiveInstallSessionsFromPsOutput(
      `
        101 /Users/x/.claude/plugins/agentbridge/server/bridge-server.js
        102 /usr/local/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4511
        103 /usr/local/bin/codex app-server --listen ws://127.0.0.1:4500
        104 /bin/zsh -c echo codex --enable tui_app_server --remote ws://127.0.0.1:4511
      `,
      [
        {
          pairId: "work-a1b2c3d4",
          pairName: "work",
          cwd: "/repo/work",
          stateDir: "/state/pairs/work-a1b2c3d4",
          proxyUrl: "ws://127.0.0.1:4511",
        },
      ],
    );

    expect(sessions).toMatchObject([
      {
        kind: "claude-frontend",
        pid: 101,
        pair: { label: "unknown" },
      },
      {
        kind: "codex-tui",
        pid: 102,
        remoteUrl: "ws://127.0.0.1:4511",
        pair: {
          label: "work (work-a1b2c3d4)",
          pairId: "work-a1b2c3d4",
          pairName: "work",
          cwd: "/repo/work",
        },
      },
    ]);
  });

  test("preflight decision blocks active sessions before install unless forced or dry-run", () => {
    expect(decideInstallPreflight({ activeSessionCount: 1, force: false, dryRun: false, isTTY: false })).toEqual({
      action: "block",
      reason: "non-tty",
    });
    expect(decideInstallPreflight({ activeSessionCount: 1, force: true, dryRun: false, isTTY: false })).toEqual({
      action: "allow",
      reason: "force",
    });
    expect(decideInstallPreflight({ activeSessionCount: 1, force: false, dryRun: true, isTTY: false })).toEqual({
      action: "allow",
      reason: "dry-run",
    });
    expect(decideInstallPreflight({ activeSessionCount: 0, force: false, dryRun: false, isTTY: false })).toEqual({
      action: "allow",
      reason: "no-active-sessions",
    });
  });

  test("local mode builds, verifies and INSTALLS before stopping anything, then syncs the plugin", () => {
    // Ordering contract (P1 downtime reduction):
    //   - stop-running comes AFTER `npm install` succeeds, so the old daemon
    //     keeps serving until the new bytes are on disk (downtime shrinks to
    //     "stop -> user restart"); a red build/pack/verify/install aborts BEFORE
    //     stop-running, so a failed install never kills the running daemon.
    //   - the redundant `npm uninstall -g` is gone: `--force` is a full replace,
    //     and uninstalling only widened the window with no binary on PATH.
    const commands = dryRunCommands("local");
    expect(commands).toEqual([
      "$ bun run prepublishOnly",
      "$ node scripts/install-safety.cjs verify-built",
      "$ npm pack --pack-destination <temp>",
      "$ node scripts/install-safety.cjs verify-tarball <packed-tarball>",
      "$ npm install -g --force <packed-tarball>",
      "$ node scripts/install-safety.cjs stop-running --dry-run  # after install succeeds — the old daemon keeps serving until the new bytes are on disk",
      "$ bun src/cli.ts dev --skip-build  # sync Claude Code plugin (skip with --skip-plugin)",
    ]);
    // The redundant uninstall must be gone entirely.
    expect(commands.some((line) => line.includes("npm uninstall"))).toBe(false);
    // stop-running must come strictly AFTER the install in local mode.
    const installIdx = commands.findIndex((l) => l.startsWith("$ npm install -g --force"));
    const stopIdx = commands.findIndex((l) => l.includes("stop-running"));
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(installIdx);
  });

  test("dry-run output includes the active-session preflight as the first plan step", () => {
    const res = runDry("npm");
    expect(res.status).toBe(0);
    const lines = res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines[0]).toContain("preflight");
    expect(lines[0]).toContain("--force");
    expect(lines.findIndex((line) => line.startsWith("$ npm view"))).toBeGreaterThan(0);
  });

  test("local mode --skip-plugin omits the plugin sync step (stop-running still last)", () => {
    const commands = dryRunCommands("local", ["--skip-plugin"]);
    expect(commands.some((line) => line.includes("dev --skip-build"))).toBe(false);
    // With the plugin sync skipped, stop-running is the final step — and it is
    // still AFTER the install (downtime + failure-safety invariant preserved).
    expect(commands[commands.length - 1]).toBe(
      "$ node scripts/install-safety.cjs stop-running --dry-run  # after install succeeds — the old daemon keeps serving until the new bytes are on disk",
    );
    const installIdx = commands.findIndex((l) => l.startsWith("$ npm install -g --force"));
    const stopIdx = commands.findIndex((l) => l.includes("stop-running"));
    expect(stopIdx).toBeGreaterThan(installIdx);
  });

  test("npm mode verifies the registry and installs BEFORE stopping the running daemon", () => {
    // Ordering contract (P1): a failed `npm view` (registry unreachable / version
    // missing) or a failed install must leave the running daemon untouched, so
    // stop-running runs LAST — after both validation and install succeed.
    const commands = dryRunCommands("npm");
    expect(commands).toEqual([
      `$ npm view ${PACKAGE_NAME}@latest version`,
      `$ npm install -g --force ${PACKAGE_NAME}@latest`,
      "$ node scripts/install-safety.cjs stop-running --dry-run  # after install succeeds — a failed `npm view` / install leaves the running daemon untouched",
    ]);
    // stop-running must be the LAST step (after view + install).
    expect(commands[commands.length - 1]).toContain("stop-running");
    const viewIdx = commands.findIndex((l) => l.startsWith("$ npm view"));
    const installIdx = commands.findIndex((l) => l.startsWith("$ npm install -g --force"));
    const stopIdx = commands.findIndex((l) => l.includes("stop-running"));
    expect(viewIdx).toBe(0);
    expect(stopIdx).toBeGreaterThan(installIdx);
  });

  // --- Behavioral failure-path tests: a FAILED install must NOT touch the
  //     running daemon (zero downtime on the failure path). These run the REAL
  //     installer with stubbed npm/node/bun and assert stop-running never fired.

  test("npm mode: a failed `npm view` aborts BEFORE stop-running (daemon untouched)", () => {
    const { status, record } = runRealWithStubs("npm", [], "view");
    expect(status).not.toBe(0); // the installer propagates the failure
    // npm view was attempted...
    expect(record.some((l) => l.startsWith("npm view"))).toBe(true);
    // ...but install and stop-running never ran.
    expect(record.some((l) => l.startsWith("npm install"))).toBe(false);
    expect(recordHasStop(record)).toBe(false);
  });

  test("npm mode: active sessions in non-TTY abort BEFORE npm view unless --force is passed", () => {
    const activePs = "501 /usr/local/bin/codex --enable tui_app_server --remote ws://127.0.0.1:4501\n";
    const { status, record, stderr } = runRealWithStubs("npm", [], "", activePs);

    expect(status).toBe(1);
    expect(record).toEqual(["ps -axo pid=,command="]);
    expect(record.some((l) => l.startsWith("npm view"))).toBe(false);
    expect(recordHasStop(record)).toBe(false);
    expect(stderr).toContain("--force");

    const forced = runRealWithStubs("npm", ["--force"], "", activePs);
    expect(forced.status).toBe(0);
    expect(forced.record.some((l) => l.startsWith("npm view"))).toBe(true);
    expect(recordHasStop(forced.record)).toBe(true);
  });

  test("npm mode: a failed `npm install` aborts BEFORE stop-running (daemon untouched)", () => {
    const { status, record } = runRealWithStubs("npm", [], "install -g --force");
    expect(status).not.toBe(0);
    expect(record.some((l) => l.startsWith("npm view"))).toBe(true);
    expect(record.some((l) => l.startsWith("npm install"))).toBe(true);
    expect(recordHasStop(record)).toBe(false);
  });

  test("npm mode: full success runs stop-running LAST, after view + install", () => {
    const { status, record } = runRealWithStubs("npm", [], "");
    expect(status).toBe(0);
    const viewIdx = record.findIndex((l) => l.startsWith("npm view"));
    const installIdx = record.findIndex((l) => l.startsWith("npm install"));
    const stopIdx = record.findIndex(
      (l) => l.includes("install-safety.cjs stop-running") || l.includes("kill --all"),
    );
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(viewIdx);
    expect(stopIdx).toBeGreaterThan(installIdx);
  });

  test("local mode: a failed build (prepublishOnly) aborts BEFORE stop-running", () => {
    const { status, record } = runRealWithStubs("local", ["--skip-plugin"], "run prepublishOnly");
    expect(status).not.toBe(0);
    expect(record.some((l) => l.startsWith("bun run prepublishOnly"))).toBe(true);
    // Nothing destructive ran: no install, no stop-running.
    expect(record.some((l) => l.startsWith("npm install"))).toBe(false);
    expect(recordHasStop(record)).toBe(false);
  });

  test("local mode: active sessions in non-TTY abort BEFORE build unless --force is passed", () => {
    const activePs = "601 /Users/x/.claude/plugins/agentbridge/server/bridge-server.js\n";
    const { status, record, stderr } = runRealWithStubs("local", ["--skip-plugin"], "", activePs);

    expect(status).toBe(1);
    expect(record).toEqual(["ps -axo pid=,command="]);
    expect(record.some((l) => l.startsWith("bun run prepublishOnly"))).toBe(false);
    expect(recordHasStop(record)).toBe(false);
    expect(stderr).toContain("--force");

    const forced = runRealWithStubs("local", ["--skip-plugin", "--force"], "", activePs);
    expect(forced.status).toBe(0);
    expect(forced.record.some((l) => l.startsWith("bun run prepublishOnly"))).toBe(true);
    expect(recordHasStop(forced.record)).toBe(true);
  });

  test("local mode: a failed `npm install` aborts BEFORE stop-running (daemon untouched)", () => {
    const { status, record } = runRealWithStubs("local", ["--skip-plugin"], "install -g --force");
    expect(status).not.toBe(0);
    // Build + verify + pack + install were attempted...
    expect(record.some((l) => l.startsWith("bun run prepublishOnly"))).toBe(true);
    expect(record.some((l) => l.startsWith("npm install -g --force"))).toBe(true);
    // ...but stop-running never fired, and the redundant uninstall is gone.
    expect(recordHasStop(record)).toBe(false);
    expect(record.some((l) => l.startsWith("npm uninstall"))).toBe(false);
  });

  test("local mode: full success runs stop-running AFTER install, with no uninstall", () => {
    const { status, record } = runRealWithStubs("local", ["--skip-plugin"], "");
    expect(status).toBe(0);
    const installIdx = record.findIndex((l) => l.startsWith("npm install -g --force"));
    const stopIdx = record.findIndex(
      (l) => l.includes("install-safety.cjs stop-running") || l.includes("kill --all"),
    );
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(installIdx);
    expect(record.some((l) => l.startsWith("npm uninstall"))).toBe(false);
  });

  test("package.json exposes one-line local and npm install commands", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    expect(pkg.scripts["install:global"]).toBe("node scripts/install-global.mjs local");
    expect(pkg.scripts["install:global:local"]).toBe("node scripts/install-global.mjs local");
    expect(pkg.scripts["install:global:npm"]).toBe("node scripts/install-global.mjs npm");
    expect(pkg.files).toContain("scripts/install-safety.cjs");
  });

  test("install safety stop command is dry-runnable and scoped to all pairs", () => {
    const res = Bun.spawnSync(["node", "scripts/install-safety.cjs", "stop-running", "--dry-run"], {
      env: {
        ...process.env,
        AGENTBRIDGE_PAIR_ID: "stale-pair",
        AGENTBRIDGE_STATE_DIR: "/tmp/stale-agentbridge-state",
        AGENTBRIDGE_CONTROL_PORT: "4999",
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe(
      "$ bun run src/cli.ts kill --all  # stop running AgentBridge daemons/TUIs",
    );
  });

  test("install safety strips pair-specific environment from child commands", () => {
    const res = Bun.spawnSync([
      "node",
      "-e",
      `
        const { agentBridgeInstallEnv } = require("./scripts/install-safety.cjs");
        const env = agentBridgeInstallEnv({
          PATH: "/bin",
          AGENTBRIDGE_BASE_DIR: "/stale/base",
          AGENTBRIDGE_DAEMON_ENTRY: "/tmp/fake-daemon.js",
          AGENTBRIDGE_MODE: "pull",
          AGENTBRIDGE_PAIR_ID: "stale",
          AGENTBRIDGE_PAIR_NAME: "main",
          AGENTBRIDGE_STATE_DIR: "/tmp/stale",
          AGENTBRIDGE_CONTROL_PORT: "4999",
          CODEX_WS_PORT: "4997",
          CODEX_PROXY_PORT: "4998",
        });
        console.log(JSON.stringify(env));
      `,
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout.toString());
    expect(env.PATH).toBe("/bin");
    expect(env.AGENTBRIDGE_BASE_DIR).toBeUndefined();
    expect(env.AGENTBRIDGE_DAEMON_ENTRY).toBeUndefined();
    expect(env.AGENTBRIDGE_MODE).toBeUndefined();
    expect(env.AGENTBRIDGE_PAIR_ID).toBeUndefined();
    expect(env.AGENTBRIDGE_PAIR_NAME).toBeUndefined();
    expect(env.AGENTBRIDGE_STATE_DIR).toBeUndefined();
    expect(env.AGENTBRIDGE_CONTROL_PORT).toBeUndefined();
    expect(env.CODEX_WS_PORT).toBeUndefined();
    expect(env.CODEX_PROXY_PORT).toBeUndefined();
  });

  test("postinstall dry-run stops running daemons before plugin registration", () => {
    const res = Bun.spawnSync(["node", "scripts/postinstall.cjs", "--dry-run"], {
      env: process.env,
    });
    expect(res.exitCode).toBe(0);
    expect(
      res.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual([
      "$ bun run src/cli.ts kill --all  # stop running AgentBridge daemons/TUIs",
      "$ claude --version",
      `$ claude plugin marketplace add ${process.cwd()}`,
      "$ claude plugin install agentbridge@agentbridge",
    ]);
  });

  test("unknown mode fails with usage", () => {
    const res = runDry("elsewhere");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Usage:");
  });
});

describe("scripts/postinstall.cjs shouldStopRunningDaemons", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { shouldStopRunningDaemons } = require(join(process.cwd(), "scripts/postinstall.cjs"));

  test("packed install with no global env does NOT stop running daemons", () => {
    expect(shouldStopRunningDaemons({ env: {}, hasSourceCli: false })).toBe(false);
  });

  test("npm_config_global=true triggers stop-the-world", () => {
    expect(shouldStopRunningDaemons({ env: { npm_config_global: "true" } })).toBe(true);
  });

  test("npm_config_location=global triggers stop-the-world", () => {
    expect(shouldStopRunningDaemons({ env: { npm_config_location: "global" } })).toBe(true);
  });

  test("AGENTBRIDGE_POSTINSTALL_STOP=1 forces stop", () => {
    expect(shouldStopRunningDaemons({ env: { AGENTBRIDGE_POSTINSTALL_STOP: "1" } })).toBe(true);
  });

  test("AGENTBRIDGE_POSTINSTALL_STOP=0 opt-out wins over npm_config_global", () => {
    expect(
      shouldStopRunningDaemons({
        env: { AGENTBRIDGE_POSTINSTALL_STOP: "0", npm_config_global: "true" },
      }),
    ).toBe(false);
  });
});

describe("scripts/install-global.mjs prefix resolution", () => {
  // The install must target the prefix where the user's `agentbridge` actually
  // resolves on PATH — npm's default global prefix is not always the same dir
  // (e.g. nvm bin on PATH but npm prefix elsewhere), which silently installs the
  // upgrade where it never takes effect.
  test("installPrefixFromBinPath derives <prefix> from <prefix>/bin/<name>", () => {
    expect(installPrefixFromBinPath("/Users/x/.nvm/versions/node/v22.20.0/bin/agentbridge")).toBe(
      "/Users/x/.nvm/versions/node/v22.20.0",
    );
    expect(installPrefixFromBinPath("/usr/local/bin/abg")).toBe("/usr/local");
    expect(installPrefixFromBinPath("  /opt/n/bin/agentbridge  ")).toBe("/opt/n");
  });

  test("installPrefixFromBinPath returns null when not under a bin/ dir or empty", () => {
    expect(installPrefixFromBinPath("/weird/path/agentbridge")).toBeNull();
    expect(installPrefixFromBinPath("")).toBeNull();
    expect(installPrefixFromBinPath(undefined)).toBeNull();
  });

  test("resolveInstallPrefix uses the first resolvable bin (agentbridge before abg)", () => {
    const which = (bin: string) =>
      bin === "agentbridge"
        ? { status: 0, stdout: "/opt/node/bin/agentbridge\n" }
        : { status: 1, stdout: "" };
    expect(resolveInstallPrefix(which)).toBe("/opt/node");
  });

  test("resolveInstallPrefix falls back to abg when agentbridge is absent", () => {
    const which = (bin: string) =>
      bin === "abg"
        ? { status: 0, stdout: "/home/u/.local/bin/abg\n" }
        : { status: 1, stdout: "" };
    expect(resolveInstallPrefix(which)).toBe("/home/u/.local");
  });

  test("resolveInstallPrefix returns null when nothing is on PATH (first install)", () => {
    expect(resolveInstallPrefix(() => ({ status: 1, stdout: "" }))).toBeNull();
  });
});
