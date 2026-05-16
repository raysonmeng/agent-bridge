#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe, sleep } from "./lib";

void runProbe("p07", async (probe) => {
  const tui = await probe.connectTui(makeToken("p07"), "primary");
  await tui.initializeAndStartThread();

  const chatId = "p07_paired";
  const first = await probe.connectClaude(chatId);
  await first.expectNoDedicatedThreadReady(8_000);
  first.close();
  await sleep(1_000);

  const resumed = await probe.connectClaude(chatId);
  await resumed.expectNoDedicatedThreadReady(5_000);
  const ok = marker("p07-ok");
  const result = await resumed.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true },
  );
  assert(result.success, `reconnected paired reply failed: ${result.error ?? "unknown"}`);
  await tui.waitForAgentMessage(ok, 180_000);
  await resumed.waitForContent(ok, 30_000);
});

