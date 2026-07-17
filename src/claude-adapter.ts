/**
 * Claude Code MCP Server — Push Message Transport
 *
 * Every logical message enters an in-memory, explicitly acknowledged mailbox
 * before notifications/claude/channel is attempted. Channel push is a bounded
 * retry latency optimization; get_messages is the at-least-once recovery path.
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
import { createHash, randomUUID } from "node:crypto";
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
  wrapUp?: boolean,
) => Promise<{ success: boolean; error?: string; code?: string; phase?: string; retryAfterMs?: number }>;

export interface ClaudeAdapterOptions {
  maxBufferedMessages?: number;
  maxBufferedBytes?: number;
  dedupeCapacity?: number;
  dedupeTtlMs?: number;
  /** Monotonic milliseconds for internal dedupe TTL; defaults to performance.now(). */
  now?: () => number;
  /** Delay before the first no-ack Channel retry. Defaults to 60000 ms. */
  deliveryRetryBaseMs?: number;
  /** Total Channel attempts, including the initial push. Defaults to 3. */
  deliveryMaxAttempts?: number;
  /** Timer seam for deterministic delivery-retry tests. */
  deliveryScheduler?: DeliveryScheduler;
  /**
   * Freshness TTL (ms) for the get_budget tool: when the cached snapshot is older
   * than this, get_budget asks the daemon for a fresh read-only refresh before
   * rendering. Defaults to AGENTBRIDGE_BUDGET_FRESH_TTL_SEC×1000 or 25000.
   */
  budgetFreshTtlMs?: number;
  /** Wall-clock milliseconds for the budget-freshness check; defaults to Date.now(). */
  wallNow?: () => number;
}

const DEFAULT_MAX_BUFFERED_MESSAGES = 100;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_DEDUPE_CAPACITY = 2048;
const DEFAULT_DEDUPE_TTL_MS = 20 * 60 * 1000;
const DEFAULT_DELIVERY_RETRY_BASE_MS = 60 * 1000;
const DEFAULT_DELIVERY_MAX_ATTEMPTS = 3;
const DEFAULT_BUDGET_FRESH_TTL_MS = 25 * 1000;

export interface DeliveryScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface DeliveredMessageRecord {
  seenAt: number;
  fingerprint: string;
}

interface MailboxMessage extends BridgeMessage {
  /** Daemon/source ID before the adapter allocates a unique ACK generation. */
  sourceMessageId: string;
  /** Original normalized source ID, retained when a conflict uses an alias. */
  originalSourceMessageId: string;
}

interface PendingDeliveryRetry {
  message: MailboxMessage;
  attempts: number;
  timer?: unknown;
}

export const CLAUDE_INSTRUCTIONS = [
  "Codex is an AI coding agent (OpenAI) running in a separate session on the same machine.",
  "",
  "## Message delivery",
  "Messages from Codex arrive as <channel source=\"agentbridge\" chat_id=\"...\" user=\"Codex\" ...> tags (push).",
  "Every message is queued before push. Channel delivery is a latency optimization, not proof of receipt.",
  "A repeated delivery ID is the same logical message. Never repeat completed work for an ID you already processed.",
  "After fully processing a pushed message, call ack_messages with its meta.message_id. Do not acknowledge before processing.",
  "If a push is missed, call get_messages. It returns the same stable message IDs until ack_messages confirms them.",
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
  "- Use the get_messages tool to check for pending messages from Codex, then call ack_messages only for IDs you fully processed.",
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
  "- If the reply tool returns a budget-pause error (code budget_paused), do NOT retry; checkpoint your work and wait for the resume notice.",
  "- If the reply tool returns a budget_admission error, the 5h window is in finishing-protection: new tasks are declined, but you may bring the CURRENT collaboration to a checkpoint by resending with wrap_up=true (a small per-window quota). Do NOT start new work; once the quota is used or you are done, write a checkpoint and wait for the 5h window to refresh.",
].join("\n");

export class ClaudeAdapter extends EventEmitter {
  private server: Server;
  private notificationSeq = 0;
  private deliverySeq = 0;
  private sessionId: string;
  private readonly notificationIdPrefix: string;
  private readonly instanceId: string;
  private replySender: ReplySender | null = null;
  // PR4: budget-resume ack callback, DELIBERATELY isolated from replySender.
  // ack_resume is a Claude→bridge control-plane signal (acknowledging a
  // system_budget_resume directive), NOT a Claude→Codex message — it must never
  // route through the reply path (no idempotency/replyTracker pollution, no
  // budget pause gate, no turn injection into Codex).
  private resumeAckHandler: ((resumeId: string, status: string) => void) | null = null;
  private readonly logFile: string;
  private readonly logger: ProcessLogger;

