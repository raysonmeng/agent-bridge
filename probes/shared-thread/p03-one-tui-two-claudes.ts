#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe } from "./lib";

void runProbe("p03", async (probe) => {
  const tui = await probe.connectTui(makeToken("p03"), "primary");
  await tui.initializeAndStartThread();

  const paired = await probe.connectClaude("p03_paired");
  await paired.expectNoDedicatedThreadReady(8_000);

  const isolated = await probe.connectClaude("p03_isolated");
  const isolatedThreadId = await isolated.waitForDedicatedThreadReady();
  assert(isolatedThreadId.length > 0, "second Claude did not provision an isolated thread");

  const pairMarker = marker("p03-pair");
  let result = await paired.sendReply(
    `Reply with exactly this marker and nothing else: ${pairMarker}`,
    { requireReply: true },
  );
  assert(result.success, `paired reply failed: ${result.error ?? "unknown"}`);
  await tui.waitForAgentMessage(pairMarker, 180_000);
  await paired.waitForContent(pairMarker, 30_000);
  await isolated.expectNoContent(pairMarker, 5_000);

  const isolatedMarker = marker("p03-isolated");
  result = await isolated.sendReply(
    `Reply with exactly this marker and nothing else: ${isolatedMarker}`,
    { requireReply: true },
  );
  assert(result.success, `isolated reply failed: ${result.error ?? "unknown"}`);
  await isolated.waitForContent(isolatedMarker, 180_000);
  await tui.expectNoAgentMessage(isolatedMarker, 5_000);
  await paired.expectNoContent(isolatedMarker, 5_000);
});

