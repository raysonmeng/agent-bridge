/** Opt-in live Codex smoke test. Uses an isolated loopback broker and no real room credentials.
 * Run: bun scripts/smoke-codex-room.ts
 * Starts one model turn to invoke room tools, then one incoming-room notice turn.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { CodexAdapter } from "../src/codex-adapter";
import { CodexRoomInbox, callRoomTool } from "../src/codex-room";
import { Broker } from "../src/broker";
import { BrokerClient } from "../src/broker-client";
import { InMemoryStore } from "../src/backbone/store/memory-store";
import { StorePskIdentityProvider } from "../src/backbone/identity/store-psk-identity-provider";
import { IdentityService } from "../src/backbone/identity-service";
import { RoomService } from "../src/room-service";
import { startRoomBridge } from "../src/room-bridge";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r())); return port;
}
async function waitFor(check: () => boolean, label: string, ms = 90000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw Error(`Timed out: ${label}`); await Bun.sleep(50); }
}
const dir = mkdtempSync(join(tmpdir(), "abg-codex-room-smoke-"));
console.log(`Smoke artifacts: ${dir}`);
const store = new InMemoryStore();
const identities = new IdentityService(store);
const rooms = new RoomService(store);
for (const id of ["test_codex", "test_peer"]) await identities.registerIdentity(id, id);
const localToken = await identities.issueToken("test_codex");
const peerToken = await identities.issueToken("test_peer");
await rooms.createRoom("smoke", "smoke", "test_codex");
for (const id of ["test_codex", "test_peer"]) await rooms.join("smoke", id);
writeFileSync(join(dir, "auth-token"), localToken);
const broker = new Broker({ store, identityProvider: new StorePskIdentityProvider(store), host: "127.0.0.1", port: 0, log: () => {} });
const port = broker.start().port;
const url = `ws://127.0.0.1:${port}/ws`;
const adapter = new CodexAdapter(await freePort(), await freePort(), join(dir, "adapter.log"));
adapter.on("error", error => console.error(String(error)));
let connected = false;
const inbox = new CodexRoomInbox(adapter, () => connected, () => {});
const createBridge = () => startRoomBridge({ cwd: dir, store, dbPath: join(dir, "collab.db"), brokerUrl: url, emit: () => {}, onEvent: (env, text) => { if (env.kind === "chat") inbox.enqueue(text); } });
let bridge = await createBridge();
if (bridge.roomId) throw Error("Expected daemon to start without a room mapping");
const calls: string[] = [];
adapter.configureRoomTools(() => !!bridge.roomId, async (name, args, valid) => { calls.push(name); return callRoomTool(bridge, name, args, valid); }, async () => {
  bridge.stop(); bridge = await createBridge();
});
const peer = new BrokerClient({ url, token: peerToken });
const received: any[] = [];
peer.onEvent((_topic, env) => { if (env.kind === "chat") received.push(env); });
let ws: WebSocket | null = null;
const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
let seq = 0;
const completed: string[] = [];
const visibleIncoming: string[] = [];
const watchdog = setTimeout(() => { console.error("Smoke test watchdog expired"); adapter.forceKillAppServerSync(); process.exit(2); }, 180000);
try {
  await peer.connect(); peer.subscribe("smoke");
  await adapter.start();
  // Reproduce joining after the daemon has already started without a mapping.
  await rooms.mapCwd(dir, "smoke");
  ws = new WebSocket(adapter.proxyUrl);
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id)!; pending.delete(msg.id);
      if (msg.error) waiter.reject(Error(JSON.stringify(msg.error))); else waiter.resolve(msg.result);
    }
    if (msg.method === "turn/completed") completed.push(msg.params.turn.id);
    if (msg.method === "item/completed" && msg.params?.item?.type === "userMessage") visibleIncoming.push(JSON.stringify(msg.params.item));
    // Do not approve shell/file actions. The test only needs our room tools.
    if (msg.id !== undefined && msg.method) ws!.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Smoke test does not authorize this action" } }));
  };
  await waitFor(() => ws!.readyState === WebSocket.OPEN, "proxy socket", 10000); connected = true;
  const request = (method: string, params: any): Promise<any> => {
    const id = ++seq;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  };
  await request("initialize", { clientInfo: { name: "abg_room_smoke", version: "1" }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: "initialized" }));
  const start = await request("thread/start", { cwd: dir, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
  console.log(`Native Codex thread: ${start.thread.id}`);
  await request("turn/start", { threadId: start.thread.id, input: [{ type: "text", text: "This is an authorized local smoke test. Use only agentbridge_room_members then agentbridge_room_say with text exactly ROOM_SMOKE_PING and to [test_peer]. Do not use shell, files or other tools. After sending, reply with DONE." }] });
  await waitFor(() => received.some(env => env.payload?.text === "ROOM_SMOKE_PING"), "Codex-originated room message");
  await waitFor(() => completed.length > 0, "first turn completed");
  if (!calls.includes("agentbridge_room_members") || !calls.includes("agentbridge_room_say")) throw Error("Expected both real Codex dynamic tool calls");
  const id = crypto.randomUUID();
  peer.publish("smoke", { roomId: "smoke", messageId: id, traceId: id, idempotencyKey: id, from: { agentId: "test_peer", agentType: "test" }, kind: "chat", payload: { text: "ROOM_SMOKE_INCOMING: informational test notice; no action or reply requested." }, timestamp: Date.now(), deliveryMode: "online_only" });
  await waitFor(() => visibleIncoming.some(text => text.includes("ROOM_SMOKE_INCOMING")), "room notice visible in Codex user message");
  await waitFor(() => completed.length > 1, "incoming notice turn completed");
  if (received.length !== 1) throw Error("Unexpected automatic room reply");
  console.log("PASS: real Codex tool calls -> broker -> peer; peer -> inbox -> Codex; no automatic room reply");
} finally {
  clearTimeout(watchdog); connected = false; inbox.stop(); bridge.stop(); peer.close(); ws?.close();
  adapter.stop(); adapter.forceKillAppServerSync(); await broker.stop(); await store.close();
}