  // Authoritative in-memory mailbox. Messages enter before Channel push and
  // remain until explicitly acknowledged or observably evicted by a bound.
  private pendingMessages: MailboxMessage[] = [];
  private pendingMessageByteSizes: number[] = [];
  private pendingMessageBytes = 0;
  private readonly maxBufferedMessages: number;
  private readonly maxBufferedBytes: number;
  /** ack_ids batch cap; never below the mailbox capacity so the drain
   *  epilogue's "ack all pending IDs" instruction is always executable. */
  private readonly ackIdsCap: number;
  private droppedMessageCount = 0;
  private oversizedMessageCount = 0;
  private oversizedMessageBytes = 0;
  private oversizedMessageSourceCounts: Partial<Record<BridgeMessage["source"], number>> = {};
  private readonly dedupeCapacity: number;
  private readonly dedupeTtlMs: number;
  private readonly monotonicNow: () => number;
  private deliveredMessageIds = new Map<string, DeliveredMessageRecord>();
  private readonly deliveryRetryBaseMs: number;
  private readonly deliveryMaxAttempts: number;
  private readonly deliveryScheduler: DeliveryScheduler;
  private deliveryRetries = new Map<string, PendingDeliveryRetry>();

  // Latest budget snapshot, fed by bridge from DaemonStatus.budget broadcasts.
  private budgetSnapshot: BudgetSnapshot | null = null;
  private readonly budgetFreshTtlMs: number;
  private readonly wallNow: () => number;
  // On-demand fresh-snapshot fetch (fresh-if-stale at get_budget). Wired by bridge
  // to daemonClient.requestBudgetRefresh; absent → get_budget renders the cache.
  private requestFreshSnapshot: (() => Promise<BudgetSnapshot | null>) | null = null;
  // Single-flight guard: concurrent get_budget calls share ONE in-flight refresh
  // (the no-requestId budget_refresh waiter cannot disambiguate parallel requests).
  private pendingBudgetRefresh: Promise<BudgetSnapshot | null> | null = null;

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
    this.ackIdsCap = Math.max(100, this.maxBufferedMessages);
    this.dedupeCapacity = positiveIntegerOr(options.dedupeCapacity, DEFAULT_DEDUPE_CAPACITY);
    this.dedupeTtlMs = positiveIntegerOr(options.dedupeTtlMs, DEFAULT_DEDUPE_TTL_MS);
    this.monotonicNow = options.now ?? (() => performance.now());
    this.deliveryRetryBaseMs = positiveIntegerOr(
      options.deliveryRetryBaseMs,
      parsePositiveIntegerEnv("AGENTBRIDGE_DELIVERY_RETRY_BASE_MS", DEFAULT_DELIVERY_RETRY_BASE_MS),
    );
    this.deliveryMaxAttempts = positiveIntegerOr(
      options.deliveryMaxAttempts,
      parsePositiveIntegerEnv("AGENTBRIDGE_DELIVERY_MAX_ATTEMPTS", DEFAULT_DELIVERY_MAX_ATTEMPTS),
    );
    this.deliveryScheduler = options.deliveryScheduler ?? globalThis;
    this.budgetFreshTtlMs = positiveIntegerOr(
      options.budgetFreshTtlMs,
      parsePositiveIntegerEnv("AGENTBRIDGE_BUDGET_FRESH_TTL_SEC", DEFAULT_BUDGET_FRESH_TTL_MS / 1000) * 1000,
    );
    this.wallNow = options.wallNow ?? (() => Date.now());

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

  /**
   * Register the budget-resume ack callback (PR4). Wired by bridge.ts to forward
   * an `ack_resume` control message to the daemon's ResumeAckTracker. Kept fully
   * separate from the reply sender so ack_resume can never be confused with a
   * Claude→Codex message.
   */
  setResumeAckHandler(handler: (resumeId: string, status: string) => void) {
    this.resumeAckHandler = handler;
  }

  /** Returns the number of messages waiting in the fallback queue. */
  getPendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  /** Cache the latest budget snapshot from the daemon (null clears it). */
  setBudgetSnapshot(snapshot: BudgetSnapshot | null) {
    this.budgetSnapshot = snapshot;
  }

