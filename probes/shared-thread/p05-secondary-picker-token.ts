#!/usr/bin/env bun
import { assert, expectForeignProxyRejected, makeToken, runProbe } from "./lib";

void runProbe("p05", async (probe) => {
  const token = makeToken("p05");
  const primary = await probe.connectTui(token, "primary");
  await primary.initializeAndStartThread();

  const secondary = await probe.connectTui(token, "secondary-picker");
  await secondary.sendRequest("initialize", {
    clientInfo: { name: "agentbridge-probe-secondary-picker", version: "0.0.1" },
  }, 30_000);
  secondary.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  const listResponse = await secondary.sendRequest("thread/list", {}, 30_000);
  assert(listResponse.result !== undefined, "same-token secondary picker did not receive thread/list response");

  const foreignToken = makeToken("p05_foreign");
  await expectForeignProxyRejected(
    probe,
    probe.proxyUrl,
    "foreign-token-after-secondary",
    4002,
    { headers: { authorization: `Bearer ${foreignToken}` } },
  );

  const log = probe.daemonLog();
  probe.log(
    log.includes("Secondary") || log.includes("secondary")
      ? "daemon log contains secondary-connection evidence"
      : "daemon log did not include a secondary marker; WS behavior still proved same-token acceptance",
  );
});
