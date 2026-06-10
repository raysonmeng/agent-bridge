import { cliInvocationName } from "./cli-invocation";
import { computeBaseDir, findPair } from "./pair-resolver";

/**
 * Render a user-facing command suggestion scoped to the current pair.
 *
 * The leading binary name echoes whichever name the user invoked the CLI as
 * (`abg` or `agentbridge`), via `cliInvocationName()` — see cli-invocation.ts.
 *
 * In multi-pair mode the resolver sets `AGENTBRIDGE_PAIR_ID`, and that env is
 * inherited by the daemon, the plugin MCP server (bridge), and the codex
 * wrapper. User-facing hints ("start Codex with…", "restart with…", "run kill
 * to reset") MUST carry `--pair <id>` in that mode — otherwise a user following
 * the hint in a named-pair session would connect to a different (cwd-derived)
 * pair, or run a bare kill that stops ALL pairs.
 *
 * In legacy/manual single-pair mode `AGENTBRIDGE_PAIR_ID` is unset, so the bare
 * command is returned (unchanged behaviour).
 *
 * @param cmd the subcommand + its own args, e.g. "codex" or "claude --resume".
 * @param name the resolved invocation name; defaults to cliInvocationName().
 *             Passed explicitly only in tests (the test runner's argv[1] is a
 *             test path, so the live default would always be the fallback).
 */
export function pairScopedCommand(cmd: string, name: string = cliInvocationName()): string {
  const pairId = process.env.AGENTBRIDGE_PAIR_ID;
  if (!pairId) return `${name} ${cmd}`;
  // Prefer the friendly, cwd-scoped name (e.g. "main") — it is what the user types.
  let selector = process.env.AGENTBRIDGE_PAIR_NAME;
  if (!selector) {
    // applyPairEnv always sets AGENTBRIDGE_PAIR_NAME alongside AGENTBRIDGE_PAIR_ID,
    // but an OLD daemon/bridge process (started before NAME shipped) or a partially
    // injected env can leave it unset. Recover the friendly name from the registry by
    // pairId — best-effort: ANY failure (missing / corrupt / unreadable registry, no
    // matching entry, empty name) falls back to the pairId. With the resolver's raw-id
    // fallback in place, even a bare pairId hint now resolves correctly, so this is
    // belt-and-suspenders, not load-bearing — and a hint must never throw while
    // rendering a bridge notification.
    try {
      selector = findPair(computeBaseDir(), pairId)?.name || pairId;
    } catch {
      selector = pairId;
    }
  }
  // `--pair <name>` goes BEFORE the subcommand (the supported position).
  return `${name} --pair ${selector} ${cmd}`;
}
