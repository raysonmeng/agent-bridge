import type { Envelope } from "./backbone/envelope";
import type { Identity } from "./backbone/identity";
import type { PresenceMeta } from "./presence";

export interface BrokerClientOptions {
  url: string;
  token: string;
  /** Reserved presence metadata (host/capabilities/...) declared at hello (§11.1 bullet 9). */
  presence?: PresenceMeta;
  log?: (msg: string) => void;
  /** Initial reconnect backoff (default 250ms), doubled up to {@link reconnectMaxMs}. */
  reconnectBaseMs?: number;
  /** Max reconnect backoff (default 10s). */
  reconnectMaxMs?: number;
  /** Max queued offline envelopes before the oldest is dropped (default 1000). */
  maxOutbox?: number;
  /** WebSocket factory — injectable so tests can drive reconnect without a real socket. */
  wsFactory?: (url: string) => WebSocket;
  /** Randomness source for reconnect jitter [0,1) — injectable so tests are deterministic. */
  random?: () => number;
}

type EventHandler = (topic: string, envelope: Envelope) => void;

/**
 * Reconnect backoff with EQUAL JITTER (§8.2). `ceiling = min(maxMs, baseMs·2^attempt)`;
 * the delay is `ceiling/2 + rand·ceiling/2`, i.e. uniformly in `[ceiling/2, ceiling]`.
 * Half-fixed keeps a sane minimum wait; half-random de-synchronises adapters that
 * dropped together (no thundering herd). Result is always `≤ ceiling ≤ maxMs`.
 */
export function reconnectDelay(baseMs: number, maxMs: number, attempt: number, rand: number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return ceiling / 2 + rand * (ceiling / 2);
}

type WhiteboardHandler = (roomId: string, whiteboard: unknown) => void;

/**
 * Edge-side client to the control-plane broker (§5 adapter transport + §8.2
 * resilience foundation).
 *
 * Connects over WS, authenticates by PSK, and exposes subscribe/publish/onEvent.
 * Resilience (A-class, §8.2): on disconnect it auto-reconnects with exponential
 * backoff, re-subscribes every topic, and flushes a local outbox of envelopes
 * published while offline — so the agent session doesn't flap on a transient
 * broker blip. There is exactly ONE in-flight socket at a time (openSocket tears
 * the old one down first), and connect() is idempotent.
 *
 * Limits (by design here): the outbox is bounded (drop-oldest); flushing after a
 * full broker RESTART only reaches peers that have already re-subscribed —
 * crash-durable, store-backed redelivery to offline peers is PR11 (§8.2 B / §3.2
 * store_if_offline), not this in-memory layer.
 */
