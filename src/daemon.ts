#!/usr/bin/env bun

/**
 * AgentBridge daemon — multi-Claude variant.
 *
 * Each attached Claude session gets:
 *   - A `chatId` (sent by the MCP at `claude_connect` time).
 *   - A dedicated `ClaudeThread` (own WebSocket to codex app-server, own
 *     codex thread). Turns on different threads run in parallel — verified
 *     by the concurrency probe under `probes/`.
 *   - Per-chat attention window, statusBuffer, replyRequired, and offline
 *     message buffer.
 *
 * Codex TUI continues to use the existing CodexAdapter proxy with its own
 * thread. TUI activity is NOT cross-broadcast to attached Claudes — every
 * Claude sees only events from its own ClaudeThread. This keeps the two
 * surfaces (TUI = human ↔ Codex, Claude = MCP ↔ Codex) isolated.
 */

import type { ServerWebSocket } from "bun";
import { getAsyncFileLogger, closeAllAsyncFileLoggers } from "./log-writer";
import { CodexAdapter } from "./codex-adapter";
import { ClaudeThread } from "./claude-thread";
import {
  BRIDGE_CONTRACT_REMINDER,
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "./message-filter";
import { TuiConnectionState } from "./tui-connection-state";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import { PairRegistry, isValidPairName } from "./pair-registry";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus, PairStatus } from "./control-protocol";
import type { BridgeMessage } from "./types";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
  chatId: string | null;
}

interface ChatState {
  chatId: string;
  /**
   * STM v2.3 §6.1 / §6.4: pair this chat is bound to.
   *
   * P1/P3 always populate this with `"default"` (the only pair until P5
   * introduces multi-pair FIFO claiming). The spec allows `null` for
   * chats with no live home pair — e.g. an isolated chat created after
   * default has been destroyed, or any chat that hasn't yet successfully
   * bound to a pair. Type-widening lands here in P3-cleanup so P5 can
   * use null without a follow-up schema change.
   */
  homePairId: string | null;
  ws: ServerWebSocket<ControlSocketData> | null;
  thread: ClaudeThread;
  ready: boolean;
  /**
   * Spec v2.2 §5: when true, this chat shares the proxy TUI's thread via
   * CodexAdapter (no own thread/start). Replies route through
   * codex.injectMessage; outbound is fed by codex.on("agentMessage" etc).
   * Paired chats skip ClaudeThread.bootstrap() — their `ready` flag flips
   * when proxyTuiSlot.readiness becomes "ready".
   */
  paired: boolean;
  /**
   * Spec v2.2 §4.3: per-turn tracking so daemon can decide whether a
   * `turn/completed` system message satisfies `requireReply`. Resets when
   * a new turn starts on the shared thread.
   */
  pairedTurnSawAgentMessage: boolean;

  inAttentionWindow: boolean;
  attentionWindowTimer: ReturnType<typeof setTimeout> | null;
  replyRequired: boolean;
  replyReceivedDuringTurn: boolean;

  bufferedMessages: BridgeMessage[];
  statusBuffer: StatusBuffer;

  disconnectTimer: ReturnType<typeof setTimeout> | null;
  reaperTimer: ReturnType<typeof setTimeout> | null;
  lastAttachStatusSentTs: number;
  onlineNoticeSent: boolean;
  nextSystemMessageId: number;
}

/**
 * Spec v2.2 §5: daemon-wide state tracking the single proxy TUI (if any).
 * `pairedChatId` is set when a Claude attaches while the slot is open.
 * `readiness` flips to "ready" when CodexAdapter signals thread is ready.
 * Only one slot exists at a time (CodexAdapter §4.6 enforces single TUI).
 */
type PairReadiness = "not-ready" | "ready";

interface ProxyTuiSlot {
  token: string;
  pairedChatId: string | null;
  readiness: PairReadiness;
  attachedAt: number;
  /** Set when paired Claude detaches; clears pairedChatId on expiry. */
  pairReapTimer: ReturnType<typeof setTimeout> | null;
}

const stateDir = new StateDirResolver();
stateDir.ensure();
// Performance fix (2026-05-17 P0): async file logger declared up here so
// any module-top-level code (e.g. `pairRegistry.load()`) that calls
// `log()` finds the logger already initialized. Earlier placement
// triggered ReferenceError "Cannot access 'daemonLogger' before
// initialization" at boot via JS temporal dead zone.
const daemonLogger = getAsyncFileLogger(stateDir.logFile);

// Bug regression E (2026-05-17) — sticky flag: once stderr breaks (broken
// pipe, closed by parent, etc.) stop trying to write to it. Without this,
// EPIPE from stderr.write in log() throws → uncaughtException handler
// calls log() → log() tries stderr.write → throws EPIPE again → infinite
// loop. Historical incident: 8.5 GB log file from `bun daemon.js | head`.
// MUST declare here (above pairRegistry.load() and other module-init code
// that can call log()) — same TDZ constraint as daemonLogger above.
let stderrBroken = false;
process.stderr.on("error", (err: any) => {
  if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
    stderrBroken = true;
  }
});

const configService = new ConfigService();
const config = configService.loadOrDefault();

const CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
const CLAUDE_DISCONNECT_GRACE_MS = 5_000;
const CLAUDE_REAP_AFTER_MS = parseInt(process.env.AGENTBRIDGE_CLAUDE_REAP_MS ?? "600000", 10); // 10 min
const PAIR_REAP_MS = parseInt(process.env.AGENTBRIDGE_PAIR_REAP_MS ?? "30000", 10); // 30s grace for paired Claude reconnect (spec v2.2 §5)
const MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
const FILTER_MODE: FilterMode =
  (process.env.AGENTBRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(
  process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000),
  10,
);
const ATTENTION_WINDOW_MS = parseInt(
  process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ??
    String(config.turnCoordination.attentionWindowSeconds * 1000),
  10,
);

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

const codex = new CodexAdapter({
  pairId: "default",
  appPort: CODEX_APP_PORT,
  proxyPort: CODEX_PROXY_PORT,
  logFile: stateDir.logFile,
});
const attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;

let controlServer: ReturnType<typeof Bun.serve> | null = null;
let nextControlClientId = 0;
let codexBootstrapped = false;
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

/** chatId → ChatState. Survives WS disconnects (lazy reap, see CLAUDE_REAP_AFTER_MS). */
const chats = new Map<string, ChatState>();

/**
 * Spec v2.2 §5: single-slot proxy TUI tracking. null when no `--via-proxy`
 * TUI connected.
 *
 * STM v2.3 P1: this module-level variable is a transitional alias for
 * `pairs.get("default")!.proxyTuiSlot` — the PairState is the canonical
 * container per spec v2.3 §6.1, but the existing ~40 reference sites
 * continue to work unchanged by reading/writing this variable. The
 * PairState entry below uses getter/setter to delegate to this variable
 * so direct accesses (e.g. `proxyTuiSlot = null`) and Map-based accesses
 * (`pairs.get("default")!.proxyTuiSlot = null`) refer to the same slot.
 * P2+ will phase out the direct accesses.
 */
let proxyTuiSlot: ProxyTuiSlot | null = null;

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    broadcastToAllClaudes(
      systemMessage(
        "system_tui_disconnected",
        `⚠️ Codex TUI disconnected (conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    broadcastToAllClaudes(
      systemMessage(
        "system_tui_reconnected",
        `✅ Codex TUI reconnected (conn #${connId}). Bridge restored.`,
      ),
    );
  },
});

/**
 * STM v2.3 §6.1 P1: pairs registry. In P1 there is exactly one entry —
 * `"default"` — and its fields are proxies for the module-level singletons
 * declared above. P2 introduces the full PairState shape (per-pair
 * lifecycle / readiness / reap timers) and P5 admits N pairs.
 *
 * The default entry uses property getters/setters for `proxyTuiSlot` so
 * mutations through either access path (direct variable assignment or
 * `pairs.get("default")!.proxyTuiSlot = X`) stay in sync.
 */
/**
 * STM v2.3 §D9 P2: each event handler registered on a pair's CodexAdapter
 * is tracked here so `detachPairHandlers(pair)` can call `codex.off(name,
 * ref)` for exactly the handlers `attachPairHandlers(pair)` registered.
 * Avoids `removeAllListeners()` which would wipe diagnostics/internal
 * listeners that the daemon does not own.
 */
interface PairHandlerRegistration {
  eventName: string;
  handler: (...args: any[]) => void;
}

interface PairState {
  readonly pairId: string;
  readonly codex: CodexAdapter;
  readonly tuiConnectionState: TuiConnectionState;
  proxyTuiSlot: ProxyTuiSlot | null;
  /** D9 handler refs populated by `attachPairHandlers`. */
  handlerRefs: PairHandlerRegistration[];
  /** P2: live = handlers attached + codex started. Toggled by ensurePair/destroyPair. */
  isLive: boolean;
}

const defaultPairState: PairState = {
  pairId: "default",
  codex,
  tuiConnectionState,
  get proxyTuiSlot() { return proxyTuiSlot; },
  set proxyTuiSlot(v: ProxyTuiSlot | null) { proxyTuiSlot = v; },
  handlerRefs: [],
  isLive: false, // bootCodex / ensurePair("default") flips this to true on success
};
const pairs = new Map<string, PairState>([["default", defaultPairState]]);

// ── STM v2.3 §D2 P3 — pair registry + write mutex ──────────────────────

/**
 * Pair → port-assignment registry. Persisted at `<stateDir>/pairs/registry.json`.
 * Loaded at module start; mutations during `ensure_pair` / `destroy_pair`
 * acquire the daemon-wide `registryWriteMutex` and save atomically via
 * the PairRegistry class.
 */
const pairRegistry = new PairRegistry({
  filePath: `${stateDir.dir}/pairs/registry.json`,
  log: (msg) => log(msg),
});
pairRegistry.load();

/**
 * Daemon-wide registry-write mutex. The per-pair `ensurePairInFlight` map
 * (P3c+) deduplicates concurrent ensures for the SAME pair; this mutex
 * protects ALL registry writes from racing each other. Implemented as a
 * promise chain — each acquire awaits the previous release before
 * proceeding, so two `ensure_pair("work")` + `ensure_pair("side")` calls
 * cannot interleave their read-modify-write of the registry file.
 */
let registryWriteMutex: Promise<unknown> = Promise.resolve();

async function runUnderRegistryMutex<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = registryWriteMutex;
  let release!: (value: unknown) => void;
  registryWriteMutex = new Promise((resolve) => { release = resolve; });
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release(undefined);
  }
}

