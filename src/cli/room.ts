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

import { RoomService, slugify } from "../room-service";
import { IdentityService } from "../backbone/identity-service";
import type { RoomRecord, Store } from "../backbone/store";
import { readAuthToken, resolveBrokerUrl, resolveDbPath, openStore } from "../collab-store";
import { BrokerClient } from "../broker-client";
import { hashPassword } from "../backbone/password";

/**
 * Read a single line (the password) from stdin — the non-leaky alternative to `--password <pw>` on the
 * command line. argv lands in `ps` / `/proc/<pid>/cmdline` and the shell history; a piped/typed secret
 * (`echo pw | abg join r --password-stdin`) does not. Mirrors `docker login --password-stdin`.
 */
async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/**
 * Resolve the currently logged-in collab identity id from `<collabDir>/auth-token`
 * (written by `abg auth login`). The token file is a local secret; a missing or
 * unresolvable token means the user has not logged in yet.
 */
export async function currentIdentityId(store: Store, dbPath: string): Promise<string> {
  const token = readAuthToken(dbPath);
  if (token === null) throw new Error("未找到登录令牌，请先运行 abg auth login");
  const identityId = await store.resolveToken(token);
  if (!identityId) throw new Error("登录令牌无效，请先运行 abg auth login");
  return identityId;
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
  /** Optional self-service-join password (§11.2). Stored hashed; omit/empty for invite-only. */
  password?: string;
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
    // Optional self-service-join password (§11.2): a member (incl. the just-created creator) may set it.
    // Hashed at rest. An empty value is treated as "not provided" here — use `room set-password` to clear.
    if (opts.password) await svc.setRoomPassword(roomId, hashPassword(opts.password));
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

/**
 * Remove `identityId` from `roomId`. Caller must be a member (§11.2). Returns whether the room still
 * has a self-service-join password — if so, removal alone does NOT revoke access (the removed party,
 * still holding a valid PSK token + the password, can `abg join --password` straight back in), so the
 * caller should warn the operator to rotate/clear the password too.
 */
export async function removeRoomMember(opts: {
  roomId: string;
  identityId: string;
  dbPath?: string;
}): Promise<{ roomHasPassword: boolean }> {
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
    return { roomHasPassword: (await svc.getRoomPasswordHash(opts.roomId)) !== null };
  } finally {
    await store.close();
  }
}

const ROOM_USAGE =
  "用法：abg room create <name> [--password <口令>|--password-stdin] | abg room list | abg room invite <roomId> <identityId> [--name <displayName>] [--broker-url <ws://…>] | abg room set-password <roomId> --password <口令>|--password-stdin|--clear | abg room add <roomId> <identityId> | abg room remove <roomId> <identityId>";

/** Dispatch `abg room <subcommand>`: `create <name>` / `list`. */
/**
 * Set or clear a room's self-service-join password (§11.2). Member-only: only an existing member may
 * change the join secret. A null/empty password clears it (back to invite-only). Runs against the
 * BROKER's collab DB (the broker machine), like `abg room add`.
 */
export async function setRoomPasswordCli(opts: {
  roomId: string;
  password: string | null;
  dbPath?: string;
}): Promise<void> {
  const dbPath = resolveDbPath(opts.dbPath);
  const store = openStore(dbPath);
  try {
    const caller = await currentIdentityId(store, dbPath);
    const svc = new RoomService(store);
    if ((await svc.getRoom(opts.roomId)) === null) throw new Error(`房间不存在：${opts.roomId}`);
    if (!(await svc.isMember(opts.roomId, caller))) {
      throw new Error(`只有房间成员能设置口令；你（${caller}）不是 ${opts.roomId} 的成员`);
    }
    await svc.setRoomPassword(opts.roomId, opts.password ? hashPassword(opts.password) : null);
  } finally {
    await store.close();
  }
}

/**
 * Self-service join a password-protected room (§11.2): connect to the broker as the logged-in identity
 * and present the room password. The BROKER verifies it against the room's stored hash and grants
 * PERSISTENT membership — no member needs to run `abg room add`. On success the cwd is mapped locally so
 * the daemon's room-bridge picks up this room. Throws the broker's reason on a wrong/throttled password.
 */
export async function joinRoomWithPassword(opts: {
  roomId: string;
  password: string;
  cwd?: string;
  dbPath?: string;
  brokerUrl?: string;
}): Promise<{ roomId: string }> {
  const dbPath = resolveDbPath(opts.dbPath);
  const token = readAuthToken(dbPath);
  if (!token) {
    throw new Error("未登录：请先 abg auth login --token <broker 签发的令牌>，再用房间口令自助加入");
  }
  const client = new BrokerClient({ url: resolveBrokerUrl(opts.brokerUrl), token });
  try {
    await client.connect(); // PSK auth — proves identity to the broker
    await client.joinWithPassword(opts.roomId, opts.password); // broker verifies password + grants membership
  } finally {
    client.close();
  }
  // Membership now lives broker-side; map the cwd locally so the daemon's room-bridge resolves it (§2.4).
  const store = openStore(dbPath);
  try {
    await new RoomService(store).mapCwd(opts.cwd ?? process.cwd(), opts.roomId);
  } finally {
    await store.close();
  }
  return { roomId: opts.roomId };
}