export class BrokerClient {
  private ws: WebSocket | null = null;
  private identity: Identity | null = null;
  private readonly subscriptions = new Set<string>();
  private readonly outbox: Array<{ topic: string; envelope: Envelope }> = [];
  private readonly eventHandlers: EventHandler[] = [];
  private readonly whiteboardHandlers: WhiteboardHandler[] = [];
  /** topic → resolver for an in-flight joinWithPassword, settled by the broker's joined/join_error. */
  private readonly pendingJoins = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private closed = false;
  /** Set on auth_error: a bad token must NOT trigger an infinite reconnect loop. */
  private authFailed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<Identity> | null = null;
  private resolveConnect: ((id: Identity) => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;
  private readonly log: (msg: string) => void;
  private readonly mkWs: (url: string) => WebSocket;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxOutbox: number;
  private readonly rand: () => number;

  constructor(private readonly opts: BrokerClientOptions) {
    this.log = opts.log ?? (() => {});
    this.mkWs = opts.wsFactory ?? ((url) => new WebSocket(url));
    this.baseMs = opts.reconnectBaseMs ?? 250;
    this.maxMs = opts.reconnectMaxMs ?? 10_000;
    this.maxOutbox = opts.maxOutbox ?? 1000;
    this.rand = opts.random ?? Math.random;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.identity !== null;
  }
  get whoami(): Identity | null {
    return this.identity;
  }
  get queuedCount(): number {
    return this.outbox.length;
  }

  /**
   * Connect + authenticate. Idempotent: repeated calls return the SAME promise
   * (one in-flight socket). Resolves on the first welcome (possibly after a
   * transient reconnect); rejects only on auth failure or close(). A transient
   * pre-welcome drop does NOT reject — the background reconnect retries and the
   * eventual welcome resolves this promise.
   */
  connect(): Promise<Identity> {
    if (this.closed) return Promise.reject(new Error("client closed"));
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<Identity>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.openSocket();
    return this.connectPromise;
  }

  subscribe(topic: string): void {
    this.subscriptions.add(topic);
    if (this.connected) this.sendRaw({ type: "subscribe", topic });
  }

  unsubscribe(topic: string): void {
    this.subscriptions.delete(topic);
    if (this.connected) this.sendRaw({ type: "unsubscribe", topic });
  }

  /**
   * Self-service join a password-protected room (§11.2): present the room password to the broker,
   * which verifies it against the room's stored hash and grants PERSISTENT membership. Resolves on
   * the broker's `joined`; rejects with the broker's reason (wrong password / throttled / no
   * self-service join). Requires a live connection — call connect() first; subscribe() after it resolves.
   */
  joinWithPassword(topic: string, password: string): Promise<void> {
    if (!this.connected) return Promise.reject(new Error("not connected"));
    return new Promise<void>((resolve, reject) => {
      this.pendingJoins.get(topic)?.reject(new Error("superseded by a newer join")); // one in-flight per topic
      this.pendingJoins.set(topic, { resolve, reject });
      this.sendRaw({ type: "join", topic, password });
    });
  }

  /** Publish an envelope; if offline, queue it (bounded) and flush on reconnect. */
  publish(topic: string, envelope: Envelope): void {
    if (this.connected) {
      this.sendRaw({ type: "publish", topic, envelope });
      return;
    }
    if (this.outbox.length >= this.maxOutbox) {
      this.outbox.shift(); // drop oldest — bounded, logged loss beats OOM
      this.log(`outbox full (${this.maxOutbox}) — dropped oldest queued message`);
    }
    this.outbox.push({ topic, envelope });
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  /** Register a handler for the room whiteboard snapshot pushed on join (§4.4). */
  onWhiteboard(handler: WhiteboardHandler): void {
    this.whiteboardHandlers.push(handler);
  }

  close(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.teardownSocket();
    this.failPendingJoins("client closed");
    if (this.rejectConnect) {
      const reject = this.rejectConnect;
      this.resolveConnect = null;
      this.rejectConnect = null;
      reject(new Error("client closed"));
    }
  }

  /** Open exactly one socket, tearing down any prior socket + pending reconnect first. */
  private openSocket(): void {
    this.clearReconnectTimer();
    this.teardownSocket();
    const ws = this.mkWs(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.sendRaw({ type: "hello", token: this.opts.token, presence: this.opts.presence });
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse((ev as MessageEvent).data as string);
      } catch {
        return;
      }
      // A buggy/hostile broker could send a non-object frame (null/number/array);
      // accessing `.type` on it would throw out of this WS callback (uncaught).
      if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") return;
      if (msg.type === "welcome") {
        this.identity = msg.identity;
        this.reconnectAttempt = 0;
        for (const topic of this.subscriptions) this.sendRaw({ type: "subscribe", topic });
        this.flushOutbox();
        this.log(`connected as ${msg.identity.id}`);
        if (this.resolveConnect) {
          const resolve = this.resolveConnect;
          this.resolveConnect = null;
          this.rejectConnect = null;
          resolve(msg.identity);
        }
      } else if (msg.type === "auth_error") {
        this.authFailed = true; // a bad token won't get better by retrying
        if (this.rejectConnect) {
          const reject = this.rejectConnect;
          this.resolveConnect = null;
          this.rejectConnect = null;
          reject(new Error("broker auth failed"));
        }
      } else if (msg.type === "event") {
        for (const h of this.eventHandlers) {
          try {
            h(msg.topic, msg.envelope);
          } catch (e) {
            this.log(`event handler threw: ${String(e)}`);
          }
        }
      } else if (msg.type === "whiteboard") {
        // §4.4 new-member injection: a room whiteboard snapshot pushed on join.
        for (const h of this.whiteboardHandlers) {
          try {
            h(msg.roomId, msg.whiteboard);
          } catch (e) {
            this.log(`whiteboard handler threw: ${String(e)}`);
          }
        }
      } else if (msg.type === "joined") {
        const p = this.pendingJoins.get(msg.topic);
        if (p) {
          this.pendingJoins.delete(msg.topic);
          p.resolve();
        }
      } else if (msg.type === "join_error") {
        const p = this.pendingJoins.get(msg.topic);
        if (p) {
          this.pendingJoins.delete(msg.topic);
          p.reject(new Error(typeof msg.reason === "string" ? msg.reason : "join failed"));
        }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // a stale/torn-down socket closing — ignore
      this.ws = null;
      this.identity = null;
      // An in-flight password join can't be answered by a dead socket — reject it now so the
      // caller errors out instead of hanging (the broker grants membership transactionally; a
      // drop before `joined` means it did NOT complete).
      this.failPendingJoins("connection lost before the join completed");
      // A transient drop does NOT reject connect() — reconnect retries and the
      // next welcome resolves the still-pending promise. Only auth failure / close()
      // settle it. Avoids the "reject-but-secretly-reconnect" contract that induced
      // racing retries (multiple sockets / leak / duplicate delivery).
      if (!this.closed && !this.authFailed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; reconnect handled there.
    };
  }

  /** Detach handlers and close the current socket WITHOUT triggering a reconnect. */
  private teardownSocket(): void {
    const old = this.ws;
    if (!old) return;
    this.ws = null;
    this.identity = null;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      /* already closing */
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Reject every in-flight joinWithPassword (the socket went away before the broker replied). */
  private failPendingJoins(reason: string): void {
    if (this.pendingJoins.size === 0) return;
    const pend = [...this.pendingJoins.values()];
    this.pendingJoins.clear();
    for (const p of pend) p.reject(new Error(reason));
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const { topic, envelope } of pending) this.sendRaw({ type: "publish", topic, envelope });
    this.log(`flushed ${pending.length} queued message(s)`);
  }

  private sendRaw(msg: unknown): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (e) {
      this.log(`send failed: ${String(e)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = reconnectDelay(this.baseMs, this.maxMs, this.reconnectAttempt, this.rand());
    this.reconnectAttempt++;
    this.log(`reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.openSocket();
    }, delay);
  }
}