// Ensure the default pair has a registry entry at startup so list_pairs
// and subsequent ensure_pair("default") calls find it without racing on
// allocation. This is the only synchronous-at-boot registry mutation —
// run it under the mutex anyway to keep the contract simple. The mutex
// is uncontended at this point.
void runUnderRegistryMutex(async () => {
  if (!pairRegistry.has("default")) {
    const result = pairRegistry.allocate("default");
    if (result.ok) {
      try { pairRegistry.save(); } catch (err: any) {
        log(`[pair-registry] failed to persist default entry: ${err?.message ?? err}`);
      }
    } else {
      log(`[pair-registry] failed to materialize default entry: ${result.error.code} — ${result.error.message}`);
    }
  }
});

// ── TUI / app-server event wiring ────────────────────────────────
// Codex TUI activity is INTENTIONALLY not cross-broadcast to Claude sessions.
// We only listen for lifecycle events that affect all chats (TUI connected,
// codex ready, codex exit, etc.).
//
// STM v2.3 §D9 P2: every handler registers on `pair.codex` (currently only
// the default pair's adapter; multi-pair lifecycle in P3+). Each
// registration is tracked in `pair.handlerRefs` so `detachPairHandlers`
// can use targeted `off()` without `removeAllListeners()`-style overreach
// that would clobber diagnostics listeners we do not own.
//
// In P2 the handler bodies still call out to module-level helpers
// (`getPairedChatState`, `chats`, `transitionToIsolated`, etc.). The
// handler bodies use `pair.X` for state owned by the PairState (codex,
// proxyTuiSlot, tuiConnectionState) to make pair scoping explicit even
// though the P1 alias keeps the module-level names pointed at the same
// objects. P3+ will progressively migrate the called-out helpers to be
// pair-aware as well.

function attachPairHandlers(pair: PairState): void {
  if (pair.handlerRefs.length > 0) {
    log(`[pair=${pair.pairId}] attachPairHandlers called but ${pair.handlerRefs.length} handler(s) already attached — no-op`);
    return;
  }
  const on = <E extends string>(eventName: E, handler: (...args: any[]) => void) => {
    pair.codex.on(eventName, handler);
    pair.handlerRefs.push({ eventName, handler });
  };
  // STM v2.3 §6.5 / §6.6 P3c — pair-scoped paired-chat lookup. Replaces the
  // P2-era module-level `getPairedChatState()` which read the default pair's
  // proxyTuiSlot via the P1 alias. Now every handler reads from its own
  // pair's slot, so events on a non-default pair stay routed within that
  // pair's chat scope.
  const getPaired = (): ChatState | null => {
    if (!pair.proxyTuiSlot?.pairedChatId) return null;
    return chats.get(pair.proxyTuiSlot.pairedChatId) ?? null;
  };

  on("ready", (threadId: string) => {
    pair.tuiConnectionState.markBridgeReady();
    log(`[pair=${pair.pairId}] Codex TUI thread ready: ${threadId} (bridge fully operational)`);
    // Spec v2.2 §5: thread/started observed → flip readiness so paired Claude
    // replies stop returning the "provisioning" error.
    if (pair.proxyTuiSlot) {
      pair.proxyTuiSlot.readiness = "ready";
      if (pair.proxyTuiSlot.pairedChatId) {
        const state = chats.get(pair.proxyTuiSlot.pairedChatId);
        if (state && !state.ready) {
          state.ready = true;
          emitToChat(state, systemMessage("system_pair_ready",
            `✅ Shared Codex TUI thread is now ready (threadId=${threadId}). Replies sent via the reply tool will appear in the right pane's TUI.`));
        }
      }
    }
  });

  on("tuiConnected", (connId: number, token: string = "") => {
    pair.tuiConnectionState.handleTuiConnected(connId);
    cancelIdleShutdown();
    log(`[pair=${pair.pairId}] Codex TUI connected (conn #${connId}, token=${token ? token.slice(0, 8) + "…" : "<none>"})`);
    // Spec v2.2 §5: a TUI carrying a non-empty shared-mode token is a proxy TUI.
    // Initialize the slot. Empty token = direct/legacy TUI; no pairing intent.
    if (token && !pair.proxyTuiSlot) {
      pair.proxyTuiSlot = {
        token,
        pairedChatId: null,
        readiness: "not-ready",
        attachedAt: Date.now(),
        pairReapTimer: null,
      };
      log(`[pair=${pair.pairId}] Proxy TUI slot allocated (token=${token.slice(0, 8)}…)`);
      // Spec v2.2 §5.1: PAIR_RACE_MS=0 — Claude-first stays isolated. Do NOT
      // retroactively pair an already-attached isolated Claude. Only chats that
      // attach AFTER this point (in attachClaude) can claim the slot.
    }
    broadcastStatus();
  });

  on("tuiDisconnected", (connId: number) => {
    pair.tuiConnectionState.handleTuiDisconnected(connId);
    log(`[pair=${pair.pairId}] Codex TUI disconnected (conn #${connId})`);
    // Spec v2.2 §5: TUI disconnect tears down the proxy slot. Paired Claude (if
    // any) transitions to isolated mode with a system notice. No prior context
    // is replayed.
    if (pair.proxyTuiSlot) {
      const wasPairedChat = pair.proxyTuiSlot.pairedChatId;
      if (pair.proxyTuiSlot.pairReapTimer) clearTimeout(pair.proxyTuiSlot.pairReapTimer);
      pair.proxyTuiSlot = null;
      pair.codex.setPairedChat(null);
      if (wasPairedChat) {
        const state = chats.get(wasPairedChat);
        if (state) {
          log(`[pair=${pair.pairId}] Transitioning paired chat ${wasPairedChat} to isolated (TUI disconnect)`);
          transitionToIsolated(state, "Shared Codex TUI thread is gone");
        }
      }
    }
    broadcastStatus();
    scheduleIdleShutdown();
  });

  // ── Spec v2.2 §4.3 — shared transport outbound routing ────────
  //
  // When a chat is paired via proxyTuiSlot, CodexAdapter is the transport. All
  // shared-thread events route to the paired chat only.

  on("agentMessage", (msg: BridgeMessage) => {
    const paired = getPaired();
    if (!paired) return;
    log(`[${paired.chatId}] CodexAdapter → paired Claude (agentMessage, ${msg.content.length} chars)`);
    paired.pairedTurnSawAgentMessage = true;
    paired.replyReceivedDuringTurn = true;
    emitToChat(paired, msg);
  });

  on("userMessage", (payload: { content: string; id?: string; turnId?: string }) => {
    const paired = getPaired();
    if (!paired) return;
    if (!payload.content) return;
    log(`[${paired.chatId}] CodexAdapter → paired Claude (userMessage from TUI, ${payload.content.length} chars)`);
    paired.replyReceivedDuringTurn = true;
    emitToChat(paired, {
      id: payload.id ?? `tui_user_${Date.now()}`,
      source: "codex",
      content: `[IMPORTANT] Human typed in the paired Codex TUI:\n${payload.content}`,
      timestamp: Date.now(),
    });
  });

  on("turnStarted", () => {
    const paired = getPaired();
    if (!paired) return;
    // Spec v2.2 §4.3: emit as diagnostic, MUST NOT satisfy requireReply.
    // Reset per-turn agentMessage tracker so turn/completed can detect the
    // "no-output failure" mode.
    paired.pairedTurnSawAgentMessage = false;
    emitToChat(paired, systemMessage("system_codex_turn_started", "[system] Codex turn started"));
  });

  on("turnCompleted", () => {
    const paired = getPaired();
    if (!paired) return;
    // Bug fix (2026-05-16): only surface "no-output failure" when Claude was
    // actually waiting for a reply (replyRequired=true). User-typed TUI turns
    // can legitimately complete without an agentMessage (e.g. silent ack) —
    // emitting failure wording there confused paired Claude.
    if (!paired.pairedTurnSawAgentMessage && paired.replyRequired) {
      log(`[${paired.chatId}] Codex turn completed with no agentMessage while replyRequired — surfacing as failure signal`);
      paired.replyReceivedDuringTurn = true;
      emitToChat(paired, systemMessage("system_codex_turn_completed_no_output",
        "[system] Codex turn completed without any agentMessage — likely a failure or empty response."));
    } else {
      emitToChat(paired, systemMessage("system_codex_turn_completed", "[system] Codex turn completed"));
    }
    paired.replyRequired = false;
    paired.replyReceivedDuringTurn = false;
  });

  on("errorItem", (payload: { code?: number; message?: string }) => {
    const paired = getPaired();
    if (!paired) return;
    paired.replyReceivedDuringTurn = true;
    emitToChat(paired, systemMessage("system_codex_error",
      `[error] ${payload.message ?? "(no message)"}${payload.code !== undefined ? ` (code ${payload.code})` : ""}`));
    paired.pairedTurnSawAgentMessage = true;
    paired.replyRequired = false;
    paired.replyReceivedDuringTurn = false;
  });

  // Spec v2.2 §8 E8: app-server reconnect restore flips paired readiness
  // back to not-ready, surfacing "restoring shared Codex TUI session" to
  // paired Claude until restore completes.
  on("sessionRestoreStart", () => {
    if (!pair.proxyTuiSlot) return;
    log(`[pair=${pair.pairId}] Shared Codex session restore started — flipping paired readiness to not-ready`);
    pair.proxyTuiSlot.readiness = "not-ready";
    const paired = getPaired();
    if (paired) paired.ready = false;
  });

  on("sessionRestoreEnd", (payload: { ok?: boolean; threadId?: string } = {}) => {
    if (!pair.proxyTuiSlot) return;
    if (payload.ok === false) {
      log(`[pair=${pair.pairId}] Shared Codex session restore FAILED — keeping readiness=not-ready, awaiting TUI tear-down`);
      return;
    }
    log(`[pair=${pair.pairId}] Shared Codex session restore succeeded — flipping readiness back to ready`);
    pair.proxyTuiSlot.readiness = "ready";
    const paired = getPaired();
    if (paired) {
      paired.ready = true;
      emitToChat(paired, systemMessage("system_pair_restored",
        "✅ Shared Codex TUI session restored. Replies can flow again."));
    }
  });

  on("threadClosed", () => {
    const paired = getPaired();
    log(`[pair=${pair.pairId}] Codex emitted thread/closed`);
    if (pair.proxyTuiSlot) {
      const wasPairedChat = pair.proxyTuiSlot.pairedChatId;
      pair.proxyTuiSlot = null;
      pair.codex.setPairedChat(null);
      if (wasPairedChat && paired) {
        log(`[pair=${pair.pairId}] Transitioning paired chat ${wasPairedChat} to isolated (thread/closed)`);
        transitionToIsolated(paired, "Shared Codex thread closed");
      }
    }
  });

  on("error", (err: Error) => {
    log(`[pair=${pair.pairId}] Codex error: ${err.message}`);
  });

  on("exit", (code: number | null) => {
    log(`[pair=${pair.pairId}] Codex app-server process exited (code ${code})`);
    codexBootstrapped = false;
    // Bug fix (Codex P2 review codex_msg_5753c73beafc_95): clear `isLive`
    // so a subsequent `ensurePair(pair.pairId)` re-spawns the app-server
    // rather than no-op'ing on stale liveness state. Without this, ME6
    // "next ensure_pair re-spawns after crash" would silently fail in P3.
    pair.isLive = false;
    pair.tuiConnectionState.handleCodexExit();

    // Issue #83 risk #3 (M02 probe found 2026-05-17): the previous code
    // broadcast system_codex_exit to ALL Claudes and closed EVERY chat
    // thread + flipped state.ready=false — violating multi-pair crash
    // isolation. Scope the cascade to chats homed on THIS pair only.
    // Chats on other pairs (or isolated) are unaffected by this pair's
    // crash and must continue operating.
    const affectedChats: ChatState[] = [];
    for (const state of chats.values()) {
      if (state.homePairId !== pair.pairId) continue;
      affectedChats.push(state);
    }
    log(`[pair=${pair.pairId}] codex exit affects ${affectedChats.length}/${chats.size} chats (homed on this pair)`);
    for (const state of affectedChats) {
      emitToChat(state, systemMessage(
        "system_codex_exit",
        `⚠️ Codex app-server on pair "${pair.pairId}" exited (code ${code ?? "unknown"}). Your thread on this pair was terminated.`,
      ));
      try { state.thread.close(); } catch {}
      state.ready = false;
    }
    broadcastStatus();
  });
}

