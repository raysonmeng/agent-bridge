#!/usr/bin/env node
/**
 * Install AgentBridge globally in a way that is convenient for local testing.
 *
 * Modes:
 *   local  preflight active sessions, build + verify this checkout, pack it,
 *          install the tarball (`--force`), sync the Claude Code plugin. With
 *          --restart-now: also stop running daemons.
 *   npm    preflight active sessions, verify npm latest exists, install latest
 *          (`--force`). With --restart-now: also stop daemons.
 *
 * Non-destructive default (backlog ⑥):
 *   - The upgrade does NOT stop running daemons by default. Active Claude
 *     frontends / Codex TUIs keep serving with the OLD bytes until they restart
 *     on their own — so an upgrade never interrupts an in-flight session, and
 *     no confirmation is needed. `--restart-now` opts back into the old "stop
 *     daemons now" behaviour (and then active sessions require confirm/--force).
 *
 * Ordering invariant (downtime + failure safety):
 *   - `npm install -g --force` is a full replace, so no separate `npm uninstall`
 *     is needed — dropping it removes the window where no binary is on PATH.
 *   - stop-running (only under --restart-now) fires AFTER the install succeeds,
 *     so the old daemon keeps serving until the new bytes are on disk and a
 *     FAILED install (red build, unreachable registry, missing version) never
 *     kills the running daemon.
 *
 * PREFIX RESOLUTION: a plain `npm install -g` targets npm's configured global
 * prefix, which is NOT always where the user's `agentbridge` command resolves —
 * e.g. an nvm node's bin dir is first on PATH while npm's prefix points elsewhere.
 * In that case the upgrade installs to a directory that is not on PATH and the
 * new bytes silently never take effect. So we resolve the prefix of the
 * `agentbridge`/`abg` currently on PATH and target THAT (via `npm_config_prefix`),
 * falling back to npm's default when nothing is installed yet.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { agentBridgeInstallEnv } = require("./install-safety.cjs");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const packageName = pkg.name;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipPlugin = args.includes("--skip-plugin");
const force = args.includes("--force");
const restartNow = args.includes("--restart-now");
const mode = args.find((arg) => !arg.startsWith("-"));
const PAIR_BASE_PORT = 4500;
const PAIR_SLOT_STRIDE = 10;

function usage() {
  process.stderr.write(`Usage: node scripts/install-global.mjs <local|npm> [--dry-run] [--skip-plugin] [--restart-now] [--force]

Examples:
  bun run install:global:local   # build this checkout, replace the global install, sync the Claude Code plugin
  bun run install:global:npm     # fully replace the global install with npm latest

Options:
  --skip-plugin   local mode only: skip the Claude Code plugin sync (\`dev\`) step
  --restart-now   stop running daemons after install (disconnects active sessions). Default is
                  non-destructive: daemons keep serving the old version until they restart on their own.
  --force         with --restart-now: skip the confirm prompt for active sessions
`);
}

function parsePsProcessList(output) {
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid)) continue;
    entries.push({ pid, command: match[2] });
  }
  return entries;
}

function extractRemoteUrl(command) {
  const tokens = command.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--remote" && tokens[i + 1]) return tokens[i + 1];
    if (token?.startsWith("--remote=")) return token.slice("--remote=".length);
  }
  return null;
}

function invokesCodexBinary(command) {
  const tokens = command.trim().split(/\s+/);
  const exe = tokens[0] ? basename(tokens[0]) : "";
  if (exe === "codex") return true;
  if ((exe === "node" || exe === "bun") && tokens[1]) {
    return basename(tokens[1]) === "codex";
  }
  return false;
}

function commandMatchesManagedCodexTui(command) {
  if (!invokesCodexBinary(command)) return false;
  if (!command.includes("tui_app_server")) return false;
  return extractRemoteUrl(command) !== null;
}

function commandMatchesBridgeFrontend(command) {
  return (
    /(?:^|[\s/\\])bridge-server\.js(?:\s|$)/.test(command) &&
    (command.includes("agentbridge") || command.includes("agent_bridge"))
  );
}

function proxyUrlForSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0) return null;
  return `ws://127.0.0.1:${PAIR_BASE_PORT + slot * PAIR_SLOT_STRIDE + 1}`;
}

function pairSummary(pair) {
  if (!pair) return { label: "unknown" };
  const label = pair.pairName && pair.pairId
    ? `${pair.pairName} (${pair.pairId})`
    : pair.pairId ?? pair.proxyUrl ?? "unknown";
  return {
    label,
    pairId: pair.pairId,
    pairName: pair.pairName,
    cwd: pair.cwd,
    stateDir: pair.stateDir,
    proxyUrl: pair.proxyUrl,
  };
}

function pairForRemoteUrl(remoteUrl, pairInfos) {
  return pairInfos.find((pair) => pair.proxyUrl === remoteUrl) ?? null;
}

export function detectActiveInstallSessionsFromPsOutput(psOutput, pairInfos = []) {
  const sessions = [];
  for (const entry of parsePsProcessList(psOutput)) {
    if (entry.pid === process.pid) continue;
    if (commandMatchesBridgeFrontend(entry.command)) {
      sessions.push({
        kind: "claude-frontend",
        pid: entry.pid,
        command: entry.command,
        pair: pairSummary(null),
      });
      continue;
    }
    if (commandMatchesManagedCodexTui(entry.command)) {
      const remoteUrl = extractRemoteUrl(entry.command);
      sessions.push({
        kind: "codex-tui",
        pid: entry.pid,
        command: entry.command,
        remoteUrl,
        pair: pairSummary(pairForRemoteUrl(remoteUrl, pairInfos)),
      });
    }
  }
  return sessions;
}

/**
 * @param {{ activeSessionCount: number, force: boolean, dryRun: boolean, isTTY: boolean, restartNow?: boolean }} opts
 * @returns {{ action: "allow" | "prompt" | "block", reason: string }}
 */
