import type { Store } from "../store";
import type { Identity, IdentityProvider } from "../identity";

/**
 * Store-backed PSK IdentityProvider — the real broker auth driver (§6.2).
 *
 * Resolves a presented token via the Store's persisted (token → identity)
 * bindings issued by `abg auth login`. Unlike the in-memory PskIdentityProvider
 * (seeded at construction), this reads the live Store, so a freshly-issued token
 * authenticates without restarting the broker.
 *
 * Note (security): tokens are stored HASHED at rest (SHA-256, §11.3 — see token-hash.ts); the raw
 * token lives only in the edge's auth-token file (0600). The collab DB file itself is 0644 (bun:sqlite
 * default), so its CONTAINING directory is still locked to 0700 by the writer (`abg auth login`,
 * src/cli/auth.ts) — the identities table holds emails/PII even though the token rows are now digests —
 * the durable equivalent of control-token.ts's 0600 file. The token is an unguessable randomUUID and
 * the link is WireGuard-encrypted over Tailscale (§7).
 */
export class StorePskIdentityProvider implements IdentityProvider {
  constructor(private readonly store: Store) {}

  async authenticate(credential: string): Promise<Identity> {
    const identityId = await this.store.resolveToken(credential);
    if (!identityId) throw new Error("invalid PSK token");
    const identity = await this.store.getIdentity(identityId);
    if (!identity) {
      // The token's identity row was deleted out from under it.
      throw new Error(`token resolved to unknown identity: ${identityId}`);
    }
    return { id: identity.id, displayName: identity.displayName };
  }
}
