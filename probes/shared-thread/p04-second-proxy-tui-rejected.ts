#!/usr/bin/env bun
import { expectForeignProxyRejected, makeToken, runProbe } from "./lib";

void runProbe("p04", async (probe) => {
  const primary = await probe.connectTui(makeToken("p04_primary"), "primary");
  await primary.initializeAndStartThread();

  const foreignToken = makeToken("p04_foreign");
  await expectForeignProxyRejected(
    probe,
    probe.proxyUrl,
    "foreign-proxy-tui",
    4002,
    { headers: { authorization: `Bearer ${foreignToken}` } },
  );

  // The first TUI should still be usable after rejection.
  await primary.sendRequest("thread/list", {}, 30_000);
});
