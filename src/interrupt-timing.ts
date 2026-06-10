/**
 * Single source of truth for the interrupt / reply timeout relationship
 * (collaboration-protocol v2, PR B).
 *
 * INVARIANT: the daemon-side interrupt terminal-wait budget MUST resolve
 * (success OR failure) strictly BEFORE the bridge client's reply timeout
 * fires. Otherwise the client reports a FALSE "Timed out waiting for daemon"
 * to Claude WHILE the daemon still proceeds to inject the message and arm
 * requireReply — a Claude retry then causes a DOUBLE turn.
 *
 * The interrupt budget is operator-overridable via
 * AGENTBRIDGE_INTERRUPT_TIMEOUT_MS (parsePositiveIntEnv has NO upper bound),
 * so a large value could otherwise exceed the client timeout. We make the
 * relationship impossible to misconfigure by CLAMPING the effective interrupt
 * budget to at most `CLIENT_REPLY_TIMEOUT_MS - INTERRUPT_CLIENT_MARGIN_MS`.
 * The clamp bounds the worst case regardless of the configured env value, and
 * the margin leaves room for the daemon to send its structured result and for
 * that result to traverse the control WS before the client gives up.
 *
 * Both call sites (daemon-client.sendReply, codex-adapter.waitForTurnsTerminal)
 * reference these constants and document the invariant inline.
 */

/**
 * The bridge client's hard reply timeout for a claude_to_codex round trip.
 * Applies to the daemon's IMMEDIATE result; the interrupt path is the only
 * one that legitimately defers the result (up to the clamped interrupt
 * budget), which is why that budget is clamped below this value.
 */
export const CLIENT_REPLY_TIMEOUT_MS = 15_000;

/**
 * Safety margin reserved below CLIENT_REPLY_TIMEOUT_MS for the daemon to emit
 * its claude_to_codex_result and for that result to reach the client before
 * the client's reply timer fires.
 */
export const INTERRUPT_CLIENT_MARGIN_MS = 2_000;

/** Default interrupt terminal-wait budget when the env override is unset. */
export const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * The largest interrupt budget that still guarantees the daemon answers
 * before the client reply timeout fires. Any configured value at or above
 * this is clamped down to it.
 */
export const MAX_INTERRUPT_TIMEOUT_MS =
  CLIENT_REPLY_TIMEOUT_MS - INTERRUPT_CLIENT_MARGIN_MS;

/**
 * Clamp a (validated, positive) interrupt-timeout value to the safe ceiling.
 * `requested` is assumed already validated by parsePositiveIntEnv (positive
 * integer); this only enforces the upper bound that keeps the double-turn
 * race impossible.
 */
export function clampInterruptTimeoutMs(requested: number): number {
  return Math.min(requested, MAX_INTERRUPT_TIMEOUT_MS);
}
