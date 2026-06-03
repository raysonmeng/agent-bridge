import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installPrefixFromBinPath, resolveInstallPrefix } from "../../scripts/install-global.mjs";

const SCRIPT = join(process.cwd(), "scripts/install-global.mjs");
const PACKAGE_NAME = "@raysonmeng/agentbridge";

function runDry(mode: string): { status: number | null; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["node", SCRIPT, mode, "--dry-run"], {
    env: process.env,
  });
  return {
    status: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

function dryRunCommands(mode: string): string[] {
  const res = runDry(mode);
  expect(res.status).toBe(0);
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("$ "));
}

describe("scripts/install-global.mjs", () => {
  test("local mode builds and packs before replacing the global install", () => {
    const commands = dryRunCommands("local");
    expect(commands).toEqual([
      "$ node scripts/install-safety.cjs stop-running --dry-run",
      "$ bun run prepublishOnly",
      "$ node scripts/install-safety.cjs verify-built",
      "$ npm pack --pack-destination <temp>",
      "$ node scripts/install-safety.cjs verify-tarball <packed-tarball>",
      `$ npm uninstall -g ${PACKAGE_NAME}  # ignored if not installed`,
      "$ npm install -g --force <packed-tarball>",
    ]);
  });

  test("npm mode verifies the registry package before replacing the global install", () => {
    const commands = dryRunCommands("npm");
    expect(commands).toEqual([
      "$ node scripts/install-safety.cjs stop-running --dry-run",
      `$ npm view ${PACKAGE_NAME}@latest version`,
      `$ npm uninstall -g ${PACKAGE_NAME}  # ignored if not installed`,
      `$ npm install -g --force ${PACKAGE_NAME}@latest`,
    ]);
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
