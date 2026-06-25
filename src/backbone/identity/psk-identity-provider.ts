/**
 * PSK (pre-shared key) IdentityProvider — the §6.2 "battery" driver.
 *
 * A PSK token is broker-signed and bound to ONE identity at issue time. This
 * provider holds the issued (token -> identity) list and resolves a presented
 * credential by constant-time comparison against each issued token.
 *
 * control-token.ts has an equivalent `constantTimeEquals`, but it is module-
 * private (not exported), so we use node:crypto's `timingSafeEqual` directly.
 */

import { timingSafeEqual } from "node:crypto";
import type { Identity, IdentityProvider } from "../identity";

/**
 * Length-independent constant-time string compare. `timingSafeEqual` throws on
 * unequal-length buffers, so on a length mismatch we still run an equal-length
 * compare (a vs a) to keep timing uniform, then fail.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export class PskIdentityProvider implements IdentityProvider {
  private readonly issued: ReadonlyArray<{ token: string; identity: Identity }>;

  constructor(issued: Array<{ token: string; identity: Identity }>) {
    this.issued = [...issued];
  }

  async authenticate(credential: string): Promise<Identity> {
    for (const { token, identity } of this.issued) {
      if (constantTimeEquals(credential, token)) {
        return identity;
      }
    }
    throw new Error("invalid PSK token");
  }
}
