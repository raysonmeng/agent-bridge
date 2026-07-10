/**
 * Runtime collaboration contract — the pluggable replacement for the static
 * CLAUDE.md / AGENTS.md doc injection (collaboration-content.ts remains the
 * single source of the section bodies and still serves the legacy
 * `abg init --inject-docs` path).
 *
 * Carriers (design settled 2026-07-10, verified on codex-cli 0.144.1):
 * - Codex side: the daemon's codex proxy injects CODEX_DEVELOPER_CONTRACT as
 *   native developer-role context — merged into
 *   `thread/start.params.developerInstructions` for new threads, appended via
 *   `thread/inject_items` (role: "developer") when first bridging an existing
 *   thread. Injection is idempotent per (threadId, contractHash()).
 * - Claude side: the plugin SessionStart hook emits CLAUDE_SESSION_CONTEXT as
 *   additionalContext only while the daemon is healthy (bridge attached).
 *
 * HARD LIMIT (measured, not assumed): any model-visible context is written to
 * the Codex thread rollout and REPLAYED on resume even when the bridge is gone
 * — codex-cli 0.144.1 exposes no revocable, history-free instruction channel.
 * Both payloads therefore OPEN with a self-scoping clause: collaborate only on
 * live bridge evidence, never wait for the other agent because this contract
 * alone says a bridge may exist.
 */

import { createHash } from "node:crypto";
import { AGENTS_MD_SECTION, CLAUDE_MD_SECTION } from "./collaboration-content";

/**
 * Self-scoping preamble for the Codex-side developer contract. Wording
 * requirement from the carrier investigation: "collaborate only when real
 * bridged messages arrive; never wait for Claude because of this contract" —
 * this is the mitigation for the irrevocable-rollout hard limit above.
 */
export const CODEX_CONTRACT_SCOPE_CLAUSE = `\
[AgentBridge runtime contract — read this scope rule first]
This developer context is injected by AgentBridge (a local Claude<->Codex
bridge) and is BINDING ONLY while the bridge is actively attached to this
thread. The ONLY proof of attachment is bridged messages from Claude (or
AgentBridge system notices) arriving in the CURRENT session. Collaborate when
such messages arrive. NEVER wait for, block on, or address Claude merely
because this contract exists. If this thread was resumed outside the bridge
(no bridged messages in the current session), ignore everything below and
operate as a normal solo Codex session.`;

/**
 * Claude-side counterpart. The SessionStart hook only emits while the daemon
 * is healthy, so staleness is bounded to "daemon died mid-session" — the
 * clause tells Claude how to detect and handle exactly that.
 */
export const CLAUDE_CONTEXT_SCOPE_CLAUSE = `\
[AgentBridge runtime context]
Injected by the AgentBridge plugin because the bridge daemon was healthy when
this session started. If the bridge later becomes unreachable (reply tool
errors, no channel messages arriving), treat collaboration as unavailable and
continue solo — do not wait for Codex.`;

/**
 * Full developer-role payload the codex proxy injects, once per
 * (threadId, contractHash()).
 */
export const CODEX_DEVELOPER_CONTRACT = `${CODEX_CONTRACT_SCOPE_CLAUSE}

${AGENTS_MD_SECTION}`;

/**
 * Full additionalContext payload the SessionStart hook emits while the daemon
 * is healthy and the Codex TUI is attached.
 */
export const CLAUDE_SESSION_CONTEXT = `${CLAUDE_CONTEXT_SCOPE_CLAUSE}

${CLAUDE_MD_SECTION}`;

/**
 * Stable fingerprint of an injected payload. The codex proxy persists
 * (threadId, contractHash()) in pair state and skips re-injection while the
 * hash is unchanged; a changed hash (content evolved with a new bridge
 * version) triggers codexContractSupersedePayload below — a replacement
 * header plus the FULL current contract, because a hash alone carries no
 * meaning for the model.
 *
 * sha256 truncated to 12 hex chars — collision space (2^48) is far beyond the
 * handful of contract versions a pair will ever see, and short enough to read
 * in state files and logs.
 */
export function contractHash(content: string = CODEX_DEVELOPER_CONTRACT): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

/**
 * Payload injected when a live thread already carries an OLDER contract
 * (persisted hash ≠ contractHash()). A "short delta" cannot work here — a hash
 * carries no meaning for the model, and only the full text conveys what the
 * rules now are — so supersede re-sends the complete current contract behind
 * an explicit replacement header. This path is rare by construction: it only
 * fires when the bridge is upgraded while an existing thread stays live (new
 * threads always get the fresh contract via thread/start).
 *
 * The adapter records contractHash() (of the DEFAULT contract, not of this
 * payload) after injecting.
 */
export function codexContractSupersedePayload(previousHash: string): string {
  return `[AgentBridge contract update]
This REPLACES the AgentBridge runtime contract injected earlier in this thread
(hash ${previousHash}). Disregard that earlier version entirely and follow only
the contract below.

${CODEX_DEVELOPER_CONTRACT}`;
}
