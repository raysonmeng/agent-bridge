import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { BridgeMessage } from "./types";

export interface QueueEntry {
  seq: number;
  messageId: string;
  chatId: string;
  source: BridgeMessage["source"];
  content: string;
  timestamp: number;
  marker: string;
  contentHash: string;
  pushedAt: number | null;
  pushError: string | null;
  drainedAt: number | null;
  ackedAt: number | null;
  createdAt: number;
}

export interface EnqueueInput {
  message: BridgeMessage;
  chatId: string;
  messageId: string;
}

export interface AuditEvent {
  event: string;
  direction: "codex_to_claude" | "claude_to_codex" | "internal";
  sender: string;
  chatId: string;
  messageId?: string;
  marker?: string;
  contentLen?: number;
  contentHash?: string;
  preview?: string;
  deliveryMode?: string;
  queued?: boolean;
  pushed?: boolean;
  drained?: boolean;
  requireReply?: boolean;
  error?: string | null;
  pushError?: string | null;
  count?: number;
}

export class PersistentMessageQueue {
  private readonly db: Database;
  private readonly auditFile: string;

  constructor(dbFile: string, auditFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.auditFile = auditFile;
    this.db = new Database(dbFile);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        marker TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        pushed_at INTEGER,
        push_error TEXT,
        drained_at INTEGER,
        acked_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    // Phase C migration: add acked_at column if missing on pre-existing DBs.
    const cols = this.db.query("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "acked_at")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN acked_at INTEGER");
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_undrained_dedupe
      ON messages(chat_id, content_hash)
      WHERE drained_at IS NULL
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_undrained_seq ON messages(drained_at, seq)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_unacked_undrained ON messages(acked_at, drained_at, seq)");
  }

  enqueue(input: EnqueueInput): QueueEntry {
    const contentHash = hashContent(input.message.content);
    const marker = extractMarker(input.message.content);
    const createdAt = Date.now();

    const insert = this.db.query(`
      INSERT OR IGNORE INTO messages (
        message_id, chat_id, source, content, timestamp, marker, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      input.messageId,
      input.chatId,
      input.message.source,
      input.message.content,
      input.message.timestamp,
      marker,
      contentHash,
      createdAt,
    );

    const entry = this.findUndrainedByChatAndHash(input.chatId, contentHash);
    if (!entry) {
      throw new Error("Failed to persist AgentBridge message queue entry.");
    }
    return entry;
  }

  listUndrained(): QueueEntry[] {
    return this.db.query(`
      SELECT
        seq,
        message_id AS messageId,
        chat_id AS chatId,
        source,
        content,
        timestamp,
        marker,
        content_hash AS contentHash,
        pushed_at AS pushedAt,
        push_error AS pushError,
        drained_at AS drainedAt,
        acked_at AS ackedAt,
        created_at AS createdAt
      FROM messages
      WHERE drained_at IS NULL
      ORDER BY seq ASC
    `).all() as QueueEntry[];
  }

  /**
   * Phase C: messages eligible for hook injection — undrained AND unacked.
   * Non-consuming read; callers must not mutate state on this query alone.
   */
  listUnackedUndrained(): QueueEntry[] {
    return this.db.query(`
      SELECT
        seq,
        message_id AS messageId,
        chat_id AS chatId,
        source,
        content,
        timestamp,
        marker,
        content_hash AS contentHash,
        pushed_at AS pushedAt,
        push_error AS pushError,
        drained_at AS drainedAt,
        acked_at AS ackedAt,
        created_at AS createdAt
      FROM messages
      WHERE drained_at IS NULL AND acked_at IS NULL
      ORDER BY seq ASC
    `).all() as QueueEntry[];
  }

  countUnackedUndrained(): number {
    const row = this.db.query(
      "SELECT COUNT(*) AS count FROM messages WHERE drained_at IS NULL AND acked_at IS NULL"
    ).get() as { count: number };
    return row.count;
  }

  countUndrained(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM messages WHERE drained_at IS NULL").get() as { count: number };
    return row.count;
  }

  markPushed(messageId: string, pushedAt = Date.now()) {
    this.db.query("UPDATE messages SET pushed_at = ?, push_error = NULL WHERE message_id = ?").run(pushedAt, messageId);
  }

  markPushFailed(messageId: string, error: string) {
    this.db.query("UPDATE messages SET push_error = ? WHERE message_id = ?").run(error, messageId);
  }

  markDrained(messageIds: string[], drainedAt = Date.now()) {
    if (messageIds.length === 0) return;
    const update = this.db.query("UPDATE messages SET drained_at = ? WHERE message_id = ? AND drained_at IS NULL");
    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) update.run(drainedAt, id);
    });
    transaction(messageIds);
  }

  /**
   * Phase C: mark all undrained messages on a chat as acked.
   * Called when Claude replies to that chat — signals the hook layer
   * to stop re-injecting these on subsequent UserPromptSubmit events.
   * Non-destructive to drained_at; get_messages can still consume.
   * Returns the number of rows actually flipped (zero is a no-op).
   */
  ackByChatId(chatId: string, ackedAt = Date.now()): number {
    const result = this.db
      .query("UPDATE messages SET acked_at = ? WHERE chat_id = ? AND drained_at IS NULL AND acked_at IS NULL")
      .run(ackedAt, chatId);
    // bun:sqlite returns { changes, lastInsertRowid }
    return Number((result as { changes?: number }).changes ?? 0);
  }

  markOldestUndrainedDropped(droppedAt = Date.now()): QueueEntry | null {
    const entry = this.db.query(`
      SELECT
        seq,
        message_id AS messageId,
        chat_id AS chatId,
        source,
        content,
        timestamp,
        marker,
        content_hash AS contentHash,
        pushed_at AS pushedAt,
        push_error AS pushError,
        drained_at AS drainedAt,
        acked_at AS ackedAt,
        created_at AS createdAt
      FROM messages
      WHERE drained_at IS NULL
      ORDER BY seq ASC
      LIMIT 1
    `).get() as QueueEntry | null;

    if (!entry) return null;
    this.db.query("UPDATE messages SET drained_at = ? WHERE message_id = ? AND drained_at IS NULL").run(droppedAt, entry.messageId);
    return entry;
  }

  audit(event: AuditEvent) {
    try {
      mkdirSync(dirname(this.auditFile), { recursive: true });
      appendFileSync(this.auditFile, JSON.stringify({ ts: Date.now(), ...event }) + "\n", "utf-8");
    } catch {
      // Audit is diagnostic only; it must never block message delivery.
    }
  }

  close() {
    this.db.close();
  }

  private findUndrainedByChatAndHash(chatId: string, contentHash: string): QueueEntry | null {
    return this.db.query(`
      SELECT
        seq,
        message_id AS messageId,
        chat_id AS chatId,
        source,
        content,
        timestamp,
        marker,
        content_hash AS contentHash,
        pushed_at AS pushedAt,
        push_error AS pushError,
        drained_at AS drainedAt,
        acked_at AS ackedAt,
        created_at AS createdAt
      FROM messages
      WHERE chat_id = ? AND content_hash = ? AND drained_at IS NULL
      ORDER BY seq ASC
      LIMIT 1
    `).get(chatId, contentHash) as QueueEntry | null;
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function extractMarker(content: string): string {
  const match = content.match(/^\[(IMPORTANT|STATUS|FYI)\]/);
  return match?.[1] ?? "untagged";
}

export function previewContent(content: string, maxLength = 160): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
