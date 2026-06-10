import type { BridgeMessage } from "./types";

/**
 * Bounded FIFO buffer for bridge messages awaiting delivery to Claude.
 *
 * Encapsulates the "append / prepend, then trim to cap and log the overflow"
 * pattern that #101 hardened across three daemon call sites (the module-level
 * delivery backlog, the detach re-buffer, and the per-socket backpressure
 * tracker). Centralising it here means the not-lost-but-bounded invariant is
 * stated once and can be unit-tested directly instead of only through a
 * live-WS harness.
 *
 * Semantics (bit-exact with the prior inline daemon code):
 *  - cap defaults to MAX_BUFFERED_MESSAGES; when the buffer grows past cap the
 *    OLDEST messages are dropped (splice from the front) and a single overflow
 *    line is logged with the per-instance label + dropped count + remaining cap.
 *  - `push` appends to the tail (newest), `unshiftMany` prepends to the head
 *    (these messages predate everything already buffered) — both re-apply cap.
 *  - `drainAll` removes and returns every message in order, leaving the buffer
 *    empty.
 *
 * The class is pure aside from the injected `log` sink, so tests can assert the
 * exact overflow text and counts without a daemon/WS.
 */
export interface BoundedMessageBufferOptions {
  /** Max retained messages; overflow drops the oldest. */
  cap: number;
  /**
   * Prefix for the overflow log line, e.g. "Message buffer overflow" or
   * "Backpressure overflow".
   */
  overflowLabel: string;
  /**
   * Noun phrase describing the dropped items. Defaults to "message(s)";
   * the backpressure tracker uses "tracked message(s)" to keep its log
   * line bit-exact with the prior inline code.
   */
  overflowNoun?: string;
  /** Log sink (injected for testability). */
  log: (msg: string) => void;
}

export class BoundedMessageBuffer {
  private readonly messages: BridgeMessage[] = [];
  private readonly cap: number;
  private readonly overflowLabel: string;
  private readonly overflowNoun: string;
  private readonly log: (msg: string) => void;

  constructor(options: BoundedMessageBufferOptions) {
    this.cap = options.cap;
    this.overflowLabel = options.overflowLabel;
    this.overflowNoun = options.overflowNoun ?? "message(s)";
    this.log = options.log;
  }

  /** Current retained message count. */
  get length(): number {
    return this.messages.length;
  }

  /** Append one message to the tail (newest), then enforce the cap. */
  push(message: BridgeMessage): void {
    this.messages.push(message);
    this.enforceCap();
  }

  /**
   * Prepend messages to the head (they predate everything already buffered),
   * preserving their relative order, then enforce the cap.
   */
  unshiftMany(messages: BridgeMessage[]): void {
    if (messages.length === 0) return;
    this.messages.unshift(...messages);
    this.enforceCap();
  }

  /** Remove and return every message in FIFO order, leaving the buffer empty. */
  drainAll(): BridgeMessage[] {
    return this.messages.splice(0, this.messages.length);
  }

  /** Discard all messages without returning them (drain-confirmation path). */
  clear(): void {
    this.messages.length = 0;
  }

  private enforceCap(): void {
    if (this.messages.length > this.cap) {
      const dropped = this.messages.length - this.cap;
      this.messages.splice(0, dropped);
      this.log(
        `${this.overflowLabel}: dropped ${dropped} oldest ${this.overflowNoun}, ${this.cap} remaining`,
      );
    }
  }
}
