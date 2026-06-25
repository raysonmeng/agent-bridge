import type { Envelope } from "../envelope";
import type { MessageTransport, Unsubscribe } from "../transport";

/**
 * Production transport skeleton (spec §11.3). NATS / Redis Streams / Kafka would
 * implement the same MessageTransport interface; this placeholder throws until
 * the driver is wired, so an accidental production swap fails loudly.
 */
export class NatsTransport implements MessageTransport {
  async publish(_topic: string, _msg: Envelope): Promise<void> {
    throw new Error("NatsTransport: not implemented — production transport skeleton (§11.3)");
  }

  subscribe(_topic: string, _handler: (msg: Envelope) => void): Unsubscribe {
    throw new Error("NatsTransport: not implemented — production transport skeleton (§11.3)");
  }
}
