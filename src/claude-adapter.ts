/**
 * Claude Code MCP Server — Dual-Mode Message Transport
 *
 * Supports two delivery modes:
 *   - Push mode (OAuth): real-time via notifications/claude/channel
 *   - Pull mode (API key): message queue + get_messages tool
 *
 * Mode defaults to pull in auto mode, or set explicitly via AGENTBRIDGE_MODE env var.
 *
 * Emits:
 *   - "ready"   ()                   — MCP connected, mode resolved
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
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PersistentMessageQueue,
  hashContent,
  previewContent,
  type QueueEntry,
} from "./message-queue";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";

export type ReplySender = (msg: BridgeMessage, requireReply?: boolean) => Promise<{ success: boolean; error?: string }>;
export type DeliveryMode = "push" | "pull" | "dual" | "auto";
export type PushMethod = "claude/channel" | "standard";

export const CLAUDE_INSTRUCTIONS = [
  "Codex is an AI coding agent (OpenAI) running in a separate session on the same machine.",
  "",
  "## Message delivery",
  "Messages from Codex may arrive in two ways depending on the connection mode:",
  "- As <channel source=\"agentbridge\" chat_id=\"...\" user=\"Codex\" ...> tags (push mode)",
  "- Via the get_messages tool (pull mode)",
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
  "- If the reply tool returns a busy error, Codex is still executing — wait and try again later.",
].join("\n");

export class ClaudeAdapter extends EventEmitter {
  private server: Server;
  private notificationSeq = 0;
  private sessionId: string;
  private readonly notificationIdPrefix: string;
  private readonly instanceId: string;
  private replySender: ReplySender | null = null;
  private readonly logFile: string;
  private readonly queue: PersistentMessageQueue;
  private readonly pushMethod: PushMethod;

  // Dual-mode transport
  private readonly configuredMode: DeliveryMode;
  private resolvedMode: "push" | "pull" | "dual" | null = null;
  private pendingMessages: BridgeMessage[] = [];
  private readonly maxBufferedMessages: number;
  private droppedMessageCount = 0;
  private lastQueueWasDuplicate = false;

  constructor(logFile = new StateDirResolver().logFile, queue?: PersistentMessageQueue) {
    super();
    this.logFile = logFile;
    const stateDir = dirname(logFile);
    this.queue = queue ?? new PersistentMessageQueue(join(stateDir, "queue.db"), join(stateDir, "transcript.jsonl"));
    this.instanceId = randomUUID().slice(0, 8);
    this.sessionId = `codex_${Date.now()}`;
    this.notificationIdPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
    this.log(`ClaudeAdapter created (instance=${this.instanceId})`);

    const envMode = process.env.AGENTBRIDGE_MODE as DeliveryMode | undefined;
    this.configuredMode = envMode && ["push", "pull", "dual", "auto"].includes(envMode) ? envMode : "auto";
    const envPushMethod = process.env.AGENTBRIDGE_PUSH_METHOD;
    this.pushMethod = envPushMethod === "standard" ? "standard" : "claude/channel";
    this.maxBufferedMessages = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);

    this.server = new Server(
      { name: "agentbridge", version: "0.1.0" },
      {
        capabilities: {
          experimental: { "claude/channel": {} },
          logging: {},
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
    this.resolveMode();
    await this.server.connect(transport);
    const clientCapabilities = (this.server as any)._clientCapabilities;
    this.log(`MCP server connected (mode: ${this.resolvedMode}, pushMethod: ${this.pushMethod})`);
    this.log(`MCP client capabilities: ${JSON.stringify(clientCapabilities ?? null)}`);
    this.emit("ready");
  }

  /** Register the async sender that bridge provides for reply delivery. */
  setReplySender(sender: ReplySender) {
    this.replySender = sender;
  }

  /** Returns the resolved delivery mode. */
  getDeliveryMode(): "push" | "pull" | "dual" {
    return this.resolvedMode ?? "pull";
  }

  /** Returns the number of messages waiting in the pull queue. */
  getPendingMessageCount(): number {
    return this.queue.countUndrained();
  }

  // ── Mode Detection ─────────────────────────────────────────

  private resolveMode(): void {
    if (this.resolvedMode) return;

    if (this.configuredMode === "push" || this.configuredMode === "pull" || this.configuredMode === "dual") {
      this.resolvedMode = this.configuredMode;
      this.log(`Delivery mode set by AGENTBRIDGE_MODE: ${this.resolvedMode}`);
    } else {
      // Default to pull — Claude Code doesn't declare channel support in
      // client capabilities, so we can't reliably detect whether channel
      // delivery is actually working. Users can opt into push explicitly with
      // AGENTBRIDGE_MODE=push when their setup is known to support it.
      this.resolvedMode = "pull";
      this.log("Delivery mode defaulting to pull (set AGENTBRIDGE_MODE=push to opt into channel delivery)");
    }
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    this.log(`pushNotification (instance=${this.instanceId}, mode=${this.resolvedMode}, pushMethod=${this.pushMethod}, msgId=${message.id}, len=${message.content.length})`);
    if (this.resolvedMode === "dual") {
      const entry = this.queueForPull(message);
      if (this.lastQueueWasDuplicate) {
        this.log(`Skipping duplicate dual push for message ${entry.messageId}`);
        return;
      }
      await this.pushViaChannel(message, entry.messageId);
    } else if (this.resolvedMode === "push") {
      await this.pushViaChannel(message);
    } else {
      this.queueForPull(message);
    }
  }

  private async pushViaChannel(message: BridgeMessage, persistedMessageId?: string) {
    const msgId = persistedMessageId ?? this.nextNotificationId();
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification(this.buildPushNotification(message, msgId, ts) as any);
      this.log(`Pushed notification: ${msgId}`);
      if (persistedMessageId) {
        this.queue.markPushed(persistedMessageId);
        this.auditMessage("message_pushed", message, {
          messageId: persistedMessageId,
          queued: true,
          pushed: true,
        });
      }
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message}`);
      if (persistedMessageId) {
        this.queue.markPushFailed(persistedMessageId, e.message);
        this.auditMessage("message_push_failed", message, {
          messageId: persistedMessageId,
          queued: true,
          pushed: false,
          pushError: e.message,
        });
      } else {
        this.queueForPull(message);
      }
    }
  }

  private buildPushNotification(message: BridgeMessage, msgId: string, ts: string) {
    const meta = {
      chat_id: this.sessionId,
      message_id: msgId,
      user: "Codex",
      user_id: "codex",
      ts,
      source_type: "codex",
    };

    if (this.pushMethod === "standard") {
      return {
        method: "notifications/message",
        params: {
          level: "info",
          logger: "agentbridge",
          data: {
            content: message.content,
            meta,
          },
        },
      };
    }

    return {
      method: "notifications/claude/channel",
      params: {
        content: message.content,
        meta,
      },
    };
  }

  private queueForPull(message: BridgeMessage): QueueEntry {
    if (this.queue.countUndrained() >= this.maxBufferedMessages) {
      const dropped = this.queue.markOldestUndrainedDropped();
      this.droppedMessageCount++;
      if (dropped) {
        this.queue.audit({
          event: "message_dropped",
          direction: "codex_to_claude",
          sender: "codex",
          chatId: dropped.chatId,
          messageId: dropped.messageId,
          marker: dropped.marker,
          contentLen: dropped.content.length,
          contentHash: dropped.contentHash,
          preview: previewContent(dropped.content),
          deliveryMode: this.getDeliveryMode(),
          queued: false,
          drained: true,
        });
      }
      this.log(`Message queue full, dropped oldest message (total dropped: ${this.droppedMessageCount})`);
    }

    const messageId = this.nextNotificationId();
    const entry = this.queue.enqueue({
      message,
      chatId: this.sessionId,
      messageId,
    });
    this.lastQueueWasDuplicate = entry.messageId !== messageId;
    this.pendingMessages = this.entriesToBridgeMessages(this.queue.listUndrained());
    this.auditMessage("message_queued", message, {
      messageId: entry.messageId,
      queued: true,
      pushed: entry.pushedAt !== null,
      pushError: entry.pushError,
    });
    this.log(`Queued message for pull (${this.queue.countUndrained()} pending, instance=${this.instanceId})`);
    return entry;
  }

  // ── get_messages ───────────────────────────────────────────

  private drainMessages(): { content: Array<{ type: "text"; text: string }> } {
    const entries = this.queue.listUndrained();
    this.pendingMessages = this.entriesToBridgeMessages(entries);
    this.log(`get_messages called (instance=${this.instanceId}, pending=${entries.length}, dropped=${this.droppedMessageCount})`);
    if (entries.length === 0 && this.droppedMessageCount === 0) {
      return {
        content: [{ type: "text" as const, text: "No new messages from Codex." }],
      };
    }

    // Snapshot and mark drained after formatting so restart replay is preserved until get_messages succeeds.
    const messages = entries;
    this.pendingMessages = [];
    const dropped = this.droppedMessageCount;
    this.droppedMessageCount = 0;

    const count = messages.length;
    let header = `[${count} new message${count > 1 ? "s" : ""} from Codex]`;
    if (dropped > 0) {
      header += ` (${dropped} older message${dropped > 1 ? "s" : ""} were dropped due to queue overflow)`;
    }
    header += `\nchat_id: ${this.sessionId}`;

    const formatted = messages
      .map((msg, i) => {
        const ts = new Date(msg.timestamp).toISOString();
        return `---\n[${i + 1}] ${ts}\nmessage_id: ${msg.messageId}\nCodex: ${msg.content}`;
      })
      .join("\n\n");

    this.queue.markDrained(messages.map((msg) => msg.messageId));
    this.queue.audit({
      event: "messages_drained",
      direction: "codex_to_claude",
      sender: "claude",
      chatId: this.sessionId,
      deliveryMode: this.getDeliveryMode(),
      count,
      drained: true,
    });

    this.log(`get_messages returning ${count} message(s) (instance=${this.instanceId}, dropped=${dropped})`);
    return {
      content: [
        {
          type: "text" as const,
          text: `${header}\n\n${formatted}`,
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
                description: "When true, Codex is required to send a reply. All Codex messages from this turn will be forwarded immediately (bypassing STATUS buffering). Use this when you need a direct answer from Codex.",
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

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });
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

    const result = await this.replySender(bridgeMsg, requireReply);
    if (!result.success) {
      this.log(`Reply delivery failed: ${result.error}`);
      this.auditReply("reply_failed", bridgeMsg, requireReply, result.error);
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    this.auditReply("reply_sent", bridgeMsg, requireReply);

    // Include pending message hint
    const pending = this.getPendingMessageCount();
    let responseText = "Reply sent to Codex.";
    if (pending > 0) {
      responseText += ` Note: ${pending} unread Codex message${pending > 1 ? "s" : ""} already waiting \u2014 call get_messages to read them.`;
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private log(msg: string) {
    const line = `[${new Date().toISOString()}] [ClaudeAdapter] ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(this.logFile, line);
    } catch {}
  }

  private nextNotificationId(): string {
    return `codex_msg_${this.notificationIdPrefix}_${++this.notificationSeq}`;
  }

  private entriesToBridgeMessages(entries: QueueEntry[]): BridgeMessage[] {
    return entries.map((entry) => ({
      id: entry.messageId,
      source: entry.source,
      content: entry.content,
      timestamp: entry.timestamp,
    }));
  }

  private auditMessage(
    event: string,
    message: BridgeMessage,
    opts: {
      messageId: string;
      queued: boolean;
      pushed?: boolean;
      pushError?: string | null;
    },
  ) {
    this.queue.audit({
      event,
      direction: "codex_to_claude",
      sender: "codex",
      chatId: this.sessionId,
      messageId: opts.messageId,
      marker: message.content.match(/^\[(IMPORTANT|STATUS|FYI)\]/)?.[1] ?? "untagged",
      contentLen: message.content.length,
      contentHash: hashContent(message.content),
      preview: previewContent(message.content),
      deliveryMode: this.getDeliveryMode(),
      queued: opts.queued,
      pushed: opts.pushed,
      pushError: opts.pushError,
    });
  }

  private auditReply(event: string, message: BridgeMessage, requireReply: boolean, error?: string) {
    this.queue.audit({
      event,
      direction: "claude_to_codex",
      sender: "claude",
      chatId: message.id,
      messageId: message.id,
      marker: message.content.match(/^\[(IMPORTANT|STATUS|FYI)\]/)?.[1] ?? "untagged",
      contentLen: message.content.length,
      contentHash: hashContent(message.content),
      preview: previewContent(message.content),
      deliveryMode: this.getDeliveryMode(),
      queued: false,
      pushed: false,
      requireReply,
      error: error ?? null,
    });
  }
}
