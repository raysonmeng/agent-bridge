/**
 * IdentityProvider interface (spec §6.1, §6.3).
 *
 * Authentication here is ROUTING data, not abstract security: event signing, DM
 * targeting, room membership and presence all need a stable identity. The core
 * depends only on this interface and only ever uses `Identity.id` — never the
 * token, never the display name (§6.4). Battery impl = broker-signed PSK; the
 * production impl (OIDC/SAML) must produce the SAME `Identity` shape so swapping
 * the driver is a one-line config change with zero core change.
 */

export interface Identity {
  /** Globally unique, machine-generated/derived (email or GitHub name, §2.2). */
  id: string;
  /** Display only; may collide; routing never uses it. */
  displayName: string;
}

export interface IdentityProvider {
  /**
   * Resolve a credential (PSK token / OIDC code / …) to a collaboration identity.
   * Rejects (throws) on an invalid credential.
   */
  authenticate(credential: string): Promise<Identity>;
}
