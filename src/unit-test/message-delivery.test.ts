import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";

// Access internals for testing
function createAdapter(
  envMode?: string,
  options?: {
    maxBufferedMessages?: number;
    maxBufferedBytes?: number;
    dedupeCapacity?: number;
    dedupeTtlMs?: number;
    now?: () => number;
  },
): any {
  const origMode = process.env.AGENTBRIDGE_MODE;
  const origMax = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;

  if (envMode !== undefined) {
    process.env.AGENTBRIDGE_MODE = envMode;
  } else {
    delete process.env.AGENTBRIDGE_MODE;
  }

  const adapter = new ClaudeAdapter(undefined, options) as any;

  // Restore env immediately after construction reads it
  if (origMode !== undefined) {
    process.env.AGENTBRIDGE_MODE = origMode;
  } else {
    delete process.env.AGENTBRIDGE_MODE;
  }
  if (origMax !== undefined) {
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = origMax;
  } else {
    delete process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;
  }

  return adapter;
}

let nextTestMessageId = 0;

function makeBridgeMessage(content: string, ts?: number, id?: string) {
  return {
    id: id ?? `test_${++nextTestMessageId}`,
    source: "codex" as const,
    content,
    timestamp: ts ?? Date.now(),
  };
}

function withMockedChannel(adapter: any, mode: "success" | "fail" = "success") {
  const notifications: any[] = [];
  adapter.server = {
    notification: async (payload: any) => {
      if (mode === "fail") throw new Error("channel unavailable");
      notifications.push(payload);
    },
  };
  return notifications;
}

describe("Push-only delivery: AGENTBRIDGE_MODE is ignored", () => {
  // Pull mode was removed (it could not wake an idle session and silently
  // broke the budget RESUME chain). Any legacy env value must be ignored.
  test("delivers via channel when AGENTBRIDGE_MODE is unset", async () => {
    const adapter = createAdapter();
    const notifications = withMockedChannel(adapter);
    await adapter.pushNotification(makeBridgeMessage("normal push"));
    expect(notifications).toHaveLength(1);
    expect(adapter.pendingMessages).toHaveLength(0);
  });

  test('legacy AGENTBRIDGE_MODE="pull" still delivers via channel', async () => {
    const adapter = createAdapter("pull");
    const notifications = withMockedChannel(adapter);
    await adapter.pushNotification(makeBridgeMessage("ignored pull env"));
    expect(notifications).toHaveLength(1);
    expect(adapter.pendingMessages).toHaveLength(0);
  });

  test("any other AGENTBRIDGE_MODE value is equally ignored", async () => {
    const adapter = createAdapter("auto");
    const notifications = withMockedChannel(adapter);
    await adapter.pushNotification(makeBridgeMessage("ignored auto env"));
    expect(notifications).toHaveLength(1);
    expect(adapter.pendingMessages).toHaveLength(0);
  });

  test("legacy warning is construction-time only — never per message", async () => {
    const adapter = createAdapter("pull");
    // Swap the logger AFTER construction: the one-time legacy warning has
    // already fired, so message delivery must not produce another one.
    const logs: string[] = [];
    adapter.logger = { log: (msg: string) => logs.push(msg) };
    withMockedChannel(adapter);
    await adapter.pushNotification(makeBridgeMessage("m1"));
    await adapter.pushNotification(makeBridgeMessage("m2"));
    expect(logs.filter((line) => line.includes("no longer supported"))).toHaveLength(0);
  });
});

