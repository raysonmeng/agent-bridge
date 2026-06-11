/**
 * Claude Code MCP Server — Push Message Transport
 *
 * Delivery is always push (real-time notifications/claude/channel). When a
 * push fails, the message falls back to an in-memory queue drained by the
 * get_messages tool — a per-message fallback, not a configurable mode.
 * (The old AGENTBRIDGE_MODE=pull delivery mode was removed: it could not wake
 * an idle session, which silently broke the budget RESUME chain.)
 *
 * Emits:
 *   - "ready"   ()                   — MCP connected
 *   - "reply"   (msg: BridgeMessage) — Claude used the reply tool
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createProcessLogger, type ProcessLogger } from "./process-log";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";
import type { BudgetSnapshot } from "./budget/types";
import { renderBudgetSnapshot, BUDGET_UNAVAILABLE_TEXT } from "./budget/render";

export type ReplySender = (
  msg: BridgeMessage,
  requireReply?: boolean,
  onBusy?: "reject" | "steer" | "interrupt",
  idempotencyKey?: string,
) => Promise<{ success: boolean; error?: string; code?: string; phase?: string; retryAfterMs?: number }>;

export interface ClaudeAdapterOptions {
  maxBufferedMessages?: number;
  maxBufferedBytes?: number;
  dedupeCapacity?: number;
  dedupeTtlMs?: number;
  /** Monotonic milliseconds for internal dedupe TTL; defaults to performance.now(). */
  now?: () => number;
}

const DEFAULT_MAX_BUFFERED_MESSAGES = 100;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_DEDUPE_CAPACITY = 2048;
const DEFAULT_DEDUPE_TTL_MS = 20 * 60 * 1000;

export const CLAUDE_INSTRUCTIONS = [
  "Codex is an AI coding agent (OpenAI) running in a separate session on the same machine.",
  "",
  "## Message delivery",
  "Messages from Codex arrive as <channel source=\"agentbridge\" chat_id=\"...\" user=\"Codex\" ...> tags (push).",
  "If a push fails, the message is queued — call get_messages to drain the fallback queue.",
  "",
  "## Collaboration roles",
  "Default roles in this setup:",
  "- Claude: Reviewer, Planner, Hypothesis Challenger",
  "- Codex: Implementer, Executor, Reproducer/Verifier",
  "- Expect Codex to provide independent technical judgment and evidence, not passive agreement.",
  "",
  "## Thinking patterns (task-driven)",
  "- Analytical/review tasks: Independent Analysis & Convergence",
  "- Implementation tasks: Architect -> Builder -> Critic",
  "- Debugging tasks: Hypothesis -> Experiment -> Interpretation",
  "",
  "## Collaboration language",
  "- Use explicit phrases such as \"My independent view is:\", \"I agree on:\", \"I disagree on:\", and \"Current consensus:\".",
  "",
  "## How to interact",
  "- Use the reply tool to send messages back to Codex — pass chat_id back.",
  "- Use the get_messages tool to check for pending messages from Codex.",
  "- After sending a reply, call get_messages to check for responses.",
  "- When the user asks about Codex status or progress, call get_messages.",
  "",
  "## Turn coordination",
  "- When you see '⏳ Codex is working', do NOT call the reply tool — wait for '✅ Codex finished'.",
  "- After Codex finishes a turn, you have an attention window to review and respond before new messages arrive.",
  "- If the reply tool returns a busy error, Codex is still executing. You decide: wait and retry later, resend with on_busy=\"steer\" to feed the message INTO the running turn (good for mid-course corrections; it does not interrupt or restart the work), or resend with on_busy=\"interrupt\" to STOP the running turn and start a new one with your message (use only when the current work is obsolete — prefer steer otherwise).",
  "",
  "## Budget awareness",
  "- Use the get_budget tool to check both agents' subscription quota (5h/weekly windows, drift, pause state).",
  "- If the reply tool returns a budget-pause error, do NOT retry; checkpoint your work and wait for the resume notice.",
].join("\n");

export class ClaudeAdapter extends EventEmitter {
  private server: Server;
  private notificationSeq = 0;
  private sessionId: string;
  private readonly notificationIdPrefix: string;
  private readonly instanceId: string;
  private replySender: ReplySender | null = null;
  private readonly logFile: string;
  private readonly logger: ProcessLogger;

