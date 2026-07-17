import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, type DeliveryScheduler } from "../claude-adapter";

interface ScheduledTask {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

class FakeScheduler implements DeliveryScheduler {
  readonly tasks: ScheduledTask[] = [];

  setTimeout(callback: () => void, delayMs: number): ScheduledTask {
    const task = { callback, delayMs, cancelled: false };
    this.tasks.push(task);
    return task;
  }

  clearTimeout(handle: unknown): void {
    (handle as ScheduledTask).cancelled = true;
  }

  activeTasks(): ScheduledTask[] {
    return this.tasks.filter((task) => !task.cancelled);
  }

  async fireNext(): Promise<void> {
    const task = this.tasks.find((candidate) => !candidate.cancelled);
    if (!task) throw new Error("No scheduled task to fire");
    task.cancelled = true;
    task.callback();
    await Bun.sleep(0);
  }
}

function message(id: string, content: string, options: { resumeId?: string; timestamp?: number } = {}) {
  return {
    id,
    source: "codex" as const,
    content,
    timestamp: options.timestamp ?? 1_705_312_200_000,
    ...(options.resumeId ? { resumeId: options.resumeId } : {}),
  };
}

function adapterWithChannel(
  channel: (payload: any) => Promise<void> = async () => {},
  options: Record<string, unknown> = {},
): { adapter: any; notifications: any[] } {
  const notifications: any[] = [];
  const adapter = new ClaudeAdapter(undefined, options) as any;
  adapter.server.notification = async (payload: any) => {
    notifications.push(payload);
    await channel(payload);
  };
  return { adapter, notifications };
}

function mailboxText(adapter: any, ackIds: string[] = []): string {
  return adapter.drainMessages(ackIds).content[0].text;
}

function deliveryIdFor(adapter: any, sourceMessageId: string): string {
  const entry = adapter.pendingMessages.find((candidate: any) => candidate.sourceMessageId === sourceMessageId);
  if (!entry) throw new Error(`No pending delivery for source ID ${sourceMessageId}`);
  return entry.id;
}

function pendingSourceIds(adapter: any): string[] {
  return adapter.pendingMessages.map((entry: any) => entry.sourceMessageId);
}

function callTool(adapter: any, name: string, args: Record<string, unknown> = {}) {
  const handler = adapter.server._requestHandlers.get("tools/call");
  return handler({ method: "tools/call", params: { name, arguments: args } }, {});
}

describe("Reliable mailbox issue 223 behavior", () => {
  test("A: a silently ignored successful Channel write stays recoverable", async () => {
    const { adapter, notifications } = adapterWithChannel();

    await adapter.pushNotification(message("silent-1", "work result"));
    const id = deliveryIdFor(adapter, "silent-1");

    expect(notifications).toHaveLength(1);
    expect(mailboxText(adapter)).toContain(`[id: ${id}]`);
    expect(mailboxText(adapter)).toContain(`[id: ${id}]`);
    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  test("B: Channel delivery exposes an ACK path that prevents later pull duplication", async () => {
    const scheduler = new FakeScheduler();
    const { adapter, notifications } = adapterWithChannel(async () => {}, {
      deliveryScheduler: scheduler,
      deliveryRetryBaseMs: 10,
    });

    await adapter.pushNotification(message("channel-1", "apply this result"));
    const id = deliveryIdFor(adapter, "channel-1");
    const pushed = notifications[0];
    expect(pushed.params.meta.message_id).toBe(id);
    expect(pushed.params.meta.source_message_id).toBe("channel-1");
    expect(pushed.params.meta.ack_tool).toBe("ack_messages");
    expect(pushed.params.content).toContain("call ack_messages");

    const ack = await callTool(adapter, "ack_messages", { ack_ids: [id] });
    expect(ack.content[0].text).toContain("Acknowledged 1 message");
    expect(mailboxText(adapter)).toBe("No new messages from Codex.");
    expect(scheduler.activeTasks()).toHaveLength(0);
  });

  test("B: an ACK during an in-flight Channel write cannot re-arm retry", async () => {
    const scheduler = new FakeScheduler();
    let releaseChannel: () => void = () => {};
    const { adapter } = adapterWithChannel(
      () => new Promise<void>((resolve) => { releaseChannel = resolve; }),
      { deliveryScheduler: scheduler, deliveryRetryBaseMs: 10 },
    );

    const push = adapter.pushNotification(message("in-flight-1", "process while write waits"));
    expect(adapter.getPendingMessageCount()).toBe(1);
    await callTool(adapter, "ack_messages", { ack_ids: [deliveryIdFor(adapter, "in-flight-1")] });
    releaseChannel();
    await push;

    expect(adapter.getPendingMessageCount()).toBe(0);
    expect(scheduler.activeTasks()).toHaveLength(0);
  });

  test("C: a throwing Channel push leaves exactly one retrievable entry", async () => {
    const { adapter } = adapterWithChannel(async () => {
      throw new Error("transport failed");
    });

    await adapter.pushNotification(message("throw-1", "recover me"));

    expect(pendingSourceIds(adapter)).toEqual(["throw-1"]);
    expect(mailboxText(adapter)).toContain("recover me");
  });

  test("D: repeated polls are at least once and ACK removes only requested stable IDs", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("poll-1", "first"));
    await adapter.pushNotification(message("poll-2", "second"));
    const firstId = deliveryIdFor(adapter, "poll-1");
    const secondId = deliveryIdFor(adapter, "poll-2");

    const first = mailboxText(adapter);
    const second = mailboxText(adapter);
    expect(second).toBe(first);

    const afterPartialAck = (await callTool(adapter, "get_messages", { ack_ids: [firstId] })).content[0].text;
    expect(afterPartialAck).not.toContain(`[id: ${firstId}]`);
    expect(afterPartialAck).toContain(`[id: ${secondId}]`);
    expect(pendingSourceIds(adapter)).toEqual(["poll-2"]);
  });

  test("E: processing without a completed ACK leaves the message recoverable", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("lost-ack-1", "processed before crash"));

    expect(mailboxText(adapter)).toContain(`[id: ${deliveryIdFor(adapter, "lost-ack-1")}]`);
    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  test("E: a committed ACK with a lost response is idempotent when repeated", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("lost-response-1", "processed"));
    const id = deliveryIdFor(adapter, "lost-response-1");

    await callTool(adapter, "ack_messages", { ack_ids: [id] });
    const repeated = await callTool(adapter, "ack_messages", { ack_ids: [id] });

    expect(repeated.isError).toBeUndefined();
    expect(repeated.content[0].text).toContain("Already acknowledged or unknown IDs");
    expect(mailboxText(adapter)).toBe("No new messages from Codex.");
  });
});

