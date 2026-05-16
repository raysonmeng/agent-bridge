#!/usr/bin/env bun
import { assert, makeToken, runProbe, sleep } from "./lib";

void runProbe("p10", async (probe) => {
  const tui = await probe.connectTui(makeToken("p10"), "primary", {
    approvalPolicy: "on-request",
    autoApprove: false,
  });
  await tui.initializeAndStartThread({ approvalPolicy: "on-request" });
  const claude = await probe.connectClaude("p10_paired");
  await claude.expectNoDedicatedThreadReady(8_000);

  await tui.sendTurn(
    "Run this shell command: echo agentbridge-p10-approval-isolation. Ask for approval if required, and do not skip the command.",
    { approvalPolicy: "on-request" },
  );
  await tui.waitForServerRequest("requestApproval", 180_000);
  await sleep(2_000);

  assert(
    !claude.bridgeMessages.some((msg) => /requestApproval|approval request|agentbridge-p10-approval-isolation/i.test(msg.content)),
    "approval request leaked to paired Claude",
  );
});

