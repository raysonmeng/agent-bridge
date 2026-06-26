/**
 * The "last mile" (§11.1): bridge the always-on control-plane broker into a live
 * agent session. The daemon starts ONE RoomBridge at boot; it connects to the
 * broker as the logged-in identity, subscribes to the cwd-resolved room, and
 * injects each room event (task_completed / member_joined / member_left) into the
 * Claude session as a system notice.
 *
 * FAIL-INERT by construction: not logged in (no auth-token) or this cwd isn't
 * mapped to a room ⇒ the bridge never starts, so a v1-only / non-collab user is
 * completely unaffected. The broker connection auto-reconnects, so a broker that
 * isn't up yet (or restarts) doesn't need the daemon to retry.
 *
 * CONTROL PLANE ONLY: it forwards structured Envelopes (a rendered one-line
 * notice), never repo files — code sync is git's job (§2.6).
 */

import { BrokerClient } from "./broker-client";
import { RoomService } from "./room-service";
import { openStore, readAuthToken, resolveBrokerUrl, resolveDbPath } from "./collab-store";
import type { Store } from "./backbone/store";
import type { Envelope } from "./backbone/envelope";

export interface RoomBridgeDeps {
  /** The pair's project dir, resolved to a room via the cwd→room map (§2.4). */
  cwd: string;
  /** Inject a rendered one-line room-event notice into the live Claude session. */
  emit: (text: string) => void;
  log?: (msg: string) => void;
  // --- test seams ---
  dbPath?: string;
  brokerUrl?: string;
  store?: Store;
}

export interface RoomBridgeHandle {
  stop(): void;
  /** The resolved room, or null when the bridge stayed inert (not logged in / no room). */
  roomId: string | null;
}

const INERT: RoomBridgeHandle = { stop: () => {}, roomId: null };
const SEEN_CAP = 500; // bounded idempotency-key memory — drop a redelivered envelope once

function label(env: Envelope): string {
  const dn = (env.payload as { displayName?: unknown } | undefined)?.displayName;
  return env.from?.name || (typeof dn === "string" ? dn : "") || env.from?.agentId || "某成员";
}

/**
 * Render a room Envelope into a one-line Chinese notice, or null for kinds the
 * MVP doesn't surface (those are simply not injected — never a raw payload dump).
 */
export function renderRoomEvent(env: Envelope): string | null {
  const who = label(env);
  switch (env.kind) {
    case "task_completed": {
      const p = (env.payload ?? {}) as {
        summary?: string;
        repo?: string;
        branch?: string;
        commit?: string;
        unblocks?: string[];
      };
      const where = [p.repo, p.branch].filter(Boolean).join("@");
      const loc = [where, p.commit].filter(Boolean).join(" ");
      const unblocks = p.unblocks && p.unblocks.length > 0 ? ` · 解锁: ${p.unblocks.join(", ")}` : "";
      return `🏁 ${who} 完成任务：${p.summary ?? "(无摘要)"}${loc ? ` (${loc})` : ""}${unblocks}`;
    }
    case "member_joined": {
      const host = (env.payload as { host?: unknown } | undefined)?.host;
      return `👋 ${who} 加入房间${typeof host === "string" && host ? `（${host}）` : ""}`;
    }
    case "member_left":
      return `👋 ${who} 离开房间`;
    default:
      return null;
  }
}

/**
 * Start the room bridge for `cwd`. Returns an INERT handle (roomId=null) when not
 * logged in or the cwd has no room — never throws, so a daemon boot is never
 * blocked by collab being absent.
 */
export async function startRoomBridge(deps: RoomBridgeDeps): Promise<RoomBridgeHandle> {
  const log = deps.log ?? (() => {});
  const dbPath = resolveDbPath(deps.dbPath);
  const token = readAuthToken(dbPath);
  if (!token) {
    log("room bridge: not logged in (no auth-token) — inactive");
    return INERT;
  }

  const ownStore = !deps.store;
  const store = deps.store ?? openStore(dbPath);
  let roomId: string | null;
  try {
    roomId = await new RoomService(store).resolveRoomForCwd(deps.cwd);
  } finally {
    // The bridge only needs the Store to resolve the room; the BrokerClient holds
    // the live connection. Close our own handle so we don't pin the DB open.
    if (ownStore) await store.close();
  }
  if (!roomId) {
    log(`room bridge: ${deps.cwd} not mapped to a room — inactive`);
    return INERT;
  }

  const room = roomId;
  const seen = new Set<string>();
  const client = new BrokerClient({
    url: resolveBrokerUrl(deps.brokerUrl),
    token,
    presence: { agentType: "claude" },
    log,
  });

  client.onEvent((_topic, env) => {
    // Dedup any redelivery (e.g. offline replay racing a live copy) by idempotency
    // key, so the same event is never injected twice.
    const key = env.idempotencyKey;
    if (typeof key === "string" && key.length > 0) {
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string); // bounded FIFO-ish
    }
    const text = renderRoomEvent(env);
    if (text) deps.emit(text);
  });
  client.subscribe(room); // queued in the subscription set; sent on the first welcome
  // Fire the connection but don't block daemon boot on it; BrokerClient reconnects
  // on its own, so a broker that isn't up yet will be picked up later. A bad token
  // rejects (won't retry) — swallow it; everything else stays pending + retries.
  client.connect().catch((e) => log(`room bridge: connect failed — ${String(e)}`));
  log(`room bridge: subscribed to room ${room}`);

  return { stop: () => client.close(), roomId: room };
}
