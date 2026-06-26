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
import { RoomService } from "../room-service";
import { SqliteStore } from "../backbone/store/sqlite-store";
import type { RoomRecord, Store } from "../backbone/store";
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

/**
 * Turn a human room name into a room id: lowercase, whitespace→`-`, keep unicode
 * letters/numbers (Chinese-first, so "结账" is valid) + dash, drop everything
 * else, collapse runs of `-`, trim leading/trailing `-`. Throws when nothing
 * usable remains (e.g. a name of only punctuation).
 */
export function slugify(name: string): string {
  // Keep unicode letters/numbers (the project is Chinese-first, so "结账" is a
  // valid room id) + dash; whitespace → dash; drop everything else. The room id
  // is an internal topic key / Store key, not a URL, so CJK is fine.
  const slug = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error(`无法从「${name}」生成有效的房间 ID（需含字母或数字）`);
  return slug;
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
    await svc.createRoom(roomId, opts.name, createdBy); // INSERT OR IGNORE — reuse if existed
    await svc.join(roomId, createdBy); // the creator is a member
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
 * Join the logged-in identity to a room and map the cwd to it (so the same
 * directory auto-joins next time, §2.4). Throws if the room does not exist.
 */
export async function joinRoom(opts: {
  roomId: string;
  cwd?: string;
  dbPath?: string;
}): Promise<{ roomId: string; agentId: string }> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const agentId = await currentIdentityId(store, dbPath);
    const svc = new RoomService(store);
    if ((await svc.getRoom(opts.roomId)) === null) {
      throw new Error(`房间不存在：${opts.roomId}（先用 abg room create 创建）`);
    }
    await svc.join(opts.roomId, agentId);
    await svc.mapCwd(opts.cwd ?? process.cwd(), opts.roomId);
    return { roomId: opts.roomId, agentId };
  } finally {
    await store.close();
  }
}

const ROOM_USAGE = "用法：abg room create <name> | abg room list";

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
  console.log(`已加入房间 ${result.roomId}（agent ${result.agentId}）；该目录今后会自动加入`);
}
