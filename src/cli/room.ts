/**
 * `abg room create/list` + `abg join` — collaboration room CLI (§2.3–2.4).
 *
 * A room = one requirement/workflow, cross-repo + cross-person. Membership binds
 * to the logical agent (the logged-in collab identity) and is persistent. `join`
 * also records a cwd→room mapping so this directory auto-joins next time (§2.4).
 *
 * Shares the same collab Store + 0700 directory lockdown as `abg auth login` /
 * `abg broker start`; the logged-in identity is resolved from `<state>/auth-token`.
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoomService, slugify } from "../room-service";
import { IdentityService } from "../backbone/identity-service";
import { SqliteStore } from "../backbone/store/sqlite-store";
import type { RoomRecord, Store } from "../backbone/store";
import { resolveBrokerUrl } from "../collab-store";
import { StateDirResolver } from "../state-dir";

/** Resolve the collab DB path: explicit > env override > `<state>/collab.db`. */
function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTBRIDGE_COLLAB_DB;
  if (env && env.length > 0) return env;
  return join(new StateDirResolver().dir, "collab.db");
}

/**
 * Resolve the currently logged-in collab identity id from `<collabDir>/auth-token`
 * (written by `abg auth login`). The token file is a local secret; a missing or
 * unresolvable token means the user has not logged in yet.
 */
export async function currentIdentityId(store: Store, dbPath: string): Promise<string> {
  const tokenFile = join(dirname(dbPath), "auth-token");
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf-8").trim();
  } catch {
    throw new Error("未找到登录令牌，请先运行 abg auth login");
  }
  if (token === "") throw new Error("登录令牌为空，请先运行 abg auth login");
  const identityId = await store.resolveToken(token);
  if (!identityId) throw new Error("登录令牌无效，请先运行 abg auth login");
  return identityId;
}

/** Open the collab Store with the same 0700 lockdown as `abg auth login`. */
function openStore(dbPath: string): SqliteStore {
  const dir = dirname(dbPath);
  // The collab DB holds raw PSK tokens + PII; lock the containing dir to 0700
  // (matches auth.ts/broker.ts — bun:sqlite files are 0644 so dir is the gate).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return new SqliteStore(dbPath);
}

/**
 * Create a room owned by the logged-in identity (roomId = slugify(name)), join
 * the creator to it, and map the cwd so this directory auto-joins next time. If
 * the slug already exists it is reused (created=false) — the creator still joins.
 */
export async function createRoom(opts: {
  name: string;
  cwd?: string;
  dbPath?: string;
}): Promise<{ roomId: string; created: boolean }> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const roomId = slugify(opts.name);
    const createdBy = await currentIdentityId(store, dbPath);
    const svc = new RoomService(store);
    const existed = (await svc.getRoom(roomId)) !== null;
    if (!existed) {
      await svc.createRoom(roomId, opts.name, createdBy);
      await svc.join(roomId, createdBy); // the creator of a NEW room is its first member
    } else if (!(await svc.isMember(roomId, createdBy))) {
      // Closed-by-default (§11.2): `create` must NOT self-grant membership of an
      // EXISTING room — that reopens the self-join hole `joinRoom` closed.
      throw new Error(`房间 ${roomId} 已存在且你（${createdBy}）不是成员；请让成员 abg room add ${createdBy}`);
    }
    await svc.mapCwd(opts.cwd ?? process.cwd(), roomId);
    return { roomId, created: !existed };
  } finally {
    await store.close();
  }
}

/** List all rooms in the collab store. */
export async function listRooms(opts: { dbPath?: string }): Promise<RoomRecord[]> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    return await new RoomService(store).listRooms();
  } finally {
    await store.close();
  }
}

/**
 * Map the current directory to a room (§2.4 cwd→room). Two paths:
 *
 * - LOCAL room (the room exists in this machine's Store): keep the strict, closed-by-default
 *   check (§11.2) — `join` does NOT self-grant membership, so a non-member is told to ask an
 *   admin. This is the single-machine / broker-machine case.
 * - REMOTE room (no local record — the normal EDGE case, since the room lives in the broker's
 *   Store, not here): just map the cwd. The cwd→room map is local routing intent only; it
 *   grants NO membership. The BROKER is authoritative and enforces membership when the edge
 *   subscribes/publishes, so a non-member still can't read or write the room. `local=false`
 *   tells the caller to print the "broker will enforce membership" hint.
 *
 * Security: relaxing the local existence check never weakens access control — membership is
 * granted only by `abg room add` / `abg room invite` on the broker, and the broker re-checks it
 * on every subscribe. Mapping a cwd you have no membership for is inert.
 */
