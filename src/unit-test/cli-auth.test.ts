import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authIssue, authLogin, authRevoke, installToken } from "../cli/auth";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { IdentityService } from "../backbone/identity-service";

describe("authLogin", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("issues a persisted 0600 token that round-trips via StorePskIdentityProvider", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-auth-"));
    const dbPath = join(dir, "collab.db");

    const result = await authLogin({ id: "alice@x.com", name: "Alice", dbPath });

    // token + identity shape
    expect(result.token).toBeTruthy();
    expect(result.identity).toEqual({ id: "alice@x.com", displayName: "Alice" });

    // token file exists, content matches, and is 0600
    expect(existsSync(result.tokenFile)).toBe(true);
    expect(readFileSync(result.tokenFile, "utf-8")).toBe(result.token);
    expect(statSync(result.tokenFile).mode & 0o777).toBe(0o600);

    // the issued token authenticates back to the same identity
    const store = new SqliteStore(dbPath);
    try {
      const provider = new StorePskIdentityProvider(store);
      const identity = await provider.authenticate(result.token);
      expect(identity).toEqual({ id: "alice@x.com", displayName: "Alice" });
    } finally {
      await store.close();
    }
  });

  it("locks a freshly-created collab DB directory to 0700 (raw tokens + PII at rest)", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-auth-"));
    const collabDir = join(dir, "nested", "collab"); // does not exist yet → mkdirSync creates it
    await authLogin({ id: "bob@x.com", name: "Bob", dbPath: join(collabDir, "collab.db") });
    // collab.db is 0644 (bun:sqlite default), so the directory must block traversal.
    expect(statSync(collabDir).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing loose collab dir to 0700", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-auth-"));
    const collabDir = join(dir, "loose");
    mkdirSync(collabDir);
    chmodSync(collabDir, 0o755); // simulate a world-traversable dir
    await authLogin({ id: "c@x.com", name: "C", dbPath: join(collabDir, "collab.db") });
    expect(statSync(collabDir).mode & 0o777).toBe(0o700);
  });
});

describe("authIssue (broker-side sign)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("issues a broker-verifiable token but does NOT write a local auth-token", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-issue-"));
    const dbPath = join(dir, "collab.db");

    const result = await authIssue({ id: "edge@x.com", name: "Edge", dbPath });

    expect(result.token).toBeTruthy();
    expect(result.identity).toEqual({ id: "edge@x.com", displayName: "Edge" });
    // The token is for SOMEONE ELSE — the broker operator must not adopt it locally.
    expect(existsSync(join(dir, "auth-token"))).toBe(false);
    // dir still locked down (raw token + PII at rest).
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    // The issued token authenticates against the broker's provider.
    const store = new SqliteStore(dbPath);
    try {
      const identity = await new StorePskIdentityProvider(store).authenticate(result.token);
      expect(identity).toEqual({ id: "edge@x.com", displayName: "Edge" });
    } finally {
      await store.close();
    }
  });
});

describe("installToken (edge: abg auth login --token)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes the broker-issued token 0600 without registering/issuing anything", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-install-"));
    const dbPath = join(dir, "collab.db");

    const { tokenFile } = await installToken({ token: "  opaque-broker-token  ", dbPath });

    expect(readFileSync(tokenFile, "utf-8")).toBe("opaque-broker-token"); // trimmed
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // No Store was opened/seeded — the binding lives on the broker, not here.
    expect(existsSync(dbPath)).toBe(false);
    // dir still locked to 0700.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects an empty token (would silently disable auth)", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-install-"));
    const dbPath = join(dir, "collab.db");
    await expect(installToken({ token: "   ", dbPath })).rejects.toThrow(/令牌为空/);
    expect(existsSync(join(dir, "auth-token"))).toBe(false);
  });
});

describe("authRevoke", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("revokes ALL of an identity's tokens so they no longer resolve, reports the count, is idempotent", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-revoke-"));
    const dbPath = join(dir, "collab.db");
    const store = new SqliteStore(dbPath);
    const svc = new IdentityService(store);
    await svc.registerIdentity("alice@x.com", "Alice");
    const t1 = await svc.issueToken("alice@x.com");
    const t2 = await svc.issueToken("alice@x.com");
    await store.close();

    expect((await authRevoke({ id: "alice@x.com", dbPath })).revoked).toBe(2);

    const check = new SqliteStore(dbPath);
    try {
      expect(await check.resolveToken(t1)).toBeNull(); // revoked → no longer authenticates
      expect(await check.resolveToken(t2)).toBeNull();
    } finally {
      await check.close();
    }
    expect((await authRevoke({ id: "alice@x.com", dbPath })).revoked).toBe(0); // nothing left → idempotent
  });
});
