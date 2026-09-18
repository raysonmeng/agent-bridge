import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTrustedSender,
  listTrustedSenders,
  readTrustedSenders,
  removeTrustedSender,
  trustFilePath,
} from "../room-trust";

describe("room-trust — local, per-room trusted sender list", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-trust-"));
    return join(dir, "collab.db");
  };

  test("the list lives next to collab.db as room-trust.json", () => {
    const dbPath = fresh();
    expect(trustFilePath(dbPath)).toBe(join(dir!, "room-trust.json"));
  });

  test("no file ⇒ nobody is trusted (fail closed)", () => {
    const dbPath = fresh();
    expect(readTrustedSenders("r1", dbPath).size).toBe(0);
    expect(listTrustedSenders(dbPath)).toEqual({});
  });

  test("add → read → remove round-trips; the file is 0600", () => {
    const dbPath = fresh();
    expect(addTrustedSender("r1", "boss@x.com", dbPath)).toBe(true);
    expect(addTrustedSender("r1", "boss@x.com", dbPath)).toBe(false); // idempotent
    expect([...readTrustedSenders("r1", dbPath)]).toEqual(["boss@x.com"]);
    expect(statSync(trustFilePath(dbPath)).mode & 0o777).toBe(0o600);

    expect(removeTrustedSender("r1", "boss@x.com", dbPath)).toBe(true);
    expect(removeTrustedSender("r1", "boss@x.com", dbPath)).toBe(false);
    expect(readTrustedSenders("r1", dbPath).size).toBe(0);
    expect(listTrustedSenders(dbPath)).toEqual({}); // an emptied room is dropped
  });

  test("trust is scoped to one room: trusting in r1 grants nothing in r2", () => {
    const dbPath = fresh();
    addTrustedSender("r1", "boss@x.com", dbPath);
    expect(readTrustedSenders("r2", dbPath).size).toBe(0);
    expect(listTrustedSenders(dbPath)).toEqual({ r1: ["boss@x.com"] });
  });

  test("a malformed file trusts nobody on read, and a write refuses to overwrite it", () => {
    const dbPath = fresh();
    writeFileSync(trustFilePath(dbPath), "{not json", { mode: 0o600 });
    expect(readTrustedSenders("r1", dbPath).size).toBe(0);
    expect(() => addTrustedSender("r1", "boss@x.com", dbPath)).toThrow(/room-trust\.json/);
    expect(readFileSync(trustFilePath(dbPath), "utf8")).toBe("{not json"); // left untouched
  });

  test("a well-formed file with wrong-typed entries only trusts the string ids", () => {
    const dbPath = fresh();
    writeFileSync(
      trustFilePath(dbPath),
      JSON.stringify({ version: 1, rooms: { r1: ["ok@x.com", 42, null, ""], r2: "boss@x.com" } }),
      { mode: 0o600 },
    );
    expect([...readTrustedSenders("r1", dbPath)]).toEqual(["ok@x.com"]);
    expect(readTrustedSenders("r2", dbPath).size).toBe(0);
  });

  test("a room id that names an Object.prototype property (slugify('Constructor') = 'constructor') works like any room", () => {
    const dbPath = fresh();
    addTrustedSender("r1", "a@x.com", dbPath); // the file exists, so lookups hit a parsed object
    expect(readTrustedSenders("constructor", dbPath).size).toBe(0);
    expect(addTrustedSender("constructor", "boss@x.com", dbPath)).toBe(true);
    expect([...readTrustedSenders("constructor", dbPath)]).toEqual(["boss@x.com"]);
    expect(removeTrustedSender("__proto__", "boss@x.com", dbPath)).toBe(false);
    expect(removeTrustedSender("constructor", "boss@x.com", dbPath)).toBe(true);
    expect(listTrustedSenders(dbPath)).toEqual({ r1: ["a@x.com"] });
  });

  test("empty room or agent id is rejected", () => {
    const dbPath = fresh();
    expect(() => addTrustedSender("", "boss@x.com", dbPath)).toThrow();
    expect(() => addTrustedSender("r1", "  ", dbPath)).toThrow();
  });
});