export async function runRoom(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "create": {
      // name = all non-flag args joined; optional `--password <pw>` (space- or `=`-separated).
      const rest = args.slice(1);
      let password: string | undefined;
      let stdin = false;
      const nameParts: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--password") password = rest[++i] ?? "";
        else if (a.startsWith("--password=")) password = a.slice("--password=".length);
        else if (a === "--password-stdin") stdin = true;
        else nameParts.push(a);
      }
      if (stdin) password = await readPasswordFromStdin();
      const name = nameParts.join(" ").trim();
      if (!name) {
        console.error("缺少房间名称。");
        console.error(ROOM_USAGE);
        process.exit(1);
        return;
      }
      if (password === "") {
        console.error("口令为空：--password <口令> / --password-stdin 需要非空口令（都省略则建无口令房）。");
        process.exit(1);
        return;
      }
      const { roomId, created } = await createRoom({ name, password });
      console.log(
        created
          ? `已创建房间 ${roomId}（${name}），你已加入；该目录今后会自动加入`
          : `房间 ${roomId} 已存在，已为你加入；该目录今后会自动加入`,
      );
      if (password) {
        console.log(`已设置自助加入口令：他人可 abg join ${roomId} --password <口令> 自助加入（口令请通过安全渠道带外发，勿随仓库提交）`);
      }
      break;
    }
    case "set-password": {
      const roomId = args[1];
      let password: string | null = null;
      let provided = false;
      let stdin = false;
      for (let i = 2; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--password") { password = args[++i] ?? ""; provided = true; }
        else if (a.startsWith("--password=")) { password = a.slice("--password=".length); provided = true; }
        else if (a === "--password-stdin") { stdin = true; provided = true; }
        else if (a === "--clear") { password = null; provided = true; }
      }
      if (stdin) password = await readPasswordFromStdin();
      if (!roomId || !provided) {
        console.error("用法：abg room set-password <roomId> --password <口令>|--password-stdin   ｜   abg room set-password <roomId> --clear（移除口令，恢复仅邀请）");
        process.exit(1);
        return;
      }
      if (password === "") {
        console.error("口令为空：--password <口令> / --password-stdin 需要非空口令；要移除口令请用 --clear。");
        process.exit(1);
        return;
      }
      await setRoomPasswordCli({ roomId, password });
      console.log(password ? `已为房间 ${roomId} 设置自助加入口令` : `已移除房间 ${roomId} 的口令（恢复仅邀请加入）`);
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
      console.log("（注：重复 invite 会另签一个新 token、旧 token 不会自动失效；要作废旧 token 用 abg auth revoke --id <id>。）");
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
        const { roomHasPassword } = await removeRoomMember({ roomId, identityId });
        console.log(`已把 ${identityId} 移出房间 ${roomId}（它将无法再订阅/发布该房）`);
        if (roomHasPassword) {
          console.log(`⚠️ 该房设有自助加入口令——仅 remove 挡不住知道口令的人：对方仍持有效 token 时可 abg join ${roomId} --password 自助加回。`);
          console.log(`   要真正排除，请同时改/清口令：abg room set-password ${roomId} --password <新口令>  或  abg room set-password ${roomId} --clear`);
        }
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
  // Optional `--password <pw>` / `--password-stdin` → self-service join via the broker.
  let password: string | undefined;
  let stdin = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--password") password = args[++i] ?? "";
    else if (a.startsWith("--password=")) password = a.slice("--password=".length);
    else if (a === "--password-stdin") stdin = true;
  }
  if (stdin) password = await readPasswordFromStdin();
  if (!roomId) {
    console.error("用法：abg join <roomId> [--password <口令> | --password-stdin]");
    process.exit(1);
    return;
  }
  if (password !== undefined) {
    if (password === "") {
      console.error("口令为空：abg join <roomId> --password <口令>");
      process.exit(1);
      return;
    }
    await joinRoomWithPassword({ roomId, password });
    console.log(`已用房间口令自助加入 ${roomId}（broker 已校验口令并授予成员资格）；该目录今后会自动加入`);
    return;
  }
  const result = await joinRoom({ roomId });
  if (result.local) {
    console.log(`已把当前目录关联到房间 ${result.roomId}（agent ${result.agentId}，你已是成员）；该目录今后会自动加入`);
  } else {
    console.log(`本地无房间 ${result.roomId} 的记录，已把当前目录映射过去（远程房间）；连接 broker 时由其校验成员制——只有成员能订阅/发布。该目录今后会自动加入`);
  }
}
