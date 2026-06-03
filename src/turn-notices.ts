/**
 * Pure helpers for the user-facing notices the daemon emits around Codex turn
 * lifecycle events. Kept side-effect-free so the wording and the
 * skip/include decisions are unit-testable without the daemon's top-level wiring.
 */

/**
 * `turnAborted` reasons that represent an INTENTIONAL, recoverable teardown by
 * AgentBridge itself — not a user-visible failure. Emitting a "the turn died"
 * notice for these would be noise or, worse, contradict a simultaneous notice:
 *
 *  - ADAPTER_DISCONNECT: the daemon is stopping (`CodexAdapter.disconnect`).
 *  - APP_SERVER_RECONNECT_NEW_TUI: a new TUI session deliberately closes the old
 *    app-server WS and reconnects to resume (`reconnectAppServerForNewSession`).
 *    The user is told "✅ Codex TUI reconnected" on this path — a parallel
 *    "⚠️ turn ended, retry" would directly contradict it.
 *
 * These string constants are the SINGLE SOURCE OF TRUTH: codex-adapter.ts passes
 * them to `resetTurnState`, so the skip set here can never silently drift from
 * the emitter. Other reasons (e.g. "app-server connection closed" = an
 * unexpected upstream drop such as a 429, or an injected-turn rejection) are
 * genuine failures and DO surface a notice.
 */
export const ADAPTER_DISCONNECT_REASON = "adapter disconnect";
export const APP_SERVER_RECONNECT_NEW_TUI_REASON = "app-server reconnect for new TUI session";

const SILENT_ABORT_REASONS: ReadonlySet<string> = new Set([
  ADAPTER_DISCONNECT_REASON,
  APP_SERVER_RECONNECT_NEW_TUI_REASON,
]);

/**
 * Build the Claude-facing notice for an abnormally-ended Codex turn, or `null`
 * when the abort is an intentional/recoverable teardown that should stay silent.
 *
 * A turn that was in progress already produced a "⏳ Codex is working" notice;
 * without a matching close signal Claude (and the user) is left waiting forever
 * when Codex hits an error (e.g. a rate-limit 429), the app-server connection
 * drops, or the turn is interrupted. This notice is the symmetric counterpart
 * to the turn-completed / turn-stalled notices.
 */
export function buildTurnAbortedNotice(
  reason: string,
  replyWasRequired: boolean,
): string | null {
  if (SILENT_ABORT_REASONS.has(reason)) return null;

  const tail = replyWasRequired
    ? " A reply you were waiting on will NOT arrive — retry your last message, or wait for the Codex TUI to reconnect."
    : " If you were waiting on a reply it will not arrive; retry, or wait for the Codex TUI to reconnect.";

  return (
    `⚠️ Codex's current turn ended without completing (${reason}). ` +
    "This usually means Codex hit an error (e.g. a rate limit / 429), the app-server connection dropped, or the turn was interrupted." +
    tail
  );
}
