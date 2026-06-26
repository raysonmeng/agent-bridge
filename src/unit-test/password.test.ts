import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../backbone/password";

describe("backbone/password — room-password hashing (§11.2/§11.3)", () => {
  test("hashPassword: scrypt$salt$hash shape, salted (distinct each call), never plaintext", () => {
    const h1 = hashPassword("hunter2");
    const h2 = hashPassword("hunter2");
    expect(h1.split("$")).toHaveLength(3);
    expect(h1.startsWith("scrypt$")).toBe(true);
    expect(h1).not.toContain("hunter2"); // never store plaintext
    expect(h1).not.toBe(h2); // random salt → different hash for the same password
  });

  test("verifyPassword: true for the right password, false for the wrong one", () => {
    const stored = hashPassword("correct horse");
    expect(verifyPassword("correct horse", stored)).toBe(true);
    expect(verifyPassword("correct hors", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
    expect(verifyPassword("CORRECT HORSE", stored)).toBe(false); // case-sensitive
  });

  test("verifyPassword: false (never throws) on any malformed stored value", () => {
    expect(verifyPassword("pw", "")).toBe(false);
    expect(verifyPassword("pw", "not-a-hash")).toBe(false);
    expect(verifyPassword("pw", "scrypt$onlytwo")).toBe(false);
    expect(verifyPassword("pw", "bcrypt$aa$bb")).toBe(false); // wrong scheme
    expect(verifyPassword("pw", "scrypt$zz$zz")).toBe(false); // non-hex / wrong length
    expect(verifyPassword("pw", "scrypt$" + "00".repeat(16) + "$" + "00".repeat(8))).toBe(false); // hash too short
  });

  test("verifyPassword: unicode + long passwords round-trip", () => {
    const pw = "口令🔐 with spaces and 中文 " + "x".repeat(200);
    expect(verifyPassword(pw, hashPassword(pw))).toBe(true);
    expect(verifyPassword(pw + "!", hashPassword(pw))).toBe(false);
  });
});
