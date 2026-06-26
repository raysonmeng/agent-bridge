/**
 * Room-password hashing (§11.2 self-service join, §11.3 at-rest hardening).
 *
 * A room may carry an OPTIONAL password so an already-authenticated identity can add
 * itself (`abg join --password`) without a member running `abg room add`. The password
 * is a SHARED room secret, so it is never stored in plaintext — only a salted scrypt
 * derivation lives in the broker's Store. scrypt is memory-hard (brute-force resistant);
 * the broker additionally throttles attempts per connection.
 *
 * Format: `scrypt$<saltHex>$<hashHex>` — self-describing so the params can evolve.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCHEME = "scrypt";
const N = 16384; // CPU/memory cost 2^14 — interactive-login appropriate (~tens of ms), ~16MB < node's 32MB maxmem
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_LEN = 16;

/** Hash a room password for at-rest storage. Returns `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `${SCHEME}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Constant-time verify `plain` against a stored `scrypt$salt$hash`. Returns false on ANY
 * malformed/unparseable stored value or scheme mismatch (never throws) — a corrupt hash
 * must read as "wrong password", not crash the broker's join handler.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== SCHEME) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1]!, "hex");
    expected = Buffer.from(parts[2]!, "hex");
  } catch {
    return false;
  }
  // A truncated hex string yields a SHORTER buffer (Buffer.from is lenient), so length-check
  // both halves before deriving — a wrong length is a malformed record, not a wrong password.
  if (salt.length !== SALT_LEN || expected.length !== KEYLEN) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
