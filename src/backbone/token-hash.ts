import { createHash } from "node:crypto";

/**
 * Hash a PSK token for at-rest storage (§11.3). The token is a 128-bit random UUID (high entropy),
 * so a fast cryptographic hash (SHA-256) is the right primitive: a DB leak then exposes only
 * irreversible digests, while `resolveToken` stays a cheap hash+lookup on the broker's hot auth path.
 *
 * Unlike a low-entropy ROOM PASSWORD (which needs the memory-hard scrypt in password.ts to resist
 * guessing), a token has no guessing surface — brute-forcing 128 bits of randomness is infeasible — so
 * a single SHA-256 is sufficient and far cheaper. The raw token lives only in the edge's auth-token
 * file (0600); the Store holds the hash.
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** True iff `s` already looks like a {@link hashToken} digest (64 lowercase hex) — drives the migration. */
export function looksHashedToken(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
