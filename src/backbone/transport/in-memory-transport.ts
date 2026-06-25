import type { Envelope } from "../envelope";
import type { MessageTransport, Unsubscribe } from "../transport";

/**
 * In-memory transport test double. Same contract as InProcTransport, plus a
 * `published` log every publish appends to — the introspection point for tests
 * that assert what was emitted.
 */
export class InMemoryTransport implements MessageTransport {
  private readonly topics = new Map<string, Set<(m: Envelope) => void>>();
  readonly published: Envelope[] = [];

  subscribe(topic: string, handler: (msg: Envelope) => void): Unsubscribe {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  publish(topic: string, msg: Envelope): Promise<void> {
    this.published.push(msg);
    const set = this.topics.get(topic);
    if (set) {
      for (const handler of [...set]) {
        handler(msg);
      }
    }
    return Promise.resolve();
  }
}
