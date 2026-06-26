import type { ServerWebSocket } from "bun";
import type { Store } from "./backbone/store";
import type { Identity, IdentityProvider } from "./backbone/identity";
import type { MessageTransport } from "./backbone/transport";
import type { Envelope } from "./backbone/envelope";
import { InProcTransport } from "./backbone/transport/inproc-transport";
import { buildPresenceEnvelope, type PresenceMeta } from "./presence";

export const DEFAULT_BROKER_PORT = 4700; // outside the multi-pair 4500/4501/4502+stride range
const CLOSE_AUTH_FAILED = 4401;

/** Validate the optional reserved presence blob from hello — best-effort, drop anything malformed. Exported for boundary tests. */
export function sanitizePresence(raw: unknown): PresenceMeta | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PresenceMeta = {};
  if (typeof r.agentType === "string") out.agentType = r.agentType;
  if (typeof r.host === "string") out.host = r.host;
  if (Array.isArray(r.capabilities)) {
    const caps = r.capabilities.filter((c): c is string => typeof c === "string");
    if (caps.length > 0) out.capabilities = caps;
  }
  if (typeof r.budgetHint === "string") out.budgetHint = r.budgetHint;
  return Object.keys(out).length > 0 ? out : undefined;
}

interface BrokerSocketData {
  connId: number;
  identity?: Identity;
  /** Reserved presence metadata declared at hello (§11.1 bullet 9); echoed in member_joined. */
  presence?: PresenceMeta;
  /** topic → unsubscribe handle for this connection's subscriptions. */
  subs: Map<string, () => void>;
}

type ClientMessage =
  | { type: "hello"; token: string; presence?: unknown }
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "publish"; topic: string; envelope: Envelope };

export interface BrokerOptions {
  store: Store;
  identityProvider: IdentityProvider;
  /** Bind host. Default 127.0.0.1; for Tailscale bind the 100.x address (never 0.0.0.0, §7.3). */
  host?: string;
  /** Bind port. Default {@link DEFAULT_BROKER_PORT}; 0 picks a random free port. */
  port?: number;
  transport?: MessageTransport;
  log?: (msg: string) => void;
}

/**
 * The always-on, multi-tenant control-plane event broker (§11.1).
 *
 * A WSS endpoint that authenticates every connection by PSK (IdentityProvider),
 * then routes Envelopes between authenticated clients via a MessageTransport
 * (in-process bus + WSS fan-out, §6.2). **CONTROL PLANE ONLY**: it accepts and
 * forwards Envelopes (structured signals) and NEVER reads/writes repo files —
 * code sync is git's job (§2.6). It is a SEPARATE process from the per-pair
 * daemon (independent failure domain) and binds a CONFIGURABLE host (default
 * loopback; Tailscale uses the 100.x address, never 0.0.0.0 — §7.3).
 *
 * Routing (§3.2): three-tier — broadcast (no `to` → all room subscribers),
 * @mention (delivered to all, highlight is client-side via `mentions[]`), and DM
 * (`to: [agentId]` → only those identities). Loop prevention: never echo to the
 * sender (`from.agentId`) + a `hop<=0` drop (the multi-hop generalisation of the
 * v1 binary-source guard). Offline replay: a `store_if_offline` envelope is
 * persisted (Store.pending) for any intended recipient with no live subscription,
 * and drained to them on their next (re)connect.
 */
