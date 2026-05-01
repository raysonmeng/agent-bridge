import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";
import { PersistentMessageQueue } from "../message-queue";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDirs: string[] = [];

// Access internals for testing
function createAdapter(envMode?: string, stateDir?: string, pushMethod?: string): any {
  const origMode = process.env.AGENTBRIDGE_MODE;
  const origMax = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;
  const origPushMethod = process.env.AGENTBRIDGE_PUSH_METHOD;
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "agentbridge-dual-test-"));
  if (!stateDir) tempDirs.push(dir);

  if (envMode !== undefined) {
    process.env.AGENTBRIDGE_MODE = envMode;
  } else {
    delete process.env.AGENTBRIDGE_MODE;
  }
  if (pushMethod !== undefined) {
    process.env.AGENTBRIDGE_PUSH_METHOD = pushMethod;
  } else {
    delete process.env.AGENTBRIDGE_PUSH_METHOD;
  }

  const queue = new PersistentMessageQueue(join(dir, "queue.db"), join(dir, "transcript.jsonl"));
  const adapter = new ClaudeAdapter(join(dir, "agentbridge.log"), queue) as any;
  adapter.__testStateDir = dir;
  adapter.__testQueue = queue;

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
  if (origPushMethod !== undefined) {
    process.env.AGENTBRIDGE_PUSH_METHOD = origPushMethod;
  } else {
    delete process.env.AGENTBRIDGE_PUSH_METHOD;
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

describe("Dual-mode transport: mode resolution", () => {
  test("configuredMode defaults to 'auto' when AGENTBRIDGE_MODE is not set", () => {
    const adapter = createAdapter();
    expect(adapter.configuredMode).toBe("auto");
  });

  test("configuredMode respects AGENTBRIDGE_MODE=push", () => {
    const adapter = createAdapter("push");
    expect(adapter.configuredMode).toBe("push");
  });

  test("configuredMode respects AGENTBRIDGE_MODE=pull", () => {
    const adapter = createAdapter("pull");
    expect(adapter.configuredMode).toBe("pull");
  });

  test("invalid AGENTBRIDGE_MODE falls back to 'auto'", () => {
    const adapter = createAdapter("invalid");
    expect(adapter.configuredMode).toBe("auto");
  });

  test("pushMethod defaults to custom claude/channel notification", () => {
    const adapter = createAdapter("push");
    expect(adapter.pushMethod).toBe("claude/channel");
  });

  test("pushMethod can use standard notifications/message for debugging", () => {
    const adapter = createAdapter("push", undefined, "standard");
    expect(adapter.pushMethod).toBe("standard");
  });

  test("auto mode defaults to pull", () => {
    const adapter = createAdapter();
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("pull");
    expect(adapter.getDeliveryMode()).toBe("pull");
  });

  test("resolveMode sets 'push' when configuredMode is 'push'", () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("push");
    expect(adapter.getDeliveryMode()).toBe("push");
  });

  test("resolveMode sets 'pull' when configuredMode is 'pull'", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("pull");
    expect(adapter.getDeliveryMode()).toBe("pull");
  });

  test("resolveMode sets 'dual' when configuredMode is 'dual'", () => {
    const adapter = createAdapter("dual");
    adapter.resolveMode();
    expect(adapter.resolvedMode).toBe("dual");
    expect(adapter.getDeliveryMode()).toBe("dual");
  });
});

