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
import { createProcessLogger, type ProcessLogger } from "./process-log";
import { StateDirResolver } from "./state-dir";
import type { BridgeMessage } from "./types";
import type { BudgetSnapshot } from "./budget/types";
import { renderBudgetSnapshot, BUDGET_UNAVAILABLE_TEXT } from "./budget/render";

export type ReplySender = (msg: BridgeMessage, requireReply?: boolean) => Promise<{ success: boolean; error?: string }>;

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
  "- If the reply tool returns a busy error, Codex is still executing — wait and try again later.",
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
  private readonly maxBufferedMessages: number;
  private droppedMessageCount = 0;

  // Latest budget snapshot, fed by bridge from DaemonStatus.budget broadcasts.
  private budgetSnapshot: BudgetSnapshot | null = null;

  constructor(logFile = new StateDirResolver().logFile) {
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
    this.maxBufferedMessages = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);

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
    await this.pushViaChannel(message);
  }

  private async pushViaChannel(message: BridgeMessage) {
    const msgId = `codex_msg_${this.notificationIdPrefix}_${++this.notificationSeq}`;
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: message.content,
          meta: {
            chat_id: this.sessionId,
            message_id: msgId,
            user: "Codex",
            user_id: "codex",
            ts,
            source_type: "codex",
          },
        },
      });
      this.log(`Pushed notification: ${msgId}`);
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message}`);
      this.queueFallbackMessage(message);
    }
  }

  /** Per-message fallback when a push fails; drained by the get_messages tool. */
  private queueFallbackMessage(message: BridgeMessage) {
    if (this.pendingMessages.length >= this.maxBufferedMessages) {
      this.pendingMessages.shift();
      this.droppedMessageCount++;
      this.log(`Fallback queue full, dropped oldest message (total dropped: ${this.droppedMessageCount})`);
    }
    this.pendingMessages.push(message);
    this.log(`Queued fallback message (${this.pendingMessages.length} pending, instance=${this.instanceId})`);
  }

  // ── get_messages ───────────────────────────────────────────

  private drainMessages(): { content: Array<{ type: "text"; text: string }> } {
    this.log(`get_messages called (instance=${this.instanceId}, pending=${this.pendingMessages.length}, dropped=${this.droppedMessageCount})`);
    if (this.pendingMessages.length === 0 && this.droppedMessageCount === 0) {
      return {
        content: [{ type: "text" as const, text: "No new messages from Codex." }],
      };
    }

    // Snapshot and clear atomically to avoid issues with concurrent writes
    const messages = this.pendingMessages;
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
        return `---\n[${i + 1}] ${ts}\nCodex: ${msg.content}`;
      })
      .join("\n\n");

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
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    // Include pending message hint
    const pending = this.pendingMessages.length;
    let responseText = "Reply sent to Codex.";
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
