/**
 * Local trusted-sender list (`abg room trust`), consulted only when the daemon runs with --room-untrusted.
 * The operator of THIS machine names room members whose chat messages are still injected as
 * instructions; task_completed and presence stay untrusted notices for everyone.
 *
 * Trust anchor = the local operator: the list lives only in `<collabDir>/room-trust.json` (0600), is
 * never sent to the broker, and is matched against the broker-stamped `from.agentId` (see broker.ts
 * anti-spoof re-stamp), never a member-chosen display name. Reads fail closed: a missing or malformed
 * file trusts nobody. Writes refuse to clobber a file they cannot parse.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import { resolveDbPath } from "./collab-store";

type TrustFile = { version: 1; rooms: Record<string, string[]> };

export function trustFilePath(dbPath?: string): string {
  return join(dirname(resolveDbPath(dbPath)), "room-trust.json");
}

function parse(raw: string): TrustFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rooms = (data as { rooms?: unknown }).rooms;
  if (!rooms || typeof rooms !== "object" || Array.isArray(rooms)) return null;
  // Null-prototype: room ids are slugs, and "constructor" / "__proto__" must be ordinary keys.
  const clean: Record<string, string[]> = Object.create(null);
  for (const [room, ids] of Object.entries(rooms)) {
    if (!Array.isArray(ids)) continue;
    const valid = ids.filter((id): id is string => typeof id === "string" && id.trim() !== "");
    if (valid.length > 0) clean[room] = valid;
  }
  return { version: 1, rooms: clean };
}

/** Own-property lookup, so a room id never resolves to an inherited Object.prototype member. */
function idsOf(rooms: Record<string, string[]>, roomId: string): string[] {
  return Object.hasOwn(rooms, roomId) ? rooms[roomId]! : [];
}

/** Trusted sender ids for one room. Missing / unreadable / malformed file ⇒ empty set (fail closed). */
export function readTrustedSenders(roomId: string, dbPath?: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(trustFilePath(dbPath), "utf-8");
  } catch {
    return new Set();
  }
  const parsed = parse(raw);
  return new Set(parsed ? idsOf(parsed.rooms, roomId) : []);
}

export function listTrustedSenders(dbPath?: string): Record<string, string[]> {
  let raw: string;
  try {
    raw = readFileSync(trustFilePath(dbPath), "utf-8");
  } catch {
    return {};
  }
  return parse(raw)?.rooms ?? {};
}

/** Load for a write: a present-but-unparseable file is an error, never silently replaced. */
function loadForWrite(path: string): TrustFile {
  if (!existsSync(path)) return { version: 1, rooms: {} };
  const parsed = parse(readFileSync(path, "utf-8"));
  if (!parsed) throw new Error(`无法解析 ${path}（room-trust.json 格式错误），请先修正或删除该文件`);
  return parsed;
}

function requireId(label: string, value: string): string {
  const v = value.trim();
  if (v === "") throw new Error(`${label} 不能为空`);
  return v;
}

function save(path: string, file: TrustFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteJson(path, file, { mode: 0o600 });
}

/** Returns false when the sender was already trusted in that room. */
export function addTrustedSender(roomId: string, agentId: string, dbPath?: string): boolean {
  const room = requireId("roomId", roomId);
  const id = requireId("agentId", agentId);
  const path = trustFilePath(dbPath);
  const file = loadForWrite(path);
  const ids = idsOf(file.rooms, room);
  if (ids.includes(id)) return false;
  save(path, { version: 1, rooms: { ...file.rooms, [room]: [...ids, id] } });
  return true;
}

/** Returns false when the sender was not trusted in that room. An emptied room is dropped. */
export function removeTrustedSender(roomId: string, agentId: string, dbPath?: string): boolean {
  const room = requireId("roomId", roomId);
  const id = requireId("agentId", agentId);
  const path = trustFilePath(dbPath);
  const file = loadForWrite(path);
  const ids = idsOf(file.rooms, room);
  if (!ids.includes(id)) return false;
  const { [room]: _dropped, ...others } = file.rooms;
  const rest = ids.filter((x) => x !== id);
  save(path, { version: 1, rooms: rest.length > 0 ? { ...others, [room]: rest } : others });
  return true;
}