describe("Dual-mode transport: pull mode message queue", () => {
  test("queueForPull adds message to pendingMessages", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const msg = makeBridgeMessage("hello from codex");
    adapter.queueForPull(msg);

    expect(adapter.getPendingMessageCount()).toBe(1);
    expect(adapter.queue.listUndrained()[0].content).toBe("hello from codex");
  });

  test("queueForPull drops oldest when queue is full", () => {
    const orig = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = "3";
    const adapter = createAdapter("pull");
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = orig;

    adapter.resolveMode();

    adapter.queueForPull(makeBridgeMessage("msg1"));
    adapter.queueForPull(makeBridgeMessage("msg2"));
    adapter.queueForPull(makeBridgeMessage("msg3"));
    adapter.queueForPull(makeBridgeMessage("msg4"));

    const pending = adapter.queue.listUndrained();
    expect(pending).toHaveLength(3);
    expect(pending[0].content).toBe("msg2");
    expect(pending[2].content).toBe("msg4");
    expect(adapter.droppedMessageCount).toBe(1);
  });

  test("pushNotification queues in pull mode", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();
    await adapter.pushNotification(makeBridgeMessage("pull msg"));
    expect(adapter.getPendingMessageCount()).toBe(1);
    expect(adapter.queue.listUndrained()[0].content).toBe("pull msg");
  });

  test("push mode message ids include a session-unique prefix", async () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();

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

  test("pushNotification falls back to the pull queue when push delivery throws", async () => {
    const adapter = createAdapter("push");
    adapter.resolveMode();

    adapter.server = {
      notification: async () => {
        throw new Error("channel unavailable");
      },
    };

    await adapter.pushNotification(makeBridgeMessage("fallback msg"));

    expect(adapter.getPendingMessageCount()).toBe(1);
    expect(adapter.queue.listUndrained()[0].content).toBe("fallback msg");
  });

  test("standard push method sends MCP logging notifications", async () => {
    const adapter = createAdapter("push", undefined, "standard");
    adapter.resolveMode();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => notifications.push(payload),
    };

    await adapter.pushNotification(makeBridgeMessage("standard push", 1705312200000));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].method).toBe("notifications/message");
    expect(notifications[0].params.level).toBe("info");
    expect(notifications[0].params.logger).toBe("agentbridge");
    expect(notifications[0].params.data.content).toBe("standard push");
    expect(notifications[0].params.data.meta.message_id).toMatch(/^codex_msg_[a-f0-9]{12}_1$/);
  });

  test("dual mode persists first and pushes with the same message id", async () => {
    const adapter = createAdapter("dual");
    adapter.resolveMode();

    const notifications: any[] = [];
    adapter.server = {
      notification: async (payload: any) => notifications.push(payload),
    };

    await adapter.pushNotification(makeBridgeMessage("dual msg", 1705312200000));

    expect(notifications).toHaveLength(1);
    expect(adapter.getPendingMessageCount()).toBe(1);
    const entry = adapter.queue.listUndrained()[0];
    expect(entry.content).toBe("dual msg");
    expect(entry.pushedAt).toBeNumber();
    expect(notifications[0].params.meta.message_id).toBe(entry.messageId);
  });

  test("dual mode keeps persisted message when channel push throws", async () => {
    const adapter = createAdapter("dual");
    adapter.resolveMode();
    adapter.server = {
      notification: async () => {
        throw new Error("channel unavailable");
      },
    };

    await adapter.pushNotification(makeBridgeMessage("dual fallback"));

    const entry = adapter.queue.listUndrained()[0];
    expect(entry.content).toBe("dual fallback");
    expect(entry.pushError).toBe("channel unavailable");
  });

  test("dedupes undrained messages by chat_id and content_hash", async () => {
    const adapter = createAdapter("dual");
    adapter.resolveMode();
    const notifications: any[] = [];
    adapter.server = { notification: async (payload: any) => notifications.push(payload) };

    await adapter.pushNotification(makeBridgeMessage("same content", 1705312200000));
    await adapter.pushNotification(makeBridgeMessage("same content", 1705312205000));

    expect(adapter.queue.listUndrained()).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });

  test("writes audit JSONL without using it as replay source", async () => {
    const adapter = createAdapter("dual");
    adapter.resolveMode();
    adapter.server = { notification: async () => {} };

    await adapter.pushNotification(makeBridgeMessage("[IMPORTANT] audited message", 1705312200000));

    const audit = readFileSync(join(adapter.__testStateDir, "transcript.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    expect(audit.some((entry) => entry.event === "message_queued")).toBe(true);
    expect(audit.some((entry) => entry.event === "message_pushed")).toBe(true);
    expect(audit[0].contentHash).toBeString();
    expect(audit[0].preview).toContain("audited message");
  });
});

