import type { BridgeMessage } from "./types";
import type { ConnectionSession } from "./connection-session";
import { BoundedMessageBuffer } from "./delivery-buffer";

export interface RoomManagerDeps {
  /** Max retained backlog messages (MAX_BUFFERED_MESSAGES). */
  bufferedCap: number;
  /** Idle-shutdown grace (IDLE_SHUTDOWN_MS). */
  idleShutdownMs: number;
  /** Claude-disconnect notification grace (CLAUDE_DISCONNECT_GRACE_MS). */
  claudeDisconnectGraceMs: number;
  log: (msg: string) => void;
  /** The live Claude member, resolved at CALL time (never captured at schedule time). */
  getClaude: () => ConnectionSession | null;
  /** Whether the Codex TUI is connected, resolved at CALL time. */
  isTuiConnected: () => boolean;
  /** Self-shutdown trigger (daemon `shutdown(reason)`). */
  onIdleShutdown: (reason: string) => void;
}

/**
 * §2.3–2.4 room layer (1:1 today: a single room with members {claude?, codex}).
 *
 * Owns the room's delivery backlog + the two "Claude slot empty" lifecycle
 * timers (idle-shutdown and disconnect-notification) — formerly the daemon
 * `bufferedMessages` / `idleShutdownTimer` / `claudeDisconnectTimer` singletons.
 * Holds no socket: it resolves the live Claude member through the injected
 * `getClaude()` so timer callbacks always read CURRENT state at fire time, never
 * a value captured when the timer was scheduled. Bodies are moved verbatim from
 * the prior daemon module functions; the daemon keeps the old function names as
 * one-line delegators.
 */
export class RoomManager {
  private readonly backlog: BoundedMessageBuffer;
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RoomManagerDeps) {
    this.backlog = new BoundedMessageBuffer({
      cap: deps.bufferedCap,
      overflowLabel: "Message buffer overflow",
      log: deps.log,
    });
  }

  /** Current backlog depth (for status diagnostics). */
  get backlogSize(): number {
    return this.backlog.length;
  }

  /**
   * Deliver to the live Claude member; on no-member / not-OPEN / failed send,
   * buffer for redelivery on the next attach (formerly `emitToClaude`).
   */
  deliverToClaude(message: BridgeMessage): void {
    const claude = this.deps.getClaude();
    if (claude && claude.isOpen) {
      if (claude.send(message)) return;
      // Send failed — fall through to buffer
      this.deps.log("Send to Claude failed, buffering message for retry on reconnect");
    }
    this.backlog.push(message);
  }

  /**
   * Drain the backlog to a (re)attached session, re-buffering the tail on the
   * first send failure (formerly `flushBufferedMessages`). Positional index, not
   * indexOf: identity lookup would break the count if a message were enqueued
   * twice. The buffer is empty here (just drained), so re-applying cap on the
   * prepend is a provable no-op — count is preserved bit-exactly.
   */
  flushBacklog(session: ConnectionSession): void {
    const messages = this.backlog.drainAll();
    for (let i = 0; i < messages.length; i++) {
      if (!session.send(messages[i]!)) {
        const remaining = messages.slice(i);
        this.backlog.unshiftMany(remaining);
        this.deps.log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
        return;
      }
    }
  }

  /**
   * Detach: move the session's backpressured (un-drained) messages into the
   * backlog so they are redelivered on reconnect. Returns the count moved.
   */
  rebufferOnDetach(session: ConnectionSession): number {
    return session.drainPendingBackpressureInto(this.backlog);
  }

  scheduleIdleShutdown(): void {
    this.cancelIdleShutdown();
    if (this.deps.getClaude()) return; // still has a client
    if (this.deps.isTuiConnected()) return; // TUI still connected

    this.deps.log(
      `No clients connected. Daemon will shut down in ${this.deps.idleShutdownMs}ms if no one reconnects.`,
    );
    this.idleShutdownTimer = setTimeout(() => {
      // Re-check CURRENT state before shutting down (never the scheduled-time value).
      if (this.deps.getClaude() || this.deps.isTuiConnected()) {
        this.deps.log("Idle shutdown cancelled: client reconnected during grace period");
        return;
      }
      this.deps.onIdleShutdown("idle — no clients connected");
    }, this.deps.idleShutdownMs);
  }

  cancelIdleShutdown(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
  }

  clearPendingClaudeDisconnect(reason?: string): void {
    if (!this.claudeDisconnectTimer) return;
    clearTimeout(this.claudeDisconnectTimer);
    this.claudeDisconnectTimer = null;
    if (reason) {
      this.deps.log(`Cleared pending Claude disconnect notification (${reason})`);
    }
  }

  scheduleClaudeDisconnectNotification(clientId: number): void {
    this.clearPendingClaudeDisconnect("rescheduled");
    this.claudeDisconnectTimer = setTimeout(() => {
      this.claudeDisconnectTimer = null;

      if (this.deps.getClaude()) {
        this.deps.log(
          `Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`,
        );
        return;
      }

      // Runtime offline events are no longer injected into Codex: the only channel
      // (turn/start) pollutes the Codex thread/title and can trigger spurious
      // responses. Logged for ops; Codex simply receives no further messages until
      // Claude reconnects (the static collaboration context lives in AGENTS.md).
      this.deps.log(`Claude disconnect persisted past grace window (client #${clientId})`);
    }, this.deps.claudeDisconnectGraceMs);
  }
}