describe("Message delivery: fallback queue", () => {
  test("queueFallbackMessage adds message to pendingMessages", () => {
    const adapter = createAdapter();

    const msg = makeBridgeMessage("hello from codex");
    adapter.queueFallbackMessage(msg);

    expect(adapter.pendingMessages).toHaveLength(1);
    expect(adapter.pendingMessages[0].content).toBe("hello from codex");
    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  test("queueFallbackMessage drops oldest when queue is full", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 3 });

    adapter.queueFallbackMessage(makeBridgeMessage("msg1"));
    adapter.queueFallbackMessage(makeBridgeMessage("msg2"));
    adapter.queueFallbackMessage(makeBridgeMessage("msg3"));
    adapter.queueFallbackMessage(makeBridgeMessage("msg4"));

    expect(adapter.pendingMessages).toHaveLength(3);
    expect(adapter.pendingMessages[0].content).toBe("msg2");
    expect(adapter.pendingMessages[2].content).toBe("msg4");
    expect(adapter.droppedMessageCount).toBe(1);
  });

  test("queueFallbackMessage drops oldest until the byte cap is respected", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 10, maxBufferedBytes: 8 });

    adapter.queueFallbackMessage(makeBridgeMessage("aa"));
    adapter.queueFallbackMessage(makeBridgeMessage("bbb"));
    adapter.queueFallbackMessage(makeBridgeMessage("cccc"));
    adapter.queueFallbackMessage(makeBridgeMessage("dd"));

    expect(adapter.pendingMessages.map((m: any) => m.content)).toEqual(["cccc", "dd"]);
    expect(adapter.pendingMessageBytes).toBe(6);
    expect(adapter.droppedMessageCount).toBe(2);
  });

  test("queueFallbackMessage counts UTF-8 bytes, not JavaScript string length", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 10, maxBufferedBytes: 7 });

    adapter.queueFallbackMessage(makeBridgeMessage("éé")); // 4 UTF-8 bytes
    adapter.queueFallbackMessage(makeBridgeMessage("abc")); // 3 UTF-8 bytes
    adapter.queueFallbackMessage(makeBridgeMessage("d")); // drops the 4-byte message

    expect(adapter.pendingMessages.map((m: any) => m.content)).toEqual(["abc", "d"]);
    expect(adapter.pendingMessageBytes).toBe(4);
    expect(adapter.droppedMessageCount).toBe(1);
  });

  test("queueFallbackMessage omits a single oversized message without storing its payload", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 10, maxBufferedBytes: 8 });

    adapter.queueFallbackMessage(makeBridgeMessage("small"));
    adapter.queueFallbackMessage(makeBridgeMessage("x".repeat(9)));

    expect(adapter.pendingMessages.map((m: any) => m.content)).toEqual(["small"]);
    expect(adapter.pendingMessageBytes).toBe(5);
    expect(adapter.oversizedMessageCount).toBe(1);
    expect(adapter.oversizedMessageBytes).toBe(9);
  });

  test("push meta uses BridgeMessage.id as message_id and a separate delivery_attempt_id", async () => {
    const adapter = createAdapter();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => {
        notifications.push(payload);
      },
    };

    await adapter.pushNotification(makeBridgeMessage("first push", 1705312200000, "codex-item-1"));
    await adapter.pushNotification(makeBridgeMessage("second push", 1705312205000, "codex-item-2"));

    expect(notifications).toHaveLength(2);

    const firstMeta = notifications[0].params.meta;
    const secondMeta = notifications[1].params.meta;

    expect(firstMeta.message_id).toBe("codex-item-1");
    expect(secondMeta.message_id).toBe("codex-item-2");
    expect(firstMeta.delivery_attempt_id).toMatch(/^codex_msg_[a-f0-9]{12}_1$/);
    expect(secondMeta.delivery_attempt_id).toMatch(/^codex_msg_[a-f0-9]{12}_2$/);
    expect(firstMeta.delivery_attempt_id.replace(/_1$/, "")).toBe(secondMeta.delivery_attempt_id.replace(/_2$/, ""));
    expect(firstMeta.delivery_attempt_id).not.toBe(firstMeta.message_id);
  });

  test("pushNotification absorbs a backpressure rebuffer replay with the same BridgeMessage.id", async () => {
    const adapter = createAdapter();
    const notifications = withMockedChannel(adapter);
    const logs: string[] = [];
    adapter.logger = { log: (msg: string) => logs.push(msg) };

    await adapter.pushNotification(makeBridgeMessage("first delivery", 1705312200000, "same-id"));
    await adapter.pushNotification(makeBridgeMessage("duplicate delivery", 1705312201000, "same-id"));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params.content).toBe("first delivery");
    expect(adapter.pendingMessages).toHaveLength(0);
    expect(logs.some((line) => line.includes("Duplicate Codex message suppressed") && line.includes("same-id"))).toBe(true);
  });

  test("pushNotification does not enqueue fallback twice for the same BridgeMessage.id", async () => {
    const adapter = createAdapter();
    withMockedChannel(adapter, "fail");

    await adapter.pushNotification(makeBridgeMessage("queued once", 1705312200000, "fallback-id"));
    await adapter.pushNotification(makeBridgeMessage("queued duplicate", 1705312201000, "fallback-id"));

    expect(adapter.pendingMessages.map((m: any) => m.content)).toEqual(["queued once"]);
    expect(adapter.pendingMessageBytes).toBe(Buffer.byteLength("queued once", "utf8"));
  });

  test("pushNotification accepts an id again after LRU eviction", async () => {
    const adapter = createAdapter(undefined, { dedupeCapacity: 2 });
    const notifications = withMockedChannel(adapter);

    await adapter.pushNotification(makeBridgeMessage("first a", 1705312200000, "id-a"));
    await adapter.pushNotification(makeBridgeMessage("first b", 1705312201000, "id-b"));
    await adapter.pushNotification(makeBridgeMessage("first c", 1705312202000, "id-c"));
    await adapter.pushNotification(makeBridgeMessage("second a", 1705312203000, "id-a"));

    expect(notifications.map((n) => n.params.content)).toEqual([
      "first a",
      "first b",
      "first c",
      "second a",
    ]);
  });

  test("pushNotification accepts an id again after dedupe TTL expires", async () => {
    let now = 1_000;
    const adapter = createAdapter(undefined, {
      dedupeCapacity: 10,
      dedupeTtlMs: 100,
      now: () => now,
    });
    const notifications = withMockedChannel(adapter);

    await adapter.pushNotification(makeBridgeMessage("first", 1705312200000, "ttl-id"));
    now += 50;
    await adapter.pushNotification(makeBridgeMessage("duplicate within ttl", 1705312201000, "ttl-id"));
    now += 101;
    await adapter.pushNotification(makeBridgeMessage("after ttl", 1705312202000, "ttl-id"));

    expect(notifications.map((n) => n.params.content)).toEqual(["first", "after ttl"]);
  });

  test("pushNotification dedupe TTL ignores wall-clock jumps", async () => {
    const originalDateNow = Date.now;
    let wallNow = 1_000;
    Date.now = () => wallNow;

    try {
      const adapter = createAdapter(undefined, { dedupeTtlMs: 60_000 });
      const notifications = withMockedChannel(adapter);

      await adapter.pushNotification(makeBridgeMessage("first", 1705312200000, "wall-clock-id"));
      wallNow += 120_000;
      await adapter.pushNotification(makeBridgeMessage("duplicate after wall jump", 1705312201000, "wall-clock-id"));

      expect(notifications.map((n) => n.params.content)).toEqual(["first"]);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("pushNotification falls back to the queue when push delivery throws", async () => {
    const adapter = createAdapter();
    withMockedChannel(adapter, "fail");

    await adapter.pushNotification(makeBridgeMessage("fallback msg"));

    expect(adapter.pendingMessages).toHaveLength(1);
    expect(adapter.pendingMessages[0].content).toBe("fallback msg");
  });

  test("push recovery does not auto-replay fallback backlog or duplicate messages", async () => {
    const adapter = createAdapter();
    withMockedChannel(adapter, "fail");
    await adapter.pushNotification(makeBridgeMessage("queued while push failed"));

    const notifications = withMockedChannel(adapter, "success");
    await adapter.pushNotification(makeBridgeMessage("live after recovery"));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params.content).toBe("live after recovery");
    expect(adapter.pendingMessages.map((m: any) => m.content)).toEqual(["queued while push failed"]);
  });
});