  // Push transport with a per-message fallback queue (drained by get_messages).
  private pendingMessages: BridgeMessage[] = [];
  private pendingMessageByteSizes: number[] = [];
  private pendingMessageBytes = 0;
  private readonly maxBufferedMessages: number;
  private readonly maxBufferedBytes: number;
  private droppedMessageCount = 0;
  private oversizedMessageCount = 0;
  private oversizedMessageBytes = 0;
  private oversizedMessageSourceCounts: Partial<Record<BridgeMessage["source"], number>> = {};
  private readonly dedupeCapacity: number;
  private readonly dedupeTtlMs: number;
  private readonly monotonicNow: () => number;
  private deliveredMessageIds = new Map<string, number>();

  // Latest budget snapshot, fed by bridge from DaemonStatus.budget broadcasts.
  private budgetSnapshot: BudgetSnapshot | null = null;

  constructor(logFile = new StateDirResolver().logFile, options: ClaudeAdapterOptions = {}) {
    super();
    this.logFile = logFile;
    this.logger = createProcessLogger({ component: "ClaudeAdapter", logFile: this.logFile });
    this.instanceId = randomUUID().slice(0, 8);
    this.sessionId = `codex_${Date.now()}`;
    this.notificationIdPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
    this.log(`ClaudeAdapter created (instance=${this.instanceId})`);

    // Legacy compat: AGENTBRIDGE_MODE no longer selects a delivery mode.
    // Warn ONCE at construction (never per message) and ignore the value.
    if (process.env.AGENTBRIDGE_MODE) {
      this.log(
        `AGENTBRIDGE_MODE="${process.env.AGENTBRIDGE_MODE}" is no longer supported — ` +
        "pull mode was removed; push delivery (with per-message fallback queue) is always used.",
      );
    }
    this.maxBufferedMessages = positiveIntegerOr(
      options.maxBufferedMessages,
      parsePositiveIntegerEnv("AGENTBRIDGE_MAX_BUFFERED_MESSAGES", DEFAULT_MAX_BUFFERED_MESSAGES),
    );
    this.maxBufferedBytes = positiveIntegerOr(
      options.maxBufferedBytes,
      parsePositiveIntegerEnv("AGENTBRIDGE_MAX_BUFFERED_BYTES", DEFAULT_MAX_BUFFERED_BYTES),
    );
    this.dedupeCapacity = positiveIntegerOr(options.dedupeCapacity, DEFAULT_DEDUPE_CAPACITY);
    this.dedupeTtlMs = positiveIntegerOr(options.dedupeTtlMs, DEFAULT_DEDUPE_TTL_MS);
    this.monotonicNow = options.now ?? (() => performance.now());

    this.server = new Server(
      { name: "agentbridge", version: "0.1.0" },
      {
        capabilities: {
          experimental: { "claude/channel": {} },
          tools: {},
        },
        instructions: CLAUDE_INSTRUCTIONS,
      },
    );

    this.setupHandlers();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.log("MCP server connected (push delivery)");
    this.emit("ready");
  }

  /** Register the async sender that bridge provides for reply delivery. */
  setReplySender(sender: ReplySender) {
    this.replySender = sender;
  }

  /** Returns the number of messages waiting in the fallback queue. */
  getPendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  /** Cache the latest budget snapshot from the daemon (null clears it). */
  setBudgetSnapshot(snapshot: BudgetSnapshot | null) {
    this.budgetSnapshot = snapshot;
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    this.log(`pushNotification (instance=${this.instanceId}, msgId=${message.id}, len=${message.content.length})`);
    if (!this.rememberDelivery(message)) return;
    await this.pushViaChannel(message);
  }

