import { test, expect } from "bun:test";
import { NatsTransport } from "../backbone/transport/nats-transport";
import { makeEnvelope } from "./backbone-fixtures";

test("subscribe throws (skeleton)", () => {
  expect(() => new NatsTransport().subscribe("r", () => {})).toThrow();
});

test("publish rejects (skeleton)", async () => {
  await expect(new NatsTransport().publish("r", makeEnvelope())).rejects.toThrow();
});