describe("Message delivery: drainMessages (get_messages)", () => {
  test("returns 'no new messages' when queue is empty", () => {
    const adapter = createAdapter();

    const result = adapter.drainMessages();
    expect(result.content[0].text).toBe("No new messages from Codex.");
  });

  test("returns formatted messages and clears queue", () => {
    const adapter = createAdapter();

    const ts = 1705312200000; // fixed timestamp for deterministic output
    adapter.queueFallbackMessage(makeBridgeMessage("first message", ts));
    adapter.queueFallbackMessage(makeBridgeMessage("second message", ts + 5000));

    const result = adapter.drainMessages();
    const text = result.content[0].text;

    expect(text).toContain("[2 new messages from Codex]");
    expect(text).toContain("chat_id:");
    expect(text).toContain("[1]");
    expect(text).toContain("first message");
    expect(text).toContain("[2]");
    expect(text).toContain("second message");

    // Queue should be cleared
    expect(adapter.pendingMessages).toHaveLength(0);
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("includes dropped count when messages were lost", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 2 });

    adapter.queueFallbackMessage(makeBridgeMessage("a"));
    adapter.queueFallbackMessage(makeBridgeMessage("b"));
    adapter.queueFallbackMessage(makeBridgeMessage("c")); // drops "a"

    const result = adapter.drainMessages();
    const text = result.content[0].text;
    expect(text).toContain("1 older message");
    expect(text).toContain("dropped due to fallback queue overflow");
    expect(adapter.droppedMessageCount).toBe(0); // reset after drain
  });

  test("includes byte overflow and oversized notices without enqueuing sentinel messages", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 10, maxBufferedBytes: 10 });

    adapter.queueFallbackMessage(makeBridgeMessage("12345"));
    adapter.queueFallbackMessage(makeBridgeMessage("abcdef"));
    adapter.queueFallbackMessage(makeBridgeMessage("x".repeat(11)));

    const result = adapter.drainMessages();
    const text = result.content[0].text;

    expect(text).toContain("[1 new message from Codex]");
    expect(text).toContain("1 older message");
    expect(text).toContain("dropped due to fallback queue overflow");
    expect(text).toContain("1 oversized message from Codex omitted (>10B)");
    expect(text).not.toContain("12345");
    expect(text).not.toContain("xxxxxxxxxxx");
    expect(adapter.pendingMessages).toHaveLength(0);
    expect(adapter.pendingMessageBytes).toBe(0);
    expect(adapter.droppedMessageCount).toBe(0);
    expect(adapter.oversizedMessageCount).toBe(0);
  });

  test("omits empty count header when drain only has oversized notices", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 10, maxBufferedBytes: 8 });

    adapter.queueFallbackMessage(makeBridgeMessage("x".repeat(9)));

    const result = adapter.drainMessages();
    const text = result.content[0].text;

    expect(text).not.toContain("0 new");
    expect(text).not.toContain("[0 new message from Codex]");
    expect(text).toContain("1 oversized message from Codex omitted (>8B)");
  });

  test("drainMessages reports no messages after clearing since-drain drop counters", () => {
    const adapter = createAdapter(undefined, { maxBufferedMessages: 1 });

    adapter.queueFallbackMessage(makeBridgeMessage("first"));
    adapter.queueFallbackMessage(makeBridgeMessage("second"));

    const firstDrain = adapter.drainMessages();
    expect(firstDrain.content[0].text).toContain("dropped due to fallback queue overflow");

    const secondDrain = adapter.drainMessages();
    expect(secondDrain.content[0].text).toBe("No new messages from Codex.");
  });

  test("singular message uses correct grammar", () => {
    const adapter = createAdapter();

    adapter.queueFallbackMessage(makeBridgeMessage("only one"));

    const result = adapter.drainMessages();
    expect(result.content[0].text).toContain("[1 new message from Codex]");
  });
});