describe("Dual-mode transport: drainMessages (get_messages)", () => {
  test("returns 'no new messages' when queue is empty", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = adapter.drainMessages();
    expect(result.content[0].text).toBe("No new messages from Codex.");
  });

  test("returns formatted messages and clears queue", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const ts = 1705312200000; // fixed timestamp for deterministic output
    adapter.queueForPull(makeBridgeMessage("first message", ts));
    adapter.queueForPull(makeBridgeMessage("second message", ts + 5000));

    const result = adapter.drainMessages();
    const text = result.content[0].text;

    expect(text).toContain("[2 new messages from Codex]");
    expect(text).toContain("chat_id:");
    expect(text).toContain("[1]");
    expect(text).toContain("first message");
    expect(text).toContain("[2]");
    expect(text).toContain("second message");

    // Queue should be cleared
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("includes dropped count when messages were lost", () => {
    const orig = process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES;
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = "2";
    const adapter = createAdapter("pull");
    process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES = orig;
    adapter.resolveMode();

    adapter.queueForPull(makeBridgeMessage("a"));
    adapter.queueForPull(makeBridgeMessage("b"));
    adapter.queueForPull(makeBridgeMessage("c")); // drops "a"

    const result = adapter.drainMessages();
    const text = result.content[0].text;
    expect(text).toContain("1 older message");
    expect(text).toContain("dropped due to queue overflow");
    expect(adapter.droppedMessageCount).toBe(0); // reset after drain
  });

  test("singular message uses correct grammar", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.queueForPull(makeBridgeMessage("only one"));

    const result = adapter.drainMessages();
    expect(result.content[0].text).toContain("[1 new message from Codex]");
  });

  test("persists undrained messages across adapter restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentbridge-dual-restart-"));
    tempDirs.push(stateDir);

    const first = createAdapter("dual", stateDir);
    first.resolveMode();
    first.queueForPull(makeBridgeMessage("survives restart", 1705312200000));
    first.__testQueue.close();

    const second = createAdapter("pull", stateDir);
    second.resolveMode();

    const result = second.drainMessages();
    expect(result.content[0].text).toContain("survives restart");
    expect(second.getPendingMessageCount()).toBe(0);
  });

  test("restart before push attempt still replays persisted message", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agentbridge-dual-crash-"));
    tempDirs.push(stateDir);

    const first = createAdapter("dual", stateDir);
    first.resolveMode();
    first.queueForPull(makeBridgeMessage("persisted before crash", 1705312200000));
    first.__testQueue.close();

    const second = createAdapter("pull", stateDir);
    second.resolveMode();

    const result = second.drainMessages();
    expect(result.content[0].text).toContain("persisted before crash");
  });

  test("second drain does not replay already drained rows", () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();
    adapter.queueForPull(makeBridgeMessage("drain once"));

    expect(adapter.drainMessages().content[0].text).toContain("drain once");
    expect(adapter.drainMessages().content[0].text).toBe("No new messages from Codex.");
  });
});

describe("Dual-mode transport: reply pending hint", () => {
  test("handleReply includes pending message hint when queue is non-empty", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({ success: true });
    adapter.queueForPull(makeBridgeMessage("waiting msg 1"));
    adapter.queueForPull(makeBridgeMessage("waiting msg 2"));

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    const text = result.content[0].text;

    expect(text).toContain("Reply sent to Codex.");
    expect(text).toContain("2 unread Codex message");
    expect(text).toContain("get_messages");
  });

  test("handleReply has no hint when queue is empty", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    adapter.replySender = async () => ({ success: true });

    const result = await adapter.handleReply({ chat_id: "test", text: "hello codex" });
    expect(result.content[0].text).toBe("Reply sent to Codex.");
  });

  test("handleReply returns error when text is missing", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleReply({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing required parameter");
  });

  test("handleReply returns error when replySender is not set", async () => {
    const adapter = createAdapter("pull");
    adapter.resolveMode();

    const result = await adapter.handleReply({ text: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bridge not initialized");
  });
});

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs = [];
});
