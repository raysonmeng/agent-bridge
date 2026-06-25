/**
 * OIDC IdentityProvider — production SSO skeleton (§11.3).
 *
 * Intentionally unimplemented: it exists so the production driver slots into the
 * same IdentityProvider interface, making the swap a one-line config change with
 * zero core change (§6.4). The real implementation exchanges an OIDC code for an
 * id_token and derives `Identity` from verified claims.
 */

import type { Identity, IdentityProvider } from "../identity";

export class OidcIdentityProvider implements IdentityProvider {
  async authenticate(_credential: string): Promise<Identity> {
    throw new Error(
      "OidcIdentityProvider: not implemented — production SSO skeleton (§11.3)",
    );
  }
}
