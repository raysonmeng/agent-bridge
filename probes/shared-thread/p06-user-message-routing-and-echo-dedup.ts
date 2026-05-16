#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe, sleep } from "./lib";

void runProbe("p06", async (probe) => {
  const tui = await probe.connectTui(makeToken("p06"), "primary");
  await tui.initializeAndStartThread();
  const claude = await probe.connectClaude("p06_paired");
  await claude.expectNoDedicatedThreadReady(8_000);

  const humanMarker = marker("p06-human");
  await tui.sendTurn(`Reply with exactly this marker and nothing else: ${humanMarker}`);
  const routed = await claude.waitForBridgeMessage(
    (msg) =>
      msg.source === "codex" &&
      msg.content.includes("[IMPORTANT] Human typed in the paired Codex TUI:") &&
      msg.content.includes(humanMarker),
    "prefixed TUI userMessage",
    30_000,
  );
  assert(routed.source === "codex", `expected source=codex, got ${routed.source}`);
  await tui.waitForAgentMessage(humanMarker, 180_000);

  const echoMarker = marker("p06-echo");
  const result = await claude.sendReply(
    `Reply with exactly this marker and nothing else: ${echoMarker}`,
    { requireReply: true },
  );
  assert(result.success, `paired reply failed: ${result.error ?? "unknown"}`);
  await tui.waitForUserMessage(echoMarker, 30_000);
  await tui.waitForAgentMessage(echoMarker, 180_000);
  await claude.waitForContent(echoMarker, 30_000);
  await sleep(2_000);
  assert(
    !claude.bridgeMessages.some((msg) =>
      msg.content.includes("[IMPORTANT] Human typed in the paired Codex TUI:") &&
      msg.content.includes(echoMarker),
    ),
    "Claude-originated injected text echoed back as a TUI userMessage",
  );
});