describe("Reliable mailbox restart and reconnect boundaries", () => {
  test("F: a Claude MCP adapter restart loses the in-memory mailbox", async () => {
    const { adapter: beforeRestart } = adapterWithChannel();
    await beforeRestart.pushNotification(message("restart-1", "ephemeral"));

    const { adapter: afterRestart } = adapterWithChannel();
    expect(beforeRestart.getPendingMessageCount()).toBe(1);
    expect(afterRestart.getPendingMessageCount()).toBe(0);
  });

  test("F: a Claude Channel reconnect using the same adapter preserves the mailbox", async () => {
    const { adapter } = adapterWithChannel(async () => {
      throw new Error("disconnected");
    });
    await adapter.pushNotification(message("claude-reconnect-1", "waiting"));

    adapter.server = { notification: async () => {} };
    expect(mailboxText(adapter)).toContain("waiting");
  });

  test("F: a daemon client replacement does not clear a live adapter mailbox", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("daemon-restart-1", "waiting"));

    adapter.setReplySender(async () => ({ success: true }));
    adapter.setReplySender(async () => ({ success: true }));
    expect(mailboxText(adapter)).toContain("waiting");
  });

  test("F: a Codex reconnect does not clear completed messages held by the live adapter", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("codex-reconnect-1", "completed reply"));

    adapter.setReplySender(async () => ({ success: true }));
    expect(mailboxText(adapter)).toContain("completed reply");
  });
});

