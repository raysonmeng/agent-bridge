import { describe, test, expect } from "bun:test";
import type { Identity, IdentityProvider } from "../backbone/identity";

/**
 * Shared IdentityProvider contract (NOT a *.test.ts).
 *
 * The §6.4 guarantee: every provider — PSK battery, OIDC production, test fake —
 * resolves a valid credential to the SAME `Identity` shape `{ id, displayName }`,
 * and rejects an invalid one. Each driver supplies its own valid/invalid
 * credentials and the expected identity (since the credential format differs per
 * provider), but the asserted shape is identical.
 */
export function runIdentityProviderContract(
  label: string,
  opts: {
    makeProvider: () => IdentityProvider;
    validCredential: string;
    expected: Identity;
    invalidCredential: string;
  },
) {
  describe(`IdentityProvider contract — ${label}`, () => {
    test("resolves a valid credential to the expected {id, displayName}", async () => {
      const id = await opts.makeProvider().authenticate(opts.validCredential);
      expect(id).toEqual(opts.expected);
      // shape invariants the core depends on
      expect(typeof id.id).toBe("string");
      expect(id.id.length).toBeGreaterThan(0);
      expect(typeof id.displayName).toBe("string");
    });

    test("rejects an invalid credential", async () => {
      await expect(opts.makeProvider().authenticate(opts.invalidCredential)).rejects.toThrow();
    });
  });
}
