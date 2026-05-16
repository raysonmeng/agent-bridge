#!/usr/bin/env bun
import { assert, sha1_16 } from "./lib";
import { CodexAdapter } from "../../src/codex-adapter";

const text = `agentbridge-p14-echo-race-${Date.now()}`;
const adapter = new CodexAdapter({ appPort: 1, proxyPort: 2, logFile: "/tmp/agentbridge-p14-no-daemon.log" }) as any;

let emittedUserMessages = 0;
adapter.on("userMessage", () => {
  emittedUserMessages++;
});

if (!(adapter.pendingInjectionHashes instanceof Map)) {
  throw new Error("CodexAdapter.pendingInjectionHashes Map is missing; implement §4.5 race dedup before running P14.");
}
if (typeof adapter.handleServerNotification !== "function") {
  throw new Error("CodexAdapter.handleServerNotification is not reachable for the P14 micro-probe.");
}

adapter.pendingInjectionHashes.set(sha1_16(text), Date.now() + 5_000);
adapter.handleServerNotification({
  method: "item/completed",
  params: {
    threadId: "thread_p14",
    turnId: "turn_p14_pre_response",
    item: {
      type: "userMessage",
      id: "item_p14_user",
      content: [{ type: "text", text }],
    },
  },
});

assert(emittedUserMessages === 0, "pre-response userMessage echo was emitted despite pendingInjectionHashes match");
assert(!adapter.pendingInjectionHashes.has(sha1_16(text)), "pending hash was not consumed one-shot");

adapter.handleServerNotification({
  method: "item/completed",
  params: {
    threadId: "thread_p14",
    turnId: "turn_p14_human",
    item: {
      type: "userMessage",
      id: "item_p14_human",
      content: [{ type: "text", text: `${text}-human` }],
    },
  },
});

assert(emittedUserMessages === 1, "non-echo userMessage was not emitted after the one-shot hash was consumed");
process.stderr.write("RESULT: PASSED\n");

