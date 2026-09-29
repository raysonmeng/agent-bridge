import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER_ID } from "./collaboration-content";

export interface AgentsContractCheck {
  /** Whether the AgentBridge contract block in AGENTS.md is present and current. */
  fresh: boolean;
  /** Whether an AGENTS.md file exists at all. */
  exists: boolean;
  /** Human-readable summary suitable for a single stderr nudge line. */
  message: string;
}

/**
 * Read-only check of the AgentBridge contract in AGENTS.md.
 *
 * NEVER writes and NEVER throws/exits. AGENTS.md is managed exclusively by
 * `abg init`; `abg codex` startup must not create, rewrite, or block on it.
 * The caller may use the result to print a single nudge suggesting `abg init`.
 */
export function checkAgentsMdContract(cwd: string): AgentsContractCheck {
  const path = join(cwd, "AGENTS.md");
  const exists = existsSync(path);

  let content = "";
  if (exists) {
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      // Unreadable file → treat as stale, but never throw from a startup check.
      return {
        fresh: false,
        exists,
        message: "AGENTS.md could not be read; re-run `abg init` to refresh the AgentBridge contract.",
      };
    }
  }

  const fresh = isFreshAgentsMdContract(content);
  if (fresh) {
    return { fresh: true, exists, message: "AGENTS.md AgentBridge contract is up to date" };
  }

  return {
    fresh: false,
    exists,
    message: exists
      ? "AGENTS.md is missing the current AgentBridge contract; re-run `abg init` to refresh it."
      : "AGENTS.md not found; re-run `abg init` to write the AgentBridge contract.",
  };
}

export function isFreshAgentsMdContract(content: string): boolean {
  if (!content.includes(`<!-- ${MARKER_ID}:start -->`)) return false;
  return (
    content.includes("agentbridge_local_send") &&
    content.includes("in_reply_to") &&
    content.includes("ordinary output is never forwarded") &&
    content.includes("Git operations") &&
    content.includes("Implementer, Executor, Verifier")
  );
}
