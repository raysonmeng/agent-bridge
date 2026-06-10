/**
 * Single source of truth for the CLI invocation name.
 *
 * The binary is published under two names — `abg` (short) and `agentbridge`
 * (full) — and user-facing guidance strings (kill's restart hint, budget's
 * "run X first", doctor's daemon hints, the `--pair`-scoped command suggestions)
 * used to hardcode one or the other inconsistently. That meant a user who typed
 * `abg kill` could be told to restart with `agentbridge claude`, and vice versa.
 *
 * `cliInvocationName()` echoes back whichever name the user actually invoked, by
 * inspecting `process.argv[1]`. Routing every guidance string through it keeps
 * the whole journey (start → diagnose → kill → restart) phrased in one name.
 */

import { basename } from "node:path";

/** The two names the CLI binary is published under. */
export const CLI_NAMES = ["abg", "agentbridge"] as const;
export type CliName = (typeof CLI_NAMES)[number];

/** Fallback when the basename of argv[1] is neither published name. */
export const DEFAULT_CLI_NAME: CliName = "abg";

/**
 * Resolve the name the CLI was invoked as from `process.argv[1]`.
 *
 * - basename "abg"  → "abg"
 * - basename "agentbridge" → "agentbridge"
 * - anything else (a test runner path, `bun src/cli.ts`, `cli.js`, an unset
 *   argv[1]) → DEFAULT_CLI_NAME ("abg")
 *
 * The strip of a trailing `.ts`/`.js`/`.mjs`/`.cjs` extension lets a
 * source/dev launcher (`agentbridge.ts`) still resolve to the published name;
 * a generic `cli.js` bundle name still falls back, which is the safe default.
 *
 * @param argv defaults to `process.argv`; passed explicitly only in tests.
 */
export function cliInvocationName(argv: readonly string[] = process.argv): CliName {
  const raw = argv[1];
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_CLI_NAME;
  // Strip a single known script extension so `agentbridge.ts` / `abg.js` match.
  const name = basename(raw).replace(/\.(ts|js|mjs|cjs)$/, "");
  return isCliName(name) ? name : DEFAULT_CLI_NAME;
}

function isCliName(value: string): value is CliName {
  return (CLI_NAMES as readonly string[]).includes(value);
}
