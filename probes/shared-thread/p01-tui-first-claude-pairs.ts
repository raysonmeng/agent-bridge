#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe } from "./lib";

void runProbe("p01", async (probe) => {
  const token = makeToken("p01");
  const tui = await probe.connectTui(token, "primary");
  const tuiThreadId = await tui.initializeAndStartThread();

  const claude = await probe.connectClaude("p01_pair");
  await claude.expectNoDedicatedThreadReady(8_000);

  const ok = marker("p01-ok");
  const result = await claude.sendReply(
    `Reply with exactly this marker and nothing else: ${ok}`,
    { requireReply: true },
  );
  assert(result.success, `paired Claude reply was rejected: ${result.error ?? "unknown"}`);

  await tui.waitForNotification("turn/started", undefined, 45_000);
  await tui.waitForAgentMessage(ok, 180_000);
  await claude.waitForContent(ok, 30_000);

  const status = await probe.status();
  assert(status.threadId === tuiThreadId, `daemon status threadId ${status.threadId} != TUI threadId ${tuiThreadId}`);
});

