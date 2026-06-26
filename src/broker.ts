import type { ServerWebSocket } from "bun";
import type { Store } from "./backbone/store";
import type { Identity, IdentityProvider } from "./backbone/identity";
import type { MessageTransport } from "./backbone/transport";
import type { Envelope } from "./backbone/envelope";
import { InProcTransport } from "./backbone/transport/inproc-transport";
import { buildPresenceEnvelope, type PresenceMeta } from "./presence";
import { mergeWhiteboard } from "./whiteboard";

export const DEFAULT_BROKER_PORT = 4700; // outside the multi-pair 4500/4501/4502+stride range
const CLOSE_AUTH_FAILED = 4401;
// Bound the hot-path membership cache (§11.2) so it can't grow unboundedly with
// distinct topic/identity pairs over a long-lived process. FIFO-ish eviction of
// the oldest key once full (same pattern as the room-bridge SEEN_CAP).
const MEMBER_CACHE_CAP = 2000;
// Per-connection bounded outbox for backpressure: when Bun's ws.send() drops a frame
// (returns 0, over the backpressure limit) we re-queue it and resend on the drain event
// instead of losing it silently. Drop oldest when full — bounded loss beats unbounded growth.
// ponytail: 256 frames covers any realistic burst; upgrade to per-type priority if needed.
const OUTBOX_CAP = 256;
// Bound attacker-controlled presence fields at the SOURCE: a member's hello blob is
// broadcast to the whole room in member_joined, so cap each string field's length and
// the capabilities count — one member must not be able to fan out a multi-MB field or
// a huge list. (room-bridge's render-side FIELD_CAP only caps the final injection, not
// the broker's fan-out bandwidth, so the cap is needed here too.)
const PRESENCE_FIELD_CAP = 200;
const PRESENCE_CAPS_CAP = 20;

/** Validate the optional reserved presence blob from hello — best-effort, drop anything malformed. Exported for boundary tests. */
export function sanitizePresence(raw: unknown): PresenceMeta | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PresenceMeta = {};
  // Strip ALL line/paragraph separators + control + format chars at the source
  // (not just \r\n\t — also U+2028/U+2029/U+000B/U+000C/U+0085, AND \p{Cf}:
  // zero-width U+200B/ZWJ/BOM + bidi U+202E/U+200F): a member rendered into
  // another agent's context must not inject a SEPARATE forged line NOR smuggle
  // invisible code points into a marker via host/capabilities (the render
  // boundary neutralises it too).
  const oneLine = (s: string) => {
    const cleaned = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
    // Hard length cap (DoS): a presence field is broadcast to every room member.
    return cleaned.length <= PRESENCE_FIELD_CAP ? cleaned : Array.from(cleaned).slice(0, PRESENCE_FIELD_CAP).join("");
  };
  if (typeof r.agentType === "string") out.agentType = oneLine(r.agentType);
  if (typeof r.host === "string") out.host = oneLine(r.host);
  if (Array.isArray(r.capabilities)) {
    // Cap the COUNT too — a 10k-entry list is the same fan-out DoS as one huge field.
    const caps = r.capabilities.filter((c): c is string => typeof c === "string").slice(0, PRESENCE_CAPS_CAP).map(oneLine);
    if (caps.length > 0) out.capabilities = caps;
  }
  if (typeof r.budgetHint === "string") out.budgetHint = oneLine(r.budgetHint);
  return Object.keys(out).length > 0 ? out : undefined;
}