/** STM v2.3 §D9 P2: targeted off() — symmetric counterpart to attachPairHandlers. */
function detachPairHandlers(pair: PairState): void {
  for (const { eventName, handler } of pair.handlerRefs) {
    pair.codex.off(eventName, handler);
  }
  pair.handlerRefs = [];
}

// Register the default pair's listeners now. In P2 this happens at module
// load (matching v2.2 behavior — daemon starts listening before bootCodex
// fires). P3 moves this call inside `ensurePair("default")` and gates it
// on lazy creation.
attachPairHandlers(defaultPairState);

function getPairedChatState(): ChatState | null {
  if (!proxyTuiSlot?.pairedChatId) return null;
  return chats.get(proxyTuiSlot.pairedChatId) ?? null;
}

function pairChat(state: ChatState): void {
  if (!proxyTuiSlot) return;
  if (proxyTuiSlot.pairedChatId) return;
  proxyTuiSlot.pairedChatId = state.chatId;
  state.paired = true;
  codex.setPairedChat(state.chatId);
  state.ready = proxyTuiSlot.readiness === "ready";
  log(`Paired chat ${state.chatId} with proxy TUI (readiness=${proxyTuiSlot.readiness})`);
  if (state.ready) {
    emitToChat(state, systemMessage("system_paired_ready",
      "✅ This Claude session is paired with the right-pane Codex TUI. Replies will appear there; user typing in the TUI will be forwarded to you with an [IMPORTANT] prefix."));
  } else {
    emitToChat(state, systemMessage("system_paired_provisioning",
      "✅ This Claude session is paired with the right-pane Codex TUI. Waiting for the shared thread to finish provisioning before replies can flow."));
  }
}

/**
 * Bug fix (2026-05-16): isolated-bootstrap retry helper.
 *
 * Previously `transitionToIsolated` did a one-shot `bootstrap()` whose catch
 * branch only emitted a system_isolated_failed message and left state.ready
 * stuck at false — paired Claude was effectively stranded with no recovery
 * path. This helper retries up to ISOLATED_BOOTSTRAP_MAX_ATTEMPTS times with
 * a delay between attempts, and surfaces a definitive "give up" message
 * only after exhausting them, including explicit instructions for the user.
 */
const ISOLATED_BOOTSTRAP_MAX_ATTEMPTS = parseInt(
  process.env.AGENTBRIDGE_ISOLATED_BOOTSTRAP_MAX_ATTEMPTS ?? "2",
  10,
);
const ISOLATED_BOOTSTRAP_RETRY_DELAY_MS = parseInt(
  process.env.AGENTBRIDGE_ISOLATED_BOOTSTRAP_RETRY_DELAY_MS ?? "2000",
  10,
);

function bootstrapIsolatedThread(state: ChatState, attempt = 1): void {
  state.thread.bootstrap()
    .then((threadId) => {
      state.ready = true;
      emitToChat(state, systemMessage("system_isolated_ready",
        `✅ Fresh isolated Codex thread ready (threadId=${threadId}).`));
    })
    .catch((err: any) => {
      const errMsg = err?.message ?? String(err);
      log(`[${state.chatId}] Isolated bootstrap attempt ${attempt}/${ISOLATED_BOOTSTRAP_MAX_ATTEMPTS} failed: ${errMsg}`);
      if (attempt < ISOLATED_BOOTSTRAP_MAX_ATTEMPTS) {
        emitToChat(state, systemMessage("system_isolated_retry",
          `⚠️ Bootstrap of isolated Codex thread failed (attempt ${attempt}/${ISOLATED_BOOTSTRAP_MAX_ATTEMPTS}): ${errMsg}. Retrying in ${ISOLATED_BOOTSTRAP_RETRY_DELAY_MS}ms.`));
        setTimeout(() => {
          // Codex review (2026-05-16): close the prior ClaudeThread before
          // constructing a replacement so a half-open WS / RPC handle from
          // the failed attempt does not leak.
          try { state.thread.close(); } catch {}
          state.thread = new ClaudeThread({
            appServerUrl: codex.appServerUrl,
            chatId: state.chatId,
            logFile: stateDir.logFile,
            cwd: process.cwd(),
          });
          wireClaudeThreadEvents(state);
          bootstrapIsolatedThread(state, attempt + 1);
        }, ISOLATED_BOOTSTRAP_RETRY_DELAY_MS);
      } else {
        emitToChat(state, systemMessage("system_isolated_failed",
          `❌ Failed to bootstrap isolated Codex thread after ${ISOLATED_BOOTSTRAP_MAX_ATTEMPTS} attempts: ${errMsg}. Closing this chat — please reconnect Claude (close the window and re-attach) to start a fresh attempt.`));
        // Bug fix (Codex review 2026-05-16): reap the chat so the advertised
        // recovery path ("reconnect Claude") actually works. Without this,
        // attachClaude takes the resume branch for the same chatId, never
        // re-enters bootstrapIsolatedThread, and the user follows our own
        // instructions but stays stuck. Reaping forces the next attach to
        // construct a fresh ChatState with a fresh bootstrap.
        reapChatState(state, "isolated bootstrap exhausted");
      }
    });
}

/**
 * Forcefully tear down a chat: close the active WS (clients can reconnect
 * fresh), clear timers, dispose StatusBuffer, close the ClaudeThread, and
 * remove the entry from `chats`. Used both for natural reaper expiry paths
 * and for the isolated-bootstrap final-failure path.
 */
function reapChatState(state: ChatState, reason: string): void {
  log(`Reaping chat state: chatId=${state.chatId} (${reason})`);
  if (state.ws) {
    try { state.ws.close(1011, `chat reaped: ${reason}`); } catch {}
    state.ws = null;
  }
  if (state.attentionWindowTimer) clearTimeout(state.attentionWindowTimer);
  if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
  if (state.reaperTimer) clearTimeout(state.reaperTimer);
  try { state.statusBuffer.dispose(); } catch {}
  try { state.thread.close(); } catch {}
  chats.delete(state.chatId);
  broadcastStatus();
}

function transitionToIsolated(state: ChatState, reason: string): void {
  state.paired = false;
  // STM v2.3 §6.5 P3c: pair teardown is a terminal boundary. Re-home the
  // chat onto the default pair (Path A) — the ClaudeThread below targets
  // `codex.appServerUrl` (the default pair's app-server). If default is
  // not live the bootstrap retries exhaust and reapChatState produces the
  // explicit "reconnect Claude" instruction (Path B equivalent).
  state.homePairId = "default";
  // Bug fix (Codex review 2026-05-16): pair teardown is a terminal boundary
  // for the old shared turn. Reset paired-turn flags so they don't bleed
  // into the fresh isolated thread — a stale `replyRequired=true` would
  // otherwise force-forward the first isolated message via the
  // require-reply path in wireClaudeThreadEvents and could fire a bogus
  // "missing reply" warning at turn/completed.
  state.replyRequired = false;
  state.replyReceivedDuringTurn = false;
  state.pairedTurnSawAgentMessage = false;
  emitToChat(state, systemMessage("system_pair_torn_down",
    `[system] ${reason}. Future replies will use a fresh isolated Codex thread (no prior shared-TUI context carried over).`));
  // Re-bootstrap as isolated. Same chatId, new ClaudeThread.
  state.thread = new ClaudeThread({
    appServerUrl: codex.appServerUrl,
    chatId: state.chatId,
    logFile: stateDir.logFile,
    cwd: process.cwd(),
  });
  state.ready = false;
  wireClaudeThreadEvents(state);
  bootstrapIsolatedThread(state);
}