export function decideInstallPreflight({ activeSessionCount, force, dryRun, isTTY, restartNow = false }) {
  if (dryRun) return { action: "allow", reason: "dry-run" };
  if (activeSessionCount === 0) return { action: "allow", reason: "no-active-sessions" };
  // Non-destructive default (backlog ⑥): the upgrade no longer stops running daemons, so active
  // sessions keep serving with the OLD bytes until they restart on their own — there is nothing to
  // disconnect, hence nothing to confirm. Only `--restart-now` (the opt-in destructive path that
  // stops daemons) keeps the old confirm/force gate below.
  if (!restartNow) return { action: "allow", reason: "non-destructive" };
  if (force) return { action: "allow", reason: "force" };
  if (isTTY) return { action: "prompt", reason: "tty" };
  return { action: "block", reason: "non-tty" };
}

function platformBaseDir(env = process.env) {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "AgentBridge");
  }
  const xdg = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
  return join(xdg, "agentbridge");
}

function computeBaseDir(env = process.env) {
  return env.AGENTBRIDGE_BASE_DIR || env.AGENTBRIDGE_STATE_DIR || platformBaseDir(env);
}

function readJsonIfPresent(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function pairInfoFromStatusFile(stateDir) {
  const status = readJsonIfPresent(join(stateDir, "daemon.json")) ?? readJsonIfPresent(join(stateDir, "status.json"));
  if (!status || typeof status !== "object") return null;
  const proxyUrl = typeof status.proxyUrl === "string" ? status.proxyUrl : null;
  if (!proxyUrl) return null;
  return {
    pairId: typeof status.pairId === "string" ? status.pairId : undefined,
    pairName: undefined,
    cwd: typeof status.cwd === "string" ? status.cwd : undefined,
    stateDir,
    proxyUrl,
  };
}

function readPairInfos(baseDir = computeBaseDir()) {
  const pairsRoot = join(baseDir, "pairs");
  const byProxy = new Map();
  const registry = readJsonIfPresent(join(pairsRoot, "registry.json"));
  if (registry && Array.isArray(registry.pairs)) {
    for (const entry of registry.pairs) {
      if (!entry || typeof entry !== "object") continue;
      const pairId = typeof entry.pairId === "string" ? entry.pairId : undefined;
      const proxyUrl = proxyUrlForSlot(entry.slot);
      if (!pairId || !proxyUrl) continue;
      byProxy.set(proxyUrl, {
        pairId,
        pairName: typeof entry.name === "string" ? entry.name : undefined,
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
        stateDir: join(pairsRoot, pairId),
        proxyUrl,
      });
    }
  }

  try {
    for (const dirent of readdirSync(pairsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const stateDir = join(pairsRoot, dirent.name);
      const fromStatus = pairInfoFromStatusFile(stateDir);
      if (!fromStatus) continue;
      const existing = byProxy.get(fromStatus.proxyUrl);
      byProxy.set(fromStatus.proxyUrl, { ...fromStatus, ...existing });
    }
  } catch {
    // Missing/corrupt state is diagnostic-only; ps command lines remain enough
    // to block safely.
  }
  return [...byProxy.values()];
}

function readActiveInstallSessions() {
  let output = "";
  try {
    output = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" }).stdout ?? "";
  } catch {
    return [];
  }
  return detectActiveInstallSessionsFromPsOutput(output, readPairInfos());
}

function renderActiveInstallSessions(sessions) {
  return sessions
    .map((session) => {
      const kind = session.kind === "codex-tui" ? "Codex TUI" : "Claude frontend";
      const remote = session.remoteUrl ? ` remote=${session.remoteUrl}` : "";
      const cwd = session.pair.cwd ? ` cwd=${session.pair.cwd}` : "";
      return `  - pid ${session.pid}: ${kind}; pair=${session.pair.label}${remote}${cwd}`;
    })
    .join("\n");
}

function askContinueWithActiveSessions() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Active sessions will be disconnected. Continue? (y/N) ", (answer) => {
      rl.close();
      resolve(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}

async function runInstallPreflight() {
  const sessions = readActiveInstallSessions();
  const decision = decideInstallPreflight({
    activeSessionCount: sessions.length,
    force,
    dryRun,
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    restartNow,
  });
  if (decision.action === "allow") {
    if (decision.reason === "non-destructive" && sessions.length > 0) {
      process.stderr.write(
        "install-global: active sessions detected; they will KEEP RUNNING the old version until they restart " +
          "(pass --restart-now to stop them now):\n" +
          `${renderActiveInstallSessions(sessions)}\n`,
      );
    }
    if (decision.reason === "force" && sessions.length > 0) {
      process.stderr.write(
        "install-global: --force set; continuing even though active sessions may be disconnected:\n" +
          `${renderActiveInstallSessions(sessions)}\n`,
      );
    }
    return sessions.length;
  }
  if (sessions.length > 0) {
    process.stderr.write(
      "install-global: active AgentBridge sessions detected:\n" +
        `${renderActiveInstallSessions(sessions)}\n`,
    );
  }
  if (decision.action === "block") {
    process.stderr.write("install-global: --restart-now in non-TTY mode needs --force to confirm disconnecting sessions; or drop --restart-now for a non-destructive install.\n");
    process.exit(1);
  }
  const ok = await askContinueWithActiveSessions();
  if (!ok) {
    process.stderr.write("install-global: cancelled; no changes made.\n");
    process.exit(1);
  }
  return sessions.length;
}

/**
 * Derive the install prefix from a resolved bin path like `<prefix>/bin/<name>`.
 * Returns the prefix, or null when the path is not under a `bin/` directory.
 */
export function installPrefixFromBinPath(binPath) {
  if (!binPath) return null;
  const binDir = dirname(binPath.trim());
  if (basename(binDir) !== "bin") return null;
  return dirname(binDir);
}

/**
 * Resolve the install prefix of the `agentbridge`/`abg` currently on PATH so the
 * global install lands where the user's command actually runs from. Returns the
 * prefix, or null to fall back to npm's default (e.g. first-ever install).
 *
 * `which` is injectable for testing.
 */
export function resolveInstallPrefix(which = (bin) => spawnSync("which", [bin], { encoding: "utf-8" })) {
  for (const bin of ["agentbridge", "abg"]) {
    const res = which(bin);
    const binPath = ((res && res.stdout) || "").trim().split("\n").filter(Boolean)[0];
    if (res && res.status === 0 && binPath) {
      const prefix = installPrefixFromBinPath(binPath);
      if (prefix) return prefix;
    }
  }
  return null;
}

/** Env additions that pin npm's global prefix to the on-PATH install location. */
function prefixEnv(prefix) {
  return prefix ? { npm_config_prefix: prefix } : {};
}

function quote(arg) {
  return /^[A-Za-z0-9_@%+=:,./<>-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(cmd, commandArgs) {
  return [cmd, ...commandArgs].map(quote).join(" ");
}

function printDry(cmd, commandArgs, suffix = "") {
  process.stdout.write(`$ ${commandLine(cmd, commandArgs)}${suffix}\n`);
}

function printDryPreflight() {
  process.stdout.write(
    restartNow
      ? "# preflight: --restart-now stops active AgentBridge frontends/Codex TUIs; prompt on TTY, refuse in non-TTY (use --force to skip)\n"
      : "# preflight: active AgentBridge frontends/Codex TUIs are left running (non-destructive); pass --restart-now to stop them\n",
  );
}

function run(cmd, commandArgs, options = {}) {
  const { allowFailure = false, cwd = root, captureStdout = false, envExtra = {} } = options;
  process.stdout.write(`$ ${commandLine(cmd, commandArgs)}\n`);
  const res = spawnSync(cmd, commandArgs, {
    cwd,
    encoding: "utf-8",
    env: { ...agentBridgeInstallEnv(process.env), ...envExtra },
    stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (res.error) {
    process.stderr.write(`install-global: failed to start ${cmd}: ${res.error.message}\n`);
    if (!allowFailure) process.exit(1);
  }
  if (res.status !== 0 && !allowFailure) {
    process.stderr.write(`install-global: command failed with exit code ${res.status}: ${commandLine(cmd, commandArgs)}\n`);
    process.exit(res.status ?? 1);
  }
  return res;
}

function packedTarballFrom(stdout, destination) {
  const file = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!file) {
    process.stderr.write("install-global: npm pack did not report a tarball name\n");
    process.exit(1);
  }
  return isAbsolute(file) ? file : join(destination, file);
}

/** Print where the install will land (a `#` note — never a `$ ` command line). */
function reportPrefix(prefix) {
  if (prefix) {
    process.stdout.write(
      `# install target: npm_config_prefix=${prefix} (where your \`agentbridge\` resolves on PATH)\n`,
    );
  } else {
    process.stdout.write(
      "# install target: npm default prefix (no agentbridge on PATH yet)\n",
    );
  }
}

async function installLocal() {
  const prefix = dryRun ? resolveInstallPrefix() : null;
  if (dryRun) {
    printDryPreflight();
    reportPrefix(prefix);
    printDry("bun", ["run", "prepublishOnly"]);
    printDry("node", ["scripts/install-safety.cjs", "verify-built"]);
    printDry("npm", ["pack", "--pack-destination", "<temp>"]);
    printDry("node", ["scripts/install-safety.cjs", "verify-tarball", "<packed-tarball>"]);
    printDry("npm", ["install", "-g", "--force", "<packed-tarball>"]);
    if (restartNow) printDry("node", ["scripts/install-safety.cjs", "stop-running", "--dry-run"], "  # --restart-now: stop running daemons now (default leaves them serving the old version until they restart)");
    if (!skipPlugin) {
      printDry("bun", ["src/cli.ts", "dev", "--skip-build"], "  # sync Claude Code plugin (skip with --skip-plugin)");
    }
    return;
  }

  const runningSessions = await runInstallPreflight();
  const target = resolveInstallPrefix();
  reportPrefix(target);
  const env = prefixEnv(target);
  let packDir = "";
  try {
    // Ordering rationale (downtime-minimizing, failure-safe):
    //   1. Build + verify FIRST so a red build aborts BEFORE anything is killed
    //      (PR #101 — a broken build must never cause a machine-wide outage).
    //   2. `npm install -g --force` is ALREADY a full replace, so the previous
    //      `npm uninstall -g` step is redundant: it only widened the window in
    //      which no `agentbridge` binary exists on PATH. Removed.
    //   3. Stop running daemons AFTER the install succeeds, not before: the old
    //      daemon keeps serving while the new bytes land, so the downtime window
    //      shrinks to "stop -> user restart". A FAILED install (build/pack/verify
    //      /npm install) returns before this line, leaving the daemon untouched.
    run("bun", ["run", "prepublishOnly"]);
    run("node", ["scripts/install-safety.cjs", "verify-built"]);
    packDir = mkdtempSync(join(tmpdir(), "agentbridge-pack-"));
    const packed = run("npm", ["pack", "--pack-destination", packDir], { captureStdout: true });
    const tarball = packedTarballFrom(packed.stdout ?? "", packDir);
    run("node", ["scripts/install-safety.cjs", "verify-tarball", tarball]);
    run("npm", ["install", "-g", "--force", tarball], { envExtra: env });
    // Non-destructive default (⑥): leave running daemons alone — they keep serving active sessions
    // with the old bytes and pick up the new version on their next restart. Only --restart-now stops
    // them now (the old behaviour).
    if (restartNow) run("node", ["scripts/install-safety.cjs", "stop-running"]);
    process.stdout.write(`install-global: installed ${packageName} globally from local source\n`);
  } finally {
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  }

  // Sync the Claude Code plugin from this checkout so one command updates both
  // deployables (terminal CLI + plugin bundles). Non-fatal: the global CLI is
  // already installed at this point, so a plugin-sync failure (e.g. missing
  // `claude` CLI) must not report the whole install as failed.
  if (!skipPlugin) {
    process.stdout.write("# syncing Claude Code plugin from this checkout (skip with --skip-plugin)\n");
    const dev = run("bun", ["src/cli.ts", "dev", "--skip-build"], { allowFailure: true });
    if (dev.status !== 0) {
      process.stderr.write(
        "install-global: global CLI installed, but the Claude Code plugin sync failed — run `bun src/cli.ts dev` in this checkout manually.\n",
      );
    }
  }

  // Tell the user the truth about running sessions — but ONLY when there actually were any at
  // preflight time (gated on runningSessions, like the preflight stderr): a clean install with
  // nothing running must not claim phantom sessions. The wording depends on whether this was the
  // destructive (--restart-now) path or the non-destructive default (backlog ⑥).
  if (runningSessions > 0) {
    process.stdout.write(
      restartNow
        ? "# note: running AgentBridge sessions were stopped — start fresh with `agentbridge claude` / `agentbridge codex`\n"
        : "# note: running AgentBridge sessions keep serving the OLD version until they restart — restart when convenient to pick up the new build (or re-run with --restart-now to stop them now)\n",
    );
  }

  warnAboutSurvivingFrontends();
}

/**
 * Old Claude Code windows keep the PREVIOUS plugin loaded in memory; their
 * sessions relaunch daemons at the old build, recreating the exact artifact
 * split this installer just fixed. Surface them explicitly — the user cannot
 * otherwise tell which windows are stale.
 */
function warnAboutSurvivingFrontends() {
  let output = "";
  try {
    output = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" }).stdout ?? "";
  } catch {
    return;
  }
  const frontends = output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter(
      (m) =>
        m &&
        /(?:^|[\s/\\])bridge-server\.js(?:\s|$)/.test(m[2]) &&
        (m[2].includes("agentbridge") || m[2].includes("agent_bridge")),
    )
    .map((m) => Number(m[1]));
  if (frontends.length === 0) return;
  process.stdout.write(
    `# ⚠️  检测到 ${frontends.length} 个仍在运行的 Claude Code 桥接前端 (pid ${frontends.join(", ")})：\n` +
      "#     它们窗口内加载的仍是旧插件代码——请关闭并重开这些 Claude Code 窗口以使用新版本。\n",
  );
}

async function installNpm() {
  const spec = `${packageName}@latest`;
  const prefix = dryRun ? resolveInstallPrefix() : null;
  if (dryRun) {
    printDryPreflight();
    reportPrefix(prefix);
    printDry("npm", ["view", spec, "version"]);
    printDry("npm", ["install", "-g", "--force", spec]);
    if (restartNow) printDry("node", ["scripts/install-safety.cjs", "stop-running", "--dry-run"], "  # --restart-now: stop running daemons now (default leaves them serving the old version until they restart)");
    return;
  }

  await runInstallPreflight();
  const target = resolveInstallPrefix();
  reportPrefix(target);
  const env = prefixEnv(target);
  // Validate + install BEFORE stopping anything: the old order killed every
  // running pair before `npm view` even confirmed the registry was reachable,
  // so an unreachable registry or a missing version caused a pointless
  // machine-wide outage. `--force` is a full replace (no separate uninstall
  // needed). A failure on any line below returns before stop-running, leaving
  // the running daemon untouched — zero downtime on the failure path.
  run("npm", ["view", spec, "version"]);
  run("npm", ["install", "-g", "--force", spec], { envExtra: env });
  // Non-destructive default (⑥): see local path above — only --restart-now stops running daemons now.
  if (restartNow) run("node", ["scripts/install-safety.cjs", "stop-running"]);
  process.stdout.write(`install-global: installed ${packageName} globally from npm latest\n`);
}

// Only dispatch when executed directly (so the helpers above stay importable in tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (mode === "local" || mode === "source") {
    await installLocal();
  } else if (mode === "npm" || mode === "registry") {
    await installNpm();
  } else {
    usage();
    process.exit(1);
  }
}