interface BrokerSocketData {
  connId: number;
  identity?: Identity;
  /** Reserved presence metadata declared at hello (§11.1 bullet 9); echoed in member_joined. */
  presence?: PresenceMeta;
  /** topic → unsubscribe handle for this connection's subscriptions. */
  subs: Map<string, () => void>;
  /**
   * Bounded outbox for backpressure: a frame is RETAINED for retry when ws.send()
   * returns 0 (DROPPED), and flushed on drain(ws). (r===-1 means Bun buffered the
   * frame itself and will deliver it, so it is removed — see flushOutbox.)
   */
  outbox: string[];
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
  /** TTL for the hot-path membership cache (§11.2 revocation latency). Default 3000ms; tests set it small. */
  memberCacheTtlMs?: number;
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
  /** Live WS connections (incremented on upgrade, decremented on close) — for /healthz. */
  private liveConnections = 0;
  /** Epoch ms the server started, for /healthz uptime. 0 until start(). */
  private startedAt = 0;
  /** topic → (identityId → live-subscription count) — who is reachable per topic. */
  private readonly topicMembers = new Map<string, Map<string, number>>();
  /** Short-TTL membership cache (§11.2 revocation): bounds re-validation cost on the hot delivery path. */
  private readonly memberCache = new Map<string, { ok: boolean; exp: number }>();
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
    this.startedAt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const server = Bun.serve<BrokerSocketData>({
      hostname: host,
      port,
      fetch(req, server) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/healthz") {
          // Liveness probe for a watchdog/supervisor (§8.2). Minimal, NON-SENSITIVE
          // body — the broker binds a Tailscale 100.x address reachable by any
          // tailnet node, so this must never leak tokens/PII/identities.
          return Response.json(self.healthBody());
        }
        if (pathname === "/ws") {
          if (server.upgrade(req, { data: { connId: ++self.nextConnId, subs: new Map(), outbox: [] } })) {
            self.liveConnections++;
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
          if (self.liveConnections > 0) self.liveConnections--;
          self.log(`conn #${ws.data.connId} closed`);
        },
        drain(ws) {
          self.flushOutbox(ws);
        },
      },
    });
    this.server = server;
    this.log(`broker listening on ${host}:${server.port}`);
    return { host, port: server.port ?? port };
  }

  /** Non-sensitive liveness body for GET /healthz (§8.2 watchdog). No tokens/PII/identities. */
  private healthBody(): { ok: true; pid: number; uptimeMs: number; connections: number } {
    return {
      ok: true,
      pid: process.pid,
      uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
      connections: this.liveConnections,
    };
  }

  // Best-effort + never-reject: callers (cli/broker.ts shutdown, test cleanup) may not
  // await the returned promise, so a rejecting server.stop() must NOT become an unhandled
  // rejection. Swallow + log; shutdown proceeds to store.close() regardless, and the cli
  // forceExit fuse covers a hung stop.
  async stop(): Promise<void> {
    try {
      await this.server?.stop(true);
    } catch (e) {
      this.log(`server stop failed: ${String(e)}`);
    }
    this.server = null;
  }

  // Bun ServerWebSocket.send() return contract (empirically verified, Bun 1.3.11):
  //   r  > 0  → sent (bytes written)
  //   r === -1 → backpressured, but Bun BUFFERED the frame and WILL deliver it on drain
  //   r === 0  → DROPPED (over backpressureLimit / socket not open) — frame NOT delivered
  // So the ONLY frame that needs our own retry is the r===0 drop; a -1 frame is already
  // owned by Bun and re-sending it would DOUBLE-deliver. The outbox is the FIFO source of
  // truth: enqueue then flush, so ordering holds even when a send is queued behind a drop.
  private send(ws: ServerWebSocket<BrokerSocketData>, msg: unknown): void {
    this.enqueue(ws, JSON.stringify(msg));
    this.flushOutbox(ws);
  }

  /** Enqueue a serialised frame; drop oldest when outbox is full (bounded loss > unbounded growth). */
  private enqueue(ws: ServerWebSocket<BrokerSocketData>, frame: string): void {
    if (ws.data.outbox.length >= OUTBOX_CAP) {
      ws.data.outbox.shift(); // drop oldest
      this.log(`outbox full (#${ws.data.connId}): dropped oldest frame (cap=${OUTBOX_CAP})`);
    }
    ws.data.outbox.push(frame);
  }

  /**
   * Drain the FIFO outbox into the socket. Called on every send and on Bun's drain
   * event. Per the send() return contract above:
   *   r === 0  → DROPPED: keep the frame at the head and stop; retry on the next drain.
   *   r  <  0  → buffered by Bun (delivered): remove the frame, then stop (we're backpressured).
   *   r  >  0  → sent: remove the frame and keep flushing.
   */
  private flushOutbox(ws: ServerWebSocket<BrokerSocketData>): void {
    while (ws.data.outbox.length > 0) {
      const frame = ws.data.outbox[0]!;
      let r: number;
      try {
        r = ws.send(frame);
      } catch (e) {
        ws.data.outbox.shift(); // socket closed/errored — can't deliver; discard head and stop
        this.log(`flush send failed (#${ws.data.connId}): ${String(e)}`);
        return;
      }
      if (r === 0) return; // dropped (over backpressure limit) — keep frame, wait for drain
      ws.data.outbox.shift(); // r>0 sent, or r<0 buffered-by-Bun (will deliver) — remove either way
      if (r < 0) return; // backpressured: Bun took this frame, stop sending more until drain
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
        // Room authz (§11.2): closed-by-default — only members may subscribe.
        if (!(await this.isMember(topic, me))) {
          this.send(ws, { type: "error", reason: "not a room member" });
          this.log(`DENY subscribe ${me} → ${topic} (not a member)`);
          return;
        }
        const unsub = this.transport.subscribe(topic, (envelope) => {
          // Re-validate membership on delivery (§11.2 revocation): an `abg room
          // remove` only updates the Store, so without this a removed member's
          // still-open subscription would keep receiving events until its socket
          // drops. On revocation, evict the subscription (stop the eavesdropping).
          void (async () => {
            try {
              // Three-state revocation check (§11.2): a CONFIRMED non-member
              // (false) is evicted; a Store read error THROWS and is handled
              // below — it must NOT be conflated with non-membership.
              if (!(await this.isMemberCached(topic, me))) {
                const u = ws.data.subs.get(topic);
                if (u) {
                  u();
                  ws.data.subs.delete(topic);
                  this.removeTopicMember(topic, me);
                  this.log(`EVICT ${me} from ${topic} (membership revoked)`);
                }
                return;
              }
              if (this.shouldDeliver(me, envelope)) this.send(ws, { type: "event", topic, envelope });
            } catch (e) {
              // Membership UNREADABLE (Store error), not a confirmed revocation:
              // skip THIS delivery but keep the subscription — never tear down a
              // legitimate member's live subscription on a transient read error.
              this.log(`delivery check skipped, subscription kept (#${ws.data.connId}): ${String(e)}`);
            }
          })();
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
        if (becamePresent) {
          await this.emitPresence(topic, "member_joined", ws.data.identity, ws.data.presence);
          // New-member injection (§4.4): hand the joiner the room's distilled
          // whiteboard so it has context immediately, WITHOUT replaying the raw
          // ledger (that would double-deliver against drainPendingTo). Sent only to
          // this socket, best-effort.
          try {
            const whiteboard = await this.opts.store.getWhiteboard(topic);
            if (whiteboard) this.send(ws, { type: "whiteboard", roomId: topic, whiteboard });
          } catch (e) {
            this.log(`whiteboard inject failed for ${me}@${topic}: ${String(e)}`);
          }
        }
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
        // The delivery channel (msg.topic) and the envelope's room MUST be the same:
        // authz + fan-out + offline-storage key on msg.topic, while the ledger +
        // whiteboard key on env.roomId. A mismatch would let a member of `topic`
        // write into ANOTHER room's memory (a member of room A poisoning room B's
        // whiteboard/ledger). The legit publish path always sets them equal.
        if (env.roomId !== msg.topic) {
          this.send(ws, { type: "error", reason: "envelope.roomId must equal the publish topic" });
          this.log(`DENY publish ${me} → topic=${msg.topic} roomId=${env.roomId} (topic/roomId mismatch)`);
          return;
        }
        // Room authz (§11.2): only a member may publish into the room — a
        // non-member can't inject events (incl. prompt-injection text) into rooms
        // it isn't in. Gate on the delivery channel (msg.topic).
        if (!(await this.isMember(msg.topic, me))) {
          this.send(ws, { type: "error", reason: "not a room member" });
          this.log(`DENY publish ${me} → ${msg.topic} (not a member)`);
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
        // Room memory (§4): append to the ledger + distil into the whiteboard AFTER
        // delivery, best-effort — a memory write must never roll back or block the
        // live fan-out that already happened. Presence is broker-synthesized via
        // emitPresence (not this path), so it's naturally excluded from the ledger.
        try {
          await this.opts.store.appendEvent(env.roomId, env);
          await this.updateWhiteboard(env);
        } catch (e) {
          this.log(`room-memory update failed (${env.idempotencyKey}): ${String(e)}`);
        }
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

  /**
   * Room authorization (§11.2): only a PERSISTED room member may subscribe to or
   * publish into a room. Closed-by-default — a non-member (incl. an authenticated
   * identity that simply isn't in this room) is denied, so PSK auth alone can't
   * reach arbitrary rooms. FAIL-CLOSED: a Store error denies access, never grants.
   */
  private async isMember(topic: string, id: string): Promise<boolean> {
    try {
      return (await this.opts.store.getMembers(topic)).includes(id);
    } catch (e) {
      this.log(`membership check failed for ${id}@${topic} (deny): ${String(e)}`);
      return false;
    }
  }

  /**
   * Cached membership check for the hot delivery path (§11.2 revocation). Bounds
   * how long a REMOVED member's still-open subscription keeps receiving events to
   * the TTL, without a Store hit per delivered event. `subscribe` itself uses the
   * uncached {@link isMember} so admission is always authoritative.
   *
   * UNLIKE {@link isMember}, a Store error here PROPAGATES (is NOT fail-closed to
   * false): the delivery path must distinguish `false` (confirmed non-member →
   * evict the subscription) from "couldn't read" (transient → skip THIS delivery,
   * keep the subscription). Fail-closing to false would silently EVICT a
   * legitimate member's live subscription on a one-off read error. Admission stays
   * fail-closed via {@link isMember}; only delivery-time revocation is relaxed.
   */
  private async isMemberCached(topic: string, id: string): Promise<boolean> {
    const ttlMs = this.opts.memberCacheTtlMs ?? 3000;
    // `|` delimiter (NOT a literal NUL): slugified topics are `\p{L}\p{N}-` only, so
    // they can't contain `|` → `${topic}|${id}` is collision-free, while keeping
    // broker.ts greppable / tree-sitter-parseable (a NUL byte marks the file binary).
    const key = `${topic}|${id}`;
    const now = Date.now();
    const c = this.memberCache.get(key);
    if (c && c.exp > now) return c.ok;
    // NOT this.isMember (which fail-closes): let a Store error throw so the caller
    // can tell "non-member" from "unreadable" (see the doc-comment above).
    const ok = (await this.opts.store.getMembers(topic)).includes(id);
    // Bound the cache (§11.2): evict the oldest entry once at capacity. Only when
    // inserting a NEW key — refreshing an existing key is an in-place update that
    // doesn't grow the map, so it must not evict an unrelated valid entry.
    if (!this.memberCache.has(key) && this.memberCache.size >= MEMBER_CACHE_CAP) {
      const oldest = this.memberCache.keys().next().value;
      if (oldest !== undefined) this.memberCache.delete(oldest);
    }
    this.memberCache.set(key, { ok, exp: now + ttlMs });
    return ok;
  }

  /**
   * Distil an event into the room whiteboard (§4.2), zero-LLM. mergeWhiteboard
   * returns the SAME reference when the kind doesn't touch the board, so an
   * unmergeable event (a DM, etc.) skips the Store write entirely.
   */
  private async updateWhiteboard(env: Envelope): Promise<void> {
    const prev = await this.opts.store.getWhiteboard(env.roomId);
    const next = mergeWhiteboard(prev, env);
    if (next !== prev && next !== null) await this.opts.store.saveWhiteboard(env.roomId, next);
  }

  /** Persist a store_if_offline envelope for intended recipients with no live subscription (§3.2). */
  private async storeForOfflineRecipients(topic: string, env: Envelope, from?: string): Promise<void> {
    // Always confine to room members (§11.2): a DM's `env.to` is attacker-supplied,
    // so a member must NOT be able to queue an offline DM for an identity that
    // isn't in this room (cross-room injection on the recipient's reconnect). Live
    // delivery is already member-gated (non-members can't subscribe); this closes
    // the offline path symmetrically.
    const members = await this.opts.store.getMembers(topic);
    const intended = Array.isArray(env.to) ? env.to.filter((id) => members.includes(id)) : members;
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
      // §11.2 (revocation symmetry): the live-delivery path re-checks membership,
      // so the offline-replay path must too — otherwise a member removed between
      // enqueue and reconnect would still get the room's queued events drained to
      // it. Authoritative (uncached) check; drain frequency is low. isMember
      // fail-closes on a Store error → skip this one item (never leak a room
      // event to a removed member; a re-drain on a later reconnect can't recover
      // it, but under-delivering is the safe side of this trade).
      if (!(await this.isMember(env.roomId, id))) continue;
      this.send(ws, { type: "event", topic: env.roomId, envelope: env });
    }
  }
}