describe("Message delivery: reply pending hint", () => {
  test("handleReply includes pending message hint when queue is non-empty", async () => {
    const adapter = createAdapter();

    adapter.replySender = async () => ({ success: true });
    adapter.queueFallbackMessage(makeBridgeMessage("waiting msg 1"));
    adapter.queueFallbackMessage(makeBridgeMessage("waiting msg 2"));

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    const text = result.content[0].text;

    expect(text).toContain("Reply sent to Codex.");
    expect(text).toContain("2 unread Codex message");
    expect(text).toContain("get_messages");
  });

  test("handleReply has no hint when queue is empty", async () => {
    const adapter = createAdapter();

    adapter.replySender = async () => ({ success: true });

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    expect(result.content[0].text).toBe("Reply sent to Codex.");
  });

  test("handleReply failures do not enqueue fallback messages", async () => {
    const adapter = createAdapter();
    adapter.replySender = async () => ({ success: false, error: "busy", code: "busy_reject" });

    const result = await adapter.handleReply({ text: "hello codex" });

    expect(result.isError).toBe(true);
    expect(adapter.pendingMessages).toHaveLength(0);
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("handleReply returns error when text is missing", async () => {
    const adapter = createAdapter();

    const result = await adapter.handleReply({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing required parameter");
  });

  test("handleReply returns error when replySender is not set", async () => {
    const adapter = createAdapter();

    const result = await adapter.handleReply({ text: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bridge not initialized");
  });
});

describe("Reply on_busy option (protocol v2 B0/B)", () => {
  function withCapturingSender(adapter: any, result: Record<string, unknown> = { success: true }) {
    const calls: Array<{ content: string; requireReply?: boolean; onBusy?: string; idempotencyKey?: string }> = [];
    adapter.replySender = async (msg: any, requireReply?: boolean, onBusy?: string, idempotencyKey?: string) => {
      calls.push({ content: msg.content, requireReply, onBusy, idempotencyKey });
      return result;
    };
    return calls;
  }

  test("on_busy defaults to reject when omitted", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello codex" });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].onBusy).toBe("reject");
    expect(result.content[0].text).toBe("Reply sent to Codex.");
  });

  test("on_busy=steer is passed through and the result text says so", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "mid-course fix", on_busy: "steer" });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].onBusy).toBe("steer");
    expect(result.content[0].text).toContain("steered into the running turn");
    expect(result.content[0].text).toContain("system_steer_failed");
  });

  test("on_busy=interrupt is accepted and passed through (protocol v2 PR B)", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "drop everything, new priority", on_busy: "interrupt" });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].onBusy).toBe("interrupt");
    expect(result.content[0].text).toContain("new turn");
    // Recommend #1: the wording must NOT unconditionally assert an interrupt
    // happened (the race-degrade path injects without interrupting anything).
    expect(result.content[0].text).toContain("interrupted first");
    expect(result.content[0].text).toContain("already finished");
  });

  test("invalid on_busy value errors before sending anything", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", on_busy: "abort" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid on_busy value");
    expect(result.content[0].text).toContain('"abort"');
    expect(calls).toHaveLength(0);
  });

  test("require_reply combined with on_busy=steer is now allowed (PR B real semantics)", async () => {
    // The B0 loud rejection is gone: the daemon arms the reply expectation
    // when the steer is ACCEPTED into the running turn.
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", on_busy: "steer", require_reply: true });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].onBusy).toBe("steer");
    expect(calls[0].requireReply).toBe(true);
  });

  test("require_reply combined with on_busy=interrupt is allowed (starts a NEW turn)", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", on_busy: "interrupt", require_reply: true });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].onBusy).toBe("interrupt");
    expect(calls[0].requireReply).toBe(true);
  });

  test("on_busy=reject explicit value behaves like the default", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", on_busy: "reject", require_reply: true });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].onBusy).toBe("reject");
    expect(calls[0].requireReply).toBe(true);
  });

  test("a failure result's machine-readable code is surfaced in the error text", async () => {
    const adapter = createAdapter();
    withCapturingSender(adapter, { success: false, error: "Codex is busy executing a turn.", code: "busy_reject" });

    const result = await adapter.handleReply({ text: "hello" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[busy_reject]");
    expect(result.content[0].text).toContain("Codex is busy");
  });

  test("a failure result without a code keeps the legacy error shape", async () => {
    const adapter = createAdapter();
    withCapturingSender(adapter, { success: false, error: "plain failure" });

    const result = await adapter.handleReply({ text: "hello" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: plain failure");
  });
});

describe("Reply idempotency_key option (protocol v2 PR B)", () => {
  function withCapturingSender(adapter: any) {
    const calls: Array<{ idempotencyKey?: string }> = [];
    adapter.replySender = async (_msg: any, _requireReply?: boolean, _onBusy?: string, idempotencyKey?: string) => {
      calls.push({ idempotencyKey });
      return { success: true };
    };
    return calls;
  }

  test("idempotency_key is passed through to the sender", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", idempotency_key: "task-42-attempt-1" });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].idempotencyKey).toBe("task-42-attempt-1");
  });

  test("omitted idempotency_key sends undefined (bypasses the machine)", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    await adapter.handleReply({ text: "hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0].idempotencyKey).toBeUndefined();
  });

  test("empty idempotency_key errors before sending", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", idempotency_key: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty string");
    expect(calls).toHaveLength(0);
  });

  test("non-string idempotency_key errors before sending", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", idempotency_key: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty string");
    expect(calls).toHaveLength(0);
  });

  test("idempotency_key longer than 128 chars errors before sending", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", idempotency_key: "x".repeat(129) });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too long");
    expect(result.content[0].text).toContain("max 128");
    expect(calls).toHaveLength(0);
  });

  test("a 128-char idempotency_key is exactly at the limit and accepted", async () => {
    const adapter = createAdapter();
    const calls = withCapturingSender(adapter);

    const result = await adapter.handleReply({ text: "hello", idempotency_key: "k".repeat(128) });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].idempotencyKey).toBe("k".repeat(128));
  });
});