// ── Control server / Claude WS handling ─────────────────────────

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") return Response.json(currentStatus());
      if (url.pathname === "/readyz") {
        // STM v2.3 §D6 P3d: readiness means "control plane ready" — the
        // daemon can accept WS connections and answer ensure_pair. Pair
        // liveness is conveyed by `pair_ensured.isLive` and `status.pairs`
        // entries, not by /readyz. v2.2 returned 503 until codexBootstrapped
        // (= default pair's `codex.start` succeeded); that conflated "I'm
        // up" with "default pair is up". In a lazy / multi-pair world the
        // daemon may be fully serving with no pair live yet (e.g. before
        // first `abg codex --via-proxy`), and that's still ready.
        return Response.json(currentStatus(), { status: 200 });
      }
      if (url.pathname === "/ws" &&
          server.upgrade(req, { data: { clientId: 0, attached: false, chatId: null } })) {
        return undefined;
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960,
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>, code: number, reason: string) => {
        const chatId = ws.data.chatId;
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, chatId=${chatId ?? "-"})`);
        if (chatId) {
          const state = chats.get(chatId);
          if (state && state.ws === ws) {
            detachClaudeWs(state, "frontend socket closed");
          }
        }
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, raw);
      },
    },
  });
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      void attachClaude(ws, message.chatId, message.pairId, message.requestId);
      return;
    case "claude_disconnect": {
      const chatId = message.chatId ?? ws.data.chatId;
      if (!chatId) return;
      const state = chats.get(chatId);
      if (state) detachClaudeWs(state, "frontend requested disconnect");
      return;
    }
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex":
      handleClaudeToCodex(ws, message);
      return;
    // STM v2.3 §D6 P3 — pair management API ──────────────────────
    case "ensure_pair":
      void handleEnsurePair(ws, message);
      return;
    case "destroy_pair":
      void handleDestroyPair(ws, message);
      return;
    case "list_pairs":
      handleListPairs(ws, message);
      return;
  }
}

// ── STM v2.3 §D6 P3 — pair management control protocol handlers ────────
//
// `ensure_pair(pairId)` validates the name (D1), allocates / reuses a
// registry entry under the daemon-wide write mutex, constructs a fresh
// PairState for non-default pairs (own CodexAdapter + TuiConnectionState,
// pair-scoped handlers via attachPairHandlers' closure-local getPaired),
// and starts the Codex app-server. Same-pair concurrent ensures dedupe
// through `ensurePairInFlight`. Port-binding failures surface as
// PAIR_PORTS_BUSY with structured details.
//
// `destroy_pair(pairId, { forget, force })` performs the full §6.3
// teardown: cancel timers, detach handlers, transition any paired chat
// to isolated, stop codex, clear slot, remove non-default pairs from
// the pairs Map, broadcast status, and optionally remove the registry
// entry. PAIR_BUSY_NOT_FORCED guards against silent loss of paired
// work.
//
// `list_pairs` reports the union of live pairs (with full runtime state)
// and registry-only entries (URLs from registry, isLive=false).

async function handleEnsurePair(
  ws: ServerWebSocket<ControlSocketData>,
  message: Extract<ControlClientMessage, { type: "ensure_pair" }>,
): Promise<void> {
  const { requestId, pairId } = message;
  try {
    const pair = await ensurePair(pairId);
    sendProtocolMessage(ws, {
      type: "pair_ensured",
      requestId,
      pairId,
      appServerUrl: pair.codex.appServerUrl,
      proxyUrl: pair.codex.proxyUrl,
      isLive: true,
    });
  } catch (err: any) {
    if (err instanceof PairError) {
      sendProtocolMessage(ws, {
        type: "pair_error",
        requestId,
        pairId,
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
      return;
    }
    log(`[ensure_pair=${pairId}] unexpected error: ${err?.stack ?? err?.message ?? err}`);
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "ALLOCATION_FAILED",
      message: `ensurePair("${pairId}") failed: ${err?.message ?? err}`,
    });
  }
}

async function handleDestroyPair(
  ws: ServerWebSocket<ControlSocketData>,
  message: Extract<ControlClientMessage, { type: "destroy_pair" }>,
): Promise<void> {
  const { requestId, pairId, forget, force } = message;
  if (!isValidPairName(pairId)) {
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "INVALID_PAIR_NAME",
      message: `pair name "${pairId}" fails validation`,
    });
    return;
  }

  const pair = pairs.get(pairId);
  const inRegistry = pairRegistry.has(pairId);
  if (!pair && !inRegistry) {
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "PAIR_NOT_FOUND",
      message: `pair "${pairId}" not found (neither live nor registered)`,
    });
    return;
  }

  // PAIR_BUSY_NOT_FORCED: live pair with paired Claude and no --force.
  if (pair?.proxyTuiSlot?.pairedChatId && !force) {
    sendProtocolMessage(ws, {
      type: "pair_error",
      requestId,
      pairId,
      code: "PAIR_BUSY_NOT_FORCED",
      message: `pair "${pairId}" has paired chat "${pair.proxyTuiSlot.pairedChatId}"; pass force:true to tear down anyway`,
    });
    return;
  }

  let wasLive = false;
  if (pair?.isLive) {
    wasLive = true;
    try {
      await destroyPair(pairId);
    } catch (err: any) {
      log(`[destroy_pair=${pairId}] internal destroyPair threw: ${err?.message ?? err}`);
    }
  }

  let registryEntryRemoved = false;
  if (forget) {
    await runUnderRegistryMutex(async () => {
      if (pairRegistry.remove(pairId)) {
        registryEntryRemoved = true;
        try { pairRegistry.save(); } catch (err: any) {
          log(`[destroy_pair=${pairId}] registry save failed: ${err?.message ?? err}`);
        }
      }
    });
  }

  sendProtocolMessage(ws, {
    type: "pair_destroyed",
    requestId,
    pairId,
    wasLive,
    registryEntryRemoved,
  });
}

function handleListPairs(
  ws: ServerWebSocket<ControlSocketData>,
  message: Extract<ControlClientMessage, { type: "list_pairs" }>,
): void {
  // Union of live pairs (pairs Map) + registry entries that aren't currently
  // live. Live entries take precedence so their runtime state is reported.
  const seen = new Set<string>();
  const result: PairStatus[] = [];

  for (const pair of pairs.values()) {
    seen.add(pair.pairId);
    result.push({
      pairId: pair.pairId,
      isLive: pair.isLive,
      appServerUrl: pair.codex.appServerUrl,
      proxyUrl: pair.codex.proxyUrl,
      tuiConnected: pair.tuiConnectionState.snapshot().tuiConnected,
      proxyTuiConnected: pair.proxyTuiSlot !== null,
      pairedChatId: pair.proxyTuiSlot?.pairedChatId ?? null,
      threadId: pair.codex.activeThreadId,
      attachedClaudes: [...chats.values()]
        .filter((s) => s.homePairId === pair.pairId)
        .map((s) => ({ chatId: s.chatId, paired: s.paired })),
    });
  }

  for (const entry of pairRegistry.list()) {
    if (seen.has(entry.pairId)) continue;
    // Registry-only entry: no live runtime state, but URLs are config.
    result.push({
      pairId: entry.pairId,
      isLive: false,
      appServerUrl: `ws://127.0.0.1:${entry.appPort}`,
      proxyUrl: `ws://127.0.0.1:${entry.proxyPort}`,
      tuiConnected: false,
      proxyTuiConnected: false,
      pairedChatId: null,
      threadId: null,
      attachedClaudes: [],
    });
  }

  sendProtocolMessage(ws, {
    type: "pair_list",
    requestId: message.requestId,
    pairs: result,
  });
}

async function attachClaude(
  ws: ServerWebSocket<ControlSocketData>,
  requestedChatId?: string,
  requestedPairId?: string,
  requestId?: string,
) {
  const chatId = requestedChatId ?? `auto_${ws.data.clientId}_${Date.now()}`;
  ws.data.chatId = chatId;

  // STM v2.3 §D4 / §D6 P3-cleanup: validate explicit pair id BEFORE state
  // mutation so a bad request doesn't side-effect chat creation. Also
  // emit a typed claude_connect_result back per spec §D6 — bridges that
  // sent a `requestId` consume the response to surface PAIR_NOT_FOUND /
  // PAIR_BUSY as a user-visible disabled state.
  //
  // Strict explicit-pair semantics (Codex P3 close re-pass HIGH#1
  // codex_msg_5753c73beafc_112): if the user asked for a specific pair,
  // we never silently fall through to default pairing or isolated
  // bootstrap. Any reason the requested pair can't accept the chat
  // surfaces as a typed error and aborts the attach.
  if (requestedPairId !== undefined) {
    if (!isValidPairName(requestedPairId)) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "INVALID_PAIR_NAME",
        message: `pair name "${requestedPairId}" fails validation`,
      });
      return;
    }
    const targetPair = pairs.get(requestedPairId);
    if (!targetPair?.isLive) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "PAIR_NOT_FOUND",
        message: `pair "${requestedPairId}" is not live; start it with abg codex --pair ${requestedPairId} --via-proxy first`,
      });
      return;
    }
    if (!targetPair.proxyTuiSlot) {
      // Live pair without a proxy-TUI slot — codex is running but no
      // `--via-proxy` TUI has connected yet, so there's nothing for
      // Claude to pair against. Per Codex P3 close re-pass: do NOT
      // fall through to default pairing or isolated bootstrap. Surface
      // as PAIR_NOT_FOUND with a clarifying message.
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "PAIR_NOT_FOUND",
        message: `pair "${requestedPairId}" has no proxy TUI connected yet; start \`abg codex --pair ${requestedPairId} --via-proxy\` first, then attach Claude`,
      });
      return;
    }
    if (targetPair.proxyTuiSlot.pairedChatId && targetPair.proxyTuiSlot.pairedChatId !== chatId) {
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: false,
        error: "PAIR_BUSY",
        message: `pair "${requestedPairId}" already has paired chat "${targetPair.proxyTuiSlot.pairedChatId}"`,
      });
      return;
    }
  }

  let state = chats.get(chatId);
  if (state) {
    // Resume: same chatId reconnecting. If another WS is still bound, replace it.
    if (state.ws && state.ws !== ws && state.ws.readyState !== WebSocket.CLOSED) {
      log(`Replacing prior WS for chatId=${chatId} (#${state.ws.data.clientId} → #${ws.data.clientId})`);
      try { state.ws.close(CLOSE_CODE_REPLACED, "replaced by newer connection for same chatId"); } catch {}
    }
    state.ws = ws;
    ws.data.attached = true;
    clearDisconnectTimer(state, "claude resumed");
    clearReaperTimer(state, "claude resumed");
    cancelIdleShutdown();
    log(`Claude resumed chatId=${chatId} (#${ws.data.clientId})`);
    statusBufferFlushIfPaused(state, "claude resumed");
    flushBufferedMessages(state);
    sendStatus(ws);
    sendProtocolMessage(ws, {
      type: "claude_connect_result",
      requestId,
      ok: true,
      chatId,
      homePairId: state.homePairId,
      paired: state.paired,
    });
    return;
  }

  // New chat: create state. Spec v2.2 §5: if a proxy TUI is connected and
  // unpaired, this new Claude becomes the paired Claude. Otherwise, isolated.
  state = createChatState(chatId);
  chats.set(chatId, state);
  state.ws = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`New Claude session attached: chatId=${chatId} (#${ws.data.clientId}, total=${chats.size}, requestedPair=${requestedPairId ?? "-"})`);

  sendStatus(ws);

  // P3-cleanup: explicit-pair Claude binds to the requested pair's slot if
  // it's unpaired. Default-only behavior (P1-P3) is preserved when no
  // pairId is supplied — pair with default's slot via the P1 alias.
  const targetPair = requestedPairId ? pairs.get(requestedPairId) : null;
  if (targetPair?.isLive && !targetPair.proxyTuiSlot?.pairedChatId && targetPair.proxyTuiSlot) {
    state.homePairId = requestedPairId!;
    targetPair.proxyTuiSlot.pairedChatId = chatId;
    state.paired = true;
    targetPair.codex.setPairedChat(chatId);
    state.ready = targetPair.proxyTuiSlot.readiness === "ready";
    log(`[${chatId}] Paired with pair="${requestedPairId}" via explicit attach (readiness=${targetPair.proxyTuiSlot.readiness})`);
    emitToChat(state, systemMessage(state.ready ? "system_paired_ready" : "system_paired_provisioning",
      state.ready
        ? `✅ This Claude session is paired with the right-pane Codex TUI on pair "${requestedPairId}". Replies will appear there.`
        : `✅ This Claude session is paired with the right-pane Codex TUI on pair "${requestedPairId}". Waiting for shared-thread provisioning.`));
    sendProtocolMessage(ws, {
      type: "claude_connect_result",
      requestId,
      ok: true,
      chatId,
      homePairId: state.homePairId,
      paired: state.paired,
    });
    broadcastStatus();
    return;
  }

  // STM v2.3 §6.4 / §D4 P5a — FIFO claim across live pairs in registry
  // insertion order. If any live pair has a `proxyTuiSlot` with no
  // paired chat, this Claude becomes its paired chat. Iterating the
  // `pairs` Map honors the spec's "registry insertion order" — default
  // is inserted first at module load, named pairs append as they
  // ensure_pair, so default is always preferred when free.
  if (!requestedPairId) {
    for (const [iterPairId, iterPair] of pairs.entries()) {
      if (!iterPair.isLive) continue;
      if (!iterPair.proxyTuiSlot) continue;            // pair has no --via-proxy TUI yet
      if (iterPair.proxyTuiSlot.pairedChatId !== null) continue; // already paired
      // Claim this pair.
      state.homePairId = iterPairId;
      iterPair.proxyTuiSlot.pairedChatId = chatId;
      state.paired = true;
      iterPair.codex.setPairedChat(chatId);
      state.ready = iterPair.proxyTuiSlot.readiness === "ready";
      log(`[${chatId}] FIFO-claimed pair "${iterPairId}" (readiness=${iterPair.proxyTuiSlot.readiness})`);
      emitToChat(state, systemMessageForChat(state,
        state.ready ? "system_paired_ready" : "system_paired_provisioning",
        state.ready
          ? `✅ This Claude session is paired with the right-pane Codex TUI on pair "${iterPairId}". Replies will appear there; user typing in the TUI will be forwarded to you with an [IMPORTANT] prefix.`
          : `✅ This Claude session is paired with the right-pane Codex TUI on pair "${iterPairId}". Waiting for the shared thread to finish provisioning before replies can flow.`,
      ));
      sendProtocolMessage(ws, {
        type: "claude_connect_result",
        requestId,
        ok: true,
        chatId,
        homePairId: state.homePairId,
        paired: state.paired,
      });
      broadcastStatus();
      return;
    }
  }

  emitToChat(state, systemMessage("system_bridge_provisioning",
    "✅ AgentBridge daemon attached. Provisioning your dedicated Codex thread..."));

  // Emit the typed claude_connect_result now — the chat is attached even
  // if the ClaudeThread bootstrap still has work to do. Bootstrap status
  // is conveyed by subsequent system_thread_ready / system_thread_failed
  // messages, not by claude_connect_result. (Per spec §D6, ok=true means
  // "attached successfully", not "thread fully bootstrapped".)
  sendProtocolMessage(ws, {
    type: "claude_connect_result",
    requestId,
    ok: true,
    chatId,
    homePairId: state.homePairId,
    paired: state.paired,
  });

  try {
    const threadId = await state.thread.bootstrap();
    state.ready = true;
    log(`ClaudeThread ready: chatId=${chatId} threadId=${threadId}`);
    emitToChat(state, systemMessage("system_thread_ready",
      `✅ Your Codex thread is ready (threadId=${threadId}). You can now send messages via the reply tool.`));
    broadcastStatus();
  } catch (err: any) {
    log(`ClaudeThread bootstrap failed for chatId=${chatId}: ${err?.message ?? err}`);
    emitToChat(state, systemMessage("system_thread_failed",
      `❌ Failed to provision Codex thread: ${err?.message ?? err}. Reconnect to retry.`));
    // Bug fix (2026-05-17): reap the half-initialized chat so the
    // advertised "Reconnect to retry" path actually works. Without
    // this, the chat stays in `chats` with `state.ready=false` forever:
    // subsequent reply attempts hit the "thread still provisioning"
    // error, and a bridge reconnect with the same chatId takes the
    // resume branch and skips bootstrap. Reaping forces the next
    // attach to construct a fresh ChatState and re-bootstrap. Mirrors
    // the §6.5 P3c isolated-bootstrap-exhausted reap.
    reapChatState(state, `bootstrap failed: ${err?.message ?? err}`);
  }
}

