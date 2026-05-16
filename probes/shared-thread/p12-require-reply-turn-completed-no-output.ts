#!/usr/bin/env bun
import { assert, makeToken, runProbe } from "./lib";

void runProbe("p12", async (probe) => {
  const tui = await probe.connectTui(makeToken("p12"), "primary");
  await tui.initializeAndStartThread();
  const claude = await probe.connectClaude("p12_paired");
  await claude.expectNoDedicatedThreadReady(8_000);

  const result = await claude.sendReply(
    "Begin a long-running task and do not produce a final answer until tools complete. This turn will be interrupted by the probe.",
    { requireReply: true },
  );
  assert(result.success, `paired reply failed: ${result.error ?? "unknown"}`);

  const started = await tui.waitForNotification("turn/started", undefined, 60_000);
  const turnId = started.params?.turn?.id;
  assert(typeof turnId === "string" && turnId.length > 0, "turn/started did not include turn.id");
  await tui.interrupt(turnId);

  await claude.waitForBridgeMessage(
    (msg) => msg.content.includes("[system] Codex turn completed") || msg.content.includes("completed the turn without sending a reply"),
    "turnCompleted no-output release",
    60_000,
  );

  assert(
    !claude.bridgeMessages.some((msg) => msg.content.includes("[system] Codex turn started") && msg.content.includes("satisfies")),
    "turnStarted appeared to satisfy requireReply; check daemon release accounting",
  );
});

