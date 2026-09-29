/**
 * Max-permission-by-default for the wrapper launchers (explicit user request:
 * `abg claude` runs with --dangerously-skip-permissions and `abg codex` with
 * --yolo, without typing them every time).
 *
 * Injection is skipped whenever the user has expressed ANY explicit permission
 * preference of their own — not only the exact alias (no double-add) but also
 * approval/sandbox/permission-mode flags: injecting --yolo next to an explicit
 * `-a never` is a hard clap conflict on codex (verified on 0.139: "the argument
 * '--ask-for-approval <APPROVAL_POLICY>' cannot be used with
 * '--dangerously-bypass-approvals-and-sandbox'"), and silently overriding an
 * explicit `--sandbox read-only` / `--permission-mode plan` would escalate a
 * deliberately more-restrictive launch.
 *
 * Opt-outs, in priority order:
 *   - `--safe` wrapper flag (consumed here, never forwarded to the child)
 *   - AGENTBRIDGE_SAFE=1 in the environment
 *   - any suppressor flag already present (exact token or `flag=value` form)
 */
export interface MaxPermissionPlan {
  /** Launch args with the wrapper-owned `--safe` flag stripped. */
  args: string[];
  /** Whether the launcher should append its max-permission flag. */
  inject: boolean;
  /** True when --safe / AGENTBRIDGE_SAFE=1 disabled the default. */
  safeMode: boolean;
}

export const CLAUDE_MAX_PERMISSION_FLAG = "--dangerously-skip-permissions";
export const AGY_MAX_PERMISSION_FLAG = "--dangerously-skip-permissions";
export const AGY_MAX_PERMISSION_SUPPRESSORS = [AGY_MAX_PERMISSION_FLAG, "--mode", "--sandbox"];
/** Explicit permission preferences that suppress the claude injection. */
export const CLAUDE_MAX_PERMISSION_SUPPRESSORS = [
  CLAUDE_MAX_PERMISSION_FLAG,
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
];

export const CODEX_MAX_PERMISSION_FLAG = "--yolo";
/** Explicit permission preferences that suppress the codex injection. */
export const CODEX_MAX_PERMISSION_SUPPRESSORS = [
  CODEX_MAX_PERMISSION_FLAG,
  "--dangerously-bypass-approvals-and-sandbox",
  "-a",
  "--ask-for-approval",
  "-s",
  "--sandbox",
];

export function planMaxPermissions(
  args: string[],
  suppressors: string[],
  env: NodeJS.ProcessEnv = process.env,
): MaxPermissionPlan {
  let safeFlag = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--safe") {
      safeFlag = true;
      continue;
    }
    rest.push(a);
  }

  const safeMode = safeFlag || env.AGENTBRIDGE_SAFE === "1";
  const userExpressedPreference = rest.some((a) =>
    suppressors.some((s) => matchesSuppressor(a, s)),
  );
  return { args: rest, inject: !safeMode && !userExpressedPreference, safeMode };
}

function matchesSuppressor(token: string, suppressor: string): boolean {
  if (token === suppressor || token.startsWith(`${suppressor}=`)) return true;
  // clap value-taking short options also accept the ATTACHED form with no
  // separator: `-anever` IS `-a never` (verified on codex 0.139 — and
  // `-anever --yolo` is the same hard conflict as the spaced form). Any
  // single-dash token starting with the short flag letter is that option.
  if (
    /^-[A-Za-z]$/.test(suppressor) &&
    !token.startsWith("--") &&
    token.startsWith(suppressor) &&
    token.length > suppressor.length
  ) {
    return true;
  }
  return false;
}