function createChatState(chatId: string): ChatState {
  const state: ChatState = {
    chatId,
    // STM v2.3 §6.1 P1: every chat is associated with the default pair.
    // Multi-pair claim logic arrives in P4/P5.
    homePairId: "default",
    ws: null,
    thread: new ClaudeThread({
      appServerUrl: codex.appServerUrl,
      chatId,
      logFile: stateDir.logFile,
      cwd: process.cwd(),
    }),
    ready: false,
    paired: false,
    pairedTurnSawAgentMessage: false,
    inAttentionWindow: false,
    attentionWindowTimer: null,
    replyRequired: false,
    replyReceivedDuringTurn: false,
    bufferedMessages: [],
    statusBuffer: null as any, // assigned below
    disconnectTimer: null,
    reaperTimer: null,
    lastAttachStatusSentTs: 0,
    onlineNoticeSent: false,
    nextSystemMessageId: 0,
  };
  state.statusBuffer = new StatusBuffer((summary) => emitToChat(state, summary));
  wireClaudeThreadEvents(state);
  return state;
}

/**
 * Spec v2.2: extracted so it can be called again when a paired chat
 * transitions to isolated mode (new ClaudeThread instance, fresh event wiring).
 */
function wireClaudeThreadEvents(state: ChatState): void {
  const chatId = state.chatId;
  state.thread.on("agentMessage", (msg: BridgeMessage) => {
    if (msg.source !== "codex") return;
    const result = classifyMessage(msg.content, FILTER_MODE);

    if (state.replyRequired) {
      log(`[${chatId}] Codex → Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
      state.replyReceivedDuringTurn = true;
      if (state.statusBuffer.size > 0) {
        state.statusBuffer.flush("reply-required message arrived");
      }
      emitToChat(state, msg);
      return;
    }

    if (state.inAttentionWindow && result.marker === "status") {
      log(`[${chatId}] Codex → Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
      state.statusBuffer.add(msg);
      return;
    }

    log(`[${chatId}] Codex → Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
    switch (result.action) {
      case "forward":
        if (result.marker === "important" && state.statusBuffer.size > 0) {
          state.statusBuffer.flush("important message arrived");
        }
        emitToChat(state, msg);
        if (result.marker === "important") startAttentionWindow(state);
        break;
      case "buffer":
        state.statusBuffer.add(msg);
        break;
      case "drop":
        break;
    }
  });

  state.thread.on("turnStarted", () => {
    log(`[${chatId}] Codex turn started`);
    emitToChat(state, systemMessage(
      "system_turn_started",
      "⏳ Codex is working on the current task. Wait for completion before sending a reply.",
    ));
  });

  state.thread.on("turnCompleted", () => {
    log(`[${chatId}] Codex turn completed`);
    state.statusBuffer.flush("turn completed");

    if (state.replyRequired && !state.replyReceivedDuringTurn) {
      log(`[${chatId}] ⚠️ Reply was required but Codex did not send any agentMessage`);
      emitToChat(state, systemMessage(
        "system_reply_missing",
        "⚠️ Codex completed the turn without sending a reply (require_reply was set).",
      ));
    }
    state.replyRequired = false;
    state.replyReceivedDuringTurn = false;

    emitToChat(state, systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
    ));
    startAttentionWindow(state);
  });

  // Capture the thread reference at registration time. bootstrapIsolatedThread
  // retry and transitionToIsolated both intentionally `state.thread.close()`
  // then assign `state.thread = new ClaudeThread(...)`. The CLOSE event
  // fires on the OLD thread reference but `state.thread` now points to
  // the NEW one. Without this capture, the close handler can't tell
  // "this was an intentional swap" apart from "the active thread crashed".
  // (Codex cross-review batch #1-#5, 2026-05-17.)
  const threadAtRegistration = state.thread;
  state.thread.on("close", () => {
    log(`[${chatId}] ClaudeThread WS closed`);

    // Issue #82 (2026-05-17): app-server crash / unexpected upstream WS
    // close. Before this guard the chat stayed in `chats` with
    // ready=false forever — reply attempts hit "thread still provisioning"
    // and the user had no recovery path short of restarting Claude Code.
    // Reap drives the bridge through the same recovery loop as the
    // bootstrap-failure case (commit 18f60d8): close 1011 → bridge auto-
    // reconnect → fresh bootstrap. If the app-server is back the new
    // bootstrap succeeds; if not, the bootstrap-failure reap kicks in
    // and bridge enters disabled state cleanly.
    //
    // Three guards prevent unwanted re-reaping (and unwanted ready-flip
    // — Codex batch review re-pass msg ..._188 caught that ready=false
    // must also be gated, else a stale OLD-thread close after replacement
    // marks the live new thread not-ready without reaping, recreating a
    // softer "still provisioning" symptom):
    //  1. shuttingDown — during daemon SIGTERM all ClaudeThread WSs
    //     close in cascade; reaping during shutdown is pointless (state
    //     will be discarded) and writes noise to logs.
    //  2. state.thread !== threadAtRegistration — if the thread was
    //     intentionally swapped (bootstrapIsolatedThread retry,
    //     transitionToIsolated), the close fires on the OLD reference
    //     but state.thread now points to the NEW one. Skip — the new
    //     thread is the live one, not the one that closed.
    //  3. chats.get(chatId) !== state — if reapChatState already removed
    //     this chat (so the close event we're seeing was caused by the
    //     intentional state.thread.close() inside reapChatState), the
    //     guard fails and we skip to avoid recursive re-entry. Also
    //     covers the case where a new ChatState replaced this one (e.g.
    //     bridge reconnected and got a fresh ChatState for the same
    //     chatId before this stale handler fired).
    if (shuttingDown) return;
    if (state.thread !== threadAtRegistration) return;
    if (chats.get(chatId) !== state) return;

    // Only flip ready=false once we've confirmed this close is for the
    // current live thread (not a stale OLD-thread close after intentional
    // replacement). Otherwise the live chat gets stuck in a soft
    // "still provisioning" state without being reaped.
    state.ready = false;

    emitToChat(state, systemMessage("system_thread_failed",
      "❌ Lost connection to Codex app-server. Reconnect to retry — bridge will provision a fresh thread."));
    reapChatState(state, "ClaudeThread WS closed unexpectedly (app-server crash or upstream failure)");
  });

  state.thread.on("error", (err: any) => {
    log(`[${chatId}] ClaudeThread error: ${err?.message ?? err}`);
  });
}

function detachClaudeWs(state: ChatState, reason: string) {
  if (!state.ws) return;
  log(`Claude WS detached: chatId=${state.chatId} (#${state.ws.data.clientId}, ${reason}, paired=${state.paired})`);
  state.ws = null;
  scheduleDisconnectTimer(state);
  scheduleReaperTimer(state);

  // Spec v2.2 §5: paired Claude WS detach starts a grace timer. Same chatId
  // reconnect within PAIR_REAP_MS keeps the pair alive; otherwise the slot
  // becomes available for a new Claude to pair AND the orphan chat state is
  // reaped (it never bootstrapped its own ClaudeThread; without the pair, it
  // has no transport and cannot serve a future resume meaningfully).
  //
  // Issue #83 risk #2 (M06b probe found 2026-05-17): the pair-reap path
  // was using the module-level `proxyTuiSlot` (default pair's slot) and
  // `codex.setPairedChat(null)` (default's adapter) regardless of the
  // chat's homePairId. For a Claude paired with a non-default pair,
  // detach left the OTHER pair's pairedChatId stuck and the chat's home
  // pair's slot never reset — subsequent attaches couldn't reclaim that
  // pair. Route everything through `pairs.get(state.homePairId)`.
  const homePair = state.paired && state.homePairId ? pairs.get(state.homePairId) : undefined;
  if (state.paired && homePair && homePair.proxyTuiSlot && homePair.proxyTuiSlot.pairedChatId === state.chatId) {
    // Capture the pairId at schedule time. `state.homePairId` is mutable
    // (transitionToIsolated flips it to "default"); without capture, a
    // stale timer firing after a transition would consult the WRONG
    // pair's slot. Codex M06b re-pass msg ..._214.
    const scheduledPairId = state.homePairId!;
    const slot = homePair.proxyTuiSlot;
    if (slot.pairReapTimer) clearTimeout(slot.pairReapTimer);
    slot.pairReapTimer = setTimeout(() => {
      // Re-fetch via the CAPTURED pairId — not state.homePairId — so
      // we never clear the wrong pair's slot if state was re-homed
      // during the grace window.
      const currentPair = pairs.get(scheduledPairId);
      const currentSlot = currentPair?.proxyTuiSlot;
      if (!currentSlot) return;
      const currentState = chats.get(state.chatId);
      if (currentState?.ws) {
        log(`[pair=${scheduledPairId}] Paired Claude ${state.chatId} reconnected during grace; not clearing pair`);
        return;
      }
      // Defense in depth: only clear if the slot still references THIS
      // chat. A different chat may have FIFO-claimed the slot if our
      // earlier mutation already ran (or if there's a parallel race).
      if (currentSlot.pairedChatId !== state.chatId) {
        log(`[pair=${scheduledPairId}] reap-timer fired for ${state.chatId} but slot now holds ${currentSlot.pairedChatId ?? "<unpaired>"} — skipping clear`);
        currentSlot.pairReapTimer = null;
        return;
      }
      log(`[pair=${scheduledPairId}] Paired Claude ${state.chatId} did not reconnect within ${PAIR_REAP_MS}ms — clearing pair slot and reaping chat state`);
      currentSlot.pairedChatId = null;
      currentSlot.pairReapTimer = null;
      currentPair!.codex.setPairedChat(null);
      // Full reap of the orphaned paired chat (matches the 10-min idle reaper's
      // cleanup: close any thread WS, dispose buffers, delete from map). A
      // future Claude with the same chatId gets a fresh chat state.
      if (currentState) {
        try { currentState.thread.close(); } catch {}
        currentState.statusBuffer.dispose();
        if (currentState.attentionWindowTimer) clearTimeout(currentState.attentionWindowTimer);
        if (currentState.disconnectTimer) clearTimeout(currentState.disconnectTimer);
        if (currentState.reaperTimer) clearTimeout(currentState.reaperTimer);
        chats.delete(state.chatId);
        broadcastStatus();
      }
    }, PAIR_REAP_MS);
  }

  scheduleIdleShutdown();
}

function scheduleReaperTimer(state: ChatState) {
  if (state.reaperTimer) clearTimeout(state.reaperTimer);
  state.reaperTimer = setTimeout(() => {
    state.reaperTimer = null;
    if (state.ws) return; // reattached
    log(`Reaping idle chat: chatId=${state.chatId} (no WS for ${CLAUDE_REAP_AFTER_MS}ms)`);
    try { state.thread.close(); } catch {}
    state.statusBuffer.dispose();
    if (state.attentionWindowTimer) clearTimeout(state.attentionWindowTimer);
    chats.delete(state.chatId);
    broadcastStatus();
  }, CLAUDE_REAP_AFTER_MS);
}

function clearReaperTimer(state: ChatState, _reason: string) {
  if (state.reaperTimer) {
    clearTimeout(state.reaperTimer);
    state.reaperTimer = null;
  }
}

function scheduleDisconnectTimer(state: ChatState) {
  if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    // No-op placeholder for future "tell codex this claude went offline" logic.
  }, CLAUDE_DISCONNECT_GRACE_MS);
}

function clearDisconnectTimer(state: ChatState, _reason: string) {
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
}

function statusBufferFlushIfPaused(state: ChatState, reason: string) {
  if (state.statusBuffer.size > 0) state.statusBuffer.flush(reason);
}

// ── Claude → Codex injection ────────────────────────────────────

function handleClaudeToCodex(
  ws: ServerWebSocket<ControlSocketData>,
  message: Extract<ControlClientMessage, { type: "claude_to_codex" }>,
) {
  const chatId = message.chatId ?? ws.data.chatId;
  if (!chatId) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "No chatId — claude_connect was never sent.",
    });
  }

  const state = chats.get(chatId);
  if (!state) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: `Unknown chatId ${chatId}. Reattach via claude_connect.`,
    });
  }

  if (message.message.source !== "claude") {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "Invalid message source",
    });
  }

  if (!state.ready) {
    // Spec v2.2 §5 + §8 E8: paired-but-not-ready returns a transient error so
    // paired Claude can retry once the shared thread is provisioned or
    // session-restored. Distinguish first-time provisioning from restore.
    let errorMsg: string;
    if (state.paired) {
      if (codex.isSessionRestoreInProgress) {
        errorMsg = "Restoring shared Codex TUI session, retry shortly.";
      } else if (proxyTuiSlot) {
        errorMsg = "Shared Codex TUI thread is still provisioning. Retry shortly.";
      } else {
        errorMsg = "Shared Codex TUI is no longer connected. Wait for transition to isolated mode.";
      }
    } else {
      errorMsg = "Your Codex thread is still provisioning. Wait for system_thread_ready.";
    }
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: errorMsg,
    });
  }

  const requireReply = !!message.requireReply;
  let contentWithReminder = message.message.content + "\n\n" + BRIDGE_CONTRACT_REMINDER;
  if (requireReply) {
    contentWithReminder += REPLY_REQUIRED_INSTRUCTION;
    state.replyRequired = true;
    state.replyReceivedDuringTurn = false;
    log(`[${chatId}] Reply required flag set`);
  }

  log(`[${chatId}] Forwarding Claude → Codex (${message.message.content.length} chars, requireReply=${requireReply}, paired=${state.paired}, homePair=${state.homePairId})`);

  // Spec v2.2 §6: paired chats route through CodexAdapter (shared transport);
  // isolated chats keep using their own ClaudeThread.
  //
  // STM v2.3 multi-pair bug found by M01 probe (2026-05-17): paired
  // injects MUST go through the chat's home pair's CodexAdapter, not
  // the module-level `codex` (which is just the default pair's). For a
  // Claude paired with the "work" pair, using the default's codex meant
  // injecting into a TUI/thread that didn't exist — "Cannot inject: no
  // active thread" was the symptom and "Shared Codex TUI is busy" the
  // user-facing error. Look up the per-pair adapter via homePairId.
  const homePair = state.paired && state.homePairId ? pairs.get(state.homePairId) : undefined;
  if (state.paired && (!homePair || !homePair.isLive)) {
    // Pair vanished or went down between FIFO claim and this reply
    // (e.g. concurrent `destroy_pair --force` race). Surface explicitly
    // rather than silently injecting into the wrong pair.
    //
    // Codex re-review of ebea1d3 (msg ..._197) — must roll back
    // replyRequired here because we set it above (line 1487) before
    // attempting the injection. Without rollback, a racing requireReply
    // reply against pair teardown leaves the chat in stale reply-
    // required state even though no injection happened, mirroring the
    // later `!injected` branch's rollback contract.
    if (requireReply) {
      state.replyRequired = false;
    }
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: `Home pair "${state.homePairId}" is no longer live; reconnect Claude to re-home.`,
    });
  }
  const injected = state.paired
    ? homePair!.codex.injectMessage(contentWithReminder)
    : state.thread.injectMessage(contentWithReminder);

  if (!injected) {
    const reason = state.paired
      ? "Shared Codex TUI is busy with another turn. Retry."
      : (state.thread.isTurnInProgress
          ? "Codex is busy executing a turn on your thread. Wait for it to finish."
          : "Injection failed: thread WS not connected.");
    if (requireReply) {
      // Roll back the replyRequired flag since injection didn't happen.
      state.replyRequired = false;
    }
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: reason,
    });
  }
  clearAttentionWindow(state);
  sendProtocolMessage(ws, {
    type: "claude_to_codex_result",
    requestId: message.requestId,
    success: true,
  });
}

