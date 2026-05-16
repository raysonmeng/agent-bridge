# Shared Thread Mode — Design Spec (v2.2)

**Status:** Final — Codex go-with-edits (codex_msg_34d65b44c51d_25) applied. Ready for implementation.
**Branch:** `feat/shared-thread-mode`
**Author:** Claude (Opus 4.7), with design input from Codex
**Date:** 2026-05-15

## 0. v1 → v2 → v2.1 → v2.2 changelog

v1 proposed `ClaudeThread + thread/resume(tuiThreadId)` as the sharing mechanism. Codex's independent review found this **blocked by codex-rs**: `thread/resume` rejects unmaterialized threads (`no rollout found for thread id`), confirmed by source test `thread_resume_rejects_unmaterialized_thread` and reproduced locally on codex-cli 0.130.0.

v2 adopted Codex's counter-proposal: **paired Claude uses CodexAdapter as shared transport** (the v1 mechanism from this project's earliest version), no thread/resume needed. ClaudeThread + thread/start path is kept for **unpaired (isolated) Claudes only**, preserving multi-Claude isolation.

v2.2 applies Codex's go-with-edits final review:
- **§4.3 protocol fix**: `error` is a top-level notification (`params.error`), NOT a `ThreadItem` variant. `thread/closed` likewise. Update protocol allowlist.
- **§4.3 + ClaudeAdapter rule**: `turnStarted` system message MUST NOT satisfy `requireReply`. Only `agentMessage`, `error`, `threadClosed`, or `turnCompleted-without-agentMessage` releases it. Otherwise no-output failures get masked by the start message.
- **§4.5 race fix**: implement content-hash echo dedup alongside turnId, narrowly scoped to the pre-response window (~5s). turnId stays the 60s primary mechanism.
- **R3 confirmed**: `AGENTBRIDGE_PAIR_REAP_MS = 30000` (separate from CLAUDE_REAP_MS).
- **Wording**: "restoring shared Codex TUI session, retry shortly" for app-server reconnect window (vs "provisioning" for first-time bootstrap).
- **Consistency fixes**: §5.1 default reconciled to `PAIR_RACE_MS=0`; P6 uses `source:"codex"` with prefix; E1 references §4.6.

v2.1 refined v2 with Codex's second review:
- **Echo prevention**: turnId dedup (not content-hash) as primary mechanism
- **Whitelist expansion**: control-plane events (`turn/started`, `turn/completed`, `error`, `thread/closed`) MUST forward, otherwise paired Claude's `requireReply` hangs silently on failures
- **Source-type encoding**: keep `BridgeMessage.source` as `"claude"|"codex"`. User-typed text forwarded as `source:"codex"` with explicit prefix
- **§8 E7 correction**: `injectMessage` returns `false` when turn-in-progress, no queue. Paired Claude gets a `busy, retry` error
- **New paired state**: `paired-but-not-ready` — pairing happens on TUI WS connect, but injection requires `thread/started` first. `reply` returns provisioning error during this window
- **Token discrimination transport**: implementation uses Codex's native `--remote-auth-token-env` Authorization header path. Current `codex-cli 0.130.0` rejects query strings in `--remote` (`ws://host:port` only). The proxy still accepts legacy `abg_token` query values for probes/backcompat.

## 1. Motivation

(unchanged from v1) User wants the right-pane Codex TUI to show Claude↔Codex activity in real time AND accept user typing as a third voice, while keeping multi-Claude parallelism. Restore v1 UX of this project, conditional on a single paired (Claude, TUI) pair.

## 2. Goals & non-goals

