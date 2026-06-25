import type { Envelope } from "./envelope";

/**
 * MessageTransport interface (spec §6.1, §6.2).
 *
 * The pub/sub seam the broker routes envelopes through. Battery impl = in-process
 * event bus (+ WSS fan-out, wired in the broker PR); production impl = NATS /
 * Redis Streams / Kafka behind the same interface. The core depends only on this
 * interface — swapping the driver is a one-line config change.
 */

export type Unsubscribe = () => void;

export interface MessageTransport {
  /** Publish an envelope to a topic (e.g. a room id). */
  publish(topic: string, msg: Envelope): Promise<void>;
  /**
   * Subscribe to a topic. Returns an unsubscribe handle. The handler MUST NOT be
   * invoked after unsubscribe.
   */
  subscribe(topic: string, handler: (msg: Envelope) => void): Unsubscribe;
}