// ── Per-chat helpers ────────────────────────────────────────────

function startAttentionWindow(state: ChatState) {
  clearAttentionWindow(state);
  state.inAttentionWindow = true;
  state.statusBuffer.pause();
  log(`[${state.chatId}] Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  state.attentionWindowTimer = setTimeout(() => {
    state.attentionWindowTimer = null;
    state.inAttentionWindow = false;
    state.statusBuffer.resume();
    log(`[${state.chatId}] Attention window ended`);
  }, ATTENTION_WINDOW_MS);
}

function clearAttentionWindow(state: ChatState) {
  if (state.attentionWindowTimer) {
    clearTimeout(state.attentionWindowTimer);
    state.attentionWindowTimer = null;
  }
  if (state.inAttentionWindow) state.statusBuffer.resume();
  state.inAttentionWindow = false;
}

function emitToChat(state: ChatState, message: BridgeMessage) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(state.ws, message, state.chatId)) return;
    log(`[${state.chatId}] Send to Claude failed, buffering`);
  }
  state.bufferedMessages.push(message);
  if (state.bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = state.bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    state.bufferedMessages.splice(0, dropped);
    log(`[${state.chatId}] Message buffer overflow: dropped ${dropped} oldest`);
  }
}

function trySendBridgeMessage(
  ws: ServerWebSocket<ControlSocketData>,
  message: BridgeMessage,
  chatId: string,
): boolean {
  try {
    const payload: ControlServerMessage = { type: "codex_to_claude", chatId, message };
    const result = ws.send(JSON.stringify(payload));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(state: ChatState) {
  if (!state.ws || state.bufferedMessages.length === 0) return;
  const messages = state.bufferedMessages.splice(0, state.bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(state.ws, message, state.chatId)) {
      const idx = messages.indexOf(message);
      state.bufferedMessages.unshift(...messages.slice(idx));
      log(`[${state.chatId}] Flush interrupted: re-buffered ${messages.length - idx} message(s)`);
      return;
    }
  }
}

function broadcastToAllClaudes(message: BridgeMessage) {
  for (const state of chats.values()) emitToChat(state, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  for (const state of chats.values()) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) sendStatus(state.ws);
  }
}

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  const snapshot = tuiConnectionState.snapshot();
  // STM v2.3 §D7 P3: aggregate status. v2.2 top-level fields are kept
  // populated from the default pair (URLs always — they're config; runtime
  // fields reflect actual state). New v2.3 code reads detail from `pairs`.
  return {
    bridgeReady: tuiConnectionState.canReply() || codexBootstrapped,
    pid: process.pid,
    // URLs are config: always populated from the default pair's registered ports.
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    tuiConnected: snapshot.tuiConnected,
    proxyTuiConnected: proxyTuiSlot !== null,
    threadId: codex.activeThreadId,
    // Aggregates across all chats / pairs.
    attachedClaudeCount: [...chats.values()].filter((s) => s.ws).length,
    queuedMessageCount: [...chats.values()].reduce(
      (n, s) => n + s.bufferedMessages.length + s.statusBuffer.size,
      0,
    ),
    // P3 sub-commit 1: protocol shape only — wire the array but keep
    // population trivial (just the default pair) until P3 sub-commit 2
    // adds the registry / pair-introspection helpers.
    pairs: [...pairs.values()].map((pair) => ({
      pairId: pair.pairId,
      isLive: pair.isLive,
      appServerUrl: pair.codex.appServerUrl,
      proxyUrl: pair.codex.proxyUrl,
      tuiConnected: pair.tuiConnectionState.snapshot().tuiConnected,
      proxyTuiConnected: pair.proxyTuiSlot !== null,
      pairedChatId: pair.proxyTuiSlot?.pairedChatId ?? null,
      threadId: pair.codex.activeThreadId,
      attachedClaudes: [...chats.values()]
        .filter((s) => s.homePairId === pair.pairId)
        .map((s) => ({ chatId: s.chatId, paired: s.paired })),
    })),
  };
}

/**
 * STM v2.3 §7.3 P5a — pair-aware system message.
 *
 * Prepends `[pair: NAME] ` to the content when multiple pairs are live
 * AND the chat is bound to one of them. Single-pair scenarios (the v2.2
 * baseline) get the unadorned message so existing UX is preserved.
 */
function systemMessageForChat(state: ChatState, idPrefix: string, content: string): BridgeMessage {
  if (state.homePairId) {
    const livePairCount = [...pairs.values()].filter((p) => p.isLive).length;
    if (livePairCount > 1) {
      return systemMessage(idPrefix, `[pair: ${state.homePairId}] ${content}`);
    }
  }
  return systemMessage(idPrefix, content);
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

// ── Idle shutdown ───────────────────────────────────────────────

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if ([...chats.values()].some((s) => s.ws !== null)) return; // still have a live claude
  if (tuiConnectionState.snapshot().tuiConnected) return;

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if ([...chats.values()].some((s) => s.ws !== null) || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle — no clients connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

// ── Lifecycle ───────────────────────────────────────────────────

function writePidFile() { daemonLifecycle.writePid(); }
function removePidFile() { daemonLifecycle.removePidFile(); }

function writeStatusFile() {
  daemonLifecycle.writeStatus({
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid,
  });
}

function removeStatusFile() { daemonLifecycle.removeStatusFile(); }

/**
 * STM v2.3 §6.2 P3c: bring a pair live — allocate registry entry if
 * needed, construct a CodexAdapter + TuiConnectionState for non-default
 * pairs, attach handlers, and start the Codex app-server.
 *
 * Errors thrown here are instances of `PairError` so callers (notably
 * `handleEnsurePair`) can map them to the right `pair_error` code in
 * the control protocol.
 *
 * Concurrency: the registry read-modify-write (allocate + save) runs
 * under `registryWriteMutex` to prevent different-pairId ensures from
 * racing. PairState construction and codex.start() happen outside the
 * mutex to avoid serializing all spawns through one chain.
 */
/**
 * STM v2.3 §6.2 P3-cleanup: same-pair in-flight dedup mutex. Two concurrent
 * `ensure_pair("work")` calls subscribe to the same promise instead of
 * racing into PairState construction / codex.start. The daemon-wide
 * `registryWriteMutex` only protects registry writes; this Map protects
 * the broader allocate→construct→start→isLive flow per pair.
 */
const ensurePairInFlight = new Map<string, Promise<PairState>>();

async function ensurePair(pairId: string): Promise<PairState> {
  // Validate upfront so a bad name doesn't get stuck in the dedup map.
  if (!isValidPairName(pairId)) {
    throw new PairError("INVALID_PAIR_NAME", `pair name "${pairId}" fails validation`);
  }
  // Fast path: pair already constructed and live.
  const existingFast = pairs.get(pairId);
  if (existingFast?.isLive) return existingFast;
  // Same-pair dedup: if another ensure for this exact pairId is mid-flight,
  // await it rather than racing.
  const inFlight = ensurePairInFlight.get(pairId);
  if (inFlight) return inFlight;
  const promise = ensurePairCore(pairId).finally(() => {
    ensurePairInFlight.delete(pairId);
  });
  ensurePairInFlight.set(pairId, promise);
  return promise;
}

async function ensurePairCore(pairId: string): Promise<PairState> {
  // Fast path is checked once more inside the core (a same-pair waiter
  // may have already finished by the time the dedup map handed us the
  // promise — but since the promise resolves with that result, this
  // path is effectively unreachable; included for defense-in-depth).
  const existing = pairs.get(pairId);
  if (existing?.isLive) return existing;

  // Allocate (or look up) the registry entry for this pair.
  const entry = await runUnderRegistryMutex(async () => {
    if (pairRegistry.has(pairId)) return pairRegistry.get(pairId)!;
    const result = pairRegistry.allocate(pairId);
    if (!result.ok) {
      throw new PairError(result.error.code, result.error.message);
    }
    try { pairRegistry.save(); } catch (err: any) {
      log(`[pair-registry] ensurePair("${pairId}"): persist failed: ${err?.message ?? err}`);
    }
    return result.entry;
  });

  // Construct the PairState if we don't have one yet. The default pair is
  // pre-constructed at module load (uses the P1 alias getter/setter for
  // proxyTuiSlot); non-default pairs get a fresh PairState with a normal
  // proxyTuiSlot field.
  let pair = pairs.get(pairId);
  if (!pair) {
    const newCodex = new CodexAdapter({
      pairId,
      appPort: entry.appPort,
      proxyPort: entry.proxyPort,
      logFile: stateDir.logFile,
    });
    const newTuiState = new TuiConnectionState({
      disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
      log,
      onDisconnectPersisted: (connId) => {
        broadcastToAllClaudes(systemMessage(
          "system_tui_disconnected",
          `⚠️ Codex TUI disconnected (pair=${pairId}, conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
        ));
      },
      onReconnectAfterNotice: (connId) => {
        broadcastToAllClaudes(systemMessage(
          "system_tui_reconnected",
          `✅ Codex TUI reconnected (pair=${pairId}, conn #${connId}). Bridge restored.`,
        ));
      },
    });
    pair = {
      pairId,
      codex: newCodex,
      tuiConnectionState: newTuiState,
      proxyTuiSlot: null,
      handlerRefs: [],
      isLive: false,
    };
    pairs.set(pairId, pair);
    log(`[pair=${pairId}] constructed new PairState (appPort=${entry.appPort}, proxyPort=${entry.proxyPort})`);
  }

  // Bug fix (Codex P2 review codex_msg_5753c73beafc_95): reattach handlers
  // if a prior destroyPair cleared them. attachPairHandlers is idempotent.
  if (pair.handlerRefs.length === 0) {
    attachPairHandlers(pair);
  }

  log(`[pair=${pair.pairId}] ensurePair: starting codex app-server (appPort=${pair.codex.appServerUrl}, proxyPort=${pair.codex.proxyUrl})`);
  try {
    await pair.codex.start();
  } catch (err: any) {
    // STM v2.3 §D2 P3-cleanup: map port-binding failures to PAIR_PORTS_BUSY
    // with structured details. CodexAdapter / Bun.serve surface port
    // conflicts via EADDRINUSE on `error.code` or in the message text.
    // Other start errors propagate as ALLOCATION_FAILED upstream.
    const errCode = err?.code ?? "";
    const errMsg = err?.message ?? String(err);
    const looksLikePortBusy =
      errCode === "EADDRINUSE" ||
      /EADDRINUSE/i.test(errMsg) ||
      /address already in use/i.test(errMsg) ||
      /port.*in use/i.test(errMsg);
    if (looksLikePortBusy) {
      // STM v2.3 P5c: parse the canonical CodexAdapter.checkPorts error
      // first since it carries both port AND PID:
      //   "Port 4500 is already in use by non-Codex process(es): PID(s) 12345, 67890."
      // Fall back to generic `:NNNN` port-only patterns if the error came
      // from somewhere else (e.g. Bun.serve raw EADDRINUSE).
      let conflictPort: number | undefined;
      let conflictPid: number | undefined;
      const checkPortsMatch = errMsg.match(/Port (\d{2,5}) is already in use[^:]*:\s*PID\(s\)\s*([\d,\s]+)/i);
      if (checkPortsMatch) {
        const portCandidate = parseInt(checkPortsMatch[1], 10);
        if (Number.isFinite(portCandidate)) conflictPort = portCandidate;
        const pidCandidate = parseInt(checkPortsMatch[2].split(",")[0]?.trim() ?? "", 10);
        if (Number.isFinite(pidCandidate)) conflictPid = pidCandidate;
      } else {
        const portMatch = errMsg.match(/(?::|port[\s=]+|address[\s=]+[\w:.]+:)(\d{2,5})/i);
        if (portMatch) {
          const candidate = parseInt(portMatch[1], 10);
          if (Number.isFinite(candidate)) conflictPort = candidate;
        }
      }
      throw new PairError(
        "PAIR_PORTS_BUSY",
        `pair "${pair.pairId}" ports (appPort=${pair.codex.appServerUrl}, proxyPort=${pair.codex.proxyUrl}) are held by another process: ${errMsg}`,
        { conflictPort, conflictPid },
      );
    }
    throw err;
  }
  pair.isLive = true;
  return pair;
}