export async function joinRoom(opts: {
  roomId: string;
  cwd?: string;
  dbPath?: string;
}): Promise<{ roomId: string; agentId: string | null; local: boolean }> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const svc = new RoomService(store);
    if ((await svc.getRoom(opts.roomId)) !== null) {
      // Local room → strict membership check (unchanged). Resolving the identity also
      // requires a valid local login, which is correct for the single-machine path.
      const agentId = await currentIdentityId(store, dbPath);
      if (!(await svc.isMember(opts.roomId, agentId))) {
        throw new Error(`你（${agentId}）不是 ${opts.roomId} 的成员；请让房间成员在 broker 机上 abg room add ${agentId}`);
      }
      await svc.mapCwd(opts.cwd ?? process.cwd(), opts.roomId);
      return { roomId: opts.roomId, agentId, local: true };
    }
    // Remote room: no local record. Don't resolve identity (a broker-issued token won't
    // resolve against this edge's empty Store) — just map the cwd; the broker enforces
    // membership at subscribe time.
    await svc.mapCwd(opts.cwd ?? process.cwd(), opts.roomId);
    return { roomId: opts.roomId, agentId: null, local: false };
  } finally {
    await store.close();
  }
}

/**
 * Add `identityId` as a member of `roomId` (§11.2 room access control). The broker
 * is closed-by-default: only members may subscribe/publish, so membership IS the
 * access grant. Authorization: the caller (logged-in identity) must already be a
 * member — only insiders can invite. Runs against the collab DB the BROKER reads
 * (the broker machine in a real cross-network deployment).
 */
export async function addRoomMember(opts: { roomId: string; identityId: string; dbPath?: string }): Promise<void> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const caller = await currentIdentityId(store, dbPath);
    const svc = new RoomService(store);
    if ((await svc.getRoom(opts.roomId)) === null) throw new Error(`房间不存在：${opts.roomId}（先 abg room create）`);
    if (!(await svc.isMember(opts.roomId, caller))) {
      throw new Error(`只有房间成员能加人；你（${caller}）不是 ${opts.roomId} 的成员`);
    }
    await svc.join(opts.roomId, opts.identityId);
  } finally {
    await store.close();
  }
}

/**
 * One-shot cross-network onboarding (§ onboarding): invite `identityId` into `roomId` ON THE
 * BROKER. Registers the invitee's identity, issues a PSK token for it (so the token authenticates
 * against the broker's StorePskIdentityProvider), and grants membership — then returns the token +
 * broker URL so the caller can print the exact commands to hand the invitee.
 *
 * Authorization: same gate as `addRoomMember` — the caller must already be a member; only insiders
 * can invite (§11.2). A fresh `--name` updates the display name; otherwise an existing name is kept
 * (never clobbered with the id).
 */
export async function inviteRoomMember(opts: {
  roomId: string;
  identityId: string;
  name?: string;
  /** Broker URL to print for the invitee. Falls back to AGENTBRIDGE_BROKER_URL > loopback default. */
  brokerUrl?: string;
  dbPath?: string;
}): Promise<{ token: string; brokerUrl: string }> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const caller = await currentIdentityId(store, dbPath);
    const roomSvc = new RoomService(store);
    if ((await roomSvc.getRoom(opts.roomId)) === null) throw new Error(`房间不存在：${opts.roomId}（先 abg room create）`);
    if (!(await roomSvc.isMember(opts.roomId, caller))) {
      throw new Error(`只有房间成员能邀请；你（${caller}）不是 ${opts.roomId} 的成员`);
    }
    const idSvc = new IdentityService(store);
    const existing = await idSvc.getIdentity(opts.identityId);
    const displayName = opts.name ?? existing?.displayName ?? opts.identityId;
    await idSvc.registerIdentity(opts.identityId, displayName);
    const token = await idSvc.issueToken(opts.identityId);
    await roomSvc.join(opts.roomId, opts.identityId);
    return { token, brokerUrl: resolveBrokerUrl(opts.brokerUrl) };
  } finally {
    await store.close();
  }
}

/** True iff `url`'s host is loopback — the invitee can't reach the broker through it. */
export function isLoopbackBrokerUrl(url: string): boolean {
  return /:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(:|\/|$)/.test(url);
}

/** Remove `identityId` from `roomId`. Caller must be a member (§11.2). */
export async function removeRoomMember(opts: { roomId: string; identityId: string; dbPath?: string }): Promise<void> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const caller = await currentIdentityId(store, dbPath);
    const svc = new RoomService(store);
    if ((await svc.getRoom(opts.roomId)) === null) throw new Error(`房间不存在：${opts.roomId}`);
    if (!(await svc.isMember(opts.roomId, caller))) {
      throw new Error(`只有房间成员能移除成员；你（${caller}）不是 ${opts.roomId} 的成员`);
    }
    await svc.leave(opts.roomId, opts.identityId);
  } finally {
    await store.close();
  }
}

