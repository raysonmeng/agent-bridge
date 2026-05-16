#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe } from "./lib";

void runProbe("p02", async (probe) => {
  const claude = await probe.connectClaude("p02_isolated");
  const isolatedThreadId = await claude.waitForDedicatedThreadReady();

  const tui = await probe.connectTui(makeToken("p02"), "late-tui");
  const tuiThreadId = await tui.initializeAndStartThread();
  assert(isolatedThreadId !== tuiThreadId, "Claude-first session reused the later TUI thread");

  const isolatedMarker = marker("p02-claude");
  const result = await claude.sendReply(
    `Reply with exactly this marker and nothing else: ${isolatedMarker}`,
    { requireReply: true },
  );
  assert(result.success, `isolated Claude reply failed: ${result.error ?? "unknown"}`);
  await claude.waitForContent(isolatedMarker, 180_000);
  await tui.expectNoAgentMessage(isolatedMarker, 5_000);

  const tuiMarker = marker("p02-tui");
  await tui.sendTurn(`Reply with exactly this marker and nothing else: ${tuiMarker}`);
  await tui.waitForAgentMessage(tuiMarker, 180_000);
  await claude.expectNoContent("Human typed in the paired Codex TUI", 5_000);
});

