/**
 * Unit tests for the daemon pairing state machine (spec v2.2 §9 / §5).
 *
 * The daemon module's top-level boot is gated by `import.meta.main`, so
 * importing it from here does NOT spin up sockets, the Codex app-server,
 * or any background processes. We drive the state machine through the
 * `__testing` harness, emit events directly on the singleton CodexAdapter,
 * and inspect each chat's `bufferedMessages` to verify what was emitted.
 *
 * Coverage:
 *   §9 Pairing FIFO
 *   §9 Grace window (AGENTBRIDGE_PAIR_REAP_MS)
 *   §9 Race-protection (PAIR_RACE_MS=0 — no retroactive pairing)
 *   §9 Isolation transition on TUI disconnect / thread/closed
 *   Bug regression A (2026-05-16): no-output failure gated on replyRequired
 *   Bug regression B (2026-05-16): bootstrap failure surfaces final error
 *   Bug regression C (2026-05-16): errorItem sets pairedTurnSawAgentMessage
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import type { BridgeMessage } from "../types";

// Test-only env overrides MUST be set before the daemon module loads,
// because daemon.ts captures several constants (PAIR_REAP_MS, the isolated-
// bootstrap retry knobs, IDLE_SHUTDOWN_MS, ...) at the top of the file.
// Static ESM `import` statements are hoisted above module body code, so we
// use a dynamic `await import()` here to guarantee env precedence.
const testStateDir = mkdtempSync(join(tmpdir(), "agentbridge-daemon-test-"));
process.env.AGENTBRIDGE_STATE_DIR = testStateDir;
process.env.AGENTBRIDGE_PAIR_REAP_MS = "100";
// MAX_ATTEMPTS=2 + RETRY_DELAY=5ms gives the retry test a real loop to
// exercise (attempt 1 fails → emit retry → attempt 2 fails → emit final
// failure + reap), and stays under 100ms total.
process.env.AGENTBRIDGE_ISOLATED_BOOTSTRAP_MAX_ATTEMPTS = "2";
process.env.AGENTBRIDGE_ISOLATED_BOOTSTRAP_RETRY_DELAY_MS = "5";
process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS = "60000";
// Point the daemon at a deliberately unbound port so any ClaudeThread
// bootstrap attempt in tests (e.g. via transitionToIsolated) fails fast
// instead of accidentally connecting to a real Codex app-server that
// happens to be running on the developer's machine.
process.env.CODEX_WS_PORT = "24500";
process.env.CODEX_PROXY_PORT = "24501";

const daemonModule = await import("../daemon");
const { __testing } = daemonModule;
const { fns, codex, chats, config } = __testing;

function makeSlot(opts: { pairedChatId?: string | null; readiness?: "not-ready" | "ready" } = {}) {
  return {
    token: "test-token-" + Math.random().toString(36).slice(2, 8),
    pairedChatId: opts.pairedChatId ?? null,
    readiness: opts.readiness ?? "ready" as const,
    attachedAt: Date.now(),
    pairReapTimer: null as ReturnType<typeof setTimeout> | null,
  };
}

function attachFakeWs(chat: ReturnType<typeof fns.createChatState>) {
  // Minimal WS shape sufficient for detachClaudeWs's guard / clientId log.
  chat.ws = {
    data: { clientId: 999, attached: true, chatId: chat.chatId },
    readyState: 1, // OPEN
    send: () => 0,
    close: () => {},
  } as any;
}

function findMessage(messages: BridgeMessage[], idPrefix: string): BridgeMessage | undefined {
  return messages.find((m) => m.id.startsWith(idPrefix));
}

function findMessageContaining(messages: BridgeMessage[], needle: string): BridgeMessage | undefined {
  return messages.find((m) => m.content.includes(needle));
}

beforeEach(() => {
  __testing.reset();
});

afterAll(() => {
  __testing.reset();
  rmSync(testStateDir, { recursive: true, force: true });
});

// ── §9 Pairing FIFO ─────────────────────────────────────────────

describe("daemon pairing FIFO (spec v2.2 §5)", () => {
  test("first attached Claude claims the slot, second stays isolated", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat1 = fns.createChatState("chat_one");
    chats.set("chat_one", chat1);
    fns.pairChat(chat1);

    expect(chat1.paired).toBe(true);
    expect(chat1.ready).toBe(true);
    expect(__testing.proxyTuiSlot?.pairedChatId).toBe("chat_one");

    const chat2 = fns.createChatState("chat_two");
    chats.set("chat_two", chat2);
    fns.pairChat(chat2);

    // Second pair attempt is rejected by the guard inside pairChat — slot
    // stays with chat_one and chat_two never flips `paired`.
    expect(chat2.paired).toBe(false);
    expect(__testing.proxyTuiSlot?.pairedChatId).toBe("chat_one");
  });

  test("pairChat is a no-op when proxyTuiSlot is null", () => {
    const chat = fns.createChatState("chat_solo");
    chats.set("chat_solo", chat);
    fns.pairChat(chat);

    expect(chat.paired).toBe(false);
    expect(__testing.proxyTuiSlot).toBeNull();
  });

  test("pairing flips ready according to slot readiness (provisioning case)", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "not-ready" }));

    const chat = fns.createChatState("chat_prov");
    chats.set("chat_prov", chat);
    fns.pairChat(chat);

    expect(chat.paired).toBe(true);
    expect(chat.ready).toBe(false); // waits for codex.on("ready") to flip it

    const provisioningMsg = findMessage(chat.bufferedMessages, "system_paired_provisioning");
    expect(provisioningMsg).toBeDefined();
  });
});

// ── §9 Grace window ─────────────────────────────────────────────

describe("daemon paired-Claude grace window (spec v2.2 §5)", () => {
  test("pairReapTimer expires after PAIR_REAP_MS and clears the slot", async () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_g");
    chats.set("chat_g", chat);
    attachFakeWs(chat);
    fns.pairChat(chat);

    fns.detachClaudeWs(chat, "test detach");

    expect(__testing.proxyTuiSlot?.pairReapTimer).not.toBeNull();

    // Wait past the grace window — PAIR_REAP_MS is 100ms in test env.
    await new Promise((r) => setTimeout(r, config.PAIR_REAP_MS + 80));

    // Slot's pairedChatId cleared; orphaned chat state fully reaped.
    expect(__testing.proxyTuiSlot?.pairedChatId).toBeNull();
    expect(chats.has("chat_g")).toBe(false);
  });

  test("reconnecting within grace cancels the reaper and preserves pair", async () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_grace_keep");
    chats.set("chat_grace_keep", chat);
    attachFakeWs(chat);
    fns.pairChat(chat);

    fns.detachClaudeWs(chat, "test detach");

    // Reattach a WS before the grace expires (simulates same chatId
    // reconnecting). The reaper's body checks `currentState.ws` and bails.
    await new Promise((r) => setTimeout(r, 30));
    attachFakeWs(chat);

    // Wait past where the original reaper would have fired.
    await new Promise((r) => setTimeout(r, config.PAIR_REAP_MS + 80));

    expect(__testing.proxyTuiSlot?.pairedChatId).toBe("chat_grace_keep");
    expect(chats.has("chat_grace_keep")).toBe(true);
  });
});

// ── §9 Race protection (PAIR_RACE_MS=0) ─────────────────────────

describe("daemon race protection (spec v2.2 §5.1, PAIR_RACE_MS=0)", () => {
  test("Claude-first stays isolated when TUI connects later (no retroactive pairing)", () => {
    // Existing isolated chat — already provisioned before any TUI shows up.
    const chat = fns.createChatState("chat_preexisting");
    chat.ready = true; // pretend its own ClaudeThread bootstrap already finished
    chats.set("chat_preexisting", chat);

    expect(chat.paired).toBe(false);
    expect(__testing.proxyTuiSlot).toBeNull();

    // TUI connects, carrying a token (this is what makes it a proxy TUI).
    codex.emit("tuiConnected", 1, "race-token-abc");

    // Slot is allocated — but the existing chat is NOT retroactively paired.
    expect(__testing.proxyTuiSlot).not.toBeNull();
    expect(__testing.proxyTuiSlot?.pairedChatId).toBeNull();
    expect(chat.paired).toBe(false);
  });

  test("tuiConnected with empty token does NOT allocate a proxy slot (legacy TUI)", () => {
    expect(__testing.proxyTuiSlot).toBeNull();
    codex.emit("tuiConnected", 1, "");
    expect(__testing.proxyTuiSlot).toBeNull();
  });
});

// ── §9 Isolation transition ─────────────────────────────────────

describe("daemon isolation transition (spec v2.2 §5)", () => {
  test("TUI disconnect tears down the slot and transitions paired chat to isolated", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_iso_tui");
    chats.set("chat_iso_tui", chat);
    fns.pairChat(chat);
    expect(chat.paired).toBe(true);

    // Capture bufferedMessages length BEFORE the transition so we can find
    // the new system_pair_torn_down message specifically.
    const beforeCount = chat.bufferedMessages.length;

    codex.emit("tuiDisconnected", 1);

    expect(chat.paired).toBe(false);
    expect(__testing.proxyTuiSlot).toBeNull();

    const newMessages = chat.bufferedMessages.slice(beforeCount);
    const tornDown = findMessage(newMessages, "system_pair_torn_down");
    expect(tornDown).toBeDefined();
    expect(tornDown!.content).toContain("Shared Codex TUI thread is gone");
  });

  test("thread/closed notification triggers same isolation transition", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_iso_tc");
    chats.set("chat_iso_tc", chat);
    fns.pairChat(chat);
    expect(chat.paired).toBe(true);

    const beforeCount = chat.bufferedMessages.length;

    codex.emit("threadClosed", { threadId: "tid-xyz" });

    expect(chat.paired).toBe(false);
    expect(__testing.proxyTuiSlot).toBeNull();

    const newMessages = chat.bufferedMessages.slice(beforeCount);
    const tornDown = findMessage(newMessages, "system_pair_torn_down");
    expect(tornDown).toBeDefined();
    expect(tornDown!.content).toContain("Shared Codex thread closed");
  });
});

// ── Bug regressions ─────────────────────────────────────────────

describe("daemon bug regressions (2026-05-16 STM v2.2 review)", () => {
  test("Bug A: turn/completed with no agentMessage does NOT emit no-output failure when replyRequired=false", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_bug_a");
    chats.set("chat_bug_a", chat);
    fns.pairChat(chat);

    // User typed in TUI scenario — replyRequired stayed false, no agentMessage.
    chat.replyRequired = false;
    chat.pairedTurnSawAgentMessage = false;
    const beforeCount = chat.bufferedMessages.length;

    codex.emit("turnCompleted");

    const newMessages = chat.bufferedMessages.slice(beforeCount);
    expect(findMessage(newMessages, "system_codex_turn_completed_no_output")).toBeUndefined();
    expect(findMessage(newMessages, "system_codex_turn_completed")).toBeDefined();
  });

  test("Bug A: no-output failure IS emitted when replyRequired=true (Claude waiting for reply)", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_bug_a_pos");
    chats.set("chat_bug_a_pos", chat);
    fns.pairChat(chat);

    chat.replyRequired = true;
    chat.pairedTurnSawAgentMessage = false;
    const beforeCount = chat.bufferedMessages.length;

    codex.emit("turnCompleted");

    const newMessages = chat.bufferedMessages.slice(beforeCount);
    const failure = findMessage(newMessages, "system_codex_turn_completed_no_output");
    expect(failure).toBeDefined();
    // Cleanup flags are reset at end of handler.
    expect(chat.replyRequired).toBe(false);
    expect(chat.replyReceivedDuringTurn).toBe(false);
  });

  test("Bug C: errorItem sets pairedTurnSawAgentMessage so subsequent turn/completed does NOT fire spurious failure", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_bug_c");
    chats.set("chat_bug_c", chat);
    fns.pairChat(chat);

    // Simulate: Claude was waiting for reply, error arrives, then turn ends.
    chat.replyRequired = true;
    chat.pairedTurnSawAgentMessage = false;
    const beforeCount = chat.bufferedMessages.length;

    codex.emit("errorItem", { code: -32601, message: "Method not found" });

    expect(chat.pairedTurnSawAgentMessage).toBe(true);
    expect(chat.replyRequired).toBe(false);

    const afterErrorCount = chat.bufferedMessages.length;
    const errMsg = findMessageContaining(
      chat.bufferedMessages.slice(beforeCount),
      "Method not found",
    );
    expect(errMsg).toBeDefined();

    // Now turn/completed fires after the error. Should NOT emit a second
    // failure system message — Claude already heard the error.
    codex.emit("turnCompleted");
    const newMessages = chat.bufferedMessages.slice(afterErrorCount);
    expect(findMessage(newMessages, "system_codex_turn_completed_no_output")).toBeUndefined();
    expect(findMessage(newMessages, "system_codex_turn_completed")).toBeDefined();
  });

  test("Bug B: bootstrap retry config is wired in via env", () => {
    // Smoke test for the retry plumbing — verify env-driven knobs landed.
    expect(config.ISOLATED_BOOTSTRAP_MAX_ATTEMPTS).toBe(2);
    expect(config.ISOLATED_BOOTSTRAP_RETRY_DELAY_MS).toBe(5);
  });

  // ── STM v2.3 P2 lifecycle (Codex P2 review codex_msg_5753c73beafc_95) ──

  test("P2 lifecycle: attachPairHandlers is idempotent (no duplicate handler refs)", () => {
    const defaultPair = __testing.pairs.get("default")!;
    const baseline = defaultPair.handlerRefs.length;
    expect(baseline).toBeGreaterThan(0); // module-load registration already ran

    fns.attachPairHandlers(defaultPair);
    expect(defaultPair.handlerRefs.length).toBe(baseline);
  });

  test("P2 lifecycle: detachPairHandlers uses targeted off(), preserves unrelated listeners", () => {
    const defaultPair = __testing.pairs.get("default")!;
    const baseline = defaultPair.handlerRefs.length;

    // Register an unrelated listener that detachPairHandlers must NOT remove.
    const unrelatedHandler = () => {};
    defaultPair.codex.on("ready", unrelatedHandler);
    const readyBefore = defaultPair.codex.listenerCount("ready");

    fns.detachPairHandlers(defaultPair);
    expect(defaultPair.handlerRefs.length).toBe(0);

    // The unrelated handler stays attached; only the daemon's own "ready"
    // handler should have been removed (count drops by exactly 1).
    expect(defaultPair.codex.listenerCount("ready")).toBe(readyBefore - 1);

    // Cleanup + restore so subsequent tests see a normal default pair.
    defaultPair.codex.off("ready", unrelatedHandler);
    fns.attachPairHandlers(defaultPair);
    expect(defaultPair.handlerRefs.length).toBe(baseline);
  });

  test("P2 lifecycle: destroyPair → ensurePair reattaches handlers (no event-deaf pair)", async () => {
    const defaultPair = __testing.pairs.get("default")!;
    // Stub codex.start()/stop() so we don't spawn a real Codex app-server here.
    const originalStart = defaultPair.codex.start.bind(defaultPair.codex);
    const originalStop = defaultPair.codex.stop.bind(defaultPair.codex);
    (defaultPair.codex as any).start = async () => {};
    (defaultPair.codex as any).stop = () => {};

    try {
      defaultPair.isLive = true;
      const baseline = defaultPair.handlerRefs.length;
      expect(baseline).toBeGreaterThan(0);

      await fns.destroyPair("default");
      expect(defaultPair.isLive).toBe(false);
      expect(defaultPair.handlerRefs.length).toBe(0);

      await fns.ensurePair("default");
      expect(defaultPair.isLive).toBe(true);
      // Handlers reattached — pair is no longer event-deaf.
      expect(defaultPair.handlerRefs.length).toBe(baseline);
    } finally {
      (defaultPair.codex as any).start = originalStart;
      (defaultPair.codex as any).stop = originalStop;
    }
  });

  test("P2 lifecycle: codex exit clears pair.isLive so a future ensurePair re-spawns (Codex P2 review finding HIGH#2)", async () => {
    const defaultPair = __testing.pairs.get("default")!;
    const originalStart = defaultPair.codex.start.bind(defaultPair.codex);
    (defaultPair.codex as any).start = async () => {};

    try {
      defaultPair.isLive = true;
      // Simulate codex app-server crash.
      defaultPair.codex.emit("exit", 137);
      expect(defaultPair.isLive).toBe(false);

      // ensurePair must now proceed past the early-return guard.
      await fns.ensurePair("default");
      expect(defaultPair.isLive).toBe(true);
    } finally {
      (defaultPair.codex as any).start = originalStart;
    }
  });

  test("P2 lifecycle: ensurePair rejects non-default pairId in P2", async () => {
    await expect(fns.ensurePair("work")).rejects.toThrow(/not yet supported in P2/);
  });

  test("Bug B: transitionToIsolated exercises the retry loop and emits a definitive 'failed' message when all attempts fail", async () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_bug_b");
    chats.set("chat_bug_b", chat);
    fns.pairChat(chat);

    const beforeCount = chat.bufferedMessages.length;

    // Trigger transition. The ClaudeThread it constructs will try to
    // bootstrap against ws://127.0.0.1:24500 (unbound), so each bootstrap
    // attempt rejects. With MAX_ATTEMPTS=2 + RETRY_DELAY=5ms we should see
    // attempt 1 → emit retry → attempt 2 → emit final failure + reap.
    fns.transitionToIsolated(chat, "test reason");

    await new Promise((r) => setTimeout(r, 400));

    const newMessages = chat.bufferedMessages.slice(beforeCount);
    const retryMsg = findMessage(newMessages, "system_isolated_retry");
    expect(retryMsg).toBeDefined();
    expect(retryMsg!.content).toContain("(attempt 1/2)");

    const failed = findMessage(newMessages, "system_isolated_failed");
    expect(failed).toBeDefined();
    expect(failed!.content).toContain("after 2 attempts");
    expect(failed!.content).toContain("reconnect Claude");
  });

  test("Bug B (Codex review): final failure REAPS the chat so subsequent attach gets a fresh bootstrap", async () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_bug_b_reap");
    chats.set("chat_bug_b_reap", chat);
    fns.pairChat(chat);

    expect(chats.has("chat_bug_b_reap")).toBe(true);

    fns.transitionToIsolated(chat, "test reason");

    await new Promise((r) => setTimeout(r, 400));

    // Without this Codex-review fix, the chat stays in the map and the
    // "reconnect Claude" guidance is a lie because attachClaude takes the
    // resume branch and never re-bootstraps.
    expect(chats.has("chat_bug_b_reap")).toBe(false);
  });

  test("Codex review #2: transitionToIsolated clears stale paired-turn flags so they don't bleed into isolated thread", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_bleed");
    chats.set("chat_bleed", chat);
    fns.pairChat(chat);

    // Mid-turn state when TUI disconnects.
    chat.replyRequired = true;
    chat.replyReceivedDuringTurn = true;
    chat.pairedTurnSawAgentMessage = true;

    fns.transitionToIsolated(chat, "test reason");

    // After transition the flags are reset so the fresh isolated thread
    // does not inherit a stale "Claude is waiting for a reply" state.
    expect(chat.replyRequired).toBe(false);
    expect(chat.replyReceivedDuringTurn).toBe(false);
    expect(chat.pairedTurnSawAgentMessage).toBe(false);
  });

  test("Codex review #3: errorItem clears replyReceivedDuringTurn (symmetric with turnCompleted)", () => {
    __testing.setProxyTuiSlot(makeSlot({ readiness: "ready" }));

    const chat = fns.createChatState("chat_err_sym");
    chats.set("chat_err_sym", chat);
    fns.pairChat(chat);

    chat.replyRequired = true;
    chat.replyReceivedDuringTurn = false;

    codex.emit("errorItem", { code: -32000, message: "test error" });

    // turnCompleted-style cleanup: both flags reset, plus
    // pairedTurnSawAgentMessage tracked so a follow-on turnCompleted
    // does not fire spurious no-output failure.
    expect(chat.replyRequired).toBe(false);
    expect(chat.replyReceivedDuringTurn).toBe(false);
    expect(chat.pairedTurnSawAgentMessage).toBe(true);
  });
});
