import { runIdentityProviderContract } from "./identity-contract";
import { PskIdentityProvider } from "../backbone/identity/psk-identity-provider";

runIdentityProviderContract("psk", {
  makeProvider: () =>
    new PskIdentityProvider([
      { token: "tok-123", identity: { id: "alice@x.com", displayName: "Alice" } },
    ]),
  validCredential: "tok-123",
  expected: { id: "alice@x.com", displayName: "Alice" },
  invalidCredential: "wrong-token",
});
