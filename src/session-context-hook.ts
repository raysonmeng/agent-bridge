/**
 * SessionStart-hook helper behind `bridge-server.js --print-session-context`.
 *
 * The plugin's health-check.sh probes the daemon itself and calls this entry
 * ONLY when the daemon is healthy AND the Codex TUI is attached — this module
 * does no probing of its own. It decides one thing: whether runtime
 * collaboration-context injection is enabled for the workspace, and if so
 * prints the complete SessionStart hook JSON (additionalContext = short status
 * line + CLAUDE_SESSION_CONTEXT) on stdout. Printing nothing tells the shell
 * script to fall back to its short informational notice.
 *
 * This is the Claude-side runtime carrier that replaced the static CLAUDE.md
 * section (see collaboration-contract.ts for the full design note).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_SESSION_CONTEXT } from "./collaboration-contract";

/**
 * Lenient read of `injection.runtime` from a raw config.json string. Defaults
 * to TRUE on every failure mode (missing file content, parse error, absent
 * keys) — runtime delivery is the product default and must not silently turn
 * off because a config is corrupt.
 *
 * The accepted spellings MUST mirror ConfigService's normalizeBoolean
 * (config-service.ts) exactly: the daemon gates the Codex-side carrier through
 * that normalizer, and the same config file has to yield the same decision on
 * both sides — a divergence would disable one carrier while the other keeps
 * injecting.
 *
 * Deliberately does NOT go through ConfigService: the daemon owns the schema
 * (normalization, env overrides); the hook only needs this one opt-out bit and
 * must never crash the SessionStart hook over unrelated config problems.
 */
export function isRuntimeInjectionEnabled(configRaw: string | null): boolean {
  if (configRaw === null) return true;
  try {
    const parsed = JSON.parse(configRaw);
    const value = parsed?.injection?.runtime;
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return true;
  } catch {
    return true;
  }
}

/** The additionalContext payload: status line (+ optional notice), then the contract. */
export function buildSessionContextAdditionalContext(notice?: string): string {
  const statusLine =
    "AgentBridge is running. Daemon healthy, Codex TUI connected. Bridge is ready for communication." +
    (notice ? ` ${notice}` : "");
  return `${statusLine}\n\n${CLAUDE_SESSION_CONTEXT}`;
}

/** Complete hook stdout document (JSON.stringify handles all escaping). */
export function buildSessionContextHookJson(notice?: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildSessionContextAdditionalContext(notice),
    },
  });
}

/** Minimal argv parser for `--workspace <path> --notice <text> [--check]`. */
export function parseSessionContextArgs(argv: string[]): {
  workspace: string;
  notice?: string;
  checkOnly: boolean;
} {
  let workspace = process.cwd();
  let notice: string | undefined;
  let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && argv[i + 1] !== undefined) {
      workspace = argv[++i]!;
    } else if (argv[i] === "--notice" && argv[i + 1] !== undefined) {
      const value = argv[++i]!;
      if (value.trim() !== "") notice = value;
    } else if (argv[i] === "--check") {
      checkOnly = true;
    }
  }
  return { workspace, notice, checkOnly };
}

/**
 * IO wrapper used by bridge.ts. Exit code is always 0 — the hook must never
 * fail the session over context delivery; "print nothing" IS the error path
 * (the shell script falls back to its short notice).
 *
 * `--check` mode prints a bare `enabled` / `disabled` verdict instead of the
 * payload. health-check.sh gates ALL of its output on this verdict so the
 * opt-out semantics live in exactly one place (isRuntimeInjectionEnabled) —
 * shell must never re-implement JSON parsing. The script treats anything
 * other than a literal `disabled` (including helper failure) as enabled:
 * fail-open, so a broken helper cannot mute the informational notices.
 */
export function runPrintSessionContext(argv: string[]): number {
  const { workspace, notice, checkOnly } = parseSessionContextArgs(argv);

  let configRaw: string | null = null;
  try {
    configRaw = readFileSync(join(workspace, ".agentbridge", "config.json"), "utf-8");
  } catch {
    // No project config → defaults apply (injection enabled).
  }

  const enabled = isRuntimeInjectionEnabled(configRaw);

  if (checkOnly) {
    console.log(enabled ? "enabled" : "disabled");
    return 0;
  }

  if (!enabled) {
    return 0;
  }

  console.log(buildSessionContextHookJson(notice));
  return 0;
}
