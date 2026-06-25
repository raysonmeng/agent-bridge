/**
 * Fake IdentityProvider — a test double (§6.4 contract conformance).
 *
 * Maps a credential string directly to an Identity, producing the SAME
 * `{ id, displayName }` shape as the PSK and OIDC drivers so the core sees no
 * difference. No crypto: lookups are plain map hits.
 */

import type { Identity, IdentityProvider } from "../identity";

export class FakeIdentityProvider implements IdentityProvider {
  private readonly mapping: Map<string, Identity>;

  constructor(mapping: Record<string, Identity> | Map<string, Identity>) {
    this.mapping =
      mapping instanceof Map ? new Map(mapping) : new Map(Object.entries(mapping));
  }

  async authenticate(credential: string): Promise<Identity> {
    const identity = this.mapping.get(credential);
    if (!identity) {
      throw new Error("invalid fake credential");
    }
    return identity;
  }
}
