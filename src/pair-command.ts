/**
 * Render a user-facing `agentbridge` command suggestion scoped to the current
 * pair.
 *
 * In multi-pair mode the resolver sets `AGENTBRIDGE_PAIR_ID`, and that env is
 * inherited by the daemon, the plugin MCP server (bridge), and the codex
 * wrapper. User-facing hints ("start Codex with…", "restart with…", "run kill
 * to reset") MUST carry `--pair <id>` in that mode — otherwise a user following
 * the hint in a named-pair session would connect to a different (cwd-derived)
 * pair, or run a bare `agentbridge kill` that stops ALL pairs.
 *
 * In legacy/manual single-pair mode `AGENTBRIDGE_PAIR_ID` is unset, so the bare
 * command is returned (unchanged behaviour).
 *
 * @param cmd the subcommand + its own args, e.g. "codex" or "claude --resume".
 */
export function pairScopedCommand(cmd: string): string {
  const pairId = process.env.AGENTBRIDGE_PAIR_ID;
  if (!pairId) return `agentbridge ${cmd}`;
  // Prefer the friendly, cwd-scoped name (e.g. "main") when available; it is what
  // the user types. The hint is meant to be run from the same project directory.
  const selector = process.env.AGENTBRIDGE_PAIR_NAME || pairId;
  // `--pair <name>` goes BEFORE the subcommand (the supported position).
  return `agentbridge --pair ${selector} ${cmd}`;
}
