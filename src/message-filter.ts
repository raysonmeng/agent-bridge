import type { BridgeMessage } from "./types";

export type MarkerLevel = "important" | "status" | "fyi" | "untagged";
export type FilterMode = "filtered" | "full";

export interface FilterResult {
  action: "forward" | "buffer" | "drop";
  marker: MarkerLevel;
}

export interface RouteCodexMessageContext {
  mode: FilterMode;
  replyArmed: boolean;
  inAttentionWindow: boolean;
}

export interface RouteCodexMessageResult extends FilterResult {
  reason: "forward" | "buffer" | "drop" | "buffer-attention" | "force-forward-reply-required";
  flushStatusBuffer?: boolean;
  startAttentionWindow?: boolean;
  noteReplyForwarded?: boolean;
}

const MARKER_REGEX = /^\s*\[(IMPORTANT|STATUS|FYI)\]\s*/i;

export function parseMarker(content: string): { marker: MarkerLevel; body: string } {
  const match = content.match(MARKER_REGEX);
  if (!match) return { marker: "untagged", body: content };
  return {
    marker: match[1].toLowerCase() as MarkerLevel,
    body: content.slice(match[0].length),
  };
}

export function classifyMessage(content: string, mode: FilterMode): FilterResult {
  if (mode === "full") return { action: "forward", marker: "untagged" };
  const { marker } = parseMarker(content);
  switch (marker) {
    case "important":
      return { action: "forward", marker };
    case "status":
      return { action: "buffer", marker };
    case "fyi":
      return { action: "drop", marker };
    case "untagged":
      return { action: "forward", marker };
  }
}

export function routeCodexMessage(
  content: string,
  ctx: RouteCodexMessageContext,
): RouteCodexMessageResult {
  const result = classifyMessage(content, ctx.mode);

  if (ctx.replyArmed) {
    return {
      action: "forward",
      marker: result.marker,
      reason: "force-forward-reply-required",
      flushStatusBuffer: true,
      noteReplyForwarded: true,
    };
  }

  if (ctx.inAttentionWindow && result.marker === "status") {
    return {
      action: "buffer",
      marker: result.marker,
      reason: "buffer-attention",
    };
  }

  if (result.action === "forward" && result.marker === "important") {
    return {
      ...result,
      reason: "forward",
      flushStatusBuffer: true,
      startAttentionWindow: true,
    };
  }

  return {
    ...result,
    reason: result.action,
  };
}

// NOTE: the static "bridge contract" (message markers, git-write prohibition,
// Codex role guidance) used to be appended to EVERY claude→codex message here.
// It now lives once in AGENTS_MD_SECTION (src/collaboration-content.ts), injected
// into the project's AGENTS.md by `abg init` and loaded by Codex on startup.
// Appending it per-message polluted every Codex thread + its resume title, so it
// was removed. AGENTS.md is the single source of truth for that contract now.
// Only the DYNAMIC, per-message reply-required instruction remains here.
const REPLY_REQUIRED_INSTRUCTION = `\n\n[⚠️ REPLY REQUIRED] Claude has explicitly requested a reply. You MUST send an agentMessage with [IMPORTANT] marker containing your response. This is a mandatory requirement — do not skip or use [STATUS]/[FYI] markers for this reply.`;

export { REPLY_REQUIRED_INSTRUCTION };

export class StatusBuffer {
  private buffer: BridgeMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushThreshold: number;
  private readonly flushTimeoutMs: number;
  private paused = false;

  constructor(
    private readonly onFlush: (summary: BridgeMessage) => void,
    options?: { flushThreshold?: number; flushTimeoutMs?: number },
  ) {
    this.flushThreshold = options?.flushThreshold ?? 3;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? 15000;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Pause automatic flushing (threshold + timeout). Manual flush() still works. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume automatic flushing. Restarts timer if buffer has content. */
  resume(): void {
    this.paused = false;
    if (this.buffer.length > 0) {
      this.resetTimer();
      if (this.buffer.length >= this.flushThreshold) {
        this.flush("threshold reached after resume");
      }
    }
  }

  add(message: BridgeMessage): void {
    this.buffer.push(message);
    if (this.paused) return; // Don't auto-flush while paused
    this.resetTimer();
    if (this.buffer.length >= this.flushThreshold) {
      this.flush("threshold reached");
    }
  }

  flush(reason: string): void {
    if (this.buffer.length === 0) return;
    this.clearTimer();
    const combined = this.buffer
      .map((m) => parseMarker(m.content).body)
      .join("\n---\n");
    const summary: BridgeMessage = {
      id: `status_summary_${Date.now()}`,
      source: "codex",
      content: `[STATUS summary — ${this.buffer.length} update(s), flushed: ${reason}]\n${combined}`,
      timestamp: Date.now(),
    };
    // Clear AFTER calling onFlush — if the send fails, emitToClaude's
    // bufferedMessages fallback will still capture the summary. Clearing
    // first would lose messages when ws.send() throws on a closing socket.
    this.onFlush(summary);
    this.buffer = [];
  }

  dispose(): void {
    this.clearTimer();
    this.buffer = [];
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush("timeout");
    }, this.flushTimeoutMs);
  }
}