  private async pushViaChannel(message: BridgeMessage) {
    const deliveryAttemptId = `codex_msg_${this.notificationIdPrefix}_${++this.notificationSeq}`;
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.content,
          meta: {
            chat_id: this.sessionId,
            message_id: message.id,
            delivery_attempt_id: deliveryAttemptId,
            user: "Codex",
            user_id: "codex",
            ts,
            source_type: "codex",
          },
        },
      });
      this.log(`Pushed notification: ${message.id} (attempt=${deliveryAttemptId})`);
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message}`);
      this.queueFallbackMessage(message);
    }
  }

  private rememberDelivery(message: BridgeMessage): boolean {
    const now = this.monotonicNow();
    this.pruneDeliveredMessageIds(now);
    if (this.deliveredMessageIds.has(message.id)) {
      // Refresh recency so duplicate bursts do not evict a still-active key.
      this.deliveredMessageIds.delete(message.id);
      this.deliveredMessageIds.set(message.id, now);
      this.log(
        `Duplicate Codex message suppressed (msgId=${message.id}, source=${message.source}, ` +
        `instance=${this.instanceId})`,
      );
      return false;
    }

    this.deliveredMessageIds.set(message.id, now);
    while (this.deliveredMessageIds.size > this.dedupeCapacity) {
      const oldest = this.deliveredMessageIds.keys().next().value;
      if (oldest === undefined) break;
      this.deliveredMessageIds.delete(oldest);
    }
    return true;
  }

  private pruneDeliveredMessageIds(now: number): void {
    for (const [id, seenAt] of this.deliveredMessageIds) {
      if (now - seenAt <= this.dedupeTtlMs) break;
      this.deliveredMessageIds.delete(id);
    }
  }

  /** Per-message fallback when a push fails; drained by the get_messages tool. */
  private queueFallbackMessage(message: BridgeMessage) {
    const messageBytes = utf8ByteLength(message.content);
    if (messageBytes > this.maxBufferedBytes) {
      this.oversizedMessageCount++;
      this.oversizedMessageBytes += messageBytes;
      this.oversizedMessageSourceCounts[message.source] =
        (this.oversizedMessageSourceCounts[message.source] ?? 0) + 1;
      this.log(
        `Fallback queue omitted oversized ${message.source} message ` +
        `(${formatBytes(messageBytes)} > ${formatBytes(this.maxBufferedBytes)}; ` +
        `total oversized: ${this.oversizedMessageCount})`,
      );
      return;
    }

    let dropped = 0;
    while (
      this.pendingMessages.length >= this.maxBufferedMessages ||
      this.pendingMessageBytes + messageBytes > this.maxBufferedBytes
    ) {
      const droppedMessage = this.pendingMessages.shift();
      const droppedBytes = this.pendingMessageByteSizes.shift() ?? 0;
      if (!droppedMessage) break;
      this.pendingMessageBytes = Math.max(0, this.pendingMessageBytes - droppedBytes);
      this.droppedMessageCount++;
      dropped++;
    }
    if (dropped > 0) {
      this.log(
        `Fallback queue overflow: dropped ${dropped} oldest message${dropped > 1 ? "s" : ""} ` +
        `(${this.pendingMessages.length} pending, ${formatBytes(this.pendingMessageBytes)} buffered, ` +
        `${this.droppedMessageCount} dropped since last drain)`,
      );
    }

    this.pendingMessages.push(message);
    this.pendingMessageByteSizes.push(messageBytes);
    this.pendingMessageBytes += messageBytes;
    this.log(
      `Queued fallback message (${this.pendingMessages.length} pending, ` +
      `${formatBytes(this.pendingMessageBytes)} buffered, instance=${this.instanceId})`,
    );
  }

  // ── get_messages ───────────────────────────────────────────

  private drainMessages(): { content: Array<{ type: "text"; text: string }> } {
    this.log(
      `get_messages called (instance=${this.instanceId}, pending=${this.pendingMessages.length}, ` +
      `bytes=${this.pendingMessageBytes}, dropped=${this.droppedMessageCount}, oversized=${this.oversizedMessageCount})`,
    );
    if (this.pendingMessages.length === 0 && this.droppedMessageCount === 0 && this.oversizedMessageCount === 0) {
      return {
        content: [{ type: "text" as const, text: "No new messages from Codex." }],
      };
    }

    // Snapshot and clear atomically to avoid issues with concurrent writes
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    this.pendingMessageByteSizes = [];
    this.pendingMessageBytes = 0;
    const dropped = this.droppedMessageCount;
    this.droppedMessageCount = 0;
    const oversizedSourceCounts = this.oversizedMessageSourceCounts;
    const oversized = this.oversizedMessageCount;
    const oversizedBytes = this.oversizedMessageBytes;
    this.oversizedMessageSourceCounts = {};
    this.oversizedMessageCount = 0;
    this.oversizedMessageBytes = 0;

    const count = messages.length;
    const notices: string[] = [];
    if (dropped > 0) {
      notices.push(
        `${dropped} older message${dropped > 1 ? "s" : ""} ` +
        `${dropped > 1 ? "were" : "was"} dropped due to fallback queue overflow`,
      );
    }
    if (oversized > 0) {
      for (const [source, sourceCount] of Object.entries(oversizedSourceCounts)) {
        notices.push(
          `${sourceCount} oversized message${sourceCount === 1 ? "" : "s"} ` +
          `from ${formatSource(source as BridgeMessage["source"])} omitted ` +
          `(>${formatBytes(this.maxBufferedBytes)})`,
        );
      }
    }

    const formatted = messages
      .map((msg, i) => {
        const ts = new Date(msg.timestamp).toISOString();
        return `---\n[${i + 1}] ${ts}\nCodex: ${msg.content}`;
      })
      .join("\n\n");

    const noticeText = notices.map((notice) => `WARNING: ${notice}`).join("\n");
    const parts: string[] = [];
    if (count > 0) {
      parts.push(`[${count} new message${count > 1 ? "s" : ""} from Codex]\nchat_id: ${this.sessionId}`);
    }
    if (noticeText) parts.push(noticeText);
    if (formatted) parts.push(formatted);

    this.log(
      `get_messages returning ${count} message(s) ` +
      `(instance=${this.instanceId}, dropped=${dropped}, oversized=${oversized}, oversizedBytes=${oversizedBytes})`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: parts.join("\n\n"),
        },
      ],
    };
  }

  // ── MCP Tool Handlers ─────────────────────────────────────

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "reply",
          description:
            "Send a message back to Codex. Your reply will be injected into the Codex session as a new user turn.",
          inputSchema: {
            type: "object" as const,
            properties: {
              chat_id: {
                type: "string",
                description: "The conversation to reply in (from the inbound <channel> tag).",
              },
              text: {
                type: "string",
                description: "The message to send to Codex.",
              },
              require_reply: {
                type: "boolean",
                description: "When true, Codex is required to send a reply. All Codex messages from this turn will be forwarded immediately (bypassing STATUS buffering). Use this when you need a direct answer from Codex. Combinable with on_busy=\"steer\": the reply expectation arms once the steer is accepted into the running turn.",
              },
              on_busy: {
                type: "string",
                enum: ["reject", "steer", "interrupt"],
                description: "What to do when Codex is mid-turn. \"reject\" (default): fail with a busy error — wait and retry. \"steer\": feed this message INTO the running turn — Codex sees it immediately and integrates it without losing work; use it for mid-course corrections, added constraints, or updated acceptance criteria (it does NOT start a new turn). \"interrupt\": STOP the running turn, wait for it to terminate, then send this message as a NEW turn — use only when the current work is obsolete; prefer steer otherwise.",
              },
              idempotency_key: {
                type: "string",
                description: "Optional client-generated key (non-empty, max 128 chars) that makes this reply idempotent: a retry carrying the same key is NOT re-injected — the bridge answers duplicate_in_flight / duplicate_terminal instead. Use a fresh key per logical message.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_messages",
          description:
            "Check for new messages from Codex. Call this after sending a reply or when you expect a response from Codex.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
        {
          name: "get_budget",
          description:
            "Check both agents' subscription quota usage (Claude + Codex): 5h/weekly window percentages, drift between the two sides, joint-pause state and model/effort tier recommendation.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === "reply") {
        return this.handleReply(args as Record<string, unknown>);
      }

      if (name === "get_messages") {
        return this.drainMessages();
      }

      if (name === "get_budget") {
        return this.handleGetBudget();
      }

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });
  }

  private handleGetBudget() {
    this.log(`get_budget called (instance=${this.instanceId}, hasSnapshot=${this.budgetSnapshot !== null})`);
    const text = this.budgetSnapshot
      ? renderBudgetSnapshot(this.budgetSnapshot)
      : BUDGET_UNAVAILABLE_TEXT;
    return {
      content: [{ type: "text" as const, text }],
    };
  }

  private async handleReply(args: Record<string, unknown>) {
    const text = args?.text as string | undefined;
    if (!text) {
      return {
        content: [{ type: "text" as const, text: "Error: missing required parameter 'text'" }],
        isError: true,
      };
    }

    const requireReply = args?.require_reply === true;
    const onBusyRaw = args?.on_busy;
    if (onBusyRaw !== undefined && onBusyRaw !== "reject" && onBusyRaw !== "steer" && onBusyRaw !== "interrupt") {
      return {
        content: [{ type: "text" as const, text: `Error: invalid on_busy value ${JSON.stringify(onBusyRaw)} — use "reject", "steer" or "interrupt".` }],
        isError: true,
      };
    }
    const onBusy: "reject" | "steer" | "interrupt" =
      onBusyRaw === "steer" || onBusyRaw === "interrupt" ? onBusyRaw : "reject";
    // require_reply × steer is allowed (protocol v2 PR B): the daemon arms the
    // reply expectation once the steer is ACCEPTED into the running turn.
    // require_reply × interrupt is allowed too — it ultimately starts a NEW
    // turn, so the tracker arms after injection exactly like a normal reply.

    const idempotencyKeyRaw = args?.idempotency_key;
    if (idempotencyKeyRaw !== undefined) {
      if (typeof idempotencyKeyRaw !== "string" || idempotencyKeyRaw.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: idempotency_key must be a non-empty string." }],
          isError: true,
        };
      }
      if (idempotencyKeyRaw.length > 128) {
        return {
          content: [{ type: "text" as const, text: `Error: idempotency_key is too long (${idempotencyKeyRaw.length} chars, max 128).` }],
          isError: true,
        };
      }
    }
    const idempotencyKey = idempotencyKeyRaw as string | undefined;

    const bridgeMsg: BridgeMessage = {
      id: (args?.chat_id as string) ?? `reply_${Date.now()}`,
      source: "claude",
      content: text,
      timestamp: Date.now(),
    };

    if (!this.replySender) {
      this.log("No reply sender registered");
      return {
        content: [{ type: "text" as const, text: "Error: bridge not initialized, cannot send reply." }],
        isError: true,
      };
    }

    const result = await this.replySender(bridgeMsg, requireReply, onBusy, idempotencyKey);
    if (!result.success) {
      this.log(`Reply delivery failed: ${result.error}${result.code ? ` (code=${result.code})` : ""}`);
      // Surface the machine-readable code (PR B structured result) alongside
      // the human error so the model can branch on it deterministically.
      const codePrefix = result.code ? ` [${result.code}]` : "";
      return {
        content: [{ type: "text" as const, text: `Error${codePrefix}: ${result.error}` }],
        isError: true,
      };
    }

    // Include pending message hint
    const pending = this.pendingMessages.length;
    let responseText = "Reply sent to Codex.";
    if (onBusy === "steer") {
      responseText = "Reply sent to Codex (will be steered into the running turn if one is active; watch for a system_steer_failed notice if the app-server rejects it).";
    } else if (onBusy === "interrupt") {
      // Honest wording: a success can mean EITHER an interrupt happened then the
      // message was injected, OR the running turn had already ended by dispatch
      // time so it fell straight through to a normal injection (race-degrade) —
      // nothing was interrupted in that case. The result does not distinguish
      // the two, so do not assert an interrupt occurred.
      responseText = "Reply sent to Codex as a new turn (any turn still running was interrupted first; if it had already finished, your message was simply injected).";
    }
    if (pending > 0) {
      responseText += ` Note: ${pending} unread Codex message${pending > 1 ? "s" : ""} already waiting \u2014 call get_messages to read them.`;
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private log(msg: string) {
    this.logger.log(msg);
  }
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  return positiveIntegerOr(parseInt(process.env[name] ?? "", 10), fallback);
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function formatSource(source: BridgeMessage["source"]): string {
  return source === "codex" ? "Codex" : "Claude";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024}KiB`;
  return `${bytes}B`;
}
