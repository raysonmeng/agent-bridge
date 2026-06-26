/**
 * §13 acceptance "agent" stand-in (one container = one machine/person/agent).
 *
 * A headless agent built on the REAL `src/broker-client.ts` BrokerClient (so it
 * exercises reconnect/jitter/onWhiteboard for real). `AGENT_TYPE` (claude/codex/
 * gemini) is just a label — the control plane is agent-agnostic, which is exactly
 * the point: heterogeneous agents interoperate over one protocol.
 *
 * Each ROLE plays a scripted, mostly EVENT-DRIVEN timeline and prints structured
 * `RECV ...` / `ASSERT <item> PASS|FAIL ...` lines, exiting 0 iff every assert passed.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BrokerClient } from "../src/broker-client";
import type { Envelope } from "../src/backbone/envelope";

const NAME = process.env.AGENT_NAME ?? "agent";
const TYPE = process.env.AGENT_TYPE ?? "claude";
const ID = process.env.IDENTITY ?? "x@team.dev";
const ROOM = process.env.ROOM ?? "team-room";
const ROLE = process.env.ROLE ?? "observer";
const URL = process.env.BROKER_URL ?? "ws://broker:4700/ws";
const TOKEN_FILE = process.env.TOKEN_FILE ?? "/data/token";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[${NAME}:${TYPE}] ${m}`);

let failures = 0;
function check(item: string, cond: boolean, detail: string): void {
  log(`ASSERT ${item} ${cond ? "PASS" : "FAIL"}: ${detail}`);
  if (!cond) failures++;
}

const events: Array<{ topic: string; env: Envelope }> = [];
const whiteboards: any[] = [];

function mkClient(): BrokerClient {
  const c = new BrokerClient({
    url: URL,
    token: readFileSync(TOKEN_FILE, "utf8").trim(),
    presence: { agentType: TYPE },
    log: () => {},
  });
  c.onEvent((topic, env) => {
    events.push({ topic, env });
    const p = env.payload as { summary?: string } | undefined;
    log(`RECV event kind=${env.kind} from=${env.from?.agentId ?? "?"} to=${env.to ? JSON.stringify(env.to) : "-"} summary=${p?.summary ?? "-"}`);
  });
  c.onWhiteboard((roomId, wb) => {
    whiteboards.push(wb);
    const contracts = (wb as { contractsReady?: Array<{ contract?: string }> })?.contractsReady?.map((x) => x.contract);
    log(`RECV whiteboard room=${roomId} contractsReady=${JSON.stringify(contracts)}`);
  });
  return c;
}

function envelope(opts: { kind: string; payload: unknown; to?: string[]; deliveryMode?: "online_only" | "store_if_offline" }): Envelope {
  return {
    roomId: ROOM,
    messageId: randomUUID(),
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    from: { agentId: ID, agentType: TYPE }, // broker re-stamps from.agentId to the authed identity (anti-spoof)
    kind: opts.kind,
    payload: opts.payload,
    timestamp: Date.now(),
    deliveryMode: opts.deliveryMode ?? "store_if_offline",
    ...(opts.to ? { to: opts.to } : {}),
  };
}

async function waitFor(pred: (e: { topic: string; env: Envelope }) => boolean, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = events.find(pred);
    if (f) return f;
    await sleep(100);
  }
  return null;
}

async function finish(): Promise<never> {
  await sleep(500);
  log(failures === 0 ? "DONE all asserts PASS" : `DONE ${failures} assert(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── ROLE: intruder — bad token must be rejected (§13#7 application-layer PSK) ──
if (ROLE === "intruder") {
  const c = new BrokerClient({ url: URL, token: "bogus-token-never-issued", log: () => {} });
  try {
    await c.connect();
    check("s13-7-psk", false, "a bogus token unexpectedly authenticated");
  } catch (e) {
    check("s13-7-psk", true, `bogus token rejected (${String(e)})`);
  } finally {
    c.close();
  }
  await finish();
}

// ── all other roles: authenticate + subscribe, then play the script ──
const client = mkClient();
await client.connect();
log(`authenticated as ${client.whoami?.id}`);
client.subscribe(ROOM);
await sleep(900); // let subscribe register + any on-join whiteboard arrive

switch (ROLE) {
  case "alice": {
    client.publish(ROOM, envelope({ kind: "task_completed", payload: { summary: "auth 契约就绪", repo: "app", branch: "main", commit: "abc123", contract: "auth/v1" } }));
    log("published task_completed (auth/v1)");
    await sleep(1500);
    check("s13-1-from-skip", !events.some((e) => e.env.from?.agentId === ID), "alice never receives her own events (loop prevention)");
    const ack = await waitFor((e) => e.env.kind === "dm" && e.env.from?.agentId === "bob@team.dev", 12000);
    check("s13-2-dm-roundtrip", !!ack, ack ? "received bob's ack DM" : "no ack DM from bob");
    client.publish(ROOM, envelope({ kind: "dm", to: ["bob@team.dev"], payload: { summary: "请基于 auth/v1 继续 checkout" } }));
    log("sent DM → bob@");
    const left = await waitFor((e) => e.env.kind === "member_left" && e.env.from?.agentId === "dave@team.dev", 15000);
    log(left ? "observed dave member_left → publishing offline-replay event" : "no dave member_left within window (publishing anyway)");
    client.publish(ROOM, envelope({ kind: "task_completed", deliveryMode: "store_if_offline", payload: { summary: "second-wave 离线补投", repo: "app", branch: "main", commit: "def456", contract: "checkout/v1" } }));
    check("s13-4-offline-trigger", !!left, left ? "dave was offline when the 2nd event was published" : "dave still online — offline path not exercised");
    await sleep(3000);
    await finish();
    break;
  }
  case "bob": {
    const tc = await waitFor((e) => e.env.kind === "task_completed" && e.env.from?.agentId === "alice@team.dev" && (e.env.payload as any)?.contract === "auth/v1", 12000);
    check("s13-1-completion", !!tc, tc ? `got alice's completion (contract=auth/v1, summary=${(tc.env.payload as any).summary})` : "no alice completion");
    client.publish(ROOM, envelope({ kind: "dm", to: ["alice@team.dev"], payload: { summary: "收到，开始基于 auth/v1" } }));
    log("sent ack DM → alice@");
    const dm = await waitFor((e) => e.env.kind === "dm" && e.env.from?.agentId === "alice@team.dev" && (e.env.to ?? []).includes(ID), 12000);
    check("s13-2-dm-recv", !!dm, dm ? "received alice's DM addressed to bob@" : "no DM from alice");
    await sleep(2000);
    await finish();
    break;
  }
  case "bob2": {
    const tc = await waitFor((e) => e.env.kind === "task_completed" && e.env.from?.agentId === "alice@team.dev", 12000);
    check("s13-6-broadcast-all", !!tc, tc ? "bob2 received the broadcast completion (broadcasts reach all members)" : "bob2 missed the broadcast");
    await sleep(9000); // give alice's DM-to-bob@ ample time to (not) arrive
    const leaked = events.some((e) => e.env.kind === "dm" && e.env.from?.agentId === "alice@team.dev");
    check("s13-6-dm-disambiguation", !leaked, leaked ? "LEAK: bob2 got a DM meant for bob@ (same displayName!)" : "bob2 correctly did NOT receive bob@'s DM — routed by id, not displayName");
    await finish();
    break;
  }
  case "carol": {
    // carol starts LATE (compose delay), so alice's completion already distilled
    // into the whiteboard; on join the broker pushes that snapshot.
    await sleep(2000);
    const wb = whiteboards.find((w) => (w?.contractsReady ?? []).some((c: any) => c.contract === "auth/v1"));
    check("s13-3-whiteboard-on-join", !!wb, wb ? "late-joiner got the whiteboard snapshot (contractsReady=auth/v1)" : `no whiteboard with auth/v1 (received ${whiteboards.length} board(s))`);
    await sleep(3000);
    await finish();
    break;
  }
  case "dave": {
    await sleep(2500);
    log("disconnecting (going offline)");
    client.close();
    await sleep(7000); // offline window: alice publishes the store_if_offline event here
    log("reconnecting");
    const client2 = mkClient();
    await client2.connect();
    client2.subscribe(ROOM);
    const drained = await waitFor((e) => e.env.kind === "task_completed" && (e.env.payload as any)?.contract === "checkout/v1", 12000);
    check("s13-4-offline-replay", !!drained, drained ? `reconnect drained the offline event (summary=${(drained.env.payload as any).summary})` : "did NOT drain the offline event on reconnect");
    client2.close();
    await finish();
    break;
  }
  default:
    log(`unknown role ${ROLE}`);
    process.exit(2);
}
