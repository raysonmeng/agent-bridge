import type { Envelope } from "../envelope";
import type { MessageTransport, Unsubscribe } from "../transport";

/**
 * In-process pub/sub transport (spec §6.1 battery impl). Topic → handler set;
 * publish snapshots the set before fanning out so a handler that (un)subscribes
 * during delivery cannot corrupt the iteration.
 */
export class InProcTransport implements MessageTransport {
  private readonly topics = new Map<string, Set<(m: Envelope) => void>>();

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
    const set = this.topics.get(topic);
    if (set) {
      for (const handler of [...set]) {
        handler(msg);
      }
    }
    return Promise.resolve();
  }
}
