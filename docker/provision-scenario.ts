/**
 * §13 acceptance provisioning (one-shot): register the whole cast, issue a PSK
 * token per identity into the shared volume, create the room + add everyone as a
 * member, and assert §13#5 (session continuity) at the Store layer.
 *
 * Cast (note bob & bob2 share the displayName "Bob" but have DIFFERENT ids — that
 * is §13#6 identity disambiguation: routing/signing is by id, never displayName).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteStore } from "../src/backbone/store/sqlite-store";
import { IdentityService } from "../src/backbone/identity-service";
import { RoomService } from "../src/room-service";
import { SessionLedger } from "../src/session-ledger";

const db = process.env.COLLAB_DB ?? "/data/collab.db";
const tokenDir = process.env.TOKEN_DIR ?? "/data";
const room = process.env.ROOM ?? "team-room";

mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
chmodSync(dirname(db), 0o700);

const cast = [
  { id: "alice@team.dev", name: "Alice", file: "token-alice" },
  { id: "bob@team.dev", name: "Bob", file: "token-bob" },
  { id: "bob2@team.dev", name: "Bob", file: "token-bob2" }, // SAME displayName, DIFFERENT id
  { id: "carol@team.dev", name: "Carol", file: "token-carol" },
  { id: "dave@team.dev", name: "Dave", file: "token-dave" },
];

const store = new SqliteStore(db);
const svc = new IdentityService(store);
const rooms = new RoomService(store);

await rooms.createRoom(room, "Team Room", "alice@team.dev");
for (const m of cast) {
  await svc.registerIdentity(m.id, m.name);
  const token = await svc.issueToken(m.id);
  writeFileSync(join(tokenDir, m.file), token, { mode: 0o600 });
  await rooms.join(room, m.id); // membership ⇒ eligible for offline store_if_offline
  console.log(`[provision] ${m.id} ("${m.name}") token→${m.file}, joined ${room}`);
}

// §13#5 session continuity (Store-level, broker-independent): the same
// workspace+agentType restarting must report `resumed` + the prior session id.
const ledger = new SessionLedger(store);
const ws = "/work/app";
const first = await ledger.recordSessionStart(ws, "claude", "sess-1");
const second = await ledger.recordSessionStart(ws, "claude", "sess-2");
const ok5 = first.continuity === "new" && second.continuity === "resumed" && second.previousSessionId === "sess-1";
console.log(
  `[provision] ASSERT s13-5-session-continuity ${ok5 ? "PASS" : "FAIL"}: ` +
    `first=${first.continuity}, second=${second.continuity}, prev=${second.previousSessionId}`,
);

await store.close();
console.log(`[provision] done (room=${room}, ${cast.length} identities)`);
if (!ok5) process.exit(1);
