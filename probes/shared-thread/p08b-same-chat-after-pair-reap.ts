#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe, sleep } from "./lib";

void runProbe("p08b", async (probe) => {
  const tui = await probe.connectTui(makeToken("p08b"), "primary");
  await tui.initializeAndStartThread();

  const chatId = "p08b_same_chat";
  const first = await probe.connectClaude(chatId);
  await first.expectNoDedicatedThreadReady(8_000);
  first.close();

  // Probe runs with a shortened pair reap window. After expiry, daemon should
  // fully delete the old ChatState; reconnecting with the same chatId should
  // behave like a fresh attach and claim the still-open proxy TUI slot.
  await sleep(1_800);

  const second = await probe.connectClaude(chatId);
  await second.expectNoDedicatedThreadReady(5_000);

  const ok = marker("p08b-ok");
  const result = await second.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true },
  );
  assert(result.success, `same-chat reattach after pair reap failed: ${result.error ?? "unknown"}`);
  await tui.waitForAgentMessage(ok, 180_000);
  await second.waitForContent(ok, 30_000);
}, { pairReapMs: 1000 });

