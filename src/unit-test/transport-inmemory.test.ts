import { test, expect } from "bun:test";
import { runTransportContract } from "./transport-contract";
import { InMemoryTransport } from "../backbone/transport/in-memory-transport";
import { makeEnvelope } from "./backbone-fixtures";

runTransportContract("in-memory", () => new InMemoryTransport());

test("publish records the envelope in the published log", async () => {
  const t = new InMemoryTransport();
  const env = makeEnvelope({ messageId: "rec-1" });
  await t.publish("r", env);
  expect(t.published).toEqual([env]);
});
