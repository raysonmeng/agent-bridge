import {
  CLOSE_CODE_CONTRACT_MISMATCH,
  CLOSE_CODE_PAIR_MISMATCH,
  CLOSE_CODE_TOKEN_MISMATCH,
  type ControlClientIdentity,
} from "./control-protocol";
import { validateControlToken } from "./control-token";
import { sameCwd } from "./cwd-identity";

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
  /**
   * The daemon's control-protocol contract version (arch-review P1 #303, from
   * BUILD_INFO.contractVersion). When set, an identity-carrying client MUST echo
   * the SAME contractVersion or it is rejected with CLOSE_CODE_CONTRACT_MISMATCH
   * (4006) — a missing or mismatched version means the frontend/daemon were
   * built from incompatible protocol snapshots and would silently drift.
   *
   * Compat (mirrors the token gate): undefined disables the contract gate (an
   * older daemon that never negotiated a contract); and an identity-LESS client
   * (legacy / AGENTBRIDGE_COMPAT_IDENTITYLESS) is exempt because it carries no
   * version to negotiate — the identityless admit paths below stay intact. The
   * check runs LAST (after pair/cwd → 4004 and token → 4005) so a token error is
   * never masked as a contract error.
   */
  expectedContractVersion?: number;
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

  // Legacy mode (no pairId enforcement): pair/cwd are not checked, but an
  // identity-carrying client still negotiates the contract (and already cleared
  // the token gate above). An identityless legacy client carries no version to
  // negotiate, so it is admitted unchanged.
  if (!input.expectedPairId) {
    return input.identity ? validateContractVersion(input) : { ok: true };
  }
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
  if (!input.identity.cwd || !sameCwd(input.identity.cwd, input.daemonCwd)) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `cwd mismatch: expected ${input.daemonCwd}, got ${input.identity.cwd ?? "<none>"}`,
    };
  }
  // Contract-version gate (P1 #303) runs LAST — after pair/cwd (4004) and the
  // token gate (4005) above — so a token/pair error is never mislabeled 4006.
  return validateContractVersion(input);
}

/**
 * Contract-version gate (arch-review P1 #303). Only reached for identity-
 * carrying clients that have already cleared the token + pair/cwd gates. When
 * the daemon advertises a contract (expectedContractVersion set), the client's
 * identity MUST echo the exact same version; a missing or mismatched version is
 * rejected with CLOSE_CODE_CONTRACT_MISMATCH (4006). expectedContractVersion
 * undefined disables the gate (older daemon that never negotiated a contract).
 */
function validateContractVersion(
  input: ClaudeIdentityValidationInput,
): ClaudeIdentityValidationResult {
  if (input.expectedContractVersion === undefined) return { ok: true };
  const provided = input.identity?.contractVersion;
  if (provided === undefined || provided === null) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_CONTRACT_MISMATCH,
      reason: `missing contract version: daemon speaks contract v${input.expectedContractVersion}`,
    };
  }
  if (provided !== input.expectedContractVersion) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_CONTRACT_MISMATCH,
      reason: `contract version mismatch: daemon v${input.expectedContractVersion}, client v${provided}`,
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
