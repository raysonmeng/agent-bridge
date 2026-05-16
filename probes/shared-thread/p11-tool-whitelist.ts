#!/usr/bin/env bun
import { assert, makeToken, marker, runProbe, sleep } from "./lib";

void runProbe("p11", async (probe) => {
  const tui = await probe.connectTui(makeToken("p11"), "primary", { autoApprove: true });
  await tui.initializeAndStartThread({ approvalPolicy: "never" });
  const claude = await probe.connectClaude("p11_paired");
  await claude.expectNoDedicatedThreadReady(8_000);

  const commandMarker = marker("p11-shell");
  await tui.sendTurn(
    `Run the shell command: echo ${commandMarker}. Then reply with exactly "${commandMarker} done".`,
    { approvalPolicy: "never" },
  );
  await tui.waitForNotification("item/completed", (msg) => msg.params?.item?.type === "commandExecution", 180_000);
  await tui.waitForAgentMessage(`${commandMarker} done`, 180_000);
  await sleep(2_000);

  assert(
    !claude.bridgeMessages.some((msg) => /commandExecution|shellCommand|requestApproval|aggregatedOutput/.test(msg.content)),
    "internal tool/shell item leaked to paired Claude",
  );
});

