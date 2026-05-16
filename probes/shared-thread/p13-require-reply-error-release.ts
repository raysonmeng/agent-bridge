#!/usr/bin/env bun
import { assert, makeToken, runProbe } from "./lib";

void runProbe("p13", async (probe) => {
  const tui = await probe.connectTui(makeToken("p13"), "primary");
  await tui.initializeAndStartThread({ approvalPolicy: "never", sandbox: "read-only" });
  const claude = await probe.connectClaude("p13_paired");
  await claude.expectNoDedicatedThreadReady(8_000);

  const result = await claude.sendReply(
    "Try to create /tmp/agentbridge-p13-should-be-denied.txt using a shell command. If the environment denies it, report the exact error.",
    { requireReply: true },
  );
  assert(result.success, `paired reply failed: ${result.error ?? "unknown"}`);

  await claude.waitForBridgeMessage(
    (msg) => msg.content.startsWith("[error]") || msg.content.includes("[error]") || msg.content.includes("permission") || msg.content.includes("denied"),
    "error release",
    180_000,
  );
});

