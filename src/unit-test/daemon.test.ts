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

  test("P3c lifecycle: ensurePair rejects INVALID_PAIR_NAME", async () => {
    // P3c generalized ensurePair to accept any valid pairId. Invalid
    // names (per D1) still throw a PairError.
    await expect(fns.ensurePair("BAD CASE")).rejects.toThrow(/fails validation/);
  });

  // ── STM v2.3 §D6 P3b — control-protocol handlers ────────────────────

  function makeMockWs(): {
    sent: any[];
    ws: any;
  } {
    const sent: any[] = [];
    return {
      sent,
      ws: {
        send: (payload: string) => { sent.push(JSON.parse(payload)); return 0; },
        data: { clientId: 1, attached: false, chatId: null },
        readyState: 1,
        close: () => {},
      },
    };
  }

  test("P3b ensure_pair: pair_error INVALID_PAIR_NAME for bad name", async () => {
    const { ws, sent } = makeMockWs();
    await fns.handleEnsurePair(ws, {
      type: "ensure_pair",
      requestId: "req-1",
      pairId: "BAD CASE",
    });
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("pair_error");
    expect(sent[0].code).toBe("INVALID_PAIR_NAME");
    expect(sent[0].requestId).toBe("req-1");
  });

  test("P3b ensure_pair: pair_ensured for 'default' (idempotent across registry)", async () => {
    const defaultPair = __testing.pairs.get("default")!;
    const originalStart = defaultPair.codex.start.bind(defaultPair.codex);
    (defaultPair.codex as any).start = async () => {};
    try {
      // Pre-condition: default registered, not live.
      expect(__testing.pairRegistry.has("default")).toBe(true);
      defaultPair.isLive = false;

      const { ws, sent } = makeMockWs();
      await fns.handleEnsurePair(ws, {
        type: "ensure_pair",
        requestId: "req-2",
        pairId: "default",
      });
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("pair_ensured");
      expect(sent[0].pairId).toBe("default");
      expect(sent[0].isLive).toBe(true);
      expect(typeof sent[0].appServerUrl).toBe("string");
      expect(typeof sent[0].proxyUrl).toBe("string");
      expect(defaultPair.isLive).toBe(true);
    } finally {
      (defaultPair.codex as any).start = originalStart;
    }
  });

  test("P3c ensure_pair: non-default name allocates a fresh PairState and goes live (with stubbed codex.start)", async () => {
    // Make sure "scratch-pair" isn't already in registry.
    if (__testing.pairRegistry.has("scratch-pair")) {
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("scratch-pair");
        __testing.pairRegistry.save();
      });
    }

    // Stub CodexAdapter.prototype.start so the test doesn't actually
    // spawn a real `codex app-server` process.
    const { CodexAdapter } = await import("../codex-adapter");
    const originalStart = (CodexAdapter.prototype as any).start;
    (CodexAdapter.prototype as any).start = async function () {};

    try {
      const { ws, sent } = makeMockWs();
      await fns.handleEnsurePair(ws, {
        type: "ensure_pair",
        requestId: "req-3",
        pairId: "scratch-pair",
      });

      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("pair_ensured");
      expect(sent[0].pairId).toBe("scratch-pair");
      expect(sent[0].isLive).toBe(true);

      // PairState now exists in the pairs Map.
      const pair = __testing.pairs.get("scratch-pair");
      expect(pair).toBeDefined();
      expect(pair?.isLive).toBe(true);
      expect(pair?.handlerRefs.length).toBeGreaterThan(0);

      // Registry entry persisted.
      const entry = __testing.pairRegistry.get("scratch-pair");
      expect(entry).not.toBeNull();
      expect(entry?.appPort).toBeGreaterThanOrEqual(4510);
    } finally {
      (CodexAdapter.prototype as any).start = originalStart;
      // Tear down the test pair we created.
      const pair = __testing.pairs.get("scratch-pair");
      if (pair) {
        try { fns.detachPairHandlers(pair); } catch {}
        __testing.pairs.delete("scratch-pair");
      }
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("scratch-pair");
        __testing.pairRegistry.save();
      });
    }
  });

  test("P3b destroy_pair: PAIR_NOT_FOUND when pair is neither live nor registered", async () => {
    const { ws, sent } = makeMockWs();
    await fns.handleDestroyPair(ws, {
      type: "destroy_pair",
      requestId: "req-4",
      pairId: "never-existed",
    });
    expect(sent[0].type).toBe("pair_error");
    expect(sent[0].code).toBe("PAIR_NOT_FOUND");
  });

  test("P3b destroy_pair: forget removes registry-only entry, returns wasLive=false", async () => {
    await __testing.runUnderRegistryMutex(async () => {
      const result = __testing.pairRegistry.allocate("scratch-2");
      if (result.ok) __testing.pairRegistry.save();
    });
    expect(__testing.pairRegistry.has("scratch-2")).toBe(true);

    const { ws, sent } = makeMockWs();
    await fns.handleDestroyPair(ws, {
      type: "destroy_pair",
      requestId: "req-5",
      pairId: "scratch-2",
      forget: true,
    });
    expect(sent[0].type).toBe("pair_destroyed");
    expect(sent[0].wasLive).toBe(false);
    expect(sent[0].registryEntryRemoved).toBe(true);
    expect(__testing.pairRegistry.has("scratch-2")).toBe(false);
  });

  test("P3b destroy_pair: PAIR_BUSY_NOT_FORCED when pair has paired chat and no force", async () => {
    const defaultPair = __testing.pairs.get("default")!;
    // Seed a fake paired-chat slot for the default pair.
    __testing.setProxyTuiSlot({
      token: "t",
      pairedChatId: "some-chat",
      readiness: "ready",
      attachedAt: Date.now(),
      pairReapTimer: null,
    });
    defaultPair.isLive = true;

    const { ws, sent } = makeMockWs();
    await fns.handleDestroyPair(ws, {
      type: "destroy_pair",
      requestId: "req-6",
      pairId: "default",
      forget: false,
      force: false,
    });
    expect(sent[0].type).toBe("pair_error");
    expect(sent[0].code).toBe("PAIR_BUSY_NOT_FORCED");
  });

  // ── P3-cleanup claude_connect_result (Codex P3 close re-pass HIGH#1) ───

  function makeAttachMockWs(clientId = 7) {
    const sent: any[] = [];
    const ws: any = {
      send: (payload: string) => { sent.push(JSON.parse(payload)); return 0; },
      data: { clientId, attached: false, chatId: null },
      readyState: 1,
      close: () => {},
    };
    return { sent, ws };
  }

  function findResult(sent: any[]) {
    return sent.find((m) => m.type === "claude_connect_result");
  }

  test("P3-cleanup claude_connect: INVALID_PAIR_NAME for bad explicit pairId", async () => {
    const { ws, sent } = makeAttachMockWs();
    await (fns as any).attachClaude(ws, "chat-cc-1", "BAD CASE", "req-cc-1");
    const result = findResult(sent);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("INVALID_PAIR_NAME");
    expect(result?.requestId).toBe("req-cc-1");
  });

  test("P3-cleanup claude_connect: PAIR_NOT_FOUND when explicit pair is not live", async () => {
    const { ws, sent } = makeAttachMockWs();
    await (fns as any).attachClaude(ws, "chat-cc-2", "ghost-pair", "req-cc-2");
    const result = findResult(sent);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("PAIR_NOT_FOUND");
  });

  test("P3-cleanup claude_connect: PAIR_NOT_FOUND when explicit pair is live but has no proxy TUI slot (Codex re-pass strict semantics)", async () => {
    // Force-set default's slot to null then explicit-attach to it.
    const defaultPair = __testing.pairs.get("default")!;
    defaultPair.isLive = true;
    // Clear the slot if anything is attached.
    __testing.setProxyTuiSlot(null);
    expect(defaultPair.proxyTuiSlot).toBeNull();

    const { ws, sent } = makeAttachMockWs();
    await (fns as any).attachClaude(ws, "chat-cc-3", "default", "req-cc-3");
    const result = findResult(sent);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("PAIR_NOT_FOUND");
    expect(result?.message).toMatch(/no proxy TUI/i);
  });

  test("P3-cleanup claude_connect: PAIR_BUSY when explicit pair already has a different paired chat", async () => {
    const defaultPair = __testing.pairs.get("default")!;
    defaultPair.isLive = true;
    __testing.setProxyTuiSlot({
      token: "t",
      pairedChatId: "another-chat",
      readiness: "ready",
      attachedAt: Date.now(),
      pairReapTimer: null,
    });

    const { ws, sent } = makeAttachMockWs();
    await (fns as any).attachClaude(ws, "chat-cc-4", "default", "req-cc-4");
    const result = findResult(sent);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("PAIR_BUSY");
  });

  test("P3-cleanup claude_connect: ok=true with paired claim on explicit live+unpaired pair", async () => {
    const defaultPair = __testing.pairs.get("default")!;
    defaultPair.isLive = true;
    __testing.setProxyTuiSlot({
      token: "t",
      pairedChatId: null,
      readiness: "ready",
      attachedAt: Date.now(),
      pairReapTimer: null,
    });

    const { ws, sent } = makeAttachMockWs();
    await (fns as any).attachClaude(ws, "chat-cc-5", "default", "req-cc-5");
    const result = findResult(sent);
    expect(result?.ok).toBe(true);
    expect(result?.chatId).toBe("chat-cc-5");
    expect(result?.homePairId).toBe("default");
    expect(result?.paired).toBe(true);
  });

  // ── P3-cleanup (Codex P3-series review codex_msg_5753c73beafc_107) ─────

  test("P3-cleanup HIGH#2: same-pair concurrent ensurePair calls dedupe via ensurePairInFlight", async () => {
    const { CodexAdapter } = await import("../codex-adapter");
    const originalStart = (CodexAdapter.prototype as any).start;
    let startCallCount = 0;
    (CodexAdapter.prototype as any).start = async function () {
      startCallCount++;
      // Small delay to keep both racers in-flight at the same time.
      await new Promise((r) => setTimeout(r, 20));
    };
    if (__testing.pairRegistry.has("dedup-pair")) {
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("dedup-pair");
        __testing.pairRegistry.save();
      });
    }
    try {
      const [a, b] = await Promise.all([
        fns.ensurePair("dedup-pair"),
        fns.ensurePair("dedup-pair"),
      ]);
      // Both calls resolve to the exact same PairState instance —
      // ensurePairInFlight dedup worked.
      expect(a).toBe(b);
      // codex.start called exactly once.
      expect(startCallCount).toBe(1);
    } finally {
      (CodexAdapter.prototype as any).start = originalStart;
      const pair = __testing.pairs.get("dedup-pair");
      if (pair) {
        try { fns.detachPairHandlers(pair); } catch {}
        __testing.pairs.delete("dedup-pair");
      }
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("dedup-pair");
        __testing.pairRegistry.save();
      });
    }
  });

  test("P3-cleanup HIGH#3+4: destroy_pair on live non-default pair removes from pairs Map + clears slot", async () => {
    const { CodexAdapter } = await import("../codex-adapter");
    const originalStart = (CodexAdapter.prototype as any).start;
    const originalStop = (CodexAdapter.prototype as any).stop;
    (CodexAdapter.prototype as any).start = async () => {};
    (CodexAdapter.prototype as any).stop = () => {};

    try {
      // Bring up a fresh non-default pair.
      await fns.ensurePair("teardown-pair");
      const pair = __testing.pairs.get("teardown-pair");
      expect(pair).toBeDefined();
      expect(pair?.isLive).toBe(true);
      expect(pair?.handlerRefs.length).toBeGreaterThan(0);

      // Seed a fake slot + paired chat so we can verify teardown handles them.
      pair!.proxyTuiSlot = {
        token: "t",
        pairedChatId: "td-chat",
        readiness: "ready",
        attachedAt: Date.now(),
        pairReapTimer: setTimeout(() => {}, 60_000),
      };
      const chat = fns.createChatState("td-chat");
      chat.paired = true;
      chat.homePairId = "teardown-pair";
      __testing.chats.set("td-chat", chat);

      const { ws, sent } = makeMockWs();
      await fns.handleDestroyPair(ws, {
        type: "destroy_pair",
        requestId: "req-td",
        pairId: "teardown-pair",
        force: true,
      });
      expect(sent[0].type).toBe("pair_destroyed");
      expect(sent[0].wasLive).toBe(true);

      // Full teardown: removed from pairs Map, slot cleared, isLive=false,
      // handlers detached.
      expect(__testing.pairs.has("teardown-pair")).toBe(false);
      expect(pair?.isLive).toBe(false);
      expect(pair?.proxyTuiSlot).toBeNull();
      expect(pair?.handlerRefs.length).toBe(0);

      // The previously-paired chat was transitioned to isolated.
      expect(chat.paired).toBe(false);
      expect(chat.homePairId).toBe("default");
    } finally {
      (CodexAdapter.prototype as any).start = originalStart;
      (CodexAdapter.prototype as any).stop = originalStop;
      __testing.chats.delete("td-chat");
      const pair = __testing.pairs.get("teardown-pair");
      if (pair) {
        try { fns.detachPairHandlers(pair); } catch {}
        __testing.pairs.delete("teardown-pair");
      }
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("teardown-pair");
        __testing.pairRegistry.save();
      });
    }
  });

  test("P3-cleanup MEDIUM: codex.start EADDRINUSE maps to PAIR_PORTS_BUSY with details", async () => {
    const { CodexAdapter } = await import("../codex-adapter");
    const originalStart = (CodexAdapter.prototype as any).start;
    (CodexAdapter.prototype as any).start = async function () {
      const err: any = new Error("Failed to start app-server: EADDRINUSE :4520");
      err.code = "EADDRINUSE";
      throw err;
    };
    if (__testing.pairRegistry.has("busy-pair")) {
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("busy-pair");
        __testing.pairRegistry.save();
      });
    }

    try {
      const { ws, sent } = makeMockWs();
      await fns.handleEnsurePair(ws, {
        type: "ensure_pair",
        requestId: "req-busy",
        pairId: "busy-pair",
      });

      expect(sent[0].type).toBe("pair_error");
      expect(sent[0].code).toBe("PAIR_PORTS_BUSY");
      expect(sent[0].message).toContain("busy-pair");
    } finally {
      (CodexAdapter.prototype as any).start = originalStart;
      // PairState may have been partially constructed before start threw.
      const pair = __testing.pairs.get("busy-pair");
      if (pair) {
        try { fns.detachPairHandlers(pair); } catch {}
        __testing.pairs.delete("busy-pair");
      }
      await __testing.runUnderRegistryMutex(async () => {
        __testing.pairRegistry.remove("busy-pair");
        __testing.pairRegistry.save();
      });
    }
  });

  test("P3b list_pairs: returns live + registry-only entries", async () => {
    // Allocate a registry-only "scratch-list" entry.
    await __testing.runUnderRegistryMutex(async () => {
      const result = __testing.pairRegistry.allocate("scratch-list");
      if (result.ok) __testing.pairRegistry.save();
    });

    const { ws, sent } = makeMockWs();
    fns.handleListPairs(ws, { type: "list_pairs", requestId: "req-7" });
    expect(sent[0].type).toBe("pair_list");
    const pairsList = sent[0].pairs as any[];

    const defaultEntry = pairsList.find((p) => p.pairId === "default");
    expect(defaultEntry).toBeDefined();

    const scratchEntry = pairsList.find((p) => p.pairId === "scratch-list");
    expect(scratchEntry).toBeDefined();
    expect(scratchEntry.isLive).toBe(false);
    expect(scratchEntry.appServerUrl).toMatch(/ws:\/\/127\.0\.0\.1:/);

    // Cleanup.
    await __testing.runUnderRegistryMutex(async () => {
      __testing.pairRegistry.remove("scratch-list");
      __testing.pairRegistry.save();
    });
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
