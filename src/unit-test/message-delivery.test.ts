import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";

// Access internals for testing
function createAdapter(envMode?: string): any {
  const origMode = process.env.AGENTBRIDGE_MODE;
  const origMax = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;

  if (envMode !== undefined) {
    process.env.AGENTBRIDGE_MODE = envMode;
  } else {
    delete process.env.AGENTBRIDGE_MODE;
  }

  const adapter = new ClaudeAdapter() as any;

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

function makeBridgeMessage(content: string, ts?: number) {
  return {
    id: `test_${Date.now()}`,
    source: "codex" as const,
    content,
    timestamp: ts ?? Date.now(),
  };
}

describe("Push-only delivery: AGENTBRIDGE_MODE is ignored", () => {
  // Pull mode was removed (it could not wake an idle session and silently
  // broke the budget RESUME chain). Any legacy env value must be ignored.
  function withMockedChannel(adapter: any) {
    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => {
        notifications.push(payload);
      },
    };
    return notifications;
  }

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
    const orig = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = "3";
    const adapter = createAdapter();
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = orig;

    adapter.queueFallbackMessage(makeBridgeMessage("msg1"));
    adapter.queueFallbackMessage(makeBridgeMessage("msg2"));
    adapter.queueFallbackMessage(makeBridgeMessage("msg3"));
    adapter.queueFallbackMessage(makeBridgeMessage("msg4"));

    expect(adapter.pendingMessages).toHaveLength(3);
    expect(adapter.pendingMessages[0].content).toBe("msg2");
    expect(adapter.pendingMessages[2].content).toBe("msg4");
    expect(adapter.droppedMessageCount).toBe(1);
  });

  test("push message ids include a session-unique prefix", async () => {
    const adapter = createAdapter();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => {
        notifications.push(payload);
      },
    };

    await adapter.pushNotification(makeBridgeMessage("first push", 1705312200000));
    await adapter.pushNotification(makeBridgeMessage("second push", 1705312205000));

    expect(notifications).toHaveLength(2);

    const firstId = notifications[0].params.meta.message_id as string;
    const secondId = notifications[1].params.meta.message_id as string;

    expect(firstId).toMatch(/^codex_msg_[a-f0-9]{12}_1$/);
    expect(secondId).toMatch(/^codex_msg_[a-f0-9]{12}_2$/);
    expect(firstId.replace(/_1$/, "")).toBe(secondId.replace(/_2$/, ""));
    expect(firstId).not.toBe("codex_msg_1");
  });

  test("pushNotification falls back to the queue when push delivery throws", async () => {
    const adapter = createAdapter();

    adapter.server = {
      notification: async () => {
        throw new Error("channel unavailable");
      },
    };

    await adapter.pushNotification(makeBridgeMessage("fallback msg"));

    expect(adapter.pendingMessages).toHaveLength(1);
    expect(adapter.pendingMessages[0].content).toBe("fallback msg");
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
    const orig = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = "2";
    const adapter = createAdapter();
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = orig;

    adapter.queueFallbackMessage(makeBridgeMessage("a"));
    adapter.queueFallbackMessage(makeBridgeMessage("b"));
    adapter.queueFallbackMessage(makeBridgeMessage("c")); // drops "a"

    const result = adapter.drainMessages();
    const text = result.content[0].text;
    expect(text).toContain("1 older message");
    expect(text).toContain("dropped due to queue overflow");
    expect(adapter.droppedMessageCount).toBe(0); // reset after drain
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
