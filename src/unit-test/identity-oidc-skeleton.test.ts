import { test, expect } from "bun:test";
import { OidcIdentityProvider } from "../backbone/identity/oidc-identity-provider";

test("OidcIdentityProvider.authenticate rejects (production skeleton, §11.3)", async () => {
  await expect(new OidcIdentityProvider().authenticate("x")).rejects.toThrow();
});