  /**
   * Register the on-demand budget refresh fetcher (fresh-if-stale at get_budget).
   * Wired by bridge.ts to daemonClient.requestBudgetRefresh. Absent → get_budget
   * always renders the broadcast cache (prior behavior).
   */
  setRequestFreshSnapshot(fetcher: () => Promise<BudgetSnapshot | null>) {
    this.requestFreshSnapshot = fetcher;
  }

  // ── Message Delivery ───────────────────────────────────────

  async pushNotification(message: BridgeMessage) {
    this.log(`pushNotification (instance=${this.instanceId}, msgId=${message.id}, len=${message.content.length})`);
    const delivery = this.rememberDelivery(message);
    if (!delivery) return;

    // Queue before the first await. A resolved Channel write only means the
    // transport accepted bytes; the mailbox remains authoritative until ACK.
    const queued = this.queueFallbackMessage(delivery);
    if (!queued) {
      // Do not leave a dedupe tombstone for content the mailbox could not
      // admit. A source replay must get another observable delivery attempt.
      this.deliveredMessageIds.delete(delivery.sourceMessageId);
    }

    // Budget resume already owns a dedicated ACK/retry state machine. General
    // messages schedule in arrival order before any transport promise settles.
    if (queued && !delivery.resumeId) {
      this.armDeliveryRetry(delivery, 1);
    }
    await this.pushViaChannel(delivery, queued);
  }

