#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe, sleep } from "./lib";

void runProbe("p09", async (probe) => {
  const tui = await probe.connectTui(makeToken("p09"), "primary");
  await tui.initializeAndStartThread();
  const claude = await probe.connectClaude("p09_paired");
  await claude.expectNoDedicatedThreadReady(8_000);

  tui.close();
  await claude.waitForContent("Shared Codex TUI thread is gone", 30_000);
  const threadId = await claude.waitForDedicatedThreadReady(90_000);
  assert(threadId.length > 0, "paired Claude did not transition to a fresh isolated thread");

  const ok = marker("p09-ok");
  const result = await claude.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true },
  );
  assert(result.success, `isolated reply after TUI disconnect failed: ${result.error ?? "unknown"}`);
  await claude.waitForContent(ok, 180_000);
  await sleep(500);
});