describe("Reliable mailbox ordering, concurrency, and dedupe", () => {
  test("G: rapid arrivals enter the mailbox in invocation order", async () => {
    const releases: Array<() => void> = [];
    const { adapter } = adapterWithChannel(
      () => new Promise<void>((resolve) => releases.push(resolve)),
      { deliveryMaxAttempts: 1 },
    );

    const first = adapter.pushNotification(message("rapid-1", "first"));
    const second = adapter.pushNotification(message("rapid-2", "second"));
    const third = adapter.pushNotification(message("rapid-3", "third"));
    expect(pendingSourceIds(adapter)).toEqual(["rapid-1", "rapid-2", "rapid-3"]);

    releases.reverse().forEach((release) => release());
    await Promise.all([first, second, third]);
    expect(pendingSourceIds(adapter)).toEqual(["rapid-1", "rapid-2", "rapid-3"]);
  });

  test("G: ACK concurrent with a new arrival cannot delete the new ID", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("old-1", "old"));
    const oldId = deliveryIdFor(adapter, "old-1");

    const arrival = adapter.pushNotification(message("new-1", "new"));
    adapter.handleAckMessages({ ack_ids: [oldId] });
    await arrival;

    expect(pendingSourceIds(adapter)).toEqual(["new-1"]);
  });

  test("G: active IDs remain protected after dedupe TTL and capacity eviction", async () => {
    let now = 1_000;
    const { adapter } = adapterWithChannel(async () => {}, {
      dedupeCapacity: 1,
      dedupeTtlMs: 10,
      now: () => now,
    });

    await adapter.pushNotification(message("stable-1", "original"));
    await adapter.pushNotification(message("other-1", "other"));
    now += 100;
    await adapter.pushNotification(message("stable-1", "original"));
    await adapter.pushNotification(message("stable-1", "different"));

    expect(adapter.pendingMessages.filter((entry: any) => entry.sourceMessageId === "stable-1")).toHaveLength(1);
    const collision = adapter.pendingMessages.find((entry: any) => entry.content === "different");
    expect(collision.sourceMessageId).toMatch(/^stable-1_collision_[a-f0-9]{12}$/);

    adapter.handleAckMessages({ ack_ids: [deliveryIdFor(adapter, "stable-1")] });
    expect(adapter.pendingMessages.map((entry: any) => entry.id)).toContain(collision.id);
  });

  test("G: a conflict alias suppresses an original-ID replay after TTL expiry", async () => {
    let now = 1_000;
    const { adapter, notifications } = adapterWithChannel(async () => {}, {
      dedupeTtlMs: 10,
      now: () => now,
      deliveryMaxAttempts: 1,
    });
    await adapter.pushNotification(message("alias-ttl", "payload A"));
    const originalDeliveryId = deliveryIdFor(adapter, "alias-ttl");
    await adapter.pushNotification(message("alias-ttl", "payload B"));
    adapter.handleAckMessages({ ack_ids: [originalDeliveryId] });

    now += 100;
    await adapter.pushNotification(message("alias-ttl", "payload B"));

    expect(adapter.pendingMessages.map((entry: any) => entry.content)).toEqual(["payload B"]);
    expect(notifications).toHaveLength(2);
  });

  test("G: a conflict alias suppresses an original-ID replay after cache eviction", async () => {
    const { adapter, notifications } = adapterWithChannel(async () => {}, {
      dedupeCapacity: 1,
      deliveryMaxAttempts: 1,
    });
    await adapter.pushNotification(message("alias-capacity", "payload A"));
    const originalDeliveryId = deliveryIdFor(adapter, "alias-capacity");
    await adapter.pushNotification(message("alias-capacity", "payload B"));
    adapter.handleAckMessages({ ack_ids: [originalDeliveryId] });
    await adapter.pushNotification(message("alias-filler", "filler"));
    adapter.handleAckMessages({ ack_ids: [deliveryIdFor(adapter, "alias-filler")] });

    await adapter.pushNotification(message("alias-capacity", "payload B"));

    expect(adapter.pendingMessages.map((entry: any) => entry.content)).toEqual(["payload B"]);
    expect(notifications).toHaveLength(3);
  });

  test("G: unsafe or overlong source IDs become stable ACK-safe IDs", async () => {
    const { adapter, notifications } = adapterWithChannel();
    await adapter.pushNotification(message(`unsafe\n${"x".repeat(600)}`, "normalized"));

    const id = adapter.pendingMessages[0].id;
    expect(adapter.pendingMessages[0].sourceMessageId).toMatch(/^agentbridge_[a-f0-9]{32}$/);
    expect(id).toMatch(/^agentbridge_[a-f0-9]{32}_delivery_[a-f0-9]{12}_1$/);
    expect(notifications[0].params.meta.message_id).toBe(id);
    expect(adapter.handleAckMessages({ ack_ids: [id] }).isError).toBeUndefined();
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("G: a late ACK cannot delete a newer delivery generation after dedupe TTL", async () => {
    let now = 1_000;
    const { adapter } = adapterWithChannel(async () => {}, {
      dedupeTtlMs: 10,
      now: () => now,
      deliveryMaxAttempts: 1,
    });
    await adapter.pushNotification(message("reuse-id", "old payload"));
    const oldDeliveryId = deliveryIdFor(adapter, "reuse-id");
    adapter.handleAckMessages({ ack_ids: [oldDeliveryId] });

    now += 100;
    await adapter.pushNotification(message("reuse-id", "new payload"));
    const newDeliveryId = deliveryIdFor(adapter, "reuse-id");
    expect(newDeliveryId).not.toBe(oldDeliveryId);

    adapter.handleAckMessages({ ack_ids: [oldDeliveryId] });
    expect(adapter.pendingMessages.map((entry: any) => entry.content)).toEqual(["new payload"]);
  });

  test("G: a late ACK cannot delete a newer generation after dedupe capacity eviction", async () => {
    const { adapter } = adapterWithChannel(async () => {}, {
      dedupeCapacity: 1,
      deliveryMaxAttempts: 1,
    });
    await adapter.pushNotification(message("capacity-reuse", "old payload"));
    const oldDeliveryId = deliveryIdFor(adapter, "capacity-reuse");
    adapter.handleAckMessages({ ack_ids: [oldDeliveryId] });
    await adapter.pushNotification(message("capacity-filler", "filler"));
    adapter.handleAckMessages({ ack_ids: [deliveryIdFor(adapter, "capacity-filler")] });

    await adapter.pushNotification(message("capacity-reuse", "new payload"));
    adapter.handleAckMessages({ ack_ids: [oldDeliveryId] });

    expect(adapter.pendingMessages.map((entry: any) => entry.content)).toEqual(["new payload"]);
  });

  test("G: an evicted in-flight push cannot replace a newer generation's retry", async () => {
    const scheduler = new FakeScheduler();
    let releaseOld: () => void = () => {};
    const { adapter } = adapterWithChannel(
      (payload) => payload.params.content.endsWith("old payload")
        ? new Promise<void>((resolve) => { releaseOld = resolve; })
        : Promise.resolve(),
      { maxBufferedMessages: 1, deliveryScheduler: scheduler, deliveryRetryBaseMs: 10 },
    );

    const oldPush = adapter.pushNotification(message("inflight-reuse", "old payload"));
    const oldDeliveryId = adapter.pendingMessages[0].id;
    await adapter.pushNotification(message("inflight-reuse", "new payload"));
    const newDeliveryId = adapter.pendingMessages[0].id;
    releaseOld();
    await oldPush;

    expect(newDeliveryId).not.toBe(oldDeliveryId);
    expect(adapter.pendingMessages.map((entry: any) => entry.content)).toEqual(["new payload"]);
    expect(adapter.deliveryRetries.has(oldDeliveryId)).toBe(false);
    expect(adapter.deliveryRetries.get(newDeliveryId)?.message.content).toBe("new payload");
  });

  test("G: retry attempts preserve Channel and mailbox FIFO order", async () => {
    const scheduler = new FakeScheduler();
    const initialResolvers = new Map<string, () => void>();
    const initialSeen = new Set<string>();
    const { adapter, notifications } = adapterWithChannel((payload) => {
      const sourceId = payload.params.meta.source_message_id as string;
      if (initialSeen.has(sourceId)) return Promise.resolve();
      initialSeen.add(sourceId);
      return new Promise<void>((resolve) => initialResolvers.set(sourceId, resolve));
    }, {
      deliveryScheduler: scheduler,
      deliveryRetryBaseMs: 10,
      deliveryMaxAttempts: 2,
    });

    const first = adapter.pushNotification(message("retry-order-1", "first"));
    const second = adapter.pushNotification(message("retry-order-2", "second"));
    initialResolvers.get("retry-order-2")!();
    initialResolvers.get("retry-order-1")!();
    await Promise.all([first, second]);

    await scheduler.fireNext();
    await scheduler.fireNext();

    expect(pendingSourceIds(adapter)).toEqual(["retry-order-1", "retry-order-2"]);
    expect(notifications.map((item) => item.params.meta.source_message_id)).toEqual([
      "retry-order-1", "retry-order-2", "retry-order-1", "retry-order-2",
    ]);
  });

  test("G: a never-settling initial Channel promise does not prevent bounded retry scheduling", async () => {
    const scheduler = new FakeScheduler();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { adapter, notifications } = adapterWithChannel(() => blocked, {
      deliveryScheduler: scheduler,
      deliveryRetryBaseMs: 10,
      deliveryMaxAttempts: 2,
    });

    const initial = adapter.pushNotification(message("blocked-1", "still recoverable"));
    expect(scheduler.activeTasks()).toHaveLength(1);
    await scheduler.fireNext();
    expect(notifications).toHaveLength(2);
    expect(scheduler.activeTasks()).toHaveLength(0);

    release();
    await initial;
  });

  test("G: separate pairs and Claude adapter instances do not share mailbox state", async () => {
    const { adapter: pairOne } = adapterWithChannel();
    const { adapter: pairTwo } = adapterWithChannel();
    await pairOne.pushNotification(message("pair-1", "only pair one"));

    expect(pairOne.getPendingMessageCount()).toBe(1);
    expect(pairTwo.getPendingMessageCount()).toBe(0);
  });
});

