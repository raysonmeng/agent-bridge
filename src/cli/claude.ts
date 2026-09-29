import { spawn } from "node:child_process";
import { launchAgentProfile } from "./agent-profile";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import {
  MARKETPLACE_STEPS,
  pluginCacheRoot,
  shouldWarnMissingPluginCache,
} from "./plugin-cache";
import { DaemonClient } from "../daemon-client";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { BUILD_INFO } from "../build-info";
import { guardAgentBridgeEnv, normalizeEnvGuardMode } from "../env-guard";
import { parsePositiveIntEnv } from "../env-utils";
import { applyPairEnv, parsePairFlag, type PairResolution } from "../pair-resolver";
import { appendTraceEvent, pickRelevantEnv } from "../trace-log";
import {
  CLAUDE_MAX_PERMISSION_SUPPRESSORS,
  CLAUDE_MAX_PERMISSION_FLAG,
  planMaxPermissions,
} from "./max-permissions";

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

export async function runClaude(args: string[]) {
  const originalEnv = { ...process.env };
  const envGuardResult = guardAgentBridgeEnv({
    cwd: process.cwd(),
    env: process.env,
    mode: normalizeEnvGuardMode(process.env.AGENTBRIDGE_ENV_GUARD),
    allowStrict: true,
    log: (msg) => console.error(msg),
  });

  // Strip `--pair <name>` before anything else; the rest flows through to claude.
  const { pairFlag, rest: pairRest } = parsePairFlag(args);

  // Max-permission default (user request): `abg claude` runs Claude Code with
  // --dangerously-skip-permissions unless --safe / AGENTBRIDGE_SAFE=1 / the
  // user already passed it. `--safe` is wrapper-owned and stripped here.
  const permissionPlan = planMaxPermissions(pairRest, CLAUDE_MAX_PERMISSION_SUPPRESSORS);
  const rest = permissionPlan.args;

  // Check for owned flag conflicts (on the real claude args, not the pair flag).
  checkOwnedFlagConflicts(rest, "agentbridge claude", OWNED_FLAGS);

  // Resolve the pair and inject its env (state dir + ports) BEFORE building the
  // lifecycle or spawning claude, so the daemon, the spawned `claude`, and its
  // plugin MCP server all target this pair's state dir + control port.
  let pair: PairResolution;
  try {
    pair = await applyPairEnv({ pairFlag });
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  if (pair.warning) console.error(`[agentbridge] ⚠️  ${pair.warning}`);
  if (process.env.AGENTBRIDGE_TRACE === "1") {
    traceCliStart("cli.claude.start", args, originalEnv, envGuardResult.action, pair);
  }

  const stateDir = pair.stateDir;
  const controlPort = pair.ports.controlPort;
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  if (!pair.manual) {
    console.error(
      `[agentbridge] pair "${pair.pairId}" (slot ${pair.slot}) — control :${controlPort}, ` +
        `codex :${pair.ports.appPort}/:${pair.ports.proxyPort}`,
    );
  }

  // Conflict guard: refuse to launch a SECOND Claude frontend into a pair that
  // already has a LIVE one (the confirmed "smart" behaviour: live → error here,
  // stale/none → fall through and let admission take over). Also applies in
  // explicit manual mode so manual sessions do not silently fight over attach.
  // Fail-open on any probe error.
  await assertPairNotLive(lifecycle, pair);

  lifecycle.clearKilled();

  // Cheap fail-open preflight: if the plugin was never installed, the channel
  // flag below loads nothing and the bridge stays silent. Warn (stderr) so the
  // user knows to run `abg init`, but never block the launch — matching the
  // fail-open style of the guards above.
  warnIfPluginCacheMissing();

  // Channel entry format: "server:<mcp-server-name>" for MCP-based channels,
  // or "plugin:<plugin>@<marketplace>" for plugin-based channels.
  // AgentBridge is installed as a plugin, so use the plugin channel format.
  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  // Only use --dangerously-load-development-channels for now.
  // --channels checks the approved allowlist (Anthropic-curated) and fails
  // for custom plugins. The dev flag bypasses this per-entry.
  // Once published to the official marketplace, switch to --channels.
  if (permissionPlan.inject) {
    console.error(`[agentbridge] running with ${CLAUDE_MAX_PERMISSION_FLAG} (default; opt out with --safe or AGENTBRIDGE_SAFE=1)`);
  }
  const fullArgs = [
    "--dangerously-load-development-channels", channelEntry,
    ...(permissionPlan.inject ? [CLAUDE_MAX_PERMISSION_FLAG] : []),
    ...rest,
  ];

  const profile = launchAgentProfile(rest, "Claude", process.env.ANTHROPIC_MODEL);
  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: { ...process.env,
      AGENTBRIDGE_CLAUDE_NAME: profile.name,
      AGENTBRIDGE_CLAUDE_MODEL: profile.model ?? "",
    },
  });

  child.on("exit", (code, signal) => {
    process.exit(mapChildExitCode(code, signal));
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: claude not found in PATH.");
      console.error("Install Claude Code: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
    console.error(`Error starting Claude Code: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Map a reaped child's (code, signal) to the wrapper's own exit code.
 *
 * A signal-killed child is reaped with `code=null` and `signal` set, so a naive
 * `code ?? 0` reports SUCCESS (0) for a signal-killed Claude — breaking
 * scriptability and diverging from the codex wrapper. When a signal is present
 * we exit with the conventional 128+N code (mirroring `src/cli/codex.ts`, which
 * maps SIGINT→130 / SIGTERM→143 etc.). An unknown signal name still yields a
 * non-zero 128 so a kill is never silently reported as success.
 *
 * Pure + exported so the mapping is unit-testable without spawning a process.
 */
export function mapChildExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (signal) {
    return 128 + (osConstants.signals[signal] ?? 0);
  }
  return code ?? 0;
}

/**
 * Fail-open preflight: warn (but never block) when the AgentBridge plugin cache
 * dir is missing — that means the plugin was never installed, so the channel
 * flag will load nothing. Resolves the cache path via the SAME pluginCacheRoot()
 * doctor uses (single source of truth). Any error is swallowed (fail-open).
 *
 * `cacheRoot` and `log` are injectable for tests; returns whether it warned.
 */
export function warnIfPluginCacheMissing(
  cacheRoot: string = pluginCacheRoot(),
  log: (msg: string) => void = (msg) => console.error(msg),
): boolean {
  let cacheExists: boolean;
  try {
    cacheExists = existsSync(cacheRoot);
  } catch {
    return false; // can't tell → don't warn, never block
  }
  if (!shouldWarnMissingPluginCache(cacheExists)) return false;
  log(
    "[agentbridge] ⚠️  Plugin not installed (no plugin cache found). Run `abg init`, " +
      `or in Claude Code: ${MARKETPLACE_STEPS.join(" → ")}. Launching anyway…`,
  );
  return true;
}

function traceCliStart(
  event: string,
  args: string[],
  originalEnv: NodeJS.ProcessEnv,
  envGuardAction: string,
  pair: PairResolution,
) {
  try {
    appendTraceEvent({
      cwd: process.cwd(),
      event,
      pid: process.pid,
      argv: ["agentbridge", "claude", ...args],
      env: process.env,
      data: {
        originalEnv: pickRelevantEnv(originalEnv),
        effectiveEnv: pickRelevantEnv(process.env),
        envGuardAction,
        pairId: pair.pairId,
        pairName: pair.name,
        manual: pair.manual,
        slot: pair.slot,
        stateDir: pair.stateDir.dir,
        ports: pair.ports,
        build: BUILD_INFO,
      },
    });
  } catch {
    // Trace logging is diagnostic only.
  }
}

/**
 * Refuse to start a second Claude session in a pair that already has a LIVE one.
 *
 * Probes the pair's running daemon (if any) WITHOUT attaching, so it never
 * contests the incumbent. If a live frontend is found, prints a clear conflict
 * message and exits — the user picks another `--pair` name or stops the live one.
 * If there is no daemon, no incumbent, or only a stale (half-open dead) one, it
 * returns so the launch proceeds; the daemon's admission logic then takes over
 * the stale slot cleanly. Any probe error fails open (launch proceeds).
 */
async function assertPairNotLive(lifecycle: DaemonLifecycle, pair: PairResolution): Promise<void> {
  let healthy = false;
  try {
    healthy = await lifecycle.isHealthy();
  } catch {
    return; // can't tell → don't block
  }
  if (!healthy) return; // no daemon yet → fresh start, no conflict

  const client = new DaemonClient(lifecycle.controlWsUrl);
  let incumbent: { connected: boolean; alive: boolean };
  try {
    await client.connect();
    // The daemon answers `probe_incumbent` only AFTER running its own liveness
    // ping against the incumbent (up to AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS).
    // The client must therefore wait LONGER than the daemon's probe, or the two
    // timeouts race and a live-but-slightly-delayed pong reply is missed (→ the
    // guard wrongly fails open). Use the SAME parser the daemon uses for this env
    // (parsePositiveIntEnv — rejects "1.5"/"10abc"/negatives) so the two never
    // disagree on the value, then add a margin. (If the daemon was started with a
    // larger override than this process sees, the margin may not fully cover it;
    // the daemon's own admission probe at attach time remains the backstop.)
    const daemonProbeMs = parsePositiveIntEnv("AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS", 3000);
    incumbent = await client.probeIncumbent(daemonProbeMs + 2500);
  } catch {
    return; // probe failed → fail open
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }

  if (incumbent.connected && incumbent.alive) {
    const name = pair.name;
    console.error(
      `[agentbridge] Pair "${name}" in ${process.cwd()} already has an active Claude session.`,
    );
    console.error(`[agentbridge] Refusing to open a second one in the same pair.`);
    console.error(`[agentbridge]`);
    console.error(`[agentbridge]   • Use that existing session, or`);
    console.error(`[agentbridge]   • Start a different pair:  abg --pair <other-name> claude`);
    console.error(
      `[agentbridge]   • If that session is actually dead, take it over with:  abg --pair ${name} kill`,
    );
    process.exit(1);
  }
}

/**
 * Check if user passed any AgentBridge-owned flags.
 * Hard error if they did — mixed flag state is unpredictable.
 */
export function checkOwnedFlagConflicts(
  args: string[],
  commandName: string,
  ownedFlags: string[],
) {
  for (const flag of ownedFlags) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by ${commandName}.`);
      console.error("");
      console.error("AgentBridge automatically injects these flags:");
      for (const f of ownedFlags) {
        console.error(`  ${f}`);
      }
      console.error("");
      const nativeCmd = commandName.includes("codex") ? "codex" : "claude";
      console.error("If you need full control over these flags, use the native command directly:");
      console.error(`  ${nativeCmd} [your flags here]`);
      process.exit(1);
    }
  }
}