describe("get_budget tool (handleGetBudget)", () => {
  const snapshot = {
    phase: "normal" as const,
    updatedAt: 1_780_711_700,
    claude: {
      ok: true,
      stale: false,
      gateUtil: 42,
      warnUtil: 45,
      fiveHour: { util: 42, resetEpoch: 1_780_750_000 },
      weekly: { util: 19, resetEpoch: 1_781_193_812 },
      remaining: 58,
      rateLimitedUntil: 0,
      fetchedAt: 1_780_711_639,
    },
    codex: null,
    driftPct: 0,
    paused: false,
    gateClosed: false,
    pauseSide: null,
    pauseReason: null,
    resumeAfterEpoch: null,
    parallelRecommended: false,
    codexTier: "full" as const,
    claudeAdvice: null,
  };

  test("returns unavailable text when no snapshot is cached", () => {
    const adapter = new ClaudeAdapter() as any;
    const result = adapter.handleGetBudget();
    expect(result.content[0].text).toContain("预算感知不可用");
    expect(result.isError).toBeUndefined();
  });

  test("renders the shared renderer output when a snapshot is cached", () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setBudgetSnapshot(snapshot);
    const result = adapter.handleGetBudget();
    expect(result.content[0].text).toContain("【预算快照 · 账号级】");
    expect(result.content[0].text).toContain("Claude：");
    expect(result.content[0].text).toContain("Codex：未知（探测不可用）");
  });

  test("clearing the snapshot reverts to unavailable text", () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setBudgetSnapshot(snapshot);
    adapter.setBudgetSnapshot(null);
    const result = adapter.handleGetBudget();
    expect(result.content[0].text).toContain("预算感知不可用");
  });
});