describe("Reliable mailbox retries and special messages", () => {
  test("H: retry is bounded with exponential delays and retains the message after exhaustion", async () => {
    const scheduler = new FakeScheduler();
    const { adapter, notifications } = adapterWithChannel(async () => {}, {
      deliveryScheduler: scheduler,
      deliveryRetryBaseMs: 25,
      deliveryMaxAttempts: 3,
    });
    await adapter.pushNotification(message("bounded-1", "keep me"));

    expect(scheduler.activeTasks().map((task) => task.delayMs)).toEqual([25]);
    await scheduler.fireNext();
    expect(scheduler.activeTasks().map((task) => task.delayMs)).toEqual([50]);
    await scheduler.fireNext();

    expect(notifications).toHaveLength(3);
    expect(scheduler.activeTasks()).toHaveLength(0);
    expect(mailboxText(adapter)).toContain(`[id: ${deliveryIdFor(adapter, "bounded-1")}]`);
  });

  test("H: system messages use the same reliable mailbox", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("system_notice_1", "important system notice"));

    expect(mailboxText(adapter)).toContain("important system notice");
  });

  test("H: an overflow-evicted ID can be recovered if the source replays it", async () => {
    const { adapter, notifications } = adapterWithChannel(async () => {}, { maxBufferedMessages: 1 });
    await adapter.pushNotification(message("overflow-1", "first"));
    await adapter.pushNotification(message("overflow-2", "second"));
    await adapter.pushNotification(message("overflow-1", "first"));

    expect(notifications).toHaveLength(3);
    expect(pendingSourceIds(adapter)).toEqual(["overflow-1"]);
  });

  test("H: an oversized ID is not tombstoned when its content cannot be admitted", async () => {
    const { adapter, notifications } = adapterWithChannel(async () => {}, { maxBufferedBytes: 4 });
    await adapter.pushNotification(message("oversized-1", "12345"));
    await adapter.pushNotification(message("oversized-1", "12345"));

    expect(notifications).toHaveLength(2);
    expect(adapter.getPendingMessageCount()).toBe(0);
    expect(mailboxText(adapter)).toContain("2 oversized messages");
  });

  test("H: acknowledging one budget-resume attempt retires all siblings and stops daemon retries", async () => {
    const { adapter } = adapterWithChannel();
    const resumeAcks: Array<{ id: string; status: string }> = [];
    adapter.setResumeAckHandler((id: string, status: string) => resumeAcks.push({ id, status }));

    await adapter.pushNotification(message("resume-attempt-1", "resume", { resumeId: "resume-logical-1" }));
    await adapter.pushNotification(message("resume-attempt-2", "resume", { resumeId: "resume-logical-1" }));
    expect(adapter.getPendingMessageCount()).toBe(2);

    adapter.handleAckMessages({ ack_ids: [deliveryIdFor(adapter, "resume-attempt-1")] });
    expect(adapter.getPendingMessageCount()).toBe(0);
    expect(resumeAcks).toEqual([{ id: "resume-logical-1", status: "resumed" }]);
  });

  test("H: ack_resume also retires every queued delivery attempt", async () => {
    const { adapter } = adapterWithChannel();
    adapter.setResumeAckHandler(() => {});
    await adapter.pushNotification(message("resume-tool-1", "resume", { resumeId: "resume-logical-2" }));
    await adapter.pushNotification(message("resume-tool-2", "resume", { resumeId: "resume-logical-2" }));

    const result = await adapter.handleAckResume({ resume_id: "resume-logical-2" });
    expect(result.content[0].text).toContain("mailbox_messages=2");
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("H: ACK input validation is bounded and unknown IDs are idempotent", () => {
    const { adapter } = adapterWithChannel();
    expect(adapter.handleAckMessages({}).isError).toBe(true);
    expect(adapter.handleAckMessages({ ack_ids: [] }).isError).toBe(true);
    expect(adapter.handleAckMessages({ ack_ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }).isError).toBe(true);

    const unknown = adapter.handleAckMessages({ ack_ids: ["already-gone"] });
    expect(unknown.isError).toBeUndefined();
    expect(unknown.content[0].text).toContain("Already acknowledged or unknown IDs");
  });

  test("I: default bounds and retry parameters match the documented contract", () => {
    const adapter = new ClaudeAdapter() as any;
    expect(adapter.maxBufferedMessages).toBe(100);
    expect(adapter.maxBufferedBytes).toBe(4 * 1024 * 1024);
    expect(adapter.dedupeCapacity).toBe(2048);
    expect(adapter.dedupeTtlMs).toBe(20 * 60 * 1000);
    expect(adapter.deliveryRetryBaseMs).toBe(60_000);
    expect(adapter.deliveryMaxAttempts).toBe(3);
    expect(adapter.ackIdsCap).toBe(100);
  });

  test("I: resume pushes carry ack_resume meta and unprefixed content", async () => {
    const { adapter, notifications } = adapterWithChannel();
    await adapter.pushNotification(message("resume-shape-1", "resume now", { resumeId: "resume-shape" }));

    expect(notifications).toHaveLength(1);
    const pushed = notifications[0];
    expect(pushed.params.meta.ack_tool).toBe("ack_resume");
    expect(pushed.params.meta.ack_required).toBe(true);
    expect(pushed.params.meta.resume_id).toBe("resume-shape");
    expect(pushed.params.content).toBe("resume now");
  });

  test("I: every Channel retry repeats the same stable delivery ID with a fresh attempt ID", async () => {
    const scheduler = new FakeScheduler();
    const { adapter, notifications } = adapterWithChannel(async () => {}, {
      deliveryScheduler: scheduler,
      deliveryRetryBaseMs: 10,
    });

    await adapter.pushNotification(message("retry-stable-1", "needs ack"));
    await scheduler.fireNext();
    await scheduler.fireNext();

    expect(notifications).toHaveLength(3);
    const messageIds = new Set(notifications.map((n) => n.params.meta.message_id));
    expect(messageIds.size).toBe(1);
    expect(messageIds.values().next().value).toBe(deliveryIdFor(adapter, "retry-stable-1"));
    const attemptIds = new Set(notifications.map((n) => n.params.meta.delivery_attempt_id));
    expect(attemptIds.size).toBe(3);
  });

  test("I: acknowledging one message releases exactly its bytes from the buffer accounting", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("bytes-1", "12345"));
    await adapter.pushNotification(message("bytes-2", "1234567"));
    expect(adapter.pendingMessageBytes).toBe(12);

    adapter.handleAckMessages({ ack_ids: [deliveryIdFor(adapter, "bytes-1")] });
    expect(adapter.pendingMessageBytes).toBe(7);
    adapter.handleAckMessages({ ack_ids: [deliveryIdFor(adapter, "bytes-2")] });
    expect(adapter.pendingMessageBytes).toBe(0);
  });

  test("I: get_messages rejects malformed ack_ids without draining", async () => {
    const { adapter } = adapterWithChannel();
    await adapter.pushNotification(message("guard-1", "still here"));

    const notArray = await callTool(adapter, "get_messages", { ack_ids: "not-an-array" });
    expect(notArray.isError).toBe(true);
    const emptyItem = await callTool(adapter, "get_messages", { ack_ids: [""] });
    expect(emptyItem.isError).toBe(true);
    const overCap = await callTool(adapter, "get_messages", {
      ack_ids: Array.from({ length: 101 }, (_, i) => `id-${i}`),
    });
    expect(overCap.isError).toBe(true);
    expect(overCap.content[0].text).toContain("maximum is 100");
    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  test("I: a mailbox configured above 100 keeps its drain epilogue acknowledgeable in one call", async () => {
    const { adapter } = adapterWithChannel(async () => {}, { maxBufferedMessages: 150 });
    for (let i = 0; i < 120; i++) {
      await adapter.pushNotification(message(`bulk-${i}`, `payload ${i}`));
    }
    expect(adapter.getPendingMessageCount()).toBe(120);

    const listed = await adapter.server._requestHandlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const ackTool = listed.tools.find((tool: any) => tool.name === "ack_messages");
    expect(ackTool.inputSchema.properties.ack_ids.maxItems).toBe(150);

    const allIds = adapter.pendingMessages.map((entry: any) => entry.id);
    const ack = await callTool(adapter, "ack_messages", { ack_ids: allIds });
    expect(ack.isError).toBeUndefined();
    expect(ack.content[0].text).toContain("Acknowledged 120 messages");
    expect(adapter.getPendingMessageCount()).toBe(0);
  });

  test("I: the byte bound measures UTF-8 bytes, not string length", async () => {
    const { adapter } = adapterWithChannel(async () => {}, { maxBufferedBytes: 8 });
    // Three euro signs: length 3, but 9 UTF-8 bytes — must be rejected as oversized.
    await adapter.pushNotification(message("utf8-over", "€€€"));
    expect(adapter.getPendingMessageCount()).toBe(0);
    expect(adapter.oversizedMessageCount).toBe(1);
    expect(adapter.oversizedMessageBytes).toBe(9);

    // Eight ASCII bytes of the same magnitude are admitted.
    await adapter.pushNotification(message("utf8-fit", "12345678"));
    expect(adapter.getPendingMessageCount()).toBe(1);
  });

  test("I: an unadmitted oversized push is honest — no ACK contract, no mailbox claim", async () => {
    const { adapter, notifications } = adapterWithChannel(async () => {}, { maxBufferedBytes: 4 });
    await adapter.pushNotification(message("oversized-honest", "12345"));

    expect(notifications).toHaveLength(1);
    const pushed = notifications[0];
    expect(pushed.params.meta.ack_required).toBe(false);
    expect(pushed.params.meta.ack_tool).toBeUndefined();
    expect(pushed.params.content).toContain("[AgentBridge oversized delivery id:");
    expect(pushed.params.content).not.toContain("call ack_messages with ack_ids");
    expect(pushed.params.content).toContain("12345");
    expect(adapter.getPendingMessageCount()).toBe(0);
    // No retry may be armed for a message the mailbox never admitted.
    expect(adapter.deliveryRetries.size).toBe(0);
  });
});