/** STM v2.3 §D6 P3c — error class carrying a pair-protocol error code. */
class PairError extends Error {
  constructor(
    public readonly code: import("./control-protocol").PairErrorCode,
    message: string,
    public readonly details?: import("./control-protocol").PairErrorDetails,
  ) {
    super(message);
    this.name = "PairError";
  }
}

/**
 * STM v2.3 §6.3 P2: tear a pair down — stop codex, detach handlers.
 *
 * In P2 the default pair is the only entry; destroying it puts the daemon
 * into an effectively-shutdown state (no Codex to talk to). Real callers
 * arrive in P3 with the `destroy_pair` control protocol; P2 just defines
 * the symmetric counterpart of `ensurePair` so the lifecycle is closed.
 */
/**
 * STM v2.3 §6.3 P3-cleanup: full live teardown per spec.
 *
 * Originally a P2 stub that just detached handlers + stopped codex. Codex
 * P3-series review (codex_msg_5753c73beafc_107) flagged HIGH gaps:
 *
 *   - timers (`tuiReapTimer`, `pairReapTimer`) were not cleared
 *   - paired chats (if any) were not transitioned to isolated via §6.5
 *   - non-default pairs were never removed from the `pairs` Map, so
 *     `list_pairs` would still report a torn-down pair as "registry-only
 *     entry" with stale isLive=false but a live PairState behind it
 *   - status was not broadcast to surviving Claude WS clients
 *
 * Default pair stays in the Map even after teardown so the v2.2-style
 * top-level `proxyTuiSlot` alias keeps resolving; only non-default
 * pairs are dropped. Tests that rely on the default pair entry being
 * present continue to work.
 */
