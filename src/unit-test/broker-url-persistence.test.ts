import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_BROKER_URL,
  resolveBrokerUrl,
  readPersistedBrokerUrl,
  writeBrokerUrl,
} from "../collab-store";

// `abg join --broker-url` persists the broker address next to the collab DB so the daemon auto-connects
// without AGENTBRIDGE_BROKER_URL. These tests pin the resolution precedence + the write/read round-trip.
describe("broker-url persistence", () => {
  let dir: string;
  let dbPath: string;
  const savedEnv = process.env.AGENTBRIDGE_BROKER_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-brokerurl-"));
    dbPath = join(dir, "collab.db");
    delete process.env.AGENTBRIDGE_BROKER_URL;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.AGENTBRIDGE_BROKER_URL;
    else process.env.AGENTBRIDGE_BROKER_URL = savedEnv;
  });

  test("write then read round-trips the URL", () => {
    expect(readPersistedBrokerUrl(dbPath)).toBeNull();
    writeBrokerUrl(dbPath, "ws://100.92.1.10:4700/ws");
    expect(readPersistedBrokerUrl(dbPath)).toBe("ws://100.92.1.10:4700/ws");
  });

  test("persisted URL is used when no env var (the footgun fix)", () => {
    writeBrokerUrl(dbPath, "ws://100.92.1.10:4700/ws");
    expect(resolveBrokerUrl(undefined, dbPath)).toBe("ws://100.92.1.10:4700/ws");
  });

  test("precedence: explicit > env > persisted > default", () => {
    writeBrokerUrl(dbPath, "ws://persisted:4700/ws");
    // explicit beats everything
    process.env.AGENTBRIDGE_BROKER_URL = "ws://env:4700/ws";
    expect(resolveBrokerUrl("ws://explicit:4700/ws", dbPath)).toBe("ws://explicit:4700/ws");
    // env beats persisted
    expect(resolveBrokerUrl(undefined, dbPath)).toBe("ws://env:4700/ws");
    // persisted beats default
    delete process.env.AGENTBRIDGE_BROKER_URL;
    expect(resolveBrokerUrl(undefined, dbPath)).toBe("ws://persisted:4700/ws");
  });

  test("falls back to local default when nothing is configured", () => {
    expect(resolveBrokerUrl(undefined, dbPath)).toBe(DEFAULT_BROKER_URL);
    // no dbPath at all keeps the legacy env-or-default shape
    expect(resolveBrokerUrl()).toBe(DEFAULT_BROKER_URL);
  });
});