export class Broker {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextConnId = 0;
  /** topic → (identityId → live-subscription count) — who is reachable per topic. */
  private readonly topicMembers = new Map<string, Map<string, number>>();
  private readonly transport: MessageTransport;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: BrokerOptions) {
    this.log = opts.log ?? (() => {});
    this.transport =
      opts.transport ??
      new InProcTransport({ onHandlerError: (e) => this.log(`subscriber handler error: ${String(e)}`) });
  }

  /** Start listening. Returns the bound { host, port } (port resolved if 0 was given). */
  start(): { host: string; port: number } {
    // `||` not `??`: a programmatically-passed empty string must fall back to
    // loopback rather than become an all-interfaces bind (`Bun.serve({hostname:""})`).
    const host = this.opts.host || "127.0.0.1";
    const port = this.opts.port ?? DEFAULT_BROKER_PORT;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const server = Bun.serve<BrokerSocketData>({
      hostname: host,
      port,
      fetch(req, server) {
        if (new URL(req.url).pathname === "/ws") {
          if (server.upgrade(req, { data: { connId: ++self.nextConnId, subs: new Map() } })) {
            return undefined;
          }
        }
        return new Response("AgentBridge broker");
      },
      websocket: {
        message(ws, raw) {
          // Catch any unexpected rejection so a bad message can never become an
          // unhandled promise rejection that takes the process down.
          self.handleMessage(ws, typeof raw === "string" ? raw : raw.toString()).catch((e) => {
            self.log(`message handler error (#${ws.data.connId}): ${String(e)}`);
          });
        },
        close(ws) {
          const identity = ws.data.identity;
          if (identity) {
            // A crash-disconnect still yields member_left here (presence tracks real
            // connectivity). Fire-and-forget: close() is sync, emit can't be awaited.
            for (const topic of ws.data.subs.keys()) {
              if (self.removeTopicMember(topic, identity.id)) {
                void self.emitPresence(topic, "member_left", identity, ws.data.presence);
              }
            }
          }
          for (const unsub of ws.data.subs.values()) unsub();
          ws.data.subs.clear();
          self.log(`conn #${ws.data.connId} closed`);
        },
      },
    });
    this.server = server;
    this.log(`broker listening on ${host}:${server.port}`);
    return { host, port: server.port ?? port };
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private send(ws: ServerWebSocket<BrokerSocketData>, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      this.log(`send failed (#${ws.data.connId}): ${String(e)}`);
    }
  }

  private async handleMessage(ws: ServerWebSocket<BrokerSocketData>, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "error", reason: "invalid JSON" });
      return;
    }
    // Valid JSON that isn't a tagged object (null / number / string / array)
    // must not reach `.type` access — that would throw out of this async handler
    // and become an unhandled rejection. Reject it as malformed.
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
      this.send(ws, { type: "error", reason: "malformed message" });
      return;
    }
    const msg = parsed as ClientMessage;

    if (msg.type === "hello") {
      // Reject a second hello on an already-authenticated socket: re-binding the
      // identity would strand the old identity's subscriptions + topicMembers
      // counts (close removes under the NEW identity), leaving the old one
      // permanently "reachable" and silently dropping its store_if_offline.
      if (ws.data.identity) {
        this.send(ws, { type: "error", reason: "already authenticated" });
        return;
      }
      let identity: Identity;
      try {
        identity = await this.opts.identityProvider.authenticate(msg.token);
      } catch {
        // Never echo the presented token or the underlying reason.
        this.send(ws, { type: "auth_error", reason: "invalid token" });
        ws.close(CLOSE_AUTH_FAILED, "auth failed");
        return;
      }
      ws.data.identity = identity;
      ws.data.presence = sanitizePresence(msg.presence); // reserved meta, best-effort
      this.send(ws, { type: "welcome", identity });
      this.log(`conn #${ws.data.connId} authenticated as ${identity.id}`);
      // Reconnect replay (§3.2) — OUTSIDE the auth try/catch: a transient store
      // error during drain must NOT be misreported as an auth failure (which
      // would close a connection that was already welcomed + resolved client-side).
      try {
        await this.drainPendingTo(ws, identity.id);
      } catch (e) {
        this.log(`pending drain failed for ${identity.id}: ${String(e)}`);
      }
      return;
    }

    // Every non-hello message requires a prior successful hello.
    if (!ws.data.identity) {
      this.send(ws, { type: "error", reason: "not authenticated (send hello first)" });
      return;
    }
    const me = ws.data.identity.id;

    switch (msg.type) {
      case "subscribe": {
        const topic = msg.topic;
        if (ws.data.subs.has(topic)) {
          this.send(ws, { type: "subscribed", topic }); // re-ack so a re-subscribe never hangs
          return;
        }
        const unsub = this.transport.subscribe(topic, (envelope) => {
          if (this.shouldDeliver(me, envelope)) this.send(ws, { type: "event", topic, envelope });
        });
        ws.data.subs.set(topic, unsub);
        const becamePresent = this.addTopicMember(topic, me);
        this.send(ws, { type: "subscribed", topic });
        // Presence (§11.1 bullet 9): announce only on the 0→1 transition, so a
        // second connection for the same identity doesn't re-announce a join.
        // Emit BEFORE draining this subscriber's own backlog: join notification
        // doesn't depend on the joiner's pending queue, and keeping it ahead of the
        // drain await means a disconnect mid-drain can't reorder it after the
        // close()-emitted member_left (a "left-then-joined" ghost) under a future
        // truly-async Store. Drain is broadcast-irrelevant; ordering vs join is moot.
        if (becamePresent) await this.emitPresence(topic, "member_joined", ws.data.identity, ws.data.presence);
        // Drain anything queued during the connected-but-not-yet-subscribed gap
        // (between hello's drain and this subscribe). Safe: drainPending removes,
        // so an already-drained message is never re-delivered.
        await this.drainPendingTo(ws, me);
        return;
      }
      case "unsubscribe": {
        const unsub = ws.data.subs.get(msg.topic);
        if (unsub) {
          unsub();
          ws.data.subs.delete(msg.topic);
          // member_left only on the →0 transition (last connection for this identity left the topic).
          if (this.removeTopicMember(msg.topic, me)) {
            await this.emitPresence(msg.topic, "member_left", ws.data.identity, ws.data.presence);
          }
        }
        return;
      }
      case "publish": {
        // CONTROL PLANE ONLY: forward the structured Envelope. No filesystem,
        // no repo access — code sync is git's job (§2.6). The broker is a trust
        // boundary (§7.3), so validate the envelope SHAPE at runtime — TS types
        // are compile-time only; a client can send anything over the wire.
        const env = msg.envelope as Envelope | null | undefined;
        if (!env || typeof env !== "object" || Array.isArray(env)) {
          this.send(ws, { type: "error", reason: "malformed envelope" });
          return;
        }
        if (!env.from || typeof env.from !== "object" || Array.isArray(env.from)) {
          this.send(ws, { type: "error", reason: "envelope.from must be an object" });
          return;
        }
        if (env.to !== undefined && !Array.isArray(env.to)) {
          // A string `to` would make `to.includes(me)` a SUBSTRING match (DM leak).
          this.send(ws, { type: "error", reason: "envelope.to must be an array" });
          return;
        }
        // Load-bearing for offline replay: a missing idempotencyKey hits the
        // NOT NULL + OR IGNORE in SqliteStore → silently dropped (≠ InMemoryStore,
        // a §6.4 divergence); a missing roomId drains as `topic: undefined`.
        if (typeof env.idempotencyKey !== "string" || env.idempotencyKey === "") {
          this.send(ws, { type: "error", reason: "envelope.idempotencyKey must be a non-empty string" });
          return;
        }
        if (typeof env.roomId !== "string" || env.roomId === "") {
          this.send(ws, { type: "error", reason: "envelope.roomId must be a non-empty string" });
          return;
        }
        // Anti-spoof + reliable loop prevention: stamp the authenticated sender
        // unconditionally (from is now guaranteed a plain object).
        env.from.agentId = me;
        // hop<=0 → drop (multi-hop loop guard, §3.2).
        if (typeof env.hop === "number" && env.hop <= 0) return;
        // Offline replay: persist for intended recipients with no live subscription.
        if (env.deliveryMode === "store_if_offline") {
          await this.storeForOfflineRecipients(msg.topic, env, me);
        }
        // Live fan-out; each subscriber's handler applies shouldDeliver (DM / from-skip).
        await this.transport.publish(msg.topic, env);
        return;
      }
      default: {
        this.send(ws, { type: "error", reason: "unknown message type" });
      }
    }
  }

  /** Should `me` receive `env`? Loop prevention (skip sender) + DM filter. */
  private shouldDeliver(me: string, env: Envelope): boolean {
    if (env.from?.agentId === me) return false; // never echo to the sender
    if (Array.isArray(env.to)) return env.to.includes(me); // DM: present `to` ⇒ only named targets ([] ⇒ nobody, never a broadcast)
    return true; // broadcast / @mention (highlight is client-side via mentions[])
  }

  /** Add a live subscription for `id` on `topic`. Returns true iff this is a 0→1 transition (newly present). */
  private addTopicMember(topic: string, id: string): boolean {
    let m = this.topicMembers.get(topic);
    if (!m) {
      m = new Map();
      this.topicMembers.set(topic, m);
    }
    const prev = m.get(id) ?? 0;
    m.set(id, prev + 1);
    return prev === 0;
  }

  /** Drop a live subscription for `id` on `topic`. Returns true iff this is a →0 transition (now absent). */
  private removeTopicMember(topic: string, id: string): boolean {
    const m = this.topicMembers.get(topic);
    if (!m) return false;
    const had = m.get(id) ?? 0;
    if (had === 0) return false;
    const n = had - 1;
    if (n <= 0) m.delete(id);
    else m.set(id, n);
    if (m.size === 0) this.topicMembers.delete(topic);
    return n <= 0;
  }

  /**
   * Synthesize a presence event (§11.1 bullet 9) on a membership transition and
   * fan it out to the topic. Broker-authored (not client-published) so it tracks
   * ACTUAL connectivity — a crash-disconnect still yields member_left via close().
   * `online_only` (never stored); shouldDeliver skips the subject themselves.
   */
  private async emitPresence(
    topic: string,
    kind: "member_joined" | "member_left",
    identity: Identity,
    presence?: PresenceMeta,
  ): Promise<void> {
    const env = buildPresenceEnvelope({
      kind,
      roomId: topic,
      agentId: identity.id,
      displayName: identity.displayName,
      meta: presence,
    });
    try {
      await this.transport.publish(topic, env);
    } catch (e) {
      this.log(`presence ${kind} publish failed for ${identity.id}@${topic}: ${String(e)}`);
    }
  }

  private isReachable(topic: string, id: string): boolean {
    return (this.topicMembers.get(topic)?.get(id) ?? 0) > 0;
  }

  /** Persist a store_if_offline envelope for intended recipients with no live subscription (§3.2). */
  private async storeForOfflineRecipients(topic: string, env: Envelope, from?: string): Promise<void> {
    const intended = Array.isArray(env.to) ? env.to : await this.opts.store.getMembers(topic);
    for (const id of intended) {
      if (id === from) continue; // never store for the sender
      if (!this.isReachable(topic, id)) {
        await this.opts.store.enqueuePending(id, env);
      }
    }
  }

  /** Reconnect replay (§3.2): drain + deliver everything queued for this identity. */
  private async drainPendingTo(ws: ServerWebSocket<BrokerSocketData>, id: string): Promise<void> {
    const pending = await this.opts.store.drainPending(id);
    for (const env of pending) {
      this.send(ws, { type: "event", topic: env.roomId, envelope: env });
    }
  }
}
