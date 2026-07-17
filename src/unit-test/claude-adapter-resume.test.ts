import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";

// The MCP Server stores wrapped request handlers in a Map keyed by JSON-RPC
// method. Invoking them directly drives ListTools / CallTool without a transport.
function listTools(adapter: any) {
  const handler = adapter.server._requestHandlers.get("tools/list");
  return handler({ method: "tools/list" }, {});
}

function callTool(adapter: any, name: string, args?: Record<string, unknown>) {
  const handler = adapter.server._requestHandlers.get("tools/call");
  return handler({ method: "tools/call", params: { name, arguments: args ?? {} } }, {});
}

function withMockedChannel(adapter: any, mode: "success" | "fail" = "success") {
  const notifications: any[] = [];
  adapter.server.notification = async (payload: any) => {
    if (mode === "fail") throw new Error("channel unavailable");
    notifications.push(payload);
  };
  return notifications;
}

function makeCodexMessage(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: `m_${Math.random().toString(36).slice(2)}`,
    source: "codex" as const,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

describe("ack_resume MCP tool — registration", () => {
  test("ack_resume appears in ListTools after the general message ACK tool", async () => {
    const adapter = new ClaudeAdapter() as any;
    const result = await listTools(adapter);
    const names = result.tools.map((t: any) => t.name);

    expect(names).toEqual(["reply", "get_messages", "ack_messages", "get_budget", "ack_resume"]);
    expect(result.tools).toHaveLength(5);
  });

  test("ack_resume schema requires resume_id and constrains status enum", async () => {
    const adapter = new ClaudeAdapter() as any;
    const result = await listTools(adapter);
    const ackTool = result.tools.find((t: any) => t.name === "ack_resume");

    expect(ackTool).toBeDefined();
    // Must NOT be advertised as a general send-to-Codex channel.
    expect(ackTool.description.toLowerCase()).toContain("ack");
    expect(ackTool.description).not.toContain("send a message back to Codex");
    expect(ackTool.inputSchema.required).toContain("resume_id");
    expect(ackTool.inputSchema.properties.resume_id.type).toBe("string");
    expect(ackTool.inputSchema.properties.status.enum).toEqual([
      "resumed",
      "declined",
      "already_running",
    ]);
  });
});

describe("ack_resume MCP tool — handleAckResume", () => {
  test("invokes the registered resumeAckHandler with (resumeId, status)", async () => {
    const adapter = new ClaudeAdapter() as any;
    const calls: Array<{ resumeId: string; status: string }> = [];
    adapter.setResumeAckHandler((resumeId: string, status: string) => {
      calls.push({ resumeId, status });
    });

    const res = await callTool(adapter, "ack_resume", {
      resume_id: "system_budget_resume_7",
      status: "resumed",
    });

    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ resumeId: "system_budget_resume_7", status: "resumed" });
  });

  test("status defaults to 'resumed' when omitted", async () => {
    const adapter = new ClaudeAdapter() as any;
    const calls: Array<{ resumeId: string; status: string }> = [];
    adapter.setResumeAckHandler((resumeId: string, status: string) => {
      calls.push({ resumeId, status });
    });

    const res = await callTool(adapter, "ack_resume", { resume_id: "rid_default" });
    expect(res.isError).toBeFalsy();
    expect(calls[0].status).toBe("resumed");
  });

  test("empty resume_id is an error and never calls the handler", async () => {
    const adapter = new ClaudeAdapter() as any;
    let called = false;
    adapter.setResumeAckHandler(() => {
      called = true;
    });

    const res = await callTool(adapter, "ack_resume", { resume_id: "" });
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });

  test("over-long resume_id (>128 chars) is an error", async () => {
    const adapter = new ClaudeAdapter() as any;
    let called = false;
    adapter.setResumeAckHandler(() => {
      called = true;
    });

    const res = await callTool(adapter, "ack_resume", { resume_id: "x".repeat(129) });
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });

  test("illegal status enum value is an error", async () => {
    const adapter = new ClaudeAdapter() as any;
    let called = false;
    adapter.setResumeAckHandler(() => {
      called = true;
    });

    const res = await callTool(adapter, "ack_resume", {
      resume_id: "rid_bad_status",
      status: "finished",
    });
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });

  // Non-string / non-enum inputs must be rejected at the boundary — never coerced
  // and never forwarded to the handler (defense against a malformed MCP call).
  test.each([123, null, { nested: true }])(
    "non-string resume_id (%p) is an error and never calls the handler",
    async (badResumeId) => {
      const adapter = new ClaudeAdapter() as any;
      let called = false;
      adapter.setResumeAckHandler(() => {
        called = true;
      });

      const res = await callTool(adapter, "ack_resume", { resume_id: badResumeId });
      expect(res.isError).toBe(true);
      expect(called).toBe(false);
    },
  );

  test("non-string status (number) is an error and never calls the handler", async () => {
    const adapter = new ClaudeAdapter() as any;
    let called = false;
    adapter.setResumeAckHandler(() => {
      called = true;
    });

    const res = await callTool(adapter, "ack_resume", { resume_id: "rid_num_status", status: 123 });
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });

  test("no registered handler yields an error (not a silent success)", async () => {
    const adapter = new ClaudeAdapter() as any;
    const res = await callTool(adapter, "ack_resume", { resume_id: "rid_no_handler" });
    expect(res.isError).toBe(true);
  });

  test("ack_resume NEVER routes through the reply sender", async () => {
    const adapter = new ClaudeAdapter() as any;
    let replySenderCalled = false;
    adapter.setReplySender(async () => {
      replySenderCalled = true;
      return { success: true };
    });
    adapter.setResumeAckHandler(() => {});

    await callTool(adapter, "ack_resume", { resume_id: "rid_isolated", status: "resumed" });
    expect(replySenderCalled).toBe(false);
  });
});