const ROOM_USAGE =
  "用法：abg room create <name> | abg room list | abg room invite <roomId> <identityId> [--name <displayName>] [--broker-url <ws://…>] | abg room add <roomId> <identityId> | abg room remove <roomId> <identityId>";

/** Dispatch `abg room <subcommand>`: `create <name>` / `list`. */
export async function runRoom(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "create": {
      const name = args.slice(1).join(" ").trim();
      if (!name) {
        console.error("缺少房间名称。");
        console.error(ROOM_USAGE);
        process.exit(1);
        return;
      }
      const { roomId, created } = await createRoom({ name });
      console.log(
        created
          ? `已创建房间 ${roomId}（${name}），你已加入；该目录今后会自动加入`
          : `房间 ${roomId} 已存在，已为你加入；该目录今后会自动加入`,
      );
      break;
    }
    case "list": {
      const rooms = await listRooms({});
      if (rooms.length === 0) {
        console.log("（暂无房间）");
        break;
      }
      for (const r of rooms) {
        console.log(`${r.roomId}\t${r.name}\t${r.createdBy}`);
      }
      break;
    }
    case "invite": {
      const roomId = args[1];
      const identityId = args[2];
      // Optional `--name <displayName>` / `--broker-url <url>` (space- or `=`-separated).
      let name: string | undefined;
      let brokerUrl: string | undefined;
      for (let i = 3; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--name") name = args[++i];
        else if (a.startsWith("--name=")) name = a.slice("--name=".length);
        else if (a === "--broker-url") brokerUrl = args[++i];
        else if (a.startsWith("--broker-url=")) brokerUrl = a.slice("--broker-url=".length);
      }
      if (!roomId || !identityId) {
        console.error("用法：abg room invite <roomId> <identityId> [--name <displayName>] [--broker-url <ws://…>]");
        process.exit(1);
        return;
      }
      const { token, brokerUrl: url } = await inviteRoomMember({ roomId, identityId, name, brokerUrl });
      console.log(`已邀请 ${identityId} 加入房间 ${roomId}。把下面三行通过安全渠道带外发给 ${identityId}，让它在自己机器上运行：`);
      console.log(`  export AGENTBRIDGE_BROKER_URL=${url}`);
      console.log(`  abg auth login --token ${token}`);
      console.log(`  abg join ${roomId}`);
      console.log("");
      console.log("提示：AGENTBRIDGE_BROKER_URL 要在 daemon 启动那一刻就已设好、且持久——建议写进 ~/.zshrc / ~/.bashrc。");
      console.log("daemon 在启动时读一次该变量；若 daemon 已在跑、或新开终端没设它，会回退本机 ws://127.0.0.1:4700/ws、");
      console.log("静默收不到房间事件。设好变量后，先 agentbridge kill 再 agentbridge claude，让 daemon 带上这个地址。");
      console.log("（注：重复 invite 会另签一个新 token、旧 token 不会自动失效——令牌吊销 CLI 仍在 backlog。）");
      if (isLoopbackBrokerUrl(url)) {
        console.log("");
        console.log(`⚠️ 上面的 broker 地址 ${url} 仅本机可达，对方跨机连不上。请改用 broker 机的可路由地址重发：`);
        console.log(`   abg room invite ${roomId} ${identityId} --broker-url ws://<broker 的 Tailscale 100.x 或局域网 IP>:4700/ws`);
        console.log("   （该地址见 broker 机上 abg broker start 打印的连接卡）");
      }
      break;
    }
    case "add":
    case "remove": {
      const roomId = args[1];
      const identityId = args[2];
      if (!roomId || !identityId) {
        console.error(`用法：abg room ${sub} <roomId> <identityId>`);
        process.exit(1);
        return;
      }
      if (sub === "add") {
        await addRoomMember({ roomId, identityId });
        console.log(`已把 ${identityId} 加入房间 ${roomId}（现在它可订阅/发布该房）`);
      } else {
        await removeRoomMember({ roomId, identityId });
        console.log(`已把 ${identityId} 移出房间 ${roomId}（它将无法再订阅/发布该房）`);
      }
      break;
    }
    default:
      console.error(`未知的 room 子命令：${sub ?? "(空)"}`);
      console.error(ROOM_USAGE);
      process.exit(1);
  }
}

/** Dispatch `abg join <roomId>`. */
export async function runJoin(args: string[]): Promise<void> {
  const roomId = args[0];
  if (!roomId) {
    console.error("用法：abg join <roomId>");
    process.exit(1);
    return;
  }
  const result = await joinRoom({ roomId });
  if (result.local) {
    console.log(`已把当前目录关联到房间 ${result.roomId}（agent ${result.agentId}，你已是成员）；该目录今后会自动加入`);
  } else {
    console.log(`本地无房间 ${result.roomId} 的记录，已把当前目录映射过去（远程房间）；连接 broker 时由其校验成员制——只有成员能订阅/发布。该目录今后会自动加入`);
  }
}
