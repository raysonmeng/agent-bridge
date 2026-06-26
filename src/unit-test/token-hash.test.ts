import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, looksHashedToken } from "../backbone/token-hash";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { InMemoryStore } from "../backbone/store/memory-store";

describe("backbone/token-hash (§11.3 at-rest token hashing)", () => {
  test("hashToken: deterministic 64-hex SHA-256, never the raw token", () => {
    const raw = "11111111-2222-3333-4444-555555555555";
    const h = hashToken(raw);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashToken(raw)); // deterministic
    expect(h).not.toContain(raw); // irreversible digest, not the plaintext
    expect(hashToken("other")).not.toBe(h);
  });

  test("looksHashedToken: a digest yes, a raw UUID / empty no", () => {
    expect(looksHashedToken(hashToken("x"))).toBe(true);
    expect(looksHashedToken("11111111-2222-3333-4444-555555555555")).toBe(false);
    expect(looksHashedToken("")).toBe(false);
  });

  for (const impl of [
    { name: "SqliteStore", mk: (dir: string) => new SqliteStore(join(dir, "collab.db")) },
    { name: "InMemoryStore", mk: (_dir: string) => new InMemoryStore() },
  ]) {
    test(`${impl.name}: stores the token HASHED, resolves by raw, revoke deletes by identity`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "abg-tokh-"));
      const store = impl.mk(dir);
      try {
        await store.issueToken("raw-token-abc", "alice@x.com");
        // at-rest: the persisted value is the hash, never the raw token
        expect(await store.listTokens()).toEqual([{ token: hashToken("raw-token-abc"), identityId: "alice@x.com" }]);
        // resolve still works when the RAW token is presented (the edge holds the raw token)
        expect(await store.resolveToken("raw-token-abc")).toBe("alice@x.com");
        expect(await store.resolveToken("wrong")).toBeNull();
        // revoke removes ALL of the identity's tokens and reports the count
        await store.issueToken("raw-token-2", "alice@x.com");
        expect(await store.revokeTokens("alice@x.com")).toBe(2);
        expect(await store.resolveToken("raw-token-abc")).toBeNull();
        expect(await store.resolveToken("raw-token-2")).toBeNull();
        expect(await store.revokeTokens("alice@x.com")).toBe(0); // idempotent — nothing left
      } finally {
        await store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("SqliteStore: migrates a legacy RAW token row to a hash on reopen, still resolves by raw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abg-tokmig-"));
    const dbPath = join(dir, "collab.db");
    try {
      new SqliteStore(dbPath).close(); // create the schema, then close
      // simulate a pre-§11.3 DB: a RAW token written directly (the old issueToken stored plaintext)
      const raw = new Database(dbPath);
      raw.query("INSERT INTO auth_tokens(token, identity_id) VALUES(?, ?)").run("legacy-raw-uuid", "bob@x.com");
      raw.close();

      // reopen → the constructor migration re-hashes the legacy row in place
      const store = new SqliteStore(dbPath);
      try {
        expect(await store.listTokens()).toEqual([{ token: hashToken("legacy-raw-uuid"), identityId: "bob@x.com" }]);
        expect(await store.resolveToken("legacy-raw-uuid")).toBe("bob@x.com"); // still authenticates by raw
      } finally {
        await store.close();
      }
      // reopen a SECOND time: the already-hashed row must be left untouched (migration is idempotent)
      const again = new SqliteStore(dbPath);
      try {
        expect(await again.listTokens()).toEqual([{ token: hashToken("legacy-raw-uuid"), identityId: "bob@x.com" }]);
        expect(await again.resolveToken("legacy-raw-uuid")).toBe("bob@x.com");
      } finally {
        await again.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