### Goals
- Designated "paired" (Claude, TUI) duo shares a single Codex thread (the TUI's thread).
- Paired Claude's turn/start is **injected through the TUI's WS** (via `CodexAdapter.injectMessage`), so:
  - The TUI sees the turn natively (it's a normal turn on its own thread).
  - The TUI sees responses normally.
- User-typed messages in the TUI route back to the paired Claude (so Claude has full conversation context).
- Multi-Claude isolation preserved: a second Claude attaches as an isolated ClaudeThread, untouched.
- Pairing opt-in via `--via-proxy` on the TUI; default `agentbridge codex` stays direct.

### Non-goals
- Multiple `--via-proxy` TUIs simultaneously. The first wins; subsequent are rejected at WS handshake.
- Multiple paired Claudes sharing one TUI. The first Claude wins; subsequent Claudes go isolated.
- Mirroring multiple Claude threads into one TUI.
- Standalone observability dashboard for N-Claude scenarios (separate effort).
- Daemon-crash recovery for paired sessions. If daemon dies, both sides must restart (document the limit).
- `thread/resume` semantics. Not used by this design.

## 3. Architecture overview

```
                    ┌────────────────────────────┐
                    │   Codex app-server :4500   │
                    │   (thread T_proxy lives)   │
                    └────────────┬───────────────┘
                                 │  WS (proxy intercepts)
              ┌──────────────────┴────────────────┐
              │   CodexAdapter (in daemon)        │
              │   - tuiWs ──── shared transport   │
              │   - pairedChatId: "claude_abc"    │
              │   - injectMessage(text) for paired│
              │   - emits item/userMessage  ─┐    │
              │   - emits item/agentMessage ─┤    │
              └────────┬──────────────────┬──┴────┘
                       │ WS :4501         │ control plane
                       │                  │
                ┌──────▼──────┐    ┌──────▼──────────────────────┐
                │  Proxy TUI  │    │  Daemon (chats map)         │
                │  (right     │    │  - paired Claude: chat_abc  │
                │   pane)     │    │  - isolated Claude(s):      │
                │             │    │    chat_xyz → ClaudeThread  │
                └─────────────┘    └─────────────────────────────┘
                                          │
                  ┌───────────────────────┼──────────────────┐
                  │                       │                  │
            ┌─────▼────┐            ┌─────▼─────┐      ┌─────▼─────┐
            │ Paired   │            │ Isolated  │      │ Isolated  │
            │ Claude   │            │ Claude #2 │      │ Claude #N │
            │ (reply → │            │ (own      │      │ (own      │
            │ inject) │             │  thread)  │      │  thread)  │
            └──────────┘            └───────────┘      └───────────┘
```

**Key invariants:**
1. At most one `tuiWs` (paired TUI) per daemon. Second WS connection that's not the paired TUI's own secondary picker is rejected.
2. At most one `pairedChatId`. Set when first eligible Claude attaches while `tuiWs != null`.
3. Paired Claude has **no ClaudeThread**. Its reply/turn flows entirely through CodexAdapter.
4. Isolated Claudes (chatId ≠ pairedChatId) use ClaudeThread normally — unchanged.

## 4. CodexAdapter changes

### 4.1 Paired-chat ownership

Add to `CodexAdapter`:

```ts
private pairedChatId: string | null = null;

setPairedChat(chatId: string | null): void {
  this.pairedChatId = chatId;
  this.logger(`[CodexAdapter] paired chat set to: ${chatId ?? "<none>"}`);
}

isPaired(chatId: string): boolean {
  return this.pairedChatId === chatId;
}
```

Daemon calls `setPairedChat()` exactly once per pairing event. Cleared on Claude detach (after grace) OR on proxy TUI disconnect (full clear).

### 4.2 Inbound: Claude → injectMessage → tuiWs

`injectMessage(text: string): boolean` already exists at line 225. No signature change. Daemon's per-chat routing decides which transport to use:

- If `chatId === codexAdapter.pairedChatId`: call `codexAdapter.injectMessage(text)`. The text becomes a `turn/start` injected on the TUI's WS, so codex-rs treats it as if the TUI's user typed it.
- Otherwise: existing ClaudeThread path (`thread/start` + own thread).

### 4.3 Outbound: items routed to paired Claude

Without a ClaudeThread, paired Claude has no native turn-tracking. The CodexAdapter must emit enough signals so paired Claude's `requireReply` doesn't hang on errors. Items routed:

**Transcript items** (rendered as conversation):
- `item/completed` with `item.type === "agentMessage"` — Codex's response → forwarded as `BridgeMessage{ source: "codex", content }` (unchanged from existing)
- `item/completed` with `item.type === "userMessage"` AND `params.turnId NOT in injectedTurnIds` — user typed in TUI → forwarded as `BridgeMessage{ source: "codex", content: "[IMPORTANT] Human typed in the paired Codex TUI:\n${text}" }`

**Control-plane events** (forwarded as system messages so paired Claude knows turn state):
- `turn/started` (notification) — emit system message `{ source: "codex", content: "[system] Codex turn started", satisfiesRequireReply: false }`. **Diagnostic only, MUST NOT satisfy `requireReply`** — otherwise no-output failures get masked by the start message.
- `turn/completed` (notification) — emit system message `{ source: "codex", content: "[system] Codex turn completed", satisfiesRequireReply: true (only if no agentMessage came in this turn) }`. Used as the "no-output failure" signal: if a turn started and completed without an agentMessage, this is the only signal paired Claude has that something went wrong.
- `error` (top-level notification, NOT a ThreadItem) — codex-rs emits this as `{ method: "error", params: { error: { code, message } } }`. Emit system message `{ source: "codex", content: "[error] ${params.error.message}", satisfiesRequireReply: true }`.
- `thread/closed` (top-level notification, NOT a ThreadItem) — emit system message `{ source: "codex", content: "[system] Shared Codex thread closed — pair is being torn down", satisfiesRequireReply: true }`. Triggers daemon's TUI-disconnect-equivalent transition (§5).

**Protocol allowlist update** (`src/app-server-protocol.ts`): the `AppServerNotification` union must include `"error"` and `"thread/closed"` so `isAppServerNotification()` recognizes them. Currently the union only lists `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`. Add:
```ts
| { jsonrpc?: "2.0"; id?: undefined; method: "error"; params?: { error?: { code?: number; message?: string; data?: unknown } } }
| { jsonrpc?: "2.0"; id?: undefined; method: "thread/closed"; params?: { threadId?: string } }
```

**`requireReply` release rule** (enforced in ClaudeAdapter or daemon's per-chat outbound path):
- Messages flagged `satisfiesRequireReply: true` release any outstanding `require_reply` wait.
- `turnStarted` (false) does not release.
- `agentMessage`, `error`, `threadClosed`: release.
- `turnCompleted`: release ONLY if no `agentMessage` was emitted earlier in this same turnId — tracks "turn finished with no output" failure mode. (Daemon keeps a per-turnId `sawAgentMessage` bool.)
- `userMessage` (after echo dedup): release. The human just spoke in the TUI, that counts as a response Claude should react to.

**Source-type encoding rationale**: `BridgeMessage.source` is `"claude" | "codex"` today (`src/types.ts`). v2.2 keeps the type unchanged. User-typed text and system messages are encoded as `source: "codex"` with explicit text prefixes. This avoids invasive type widening across `claude-adapter`, `daemon-client`, control-protocol, and formatting paths.

### 4.4 What does NOT go to paired Claude (whitelist exclusion)

To avoid Claude's context being polluted with internal Codex execution noise:

- `toolCall`, `shellCommand`, `fileChange` items: NOT forwarded. These are Codex's own internal actions; Claude doesn't need them as conversation context. (TUI shows them natively.)
- Approval requests (`item/permissions/requestApproval`, `item/fileChange/requestApproval`, `item/commandExecution/requestApproval`): NOT forwarded to Claude. The user (via TUI) approves, not Claude.
- `reasoning`, `plan`, raw `response` items: NOT forwarded.
- `item/agentMessage/delta` (streaming chunks): NOT forwarded individually — only the final `item/completed` is emitted, as today.

### 4.5 Echo prevention: turnId dedup

When daemon routes a paired Claude's reply through `CodexAdapter.injectMessage(text)`, codex-rs will subsequently emit `item/completed{ item.type: "userMessage", params.turnId: T }` for the very same text. Without dedup, this would echo back to the paired Claude as a user message.

**Mechanism (primary):**

```ts
// In CodexAdapter
private injectedTurnIds = new Map<string, number>();  // turnId → expiresAt
private readonly ECHO_DEDUP_TTL_MS = 60_000;

injectMessage(text: string): boolean {
  // existing turn-in-progress check ...
  const reqId = nextProxyId();
  const turnStart = { jsonrpc: "2.0", id: reqId, method: "turn/start", params: { /* ... */ } };
  this.appServerWs.send(JSON.stringify(turnStart));
  this.pendingInjects.set(reqId, { text, sentAt: Date.now() });
  return true;
}

// On turn/start response:
private handleInjectionTurnStartResponse(response: AppServerResponse<TurnStartResponse>) {
  const turnId = response.result?.turn?.id;
  if (turnId) {
    this.injectedTurnIds.set(turnId, Date.now() + this.ECHO_DEDUP_TTL_MS);
  }
  // existing logic ...
}

// In item/completed handler for userMessage:
const turnId = params?.turnId;
if (typeof turnId === "string" && this.isInjectedTurn(turnId)) {
  return;  // suppress echo
}

private isInjectedTurn(turnId: string): boolean {
  const expiresAt = this.injectedTurnIds.get(turnId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    this.injectedTurnIds.delete(turnId);
    return false;
  }
  return true;
}
```

**Race protection (content-hash, also implemented)**: Even when turnId is present, a `userMessage` notification could arrive **before** the `turn/start` response populates `injectedTurnIds`. The window is tiny but non-zero. Mitigation: a parallel `pendingInjectionHashes: Map<contentHash, expiresAt>` with 5s TTL.

```ts
private pendingInjectionHashes = new Map<string, number>();
private readonly PENDING_HASH_TTL_MS = 5_000;

injectMessage(text: string): boolean {
  // existing turn-in-progress check ...
  const hash = sha1(text).slice(0, 16);
  this.pendingInjectionHashes.set(hash, Date.now() + this.PENDING_HASH_TTL_MS);
  // ... send turn/start, etc.
}

// In item/completed handler for userMessage:
private isEchoOfInjection(text: string, turnId: string | undefined): boolean {
  if (turnId && this.isInjectedTurn(turnId)) return true;        // primary: turnId match
  const hash = sha1(text).slice(0, 16);
  const expires = this.pendingInjectionHashes.get(hash);
  if (expires && Date.now() <= expires) {
    this.pendingInjectionHashes.delete(hash);                    // consume; one-shot
    return true;
  }
  return false;
}
```

The hash map is one-shot (delete on match) to avoid suppressing a legitimate user-typed message that happens to match an earlier injection's text. TTL 5s is well under realistic typing latency for a duplicate.

Metadata-marker approach is rejected — codex-rs's `ThreadItem` does not preserve arbitrary fields on round-trip.

### 4.6 Secondary-picker discrimination

Rejecting any second proxy WS would break codex-rs's own secondary "resume picker" connection (current adapter intentionally supports these via `secondaryConnections` Map at line 83).

**Mechanism: Authorization bearer token.**

- `agentbridge codex --via-proxy` generates a random 16-char token at startup, sets `AGENTBRIDGE_PROXY_TOKEN=<token>`, and starts codex with `--remote ws://127.0.0.1:4501 --remote-auth-token-env AGENTBRIDGE_PROXY_TOKEN`.
- Codex-rs applies this as `Authorization: Bearer <token>` on each remote app-server WebSocket connection. This path is required because current `codex-cli 0.130.0` rejects query strings in `--remote` and only accepts `ws://host:port` / `wss://host:port`.
- Daemon proxy at WS upgrade reads `Authorization: Bearer <token>` as canonical input. It also accepts legacy `?abg_token=<token>` for probe/backcompat coverage.
- Accept/reject logic:
  - If token absent: reject (foreign WS or stale picker from a dead session).
  - If token matches the existing `proxyTuiSlot.token`: allow as secondary picker (route via existing `secondaryConnections` path).
  - If token differs from existing `proxyTuiSlot.token`: reject with WS close 4002 + reason `"another --via-proxy TUI is already connected"`.

If no `proxyTuiSlot` yet (first connect): accept and store `proxyTuiSlot.token = token`.

## 5. Daemon pairing state machine

```ts
type PairReadiness = "not-ready" | "ready";

type ProxyTuiSlot = {
  ws: ServerWebSocket;
  token: string;
  pairedChatId: string | null;
  readiness: PairReadiness;        // becomes "ready" when CodexAdapter has activeThreadId
  attachedAt: number;
};

class Daemon {
  private proxyTuiSlot: ProxyTuiSlot | null = null;
}
```

**`readiness` state lifecycle:**
- TUI WS opens → `readiness = "not-ready"`. Pairing CAN happen (a Claude attaches) but `reply` returns "thread provisioning, retry in a moment" until ready.
- CodexAdapter observes `thread/started` (existing event path) → daemon flips `readiness = "ready"`. Now `injectMessage` will succeed.
- App-server reconnect / session restore → readiness may flip back to "not-ready" momentarily during `handleSessionRestoreAfterReconnect`. Same provisioning error returned.

**Transitions:**

| Event | Effect |
|---|---|
| Proxy TUI connects with new token | `proxyTuiSlot = {ws, token, pairedChatId: null, readiness: "not-ready", attachedAt: now}`. Notify CodexAdapter via `setProxyTui()`. |
| CodexAdapter emits `thread-ready` (after observing `thread/started` on TUI WS) | `proxyTuiSlot.readiness = "ready"`. If a paired Claude was already attached waiting, no action needed — its next `reply` will succeed. |
| Claude attaches (chat created) | If `proxyTuiSlot && !proxyTuiSlot.pairedChatId` → pair (regardless of readiness): `proxyTuiSlot.pairedChatId = chatId`; call `codexAdapter.setPairedChat(chatId)`; **skip ClaudeThread construction** for this chat. Else: construct ClaudeThread normally (isolated). |
| Paired Claude calls `reply` while `readiness === "not-ready"` | Return error to Claude: `"Shared Codex TUI thread is still provisioning. Retry shortly."` Do NOT inject. Do not hang. |
| Paired Claude calls `reply` while `readiness === "ready"` | Daemon calls `codexAdapter.injectMessage(text)`. If `injectMessage` returns `false` (turn-in-progress, see §8 E7), return error `"Shared Codex TUI is busy with another turn. Retry."` Same surface, different reason. |
| Paired Claude WS detaches | Start grace timer (default `AGENTBRIDGE_PAIR_REAP_MS = 30000`). On expiry, clear `proxyTuiSlot.pairedChatId` and call `codexAdapter.setPairedChat(null)`. Within grace, same chatId reconnect re-pairs immediately. |
| Same Claude reconnects within grace | Cancel grace timer. Pair preserved. No state change in CodexAdapter. |
| Proxy TUI WS disconnects | Clear `proxyTuiSlot = null`. Call `codexAdapter.setPairedChat(null)`. **If a paired Claude was still attached: send Claude a system notice (§4.3 control-plane event), then transition that Claude to isolated mode** — daemon now constructs a fresh ClaudeThread for this chatId (new `thread/start`, new threadId, no replay of TUI conversation context). The system notice content: `"[system] Shared Codex TUI thread is gone. Future replies will use a fresh isolated Codex thread (no prior context carried over)."` |
| Paired Claude receives `thread/closed` notification (forwarded as system message per §4.3) | Same as "Proxy TUI WS disconnects" — pair torn down, transition to isolated, system notice sent. |
| Second proxy TUI connect (foreign token) | Reject at WS upgrade. Daemon does not touch `proxyTuiSlot`. |
| Second proxy TUI connect (same token) | Treat as secondary picker. Route via CodexAdapter's existing `secondaryConnections` path. |

### 5.1 Race window (Claude vs TUI startup order)

- **No grace window.** If Claude attaches and `proxyTuiSlot == null`, it goes straight to isolated. No waiting.
- `AGENTBRIDGE_PAIR_RACE_MS` env var exists for future opt-in but **default is `0`** (no race window). Resolved per Codex review Q4 — predictability over race tolerance.

If user starts TUI after Claude, they must restart Claude to enable pairing. This is documented in the kickoff message:
> "Shared Codex TUI mode is opt-in via `agentbridge codex --via-proxy`. To use it, start the TUI before attaching Claude. If Claude is already attached when you open the TUI, only future Claude sessions can pair."

## 6. ClaudeAdapter / ClaudeThread changes

- `ClaudeAdapter`: unchanged. Its public API (`reply`, `get_messages`) is the same for both paired and isolated chats. The routing decision happens in daemon.
- `ClaudeThread`: unchanged. Just not constructed for the paired chat.
- `Daemon.handleClaudeAttach`: branch on "paired or isolated", construct ClaudeThread only for isolated.

Inbound (Claude → Codex) routing in daemon:
```ts
async onClaudeMessage(chatId: string, text: string): Promise<ReplyResult> {
  if (codexAdapter.isPaired(chatId)) {
    if (proxyTuiSlot.readiness !== "ready") {
      return { ok: false, error: "Shared Codex TUI thread is still provisioning. Retry shortly." };
    }
    const accepted = codexAdapter.injectMessage(text);
    if (!accepted) {
      return { ok: false, error: "Shared Codex TUI is busy with another turn. Retry." };
    }
    return { ok: true };
  }
  // isolated path:
  chats.get(chatId).claudeThread.injectTurn(text);
  return { ok: true };
}
```

Outbound (Codex → Claude) routing — all encoded as `source: "codex"` with explicit prefixes:
```ts
codexAdapter.on("agentMessage", ({ content }) => {
  if (codexAdapter.pairedChatId) {
    forwardToClaude(codexAdapter.pairedChatId, { source: "codex", content });
  }
});

codexAdapter.on("userMessage", ({ content, turnId }) => {
  // §4.5 echo dedup already applied inside CodexAdapter; this event only fires for genuine user typing
  if (codexAdapter.pairedChatId) {
    forwardToClaude(codexAdapter.pairedChatId, {
      source: "codex",
      content: `[IMPORTANT] Human typed in the paired Codex TUI:\n${content}`,
    });
  }
});

codexAdapter.on("turnStarted", () => {
  if (codexAdapter.pairedChatId) {
    forwardToClaude(codexAdapter.pairedChatId, { source: "codex", content: "[system] Codex turn started" });
  }
});

codexAdapter.on("turnCompleted", () => {
  if (codexAdapter.pairedChatId) {
    forwardToClaude(codexAdapter.pairedChatId, { source: "codex", content: "[system] Codex turn completed" });
  }
});

codexAdapter.on("errorItem", ({ detail }) => {
  if (codexAdapter.pairedChatId) {
    forwardToClaude(codexAdapter.pairedChatId, { source: "codex", content: `[error] ${detail}` });
  }
});

codexAdapter.on("threadClosed", () => {
  // also drives §5 transition
  daemon.handleSharedThreadClosed();
});
```

Isolated Claudes get their messages from their own ClaudeThread's existing event flow — unchanged.

## 7. CLI changes (`src/cli/codex.ts`)

- When `--via-proxy`: generate `abgToken = crypto.randomBytes(8).toString("hex")`; spawn codex with the bare proxy URL plus `--remote-auth-token-env AGENTBRIDGE_PROXY_TOKEN`, setting that env var to the token.
- **Pre-flight check**: before spawning codex-rs, hit daemon's `/status` endpoint to check `proxyTuiConnected`. If true: exit(1) with `error: another --via-proxy TUI is already running. Close it first, or use 'agentbridge codex' (direct mode) for parallel.`
- Daemon's `DaemonStatus` adds `proxyTuiConnected: boolean`.

## 8. Edge cases (Codex's review items addressed)

| # | Edge case | Resolution |
|---|---|---|
| E1 | Second `--via-proxy` TUI conflated with codex-rs picker | Token discrimination (§4.6). Same token = picker. New token = reject. |
| E2 | Claude-first, TUI-later | Goes isolated. User must restart Claude to pair. Document in kickoff. |
| E3 | User-typed TUI text not visible to Claude | New `userMessage` event emission (§4.3). |
| E4 | Daemon crash recovery | Out of scope. Both clients restart. Documented. |
| E5 | Transient paired-Claude disconnect race | 30s grace window (§5). Same chatId reconnect resumes pair. |
| E6 | Tool/approval/system noise leaking into Claude context | Strict whitelist in §4.3 (forward agentMessage + userMessage + control-plane events) and §4.4 (block tool/approval/reasoning items). |
| E7 | Turn-arbitration: Claude tries to inject while TUI mid-turn | **Corrected:** `CodexAdapter.injectMessage()` returns `false` when `turnInProgress` — it does not queue. Daemon surfaces `"Shared Codex TUI is busy with another turn. Retry."` to paired Claude. No internal queue in v1. |
| E8 | App-server restart mid-pair | Existing `handleSessionRestoreAfterReconnect` (codex-adapter.ts:566) handles TUI; paired Claude has no separate session to restore. Pair survives, but during restore window `readiness` flips back to `"not-ready"` and `reply` returns provisioning error. |
| E9 | Paired Claude sends `reply` before `thread/started` lands | `readiness === "not-ready"` → daemon returns provisioning error. Paired Claude retries; once `thread/started` arrives, readiness flips to `"ready"` and injection proceeds. |
| E10 | Echo loop: paired Claude's injected text comes back as userMessage | `injectedTurnIds` Set (§4.5). When `item/completed{type: userMessage, params.turnId in set}` arrives, suppress forwarding. Content-hash fallback if turnId absent. |
| E11 | Paired Claude `requireReply` hanging silently on Codex error | Control-plane events (`turn/completed`, `error`, `thread/closed`) forwarded as system messages (§4.3). `requireReply` releases on first forwarded message; error path is observable. |

## 9. Test matrix

Probe scripts (real WS clients) in `probes/shared-thread/`:

| # | Scenario | Asserts |
|---|---|---|
| P1 | TUI (with token) first, Claude second | Claude reply via CodexAdapter; TUI receives turn/started + agentMessage events; both clients see same threadId |
| P2 | Claude first, TUI second | Claude is isolated (own threadId); TUI is unpaired (own threadId); they don't interact |
| P3 | TUI + 2 Claudes | First Claude pairs; second goes isolated. Both Claudes can converse independently. Pair-Claude's turn shows in TUI; isolated-Claude's turn does not. |
| P4 | 2 `--via-proxy` TUIs (different tokens) | Second rejected with 4002 at WS upgrade. CLI exits 1 with clear message. First TUI keeps running. |
| P5 | 1 `--via-proxy` TUI + its secondary picker (same token) | Both accepted. Routing through existing `secondaryConnections`. Pair still works. |
| P6 | TUI sends `userMessage`, paired Claude attached | Claude receives a BridgeMessage with `source: "codex"` and content prefixed `[IMPORTANT] Human typed in the paired Codex TUI:\n...`. Verifies §4.3 encoding + §4.5 echo dedup (the TUI-originated message must reach Claude, while Claude-originated injection echoes must not). |
| P7 | Paired Claude WS disconnects, reconnects within 30s | Pair preserved; CodexAdapter.pairedChatId unchanged. |
| P8 | Paired Claude WS disconnects, doesn't reconnect within 30s | After grace: `pairedChatId = null`. Next attaching Claude can re-pair. |
| P9 | Proxy TUI disconnects (paired Claude still attached) | Pair cleared. Claude transitions to isolated mode (new ClaudeThread). Verify continuity from Claude's side (no message loss). |
| P10 | Approval request from TUI thread mid-pair | Approval goes only to TUI. Paired Claude does NOT see approval-request items. |
| P11 | Tool/shellCommand items mid-pair | Not forwarded to paired Claude (whitelist enforcement). |
| P12 | Paired Claude `reply` with `requireReply=true`, Codex turn completes without an `agentMessage` | Paired Claude's wait releases on `turn/completed` (the "no-output failure" signal). Without this, `requireReply` would hang. |
| P13 | Paired Claude `reply` with `requireReply=true`, codex-rs emits `error` notification (e.g. permission denied) | Paired Claude's wait releases on error system message. Content prefix `[error] ...` visible. |
| P14 | Echo race: paired Claude calls `injectMessage`; `userMessage` notification arrives BEFORE `turn/start` response | Content-hash fallback suppresses echo. Verifies §4.5 race protection. |

Unit tests:
- `codex-adapter.test.ts`: setPairedChat/isPaired; userMessage emission; whitelist (no toolCall/approval leakage); token-based secondary discrimination.
- `daemon.test.ts`: pairing FIFO; grace window; race-protection window; isolation-on-TUI-disconnect transition.
- `cli/codex.test.ts`: token generation; pre-flight status check; `--via-proxy` error path.

## 10. Open questions — status

Questions from v2's first review pass (Codex msg #21), resolved in v2.1:

| Q | Topic | Resolution |
|---|---|---|
| Q1 | Whitelist completeness | **Resolved**: control-plane events (turn/started, turn/completed, error, thread/closed) added (§4.3). Internal noise (tool/approval/reasoning) explicitly blocked (§4.4). |
| Q2 | Token propagation | **Resolved**: implementation uses Codex's `--remote-auth-token-env` bearer header path because `codex-cli 0.130.0` rejects query strings in `--remote`. P5 validates same-token/foreign-token behavior through the proxy. |
| Q3 | TUI-disconnect → isolated transition | **Resolved per Codex**: transition to fresh isolated (new conversation, no replay), with explicit system notice to Claude (§5). |
| Q4 | Race window default | **Resolved**: `PAIR_RACE_MS = 0` (no race window). Document "start TUI first" in kickoff. |
| Q5 | Echo loop | **Resolved**: `injectedTurnIds` Set with TTL keyed on `params.turnId` from `turn/start` response (§4.5). Content-hash fallback documented but not implemented unless P6 reveals turnId missing. |

Open items remaining (resolved by Codex final review):

- **R1**: Token discrimination transport (§4.6). **Status**: resolved to Authorization header via `--remote-auth-token-env`; proxy keeps legacy query parsing only for probes/backcompat.
- **R2**: Content-hash race protection. **Status**: Codex recommended implementing now alongside turnId (§4.5 updated). Both mechanisms ship together; turnId primary (60s TTL), content-hash race-protection (5s TTL, one-shot).
- **R3**: `AGENTBRIDGE_PAIR_REAP_MS` default. **Status**: confirmed `30000` (separate constant from CLAUDE_REAP_MS=600000).

## 11. Implementation order

1. **Spec v2.1 final sign-off from Codex** — confirm R1/R2/R3 in §10 don't block; agree on P5 as the gating empirical test before merging.
2. **CodexAdapter §4 changes**: pairedChatId state, item event emission (agentMessage/userMessage/turnStarted/turnCompleted/errorItem/threadClosed), §4.4 exclusion whitelist enforcement, §4.5 injectedTurnIds dedup, §4.6 token-based secondary discrimination, §5 readiness signaling.
3. **Daemon §5 state machine**: pairing transitions, readiness state, grace window, isolation transition on TUI disconnect with system notice.
4. **ClaudeAdapter routing in daemon §6**: branch on isPaired with paired-not-ready and busy error returns.
5. **CLI §7 changes**: token generation, pre-flight status check, kickoff message documenting "start TUI first".
6. **Unit tests** (§9): codex-adapter, daemon, cli/codex.
7. **Probes P1–P11** (Codex's deliverable, my/user-side execution). **P5 must run** to lock §4.6 path.
8. **Manual cross-test**: left Claude + right `abg codex --via-proxy`, observe 3-way chat; second `abg codex` (direct) in third terminal stays parallel.
9. **Bilingual release notes** + sync `plugins/agentbridge/server/{bridge-server,daemon}.js` bundle via `bun run build:plugin`.

## 12. Division of labor

- **Claude (me)**: §4 CodexAdapter changes, §5 daemon state machine, §6 routing, §7 CLI. Unit tests for each. Spec maintenance.
- **Codex**: Probes P1–P11 in `probes/shared-thread/`. Empirical verification of P5 (token discriminator path). Cross-review of state machine for races I missed. Cross-review of implementation PRs.
- **Both**: `bun run check` before every commit. Bilingual release notes are bilateral.

Sandbox note: Codex's environment cannot bind local listeners (`Bun.serve({port:0})` and `codex app-server --listen ws://...` both fail with `Operation not permitted`). Probes can be written there but final live execution must run on my side or user-side terminals.

---

**Status**: v2.2 has Codex's go-with-edits sign-off. All 4 final-review edits applied. Implementation begins next.

**Implementation kickoff order**:
1. Sync state: `bun run typecheck && bun test src` (baseline green check).
2. Branch off `feat/shared-thread-mode` is current. Start with `app-server-protocol.ts` (§4.3 protocol allowlist) — small, foundational, unblocks CodexAdapter changes.
3. CodexAdapter changes incrementally (each behind a unit test).
4. Daemon state machine.
5. CLI.
6. Probes (Codex's deliverable; P5 first to lock §4.6 path; P14 last as the trickiest race test).
