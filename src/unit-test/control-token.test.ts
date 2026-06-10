import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_TOKEN_FILENAME,
  generateControlToken,
  readControlToken,
  resolveControlTokenPath,
  validateControlToken,
  writeControlToken,
} from "../control-token";

describe("control-token", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abg-control-token-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolveControlTokenPath nests the token under the state dir", () => {
    expect(resolveControlTokenPath(dir)).toBe(join(dir, CONTROL_TOKEN_FILENAME));
  });

  test("generateControlToken produces a non-trivial, unique-per-call token", () => {
    const a = generateControlToken();
    const b = generateControlToken();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b); // randomUUID collision is astronomically unlikely
  });

  test("writeControlToken writes the token and round-trips via readControlToken", () => {
    const path = resolveControlTokenPath(dir);
    const token = generateControlToken();
    writeControlToken(path, token);
    expect(readControlToken(path)).toBe(token);
    // On-disk bytes are exactly the token (no trailing newline added).
    expect(readFileSync(path, "utf-8")).toBe(token);
  });

  test("writeControlToken enforces 0600 owner-only permissions", () => {
    const path = resolveControlTokenPath(dir);
    writeControlToken(path, generateControlToken());
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writeControlToken re-tightens a pre-existing world-readable file to 0600", () => {
    const path = resolveControlTokenPath(dir);
    // Simulate a stale, loosely-permissioned token left behind by an old build.
    writeFileSync(path, "stale-token", { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);

    const fresh = generateControlToken();
    writeControlToken(path, fresh);
    expect(readControlToken(path)).toBe(fresh);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("readControlToken returns null for a missing file", () => {
    expect(readControlToken(resolveControlTokenPath(dir))).toBeNull();
    expect(existsSync(resolveControlTokenPath(dir))).toBe(false);
  });

  test("readControlToken trims trailing whitespace/newline so any writer compares equal", () => {
    const path = resolveControlTokenPath(dir);
    writeFileSync(path, "tok-with-newline\n");
    expect(readControlToken(path)).toBe("tok-with-newline");
  });

  test("readControlToken returns null for an empty/whitespace-only file", () => {
    const path = resolveControlTokenPath(dir);
    writeFileSync(path, "   \n");
    expect(readControlToken(path)).toBeNull();
  });
});

describe("validateControlToken", () => {
  test("disabled (no expected token) always passes — compat / degraded", () => {
    expect(validateControlToken({ expectedToken: null, providedToken: undefined }).ok).toBe(true);
    expect(validateControlToken({ expectedToken: "", providedToken: "anything" }).ok).toBe(true);
    // Even a wrong/absent provided token passes when enforcement is off.
    expect(validateControlToken({ expectedToken: null, providedToken: "wrong" }).ok).toBe(true);
  });

  test("expected token present but provided missing → reject", () => {
    const r1 = validateControlToken({ expectedToken: "secret", providedToken: undefined });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("missing control token");

    const r2 = validateControlToken({ expectedToken: "secret", providedToken: "" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("missing control token");

    const r3 = validateControlToken({ expectedToken: "secret", providedToken: null });
    expect(r3.ok).toBe(false);
  });

  test("mismatched provided token → reject", () => {
    const r = validateControlToken({ expectedToken: "secret", providedToken: "guess" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control token mismatch");
  });

  test("a near-miss (prefix / length-off) token → reject", () => {
    expect(validateControlToken({ expectedToken: "secret", providedToken: "secre" }).ok).toBe(false);
    expect(validateControlToken({ expectedToken: "secret", providedToken: "secretx" }).ok).toBe(false);
    expect(validateControlToken({ expectedToken: "secret", providedToken: "Secret" }).ok).toBe(false);
  });

  test("exact match → pass", () => {
    const token = generateControlToken();
    expect(validateControlToken({ expectedToken: token, providedToken: token }).ok).toBe(true);
  });
});