  private async pushViaChannel(message: MailboxMessage, admitted = true) {
    const deliveryAttemptId = `codex_msg_${this.notificationIdPrefix}_${++this.notificationSeq}`;
    const ts = new Date(message.timestamp).toISOString();

    try {
      await this.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: this.channelContent(message, admitted),
          meta: {
            chat_id: this.sessionId,
            message_id: message.id,
            source_message_id: message.originalSourceMessageId,
            ...(message.sourceMessageId !== message.originalSourceMessageId
              ? { dedupe_source_message_id: message.sourceMessageId }
              : {}),
            delivery_attempt_id: deliveryAttemptId,
            // An unadmitted (oversized) message is best-effort only: it is not
            // in the mailbox, so an ACK contract would be a lie — see channelContent.
            ack_required: admitted,
            ...(admitted ? { ack_tool: message.resumeId ? "ack_resume" : "ack_messages" } : {}),
            user: "Codex",
            user_id: "codex",
            ts,
            source_type: "codex",
            // PR4: budget-resume correlation id. Only present on resume pushes;
            // omitted entirely for normal Codex messages so the meta shape is
            // unchanged for the common path.
            ...(message.resumeId ? { resume_id: message.resumeId } : {}),
          },
        },
      });
      this.log(`Pushed notification: ${message.id} (attempt=${deliveryAttemptId})`);
    } catch (e: any) {
      this.log(`Push notification failed: ${e.message} (message remains in mailbox)`);
    }
  }

  private channelContent(message: MailboxMessage, admitted = true): string {
    if (message.resumeId) return message.content;
    if (!admitted) {
      return (
        `[AgentBridge oversized delivery id: ${message.id}. This message exceeded the mailbox size ` +
        `bound and is NOT retained: it cannot be recovered via get_messages and must not be ` +
        `acknowledged. If you already processed a message with this exact content, do not repeat the work.]\n\n` +
        message.content
      );
    }
    const ackIds = JSON.stringify([message.id]);
    return (
      `[AgentBridge delivery id: ${message.id}. If this ID is already being processed or was processed, ` +
      `do not repeat the work. After fully processing this message, ` +
      `call ack_messages with ack_ids ${ackIds}. Do not acknowledge before processing.]\n\n` +
      message.content
    );
  }

  private rememberDelivery(
    message: BridgeMessage,
    originalSourceMessageId?: string,
  ): MailboxMessage | null {
    const sourceMessageId = normalizeDeliveryId(message.id);
    const originalSourceId = originalSourceMessageId ?? sourceMessageId;
    if (sourceMessageId !== message.id) {
      this.log(`WARNING: normalized unsafe Codex message id to ${sourceMessageId}`);
      message = { ...message, id: sourceMessageId };
    }
    const now = this.monotonicNow();
    const fingerprint = deliveryFingerprint(message);

    // A conflict alias must still dedupe replays addressed to the original
    // source ID. Match original source + payload before considering the current
    // alias key, otherwise an expired original tombstone can admit the same
    // logical payload twice under two different ACK generations.
    const activeLogicalMessage = this.pendingMessages.find(
      (pending) => pending.originalSourceMessageId === originalSourceId &&
        deliveryFingerprint(pending) === fingerprint,
    );
    if (activeLogicalMessage) {
      this.deliveredMessageIds.delete(activeLogicalMessage.sourceMessageId);
      this.deliveredMessageIds.set(activeLogicalMessage.sourceMessageId, { seenAt: now, fingerprint });
      this.enforceDedupeCapacity();
      this.log(
        `Duplicate active Codex message suppressed (msgId=${sourceMessageId}, source=${message.source}, ` +
        `instance=${this.instanceId})`,
      );
      return null;
    }

    // An unacknowledged mailbox entry must remain authoritative even after the
    // bounded dedupe cache expires or evicts its tombstone. Otherwise the same
    // source ID could be queued twice and one ACK would accidentally delete two
    // different logical messages.
    const active = this.pendingMessages.find((pending) => pending.sourceMessageId === sourceMessageId);
    if (active) {
      const activeFingerprint = deliveryFingerprint(active);
      this.deliveredMessageIds.delete(sourceMessageId);
      this.deliveredMessageIds.set(sourceMessageId, { seenAt: now, fingerprint: activeFingerprint });
      this.enforceDedupeCapacity();
      return this.preserveIdCollision(message, fingerprint, originalSourceId);
    }

    this.pruneDeliveredMessageIds(now);
    const previous = this.deliveredMessageIds.get(sourceMessageId);
    if (previous) {
      // Refresh recency so duplicate bursts do not evict a still-active key.
      this.deliveredMessageIds.delete(sourceMessageId);
      this.deliveredMessageIds.set(sourceMessageId, { seenAt: now, fingerprint: previous.fingerprint });
      this.enforceDedupeCapacity();
      if (previous.fingerprint === fingerprint) {
        this.log(
          `Duplicate Codex message suppressed (msgId=${message.id}, source=${message.source}, ` +
          `instance=${this.instanceId})`,
        );
        return null;
      }

      // One ACK key cannot safely represent two different payloads. Preserve
      // the later payload under a deterministic collision ID and warn loudly.
      return this.preserveIdCollision(message, fingerprint, originalSourceId);
    }

    this.deliveredMessageIds.set(sourceMessageId, { seenAt: now, fingerprint });
    this.enforceDedupeCapacity();
    return {
      ...message,
      id: this.allocateDeliveryId(sourceMessageId),
      sourceMessageId,
      originalSourceMessageId: originalSourceId,
    };
  }

  private enforceDedupeCapacity(): void {
    while (this.deliveredMessageIds.size > this.dedupeCapacity) {
      const oldest = this.deliveredMessageIds.keys().next().value;
      if (oldest === undefined) break;
      this.deliveredMessageIds.delete(oldest);
    }
  }

  private allocateDeliveryId(sourceMessageId: string): string {
    const suffix = `_delivery_${this.notificationIdPrefix}_${++this.deliverySeq}`;
    return `${sourceMessageId.slice(0, 512 - suffix.length)}${suffix}`;
  }

  private preserveIdCollision(
    message: BridgeMessage,
    fingerprint: string,
    originalSourceMessageId: string,
  ): MailboxMessage | null {
    const suffix = `_collision_${fingerprint.slice(0, 12)}`;
    const collisionId = `${message.id.slice(0, 512 - suffix.length)}${suffix}`;
    this.log(
      `WARNING: conflicting Codex message id ${message.id}; preserving the later payload as ${collisionId}`,
    );
    return this.rememberDelivery({ ...message, id: collisionId }, originalSourceMessageId);
  }

  private pruneDeliveredMessageIds(now: number): void {
    for (const [id, record] of this.deliveredMessageIds) {
      if (now - record.seenAt <= this.dedupeTtlMs) break;
      this.deliveredMessageIds.delete(id);
    }
  }

  /** Insert into the authoritative mailbox before Channel push. */
  private queueFallbackMessage(message: MailboxMessage | BridgeMessage): boolean {
    if (!("sourceMessageId" in message)) {
      message = {
        ...message,
        sourceMessageId: message.id,
        originalSourceMessageId: message.id,
      };
    }
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
      return false;
    }

    let dropped = 0;
    while (
      this.pendingMessages.length >= this.maxBufferedMessages ||
      this.pendingMessageBytes + messageBytes > this.maxBufferedBytes
    ) {
      const droppedMessage = this.pendingMessages.shift();
      const droppedBytes = this.pendingMessageByteSizes.shift() ?? 0;
      if (!droppedMessage) break;
      this.cancelDeliveryRetry(droppedMessage.id);
      this.deliveredMessageIds.delete(droppedMessage.sourceMessageId);
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
    return true;
  }

  // ── get_messages ───────────────────────────────────────────

  private hasPendingMessage(messageId: string): boolean {
    return this.pendingMessages.some((message) => message.id === messageId);
  }

  private armDeliveryRetry(message: MailboxMessage, attempts: number): void {
    this.cancelDeliveryRetry(message.id);
    if (!this.hasPendingMessage(message.id)) return;
    if (attempts >= this.deliveryMaxAttempts) return;

    const exponent = Math.max(0, attempts - 1);
    const delayMs = Math.min(this.deliveryRetryBaseMs * (2 ** exponent), 2_147_483_647);
    const entry: PendingDeliveryRetry = { message, attempts };
    // Register before installing the timer so a scheduler seam that fires the
    // callback synchronously still finds (and can advance) this entry.
    this.deliveryRetries.set(message.id, entry);
    entry.timer = this.deliveryScheduler.setTimeout(() => {
      delete entry.timer;
      void this.retryPendingDelivery(entry);
    }, delayMs);
    (entry.timer as { unref?: () => void } | undefined)?.unref?.();
  }

  private async retryPendingDelivery(entry: PendingDeliveryRetry): Promise<void> {
    const current = this.deliveryRetries.get(entry.message.id);
    if (current !== entry || !this.hasPendingMessage(entry.message.id)) {
      if (current === entry) this.deliveryRetries.delete(entry.message.id);
      return;
    }

    const nextAttempt = entry.attempts + 1;
    this.log(`Retrying unacknowledged Channel delivery: ${entry.message.id} (attempt=${nextAttempt})`);
    // Install the next timer before awaiting transport. This keeps retry
    // scheduling in FIFO callback order even when Channel promises settle out
    // of order. ACK still cancels the newly installed timer by delivery ID.
    this.armDeliveryRetry(entry.message, nextAttempt);
    await this.pushViaChannel(entry.message);

    if (nextAttempt >= this.deliveryMaxAttempts && this.hasPendingMessage(entry.message.id)) {
      this.log(
        `Channel delivery unacknowledged after ${nextAttempt} attempt(s): ${entry.message.id}; ` +
        "message remains available via get_messages",
      );
    }
  }

  private cancelDeliveryRetry(messageId: string): void {
    const entry = this.deliveryRetries.get(messageId);
    if (!entry) return;
    if (entry.timer !== undefined) {
      this.deliveryScheduler.clearTimeout(entry.timer);
    }
    this.deliveryRetries.delete(messageId);
  }

  private acknowledgeMessages(
    messageIds: string[],
    acknowledgeResumeControl = true,
  ): { acknowledged: string[]; unknown: string[] } {
    const requested = [...new Set(messageIds)];
    const requestedSet = new Set(requested);
    const resumeIds = new Set(
      this.pendingMessages
        .filter((message) => requestedSet.has(message.id) && message.resumeId)
        .map((message) => message.resumeId!),
    );

    // A budget resume is one logical directive with potentially several
    // delivery-attempt IDs. Acknowledging any attempt retires every queued
    // sibling so a later pull cannot repeat an already processed directive.
    for (const message of this.pendingMessages) {
      if (message.resumeId && resumeIds.has(message.resumeId)) {
        requestedSet.add(message.id);
      }
    }
    const acknowledged: string[] = [];
    const remainingMessages: MailboxMessage[] = [];
    const remainingSizes: number[] = [];

    for (let i = 0; i < this.pendingMessages.length; i++) {
      const message = this.pendingMessages[i]!;
      const bytes = this.pendingMessageByteSizes[i] ?? utf8ByteLength(message.content);
      if (requestedSet.has(message.id)) {
        acknowledged.push(message.id);
        this.pendingMessageBytes = Math.max(0, this.pendingMessageBytes - bytes);
        this.cancelDeliveryRetry(message.id);
      } else {
        remainingMessages.push(message);
        remainingSizes.push(bytes);
      }
    }

    this.pendingMessages = remainingMessages;
    this.pendingMessageByteSizes = remainingSizes;
    if (acknowledgeResumeControl) {
      for (const resumeId of resumeIds) {
        if (this.resumeAckHandler) {
          this.resumeAckHandler(resumeId, "resumed");
        } else {
          this.log(`Resume mailbox message acknowledged without a daemon ACK handler (resume_id=${resumeId})`);
        }
      }
    }
    const acknowledgedSet = new Set(acknowledged);
    const unknown = requested.filter((id) => !acknowledgedSet.has(id));
    if (acknowledged.length > 0 || unknown.length > 0) {
      this.log(
        `ack_messages (instance=${this.instanceId}, acknowledged=${acknowledged.length}, ` +
        `unknown=${unknown.length}, pending=${this.pendingMessages.length})`,
      );
    }
    return { acknowledged, unknown };
  }

  private acknowledgeResume(resumeId: string): number {
    const ids = this.pendingMessages
      .filter((message) => message.resumeId === resumeId)
      .map((message) => message.id);
    return this.acknowledgeMessages(ids, false).acknowledged.length;
  }

  private drainMessages(ackIds: string[] = []): { content: Array<{ type: "text"; text: string }> } {
    const ackResult = ackIds.length > 0
      ? this.acknowledgeMessages(ackIds)
      : { acknowledged: [] as string[], unknown: [] as string[] };
    this.log(
      `get_messages called (instance=${this.instanceId}, pending=${this.pendingMessages.length}, ` +
      `bytes=${this.pendingMessageBytes}, dropped=${this.droppedMessageCount}, oversized=${this.oversizedMessageCount})`,
    );
    if (this.pendingMessages.length === 0 && this.droppedMessageCount === 0 && this.oversizedMessageCount === 0) {
      if (ackResult.acknowledged.length > 0 || ackResult.unknown.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: formatAckResult(ackResult) + " No unacknowledged messages from Codex.",
          }],
        };
      }
      return {
        content: [{ type: "text" as const, text: "No new messages from Codex." }],
      };
    }

    // Snapshot without clearing. Only an explicit ACK may remove a message.
    const messages = [...this.pendingMessages];
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
        return `---\n[${i + 1}] ${ts} [id: ${msg.id}]\nCodex: ${msg.content}`;
      })
      .join("\n\n");

    const noticeText = notices.map((notice) => `WARNING: ${notice}`).join("\n");
    const parts: string[] = [];
    if (ackResult.acknowledged.length > 0 || ackResult.unknown.length > 0) {
      parts.push(formatAckResult(ackResult));
    }
    if (count > 0) {
      parts.push(`[${count} unacknowledged message${count > 1 ? "s" : ""} from Codex]\nchat_id: ${this.sessionId}`);
    }
    if (noticeText) parts.push(noticeText);
    if (formatted) parts.push(formatted);
    if (messages.length > 0) {
      parts.push(
        `After fully processing these messages, call ack_messages with ack_ids: ` +
        JSON.stringify(messages.map((message) => message.id)),
      );
    }

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
              wrap_up: {
                type: "boolean",
                description: "Set true ONLY to declare a finishing turn when the budget gate is in 5h finishing-protection (you got a budget_admission error or a system_budget_admission notice). A wrap-up reply is let through the admission gate up to a small per-5h-window quota so you can bring the current collaboration to a checkpoint; do NOT use it to start new work. Leave false/unset for normal replies.",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_messages",
          description:
            "Return all unacknowledged Codex messages in stable order. Messages remain until ack_messages confirms their stable IDs. Optionally acknowledge IDs from a previous result with ack_ids before reading the remaining mailbox.",
          inputSchema: {
            type: "object" as const,
            properties: {
              ack_ids: {
                type: "array",
                items: { type: "string", minLength: 1, maxLength: 512 },
                maxItems: this.ackIdsCap,
                description: "Optional stable message IDs from a previous get_messages result to acknowledge before returning the remaining mailbox.",
              },
            },
            required: [],
          },
        },
        {
          name: "ack_messages",
          description:
            "Acknowledge Codex messages only after fully processing them. Works for messages received through Channel push or get_messages. Removes only the requested stable IDs and cancels their retries.",
          inputSchema: {
            type: "object" as const,
            properties: {
              ack_ids: {
                type: "array",
                items: { type: "string", minLength: 1, maxLength: 512 },
                minItems: 1,
                maxItems: this.ackIdsCap,
                description: "Stable message IDs to acknowledge, from Channel meta.message_id or get_messages [id: ...] labels.",
              },
            },
            required: ["ack_ids"],
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
        {
          name: "ack_resume",
          description:
            "ONLY for acknowledging a system_budget_resume directive (the budget window refreshed). NOT a general channel to Codex (use reply for that). This is an acknowledgement that you RECEIVED the resume directive — call it as soon as you see the notice, then continue the work; do NOT wait until the task is finished.",
          inputSchema: {
            type: "object" as const,
            properties: {
              resume_id: {
                type: "string",
                description: "The resume_id from the system_budget_resume notice (meta.resume_id).",
              },
              status: {
                type: "string",
                enum: ["resumed", "declined", "already_running"],
                description:
                  "Acknowledgement outcome, recorded for observability only — all three values stop the resume re-push identically (the bridge takes no different downstream action for \"declined\"). \"resumed\" (default): you are resuming the task. \"declined\": you are not resuming. \"already_running\": you were already working and need no resume.",
              },
            },
            required: ["resume_id"],
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
        const parsed = parseAckIds((args as Record<string, unknown> | undefined)?.ack_ids, false, this.ackIdsCap);
        if (!parsed.ok) return ackIdsError(parsed.error);
        return this.drainMessages(parsed.ids);
      }

      if (name === "ack_messages") {
        return this.handleAckMessages(args as Record<string, unknown>);
      }

      if (name === "get_budget") {
        return this.handleGetBudget();
      }

      if (name === "ack_resume") {
        return this.handleAckResume(args as Record<string, unknown>);
      }

      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    });
  }

  private handleAckMessages(args: Record<string, unknown>) {
    const parsed = parseAckIds(args?.ack_ids, true, this.ackIdsCap);
    if (!parsed.ok) return ackIdsError(parsed.error);

    const result = this.acknowledgeMessages(parsed.ids);
    return {
      content: [{ type: "text" as const, text: formatAckResult(result) }],
    };
  }

  /**
   * Handle ack_resume (PR4): Claude acknowledging a system_budget_resume
   * directive. Mirrors handleReply's boundary checks, but routes through the
   * dedicated resumeAckHandler — NEVER the replySender. Validation failures
   * never invoke the handler.
   */
  private async handleAckResume(args: Record<string, unknown>) {
    const resumeIdRaw = args?.resume_id;
    if (typeof resumeIdRaw !== "string" || resumeIdRaw.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Error: missing required parameter 'resume_id'" }],
        isError: true,
      };
    }
    if (resumeIdRaw.length > 128) {
      return {
        content: [{ type: "text" as const, text: `Error: resume_id is too long (${resumeIdRaw.length} chars, max 128).` }],
        isError: true,
      };
    }

    const statusRaw = args?.status;
    if (
      statusRaw !== undefined &&
      statusRaw !== "resumed" &&
      statusRaw !== "declined" &&
      statusRaw !== "already_running"
    ) {
      return {
        content: [{ type: "text" as const, text: `Error: invalid status value ${JSON.stringify(statusRaw)} — use "resumed", "declined" or "already_running".` }],
        isError: true,
      };
    }
    const status: string = typeof statusRaw === "string" ? statusRaw : "resumed";

    if (!this.resumeAckHandler) {
      this.log("No resume ack handler registered");
      return {
        content: [{ type: "text" as const, text: "Error: bridge not initialized, cannot acknowledge resume." }],
        isError: true,
      };
    }

    this.log(`ack_resume received (resume_id=${resumeIdRaw}, status=${status}, instance=${this.instanceId})`);
    this.resumeAckHandler(resumeIdRaw, status);
    const mailboxAcknowledged = this.acknowledgeResume(resumeIdRaw);

    return {
      content: [{
        type: "text" as const,
        text:
          `Resume acknowledged (resume_id=${resumeIdRaw}, status=${status}, ` +
          `mailbox_messages=${mailboxAcknowledged}).`,
      }],
    };
  }

  private async handleGetBudget() {
    // Fresh-if-stale: a get_budget call is an explicit task-allocation decision
    // point, so when the broadcast cache is older than budgetFreshTtlMs ask the
    // daemon for a read-only on-demand refresh. Fresh cache (or no fetcher wired)
    // → render the cache directly. Refresh failure/timeout → fall back to the
    // (stale) cache, else the unavailable text.
    let snapshot = this.budgetSnapshot;
    const fresh = snapshot !== null && this.isBudgetSnapshotFresh(snapshot);
    this.log(
      `get_budget called (instance=${this.instanceId}, hasSnapshot=${snapshot !== null}, fresh=${fresh})`,
    );
    if (!fresh && this.requestFreshSnapshot) {
      const refreshed = await this.refreshBudgetSnapshot();
      snapshot = refreshed ?? this.budgetSnapshot;
    }
    const text = snapshot ? renderBudgetSnapshot(snapshot) : BUDGET_UNAVAILABLE_TEXT;
    return {
      content: [{ type: "text" as const, text }],
    };
  }

  private isBudgetSnapshotFresh(snapshot: BudgetSnapshot): boolean {
    if (!snapshot.updatedAt || snapshot.updatedAt <= 0) return false;
    const ageMs = this.wallNow() - snapshot.updatedAt * 1000;
    // Negative age (clock skew between daemon poll time and this process) is
    // treated as fresh — never trigger a refresh on a future-stamped snapshot.
    return ageMs < this.budgetFreshTtlMs;
  }

  /**
   * Single-flight on-demand refresh: concurrent get_budget calls await ONE
   * in-flight daemon round-trip. A successful refresh updates the cache; a null
   * result (timeout / unavailable) leaves the existing cache untouched so the
   * caller can fall back to it.
   */
  private refreshBudgetSnapshot(): Promise<BudgetSnapshot | null> {
    if (!this.requestFreshSnapshot) return Promise.resolve(null);
    if (!this.pendingBudgetRefresh) {
      this.pendingBudgetRefresh = this.requestFreshSnapshot()
        .then((snapshot) => {
          if (snapshot) this.budgetSnapshot = snapshot;
          return snapshot;
        })
        .catch((error) => {
          this.log(`get_budget refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
        .finally(() => {
          this.pendingBudgetRefresh = null;
        });
    }
    return this.pendingBudgetRefresh;
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

    const wrapUp = args?.wrap_up === true;
    const result = await this.replySender(bridgeMsg, requireReply, onBusy, idempotencyKey, wrapUp);
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
      responseText += ` Note: ${pending} unacknowledged Codex message${pending > 1 ? "s" : ""} in the mailbox \u2014 ` +
        "call get_messages if any are unprocessed, and acknowledge processed IDs with ack_messages.";
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }

  private log(msg: string) {
    this.logger.log(msg);
  }
}

type AckIdsParseResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

function parseAckIds(value: unknown, required: boolean, maxItems = 100): AckIdsParseResult {
  if (value === undefined) {
    return required
      ? { ok: false, error: "missing required parameter 'ack_ids'" }
      : { ok: true, ids: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "ack_ids must be an array of message ID strings" };
  }
  if (required && value.length === 0) {
    return { ok: false, error: "ack_ids must contain at least one message ID" };
  }
  if (value.length > maxItems) {
    return { ok: false, error: `ack_ids has ${value.length} items; maximum is ${maxItems}` };
  }
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > 512) {
      return { ok: false, error: "each ack_ids item must be a non-empty string of at most 512 characters" };
    }
  }
  return { ok: true, ids: value as string[] };
}

function ackIdsError(error: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error}.` }],
    isError: true,
  };
}

function formatAckResult(result: { acknowledged: string[]; unknown: string[] }): string {
  const parts = [`Acknowledged ${result.acknowledged.length} message${result.acknowledged.length === 1 ? "" : "s"}.`];
  if (result.acknowledged.length > 0) {
    parts.push(`IDs: ${JSON.stringify(result.acknowledged)}.`);
  }
  if (result.unknown.length > 0) {
    parts.push(`Already acknowledged or unknown IDs: ${JSON.stringify(result.unknown)}.`);
  }
  return parts.join(" ");
}

function deliveryFingerprint(message: BridgeMessage): string {
  return createHash("sha256")
    .update(JSON.stringify([message.source, message.content, message.resumeId ?? null]))
    .digest("hex");
}

function normalizeDeliveryId(id: string): string {
  if (id.length > 0 && id.length <= 512 && /^[A-Za-z0-9._:-]+$/.test(id)) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `agentbridge_${digest}`;
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
