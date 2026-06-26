/**
 * Token revocation (§11.3): `abg auth revoke` deletes an identity's token bindings, so a presented
 * (now-revoked) token no longer authenticates at the broker. Auth is checked at hello, so an
 * already-open connection persists until it drops — pair revoke with `abg room remove` to evict a live
 * session (membership is re-checked on delivery). This test pins both the rejection and the limitation.
 */

import { describe, test, expect } from "bun:test";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";

describe("token revoke (§11.3) — broker rejects a revoked token on reconnect", () => {
  test("valid before revoke; a NEW connection with the revoked token is rejected; the live one persists", async () => {
    const store = new InMemoryStore();
    const svc = new IdentityService(store);
    await svc.registerIdentity("bob@x.com", "Bob");
    const token = await svc.issueToken("bob@x.com");
    const broker = new Broker({
      store,
      identityProvider: new StorePskIdentityProvider(store),
      host: "127.0.0.1",
      port: 0,
      log: () => {},
    });
    const { port } = broker.start();
    const url = `ws://127.0.0.1:${port}/ws`;
    const live = new BrokerClient({ url, token, log: () => {} });
    try {
      expect(await live.connect()).toEqual({ id: "bob@x.com", displayName: "Bob" }); // valid before revoke

      expect(await svc.revokeTokens("bob@x.com")).toBe(1); // operator runs `abg auth revoke --id bob@x.com`

      // A fresh connection with the now-revoked token authenticates against the store → not found → reject.
      const reconnect = new BrokerClient({ url, token, log: () => {} });
      try {
        await expect(reconnect.connect()).rejects.toThrow();
      } finally {
        reconnect.close();
      }
      // The already-open connection stays authenticated (auth is hello-only) — the documented limitation.
      expect(live.connected).toBe(true);
    } finally {
      live.close();
      broker.stop();
      await store.close();
    }
  });
});
