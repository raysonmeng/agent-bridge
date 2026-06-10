import {
  CLOSE_CODE_PAIR_MISMATCH,
  CLOSE_CODE_TOKEN_MISMATCH,
  type ControlClientIdentity,
} from "./control-protocol";
import { validateControlToken } from "./control-token";

export interface ClaudeIdentityValidationInput {
  expectedPairId: string | null;
  daemonCwd: string;
  identity?: ControlClientIdentity;
  allowIdentityless?: boolean;
  /**
   * The daemon's control-port capability token (arch-review P1 #283). When set,
   * the client's identity MUST echo it. null disables the token layer (older
   * daemon / token write+read failure) — admission then degrades to the
   * pre-token pair/cwd checks plus the attach-convergence guard at injection.
   */
  expectedControlToken?: string | null;
}

export type ClaudeIdentityValidationResult =
  | { ok: true }
  | { ok: false; closeCode: number; reason: string };

export function validateClaudeClientIdentity(
  input: ClaudeIdentityValidationInput,
): ClaudeIdentityValidationResult {
  // Capability-token gate (P1 #283) runs FIRST and INDEPENDENTLY of pair mode:
  // even a legacy/manual single-pair daemon (no pairId enforcement) writes a
  // token, so an identity-carrying socket that did not read the 0600 token file
  // is rejected here before any pair/cwd reasoning. Compat is two-fold:
  //
  //   1. expectedControlToken null (older daemon / token write+read failure) →
  //      gate disabled, behavior unchanged.
  //   2. NO identity object on the message → gate skipped, and the request is
  //      handled by the identityless policy below. This preserves the two
  //      legacy admit paths verbatim: pure legacy mode (no pairId) admits an
  //      identityless client, and AGENTBRIDGE_COMPAT_IDENTITYLESS admits one in
  //      pair mode. A client that CANNOT carry a token (sends no identity at
  //      all) must not be force-rejected by the token layer — the attach guard
  //      + Origin guard remain its defense. EVERY real frontend (bridge.ts)
  //      sends an identity and therefore IS held to the token.
  //
  // Consequence: as soon as a socket presents an identity, it must present the
  // right token — a foreign/browser socket cannot read the file, so it cannot
  // forge a passing identity here.
  if (input.expectedControlToken && input.identity) {
    const tokenResult = validateControlToken({
      expectedToken: input.expectedControlToken,
      providedToken: input.identity.controlToken,
    });
    if (!tokenResult.ok) {
      return {
        ok: false,
        closeCode: CLOSE_CODE_TOKEN_MISMATCH,
        reason: tokenResult.reason,
      };
    }
  }

  if (!input.expectedPairId) return { ok: true };
  if (!input.identity) {
    return input.allowIdentityless
      ? { ok: true }
      : { ok: false, closeCode: CLOSE_CODE_PAIR_MISMATCH, reason: "missing client identity" };
  }
  if (input.identity.pairId !== input.expectedPairId) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `pair mismatch: expected ${input.expectedPairId}, got ${input.identity.pairId ?? "<none>"}`,
    };
  }
  if (!input.identity.cwd || input.identity.cwd !== input.daemonCwd) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `cwd mismatch: expected ${input.daemonCwd}, got ${input.identity.cwd ?? "<none>"}`,
    };
  }
  return { ok: true };
}

export type InjectionAttachGuardResult =
  | { allowed: true }
  | { allowed: false; code: "not_attached"; reason: string };

/**
 * Attach-convergence guard for claude_to_codex injection (arch-review P1 #283,
 * defense layer 1). ONLY the socket that currently holds the attach slot — i.e.
 * the one that passed `claude_connect` admission (pair/cwd + capability token)
 * and has not been detached/evicted/replaced — may inject a turn into Codex.
 *
 * Pure + reference-identity based so it is unit-testable without a live
 * WebSocket: pass the daemon's `attachedClaude` and the requesting socket; the
 * decision is exactly their identity comparison. `null`/`undefined` attached
 * (no live frontend) always rejects.
 *
 * Generic over the socket type (compared by reference) to avoid importing Bun's
 * ServerWebSocket here; the daemon passes its real sockets, tests pass sentinels.
 */
export function evaluateInjectionAttachGuard<T>(
  attachedSocket: T | null | undefined,
  requestingSocket: T,
): InjectionAttachGuardResult {
  if (attachedSocket != null && attachedSocket === requestingSocket) {
    return { allowed: true };
  }
  return {
    allowed: false,
    code: "not_attached",
    reason:
      "This socket is not the attached Claude session. Send `claude_connect` " +
      "(with a valid control token) and win the attach slot before injecting a turn.",
  };
}
