import { describe, test, expect } from "bun:test";
import type { MessageTransport } from "../backbone/transport";
import { makeEnvelope } from "./backbone-fixtures";

/**
 * Shared MessageTransport contract (NOT a *.test.ts). Every transport impl passes
 * the identical suite: topic-scoped delivery, unsubscribe stops delivery, and
 * multiple subscribers on a topic all receive.
 */
export function runTransportContract(label: string, makeTransport: () => MessageTransport) {
  describe(`MessageTransport contract — ${label}`, () => {
    test("subscribe receives published envelopes on its topic only", async () => {
      const t = makeTransport();
      const got: string[] = [];
      const unsub = t.subscribe("room-1", (m) => got.push(m.messageId));
      await t.publish("room-1", makeEnvelope({ messageId: "m1" }));
      await t.publish("room-2", makeEnvelope({ roomId: "room-2", messageId: "x" }));
      expect(got).toEqual(["m1"]);
      unsub();
    });

    test("unsubscribe stops delivery", async () => {
      const t = makeTransport();
      const got: string[] = [];
      const unsub = t.subscribe("r", (m) => got.push(m.messageId));
      unsub();
      await t.publish("r", makeEnvelope());
      expect(got).toEqual([]);
    });

    test("multiple subscribers on a topic all receive", async () => {
      const t = makeTransport();
      const a: string[] = [];
      const b: string[] = [];
      t.subscribe("r", (m) => a.push(m.messageId));
      t.subscribe("r", (m) => b.push(m.messageId));
      await t.publish("r", makeEnvelope({ messageId: "z" }));
      expect(a).toEqual(["z"]);
      expect(b).toEqual(["z"]);
    });

    test("one subscriber's unsubscribe does not affect the other", async () => {
      const t = makeTransport();
      const a: string[] = [];
      const b: string[] = [];
      const unsubA = t.subscribe("r", (m) => a.push(m.messageId));
      t.subscribe("r", (m) => b.push(m.messageId));
      unsubA();
      await t.publish("r", makeEnvelope({ messageId: "z" }));
      expect(a).toEqual([]);
      expect(b).toEqual(["z"]);
    });
  });
}
