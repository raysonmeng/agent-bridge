import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { DaemonClient } from "../daemon-client";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { applyPairEnv, parsePairFlag, type PairResolution } from "../pair-resolver";

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

export async function runClaude(args: string[]) {
  // Strip `--pair <name>` before anything else; the rest flows through to claude.
  const { pairFlag, rest } = parsePairFlag(args);

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
  // stale/none → fall through and let admission take over). Skipped in manual
  // mode (power-user single-pair). Fail-open on any probe error.
  if (!pair.manual) {
    await assertPairNotLive(lifecycle, pair);
  }

  lifecycle.clearKilled();

  // Channel entry format: "server:<mcp-server-name>" for MCP-based channels,
  // or "plugin:<plugin>@<marketplace>" for plugin-based channels.
  // AgentBridge is installed as a plugin, so use the plugin channel format.
  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  // Only use --dangerously-load-development-channels for now.
  // --channels checks the approved allowlist (Anthropic-curated) and fails
  // for custom plugins. The dev flag bypasses this per-entry.
  // Once published to the official marketplace, switch to --channels.
  const fullArgs = [
    "--dangerously-load-development-channels", channelEntry,
    ...rest,
  ];

  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
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
    incumbent = await client.probeIncumbent();
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