describe("ack_resume does not regress reply / get_messages / get_budget", () => {
  test("reply still dispatches through the reply sender", async () => {
    const adapter = new ClaudeAdapter() as any;
    let sent = false;
    adapter.setReplySender(async () => {
      sent = true;
      return { success: true };
    });

    const res = await callTool(adapter, "reply", { chat_id: "c1", text: "hi codex" });
    expect(res.isError).toBeFalsy();
    expect(sent).toBe(true);
  });

  test("get_messages still drains the fallback queue", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.queueFallbackMessage(makeCodexMessage("queued msg"));
    const res = await callTool(adapter, "get_messages", {});
    expect(res.content[0].text).toContain("queued msg");
  });

  test("get_budget still responds (unavailable when no snapshot)", async () => {
    const adapter = new ClaudeAdapter() as any;
    const res = await callTool(adapter, "get_budget", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe("text");
  });
});

describe("channel resume push — meta.resume_id", () => {
  test("pushViaChannel surfaces message.resumeId as meta.resume_id", async () => {
    const adapter = new ClaudeAdapter() as any;
    const notifications = withMockedChannel(adapter);

    await adapter.pushNotification(
      makeCodexMessage("额度窗口已刷新", { resumeId: "system_budget_claude_recovered_3" }),
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params.meta.resume_id).toBe("system_budget_claude_recovered_3");
  });

  test("a normal Codex message without resumeId carries no meta.resume_id", async () => {
    const adapter = new ClaudeAdapter() as any;
    const notifications = withMockedChannel(adapter);

    await adapter.pushNotification(makeCodexMessage("plain message"));

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params.meta.resume_id).toBeUndefined();
  });

  test("a resume push that fails falls back to the in-memory queue", async () => {
    const adapter = new ClaudeAdapter() as any;
    withMockedChannel(adapter, "fail");

    await adapter.pushNotification(
      makeCodexMessage("resume content", { resumeId: "rid_fallback" }),
    );

    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  // PR4 core invariant (§4.5): a re-push carries the SAME stable resumeId but a
  // DIFFERENT production-shaped message id (the per-attempt deliveryId). The
  // adapter's LRU dedup is keyed on message.id, so BOTH attempts must reach the
  // channel — if dedup keyed on resumeId (or shared an id), the retry would be
  // silently dropped and an idle Claude session would never be re-woken.
  test("two re-push attempts (same resumeId, distinct production-shaped ids) both reach the channel", async () => {
    const adapter = new ClaudeAdapter() as any;
    const notifications = withMockedChannel(adapter);

    const salt = "abcd1234";
    const rid = "system_budget_claude_recovered_xy_7";
    const attempt0 = `system_budget_resume_${salt}_${rid}_retry0_1`;
    const attempt1 = `system_budget_resume_${salt}_${rid}_retry1_2`;

    await adapter.pushNotification({
      id: attempt0,
      source: "codex" as const,
      content: "resume attempt 0",
      timestamp: Date.now(),
      resumeId: rid,
    });
    await adapter.pushNotification({
      id: attempt1,
      source: "codex" as const,
      content: "resume attempt 1",
      timestamp: Date.now(),
      resumeId: rid,
    });

    // Neither was dropped by LRU dedup — both delivered.
    expect(notifications).toHaveLength(2);
    expect(notifications[0].params.meta.source_message_id).toBe(attempt0);
    expect(notifications[1].params.meta.source_message_id).toBe(attempt1);
    expect(notifications[0].params.meta.message_id).not.toBe(notifications[1].params.meta.message_id);
    // Both carry the SAME stable resumeId so Claude's single ack correlates.
    expect(notifications[0].params.meta.resume_id).toBe(rid);
    expect(notifications[1].params.meta.resume_id).toBe(rid);
  });
});
