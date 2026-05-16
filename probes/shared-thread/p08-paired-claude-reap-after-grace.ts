#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe, sleep } from "./lib";

void runProbe("p08", async (probe) => {
  const tui = await probe.connectTui(makeToken("p08"), "primary");
  await tui.initializeAndStartThread();

  const first = await probe.connectClaude("p08_first");
  await first.expectNoDedicatedThreadReady(8_000);
  first.close();
  await sleep(1_800);

  const second = await probe.connectClaude("p08_second");
  await second.expectNoDedicatedThreadReady(5_000);
  const ok = marker("p08-ok");
  const result = await second.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true },
  );
  assert(result.success, `new paired Claude reply failed after reap: ${result.error ?? "unknown"}`);
  await tui.waitForAgentMessage(ok, 180_000);
  await second.waitForContent(ok, 30_000);
}, { pairReapMs: 1000 });

