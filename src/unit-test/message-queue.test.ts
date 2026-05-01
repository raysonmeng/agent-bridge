import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersistentMessageQueue } from "../message-queue";
import type { BridgeMessage } from "../types";

const tempDirs: string[] = [];

function newQueue(): { queue: PersistentMessageQueue; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentbridge-queue-test-"));
  tempDirs.push(dir);
  return {
    queue: new PersistentMessageQueue(
      join(dir, "queue.db"),
      join(dir, "transcript.jsonl"),
    ),
    dir,
  };
}

function makeMsg(content: string): BridgeMessage {
  return {
    id: `test_${Math.random().toString(36).slice(2)}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Phase C: acked_at column + ackByChatId", () => {
  test("acked_at column exists after construction (fresh DB)", () => {
    const { queue } = newQueue();
    // listUnackedUndrained must work even with no rows; it would throw if column was missing.
    expect(queue.listUnackedUndrained()).toEqual([]);
    expect(queue.countUnackedUndrained()).toBe(0);
    queue.close();
  });

  test("freshly enqueued message has ackedAt = null and shows up in unacked list", () => {
    const { queue } = newQueue();
    queue.enqueue({
      message: makeMsg("hello A"),
      chatId: "chat-1",
      messageId: "m-1",
    });
    const list = queue.listUnackedUndrained();
    expect(list).toHaveLength(1);
    expect(list[0].ackedAt).toBeNull();
    expect(list[0].drainedAt).toBeNull();
    expect(queue.countUnackedUndrained()).toBe(1);
    queue.close();
  });

  test("ackByChatId flips acked_at and removes from unacked list (non-consuming for drain)", () => {
    const { queue } = newQueue();
    queue.enqueue({ message: makeMsg("a"), chatId: "chat-1", messageId: "m-1" });
    queue.enqueue({ message: makeMsg("b"), chatId: "chat-1", messageId: "m-2" });
    queue.enqueue({ message: makeMsg("c"), chatId: "chat-2", messageId: "m-3" });

    const flipped = queue.ackByChatId("chat-1");
    expect(flipped).toBe(2);

    // Unacked list should now only contain chat-2
    const unacked = queue.listUnackedUndrained();
    expect(unacked).toHaveLength(1);
    expect(unacked[0].chatId).toBe("chat-2");
    expect(queue.countUnackedUndrained()).toBe(1);

    // But undrained list (used by get_messages) still sees all 3 — ack does NOT consume.
    const undrained = queue.listUndrained();
    expect(undrained).toHaveLength(3);
    queue.close();
  });

  test("ackByChatId is idempotent (second call returns 0 changes)", () => {
    const { queue } = newQueue();
    queue.enqueue({ message: makeMsg("x"), chatId: "chat-1", messageId: "m-1" });
    expect(queue.ackByChatId("chat-1")).toBe(1);
    expect(queue.ackByChatId("chat-1")).toBe(0);
    queue.close();
  });

  test("ackByChatId on unknown chat is no-op", () => {
    const { queue } = newQueue();
    queue.enqueue({ message: makeMsg("x"), chatId: "chat-1", messageId: "m-1" });
    expect(queue.ackByChatId("never-seen")).toBe(0);
    expect(queue.countUnackedUndrained()).toBe(1);
    queue.close();
  });

  test("draining a message removes it from unacked list even if not yet acked", () => {
    const { queue } = newQueue();
    queue.enqueue({ message: makeMsg("d"), chatId: "chat-1", messageId: "m-1" });
    expect(queue.countUnackedUndrained()).toBe(1);
    queue.markDrained(["m-1"]);
    expect(queue.countUnackedUndrained()).toBe(0);
    queue.close();
  });

  test("migration: existing DB without acked_at column is upgraded on open", () => {
    // Create a queue, close it, then re-open with the same path.
    // The second constructor must run the ALTER TABLE migration safely.
    const dir = mkdtempSync(join(tmpdir(), "agentbridge-queue-migrate-"));
    tempDirs.push(dir);
    const dbFile = join(dir, "queue.db");
    const auditFile = join(dir, "transcript.jsonl");

    const q1 = new PersistentMessageQueue(dbFile, auditFile);
    q1.enqueue({ message: makeMsg("pre"), chatId: "chat-1", messageId: "m-1" });
    q1.close();

    const q2 = new PersistentMessageQueue(dbFile, auditFile);
    const list = q2.listUnackedUndrained();
    expect(list).toHaveLength(1);
    expect(list[0].ackedAt).toBeNull();
    expect(q2.ackByChatId("chat-1")).toBe(1);
    q2.close();
  });
});