async function destroyPair(pairId: string): Promise<void> {
  const pair = pairs.get(pairId);
  if (!pair) return;
  log(`[pair=${pair.pairId}] destroyPair: full teardown (isLive=${pair.isLive})`);

  // 1. Cancel any timers attached to this pair's slot before we drop the slot.
  if (pair.proxyTuiSlot?.pairReapTimer) {
    clearTimeout(pair.proxyTuiSlot.pairReapTimer);
    pair.proxyTuiSlot.pairReapTimer = null;
  }

  // 2. Detach event handlers (D9 targeted off). MUST happen before
  //    codex.stop() so the exit handler's `pair.isLive = false` doesn't
  //    fire and confuse downstream observers — we're about to set
  //    isLive=false explicitly here anyway.
  detachPairHandlers(pair);

  // 3. Transition the paired Claude (if any) to isolated per §6.5
  //    BEFORE killing the codex app-server, so the new ClaudeThread
  //    has time to bootstrap against default's app-server (the
  //    existing transitionToIsolated targets `codex.appServerUrl`).
  const pairedChatId = pair.proxyTuiSlot?.pairedChatId ?? null;
  if (pairedChatId) {
    const state = chats.get(pairedChatId);
    if (state) {
      log(`[pair=${pair.pairId}] destroyPair: transitioning paired chat "${pairedChatId}" to isolated`);
      transitionToIsolated(state, `Pair "${pair.pairId}" destroyed`);
    }
  }

  // 4. Clear the slot itself.
  pair.proxyTuiSlot = null;

  // 5. Stop the Codex app-server child. Wrapped in try/catch because
  //    stop() can throw if the app-server already exited.
  try { pair.codex.stop(); } catch (err: any) {
    log(`[pair=${pair.pairId}] destroyPair: codex.stop() threw — ${err?.message ?? err}`);
  }

  pair.isLive = false;

  // 6. Non-default pairs leave the `pairs` Map entirely so `list_pairs`
  //    won't keep reporting them and so reallocations don't conflict
  //    with stale PairState. Default stays in the Map (its P1 alias
  //    for proxyTuiSlot is consumed by `let proxyTuiSlot` reads
  //    elsewhere in the daemon — removing it would dangle that alias).
  if (pairId !== "default") {
    pairs.delete(pairId);
    log(`[pair=${pair.pairId}] destroyPair: removed from pairs Map`);
  }

  // 7. Broadcast so any attached Claude reads the new aggregate status.
  broadcastStatus();
}

async function bootCodex() {
  log("Starting AgentBridge daemon (multi-Claude variant)...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);

  try {
    await ensurePair("default");
    codexBootstrapped = true;
    writeStatusFile();
    broadcastStatus();
  } catch (err: any) {
    log(`Failed to start Codex: ${err.message}`);
    broadcastToAllClaudes(
      systemMessage(
        "system_codex_start_failed",
        `❌ AgentBridge failed to start Codex app-server: ${err.message}`,
      ),
    );
    broadcastStatus();
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  for (const state of chats.values()) {
    if (state.attentionWindowTimer) clearTimeout(state.attentionWindowTimer);
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    if (state.reaperTimer) clearTimeout(state.reaperTimer);
    state.statusBuffer.dispose();
    try { state.thread.close(); } catch {}
  }
  chats.clear();
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  // Performance fix (2026-05-17 P0): flush async file loggers before
  // process.exit so the last few buffered log lines reach disk. The
  // exit call is sequenced after the flush completes.
  void closeAllAsyncFileLoggers().then(() => process.exit(0)).catch(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { removePidFile(); removeStatusFile(); });
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}\n`;
  if (!stderrBroken) {
    try {
      process.stderr.write(line);
    } catch (err: any) {
      if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
        stderrBroken = true;
      }
      // Any other stderr write error: silently drop. File log still records.
    }
  }
  daemonLogger.write(line);
}

function startDaemon() {
  // Refuse to start if user intentionally killed the daemon.
  if (daemonLifecycle.wasKilled()) {
    log("Killed sentinel found — daemon was intentionally stopped. Exiting immediately.");
    process.exit(0);
  }

  writePidFile();
  startControlServer();
  void bootCodex();
}

// `import.meta.main` is true only when this module is the entrypoint (run via
// `bun daemon.js` or the bundled CLI). When imported as a library (e.g. by
// `src/unit-test/daemon.test.ts`), the side-effectful boot is skipped so
// tests can exercise the state machine without spinning up sockets or
// spawning the Codex app-server.
if (import.meta.main) {
  startDaemon();
}

// Silence unused-warning for the legacy import; we keep the symbol around in
// case future tooling wants to surface the attach command in status.
void attachCmd;

// ── Testing harness ─────────────────────────────────────────────
//
// Exported strictly for `src/unit-test/daemon.test.ts`. Not part of any
// public API; do not import from production code. The shape and guarantees
// here are subject to change to suit testing needs.

export const __testing = {
  /** Read current single-slot proxy TUI state. */
  get proxyTuiSlot(): ProxyTuiSlot | null {
    return proxyTuiSlot;
  },
  /** Overwrite the slot (set to null to clear). Tests use this to seed scenarios. */
  setProxyTuiSlot(next: ProxyTuiSlot | null): void {
    proxyTuiSlot = next;
  },
  /** Direct handle to the chat registry — tests can read/write/clear. */
  chats,
  /** Direct handle to the singleton CodexAdapter — tests can emit events on it. */
  codex,
  /**
   * STM v2.3 §6.1 P1: pair registry. In P1 contains exactly the default
   * entry whose fields proxy the module-level singletons (codex /
   * proxyTuiSlot / tuiConnectionState). Tests can read but should not
   * mutate the Map shape — use `setProxyTuiSlot` / `chats` for state changes.
   */
  pairs,
  /** Daemon-level functions exposed for direct invocation in tests. */
  fns: {
    pairChat,
    transitionToIsolated,
    bootstrapIsolatedThread,
    getPairedChatState,
    createChatState,
    detachClaudeWs,
    emitToChat,
    /** STM v2.3 P2 lifecycle entry points (added 2026-05-16). */
    attachPairHandlers,
    detachPairHandlers,
    ensurePair,
    destroyPair,
    /** STM v2.3 §D6 P3b — control-protocol handlers, exposed for unit tests. */
    handleEnsurePair,
    handleDestroyPair,
    handleListPairs,
    /** STM v2.3 §D4 / §D6 P3-cleanup — attach flow exposed so tests can verify claude_connect_result. */
    attachClaude,
    /** Bug regression E (2026-05-17): exposed so EPIPE/stderr-broken test
     * can drive log() directly and verify the sticky-flag short-circuit. */
    log,
    /** Issue #82 (2026-05-17): exposed so tests can wire ClaudeThread
     * event handlers onto stubbed ChatStates and emit close/error. */
    wireClaudeThreadEvents,
    /** Issue #82 (2026-05-17): exposed so tests can flip `shuttingDown`
     * to assert close-handler guard behavior during shutdown. */
    setShuttingDownForTest(value: boolean) { shuttingDown = value; },
    /** M01 probe bug regression (2026-05-17): exposed so a unit test
     * can assert paired-inject routes to the chat's homePair adapter
     * (not the module-level default `codex`). */
    handleClaudeToCodex,
  } as const,
  /** STM v2.3 §D2 P3b — registry handle (read for assertions; mutate via handlers). */
  pairRegistry,
  /** STM v2.3 §D2 P3b — registry-write mutex bridge for assertions in tests. */
  runUnderRegistryMutex,
  /** Constants captured at module load — useful for asserting timer behavior. */
  config: {
    PAIR_REAP_MS,
    CLAUDE_REAP_AFTER_MS,
    ISOLATED_BOOTSTRAP_MAX_ATTEMPTS,
    ISOLATED_BOOTSTRAP_RETRY_DELAY_MS,
  } as const,
  /** Reset every mutable module-level field to its clean state. Call in beforeEach. */
  reset(): void {
    if (proxyTuiSlot?.pairReapTimer) {
      clearTimeout(proxyTuiSlot.pairReapTimer);
    }
    for (const state of chats.values()) {
      if (state.attentionWindowTimer) clearTimeout(state.attentionWindowTimer);
      if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
      if (state.reaperTimer) clearTimeout(state.reaperTimer);
      try { state.statusBuffer.dispose(); } catch {}
      try { state.thread.close(); } catch {}
    }
    chats.clear();
    proxyTuiSlot = null;
    // Codex review (2026-05-16): also clear CodexAdapter's internal
    // pairedChatId so it does not leak across tests.
    try { codex.setPairedChat(null); } catch {}
  },
  /** Direct reap helper exposed for tests that need to assert the reap behavior. */
  reapChatState,
};
