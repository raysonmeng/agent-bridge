import { runIdentityProviderContract } from "./identity-contract";
import { FakeIdentityProvider } from "../backbone/identity/fake-identity-provider";

runIdentityProviderContract("fake", {
  makeProvider: () =>
    new FakeIdentityProvider({
      "cred-bob": { id: "bob@x.com", displayName: "Bob" },
    }),
  validCredential: "cred-bob",
  expected: { id: "bob@x.com", displayName: "Bob" },
  invalidCredential: "nope",
});
