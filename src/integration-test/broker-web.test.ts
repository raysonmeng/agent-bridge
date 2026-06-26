import { describe, test, expect, afterEach } from "bun:test";
import { startBrokerWeb, hostAllowed, type BrokerWebHandle } from "../broker-web";
import { InMemoryStore } from "../backbone/store/memory-store";

/** Seed a store with one room (alice+bob members) and a whiteboard. */
async function seed(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.createRoom("checkout", "结账重构", "alice@x.com");
  await store.addMember("checkout", "alice@x.com");
  await store.addMember("checkout", "bob@x.com");
  await store.saveWhiteboard("checkout", {
    roomId: "checkout",
    contractsReady: [{ contract: "auth/v1" }],
    inProgress: [],
    blockers: [],
    recentMilestones: [{ summary: "auth done" }],
    updatedAt: 1,
  });
  return store;
}

describe("broker web dashboard (loopback admin console)", () => {
  let handle: BrokerWebHandle | undefined;
  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  test("hostAllowed: only loopback:port passes (DNS-rebinding guard)", () => {
    expect(hostAllowed("127.0.0.1:4701", 4701)).toBe(true);
    expect(hostAllowed("localhost:4701", 4701)).toBe(true);
    expect(hostAllowed("[::1]:4701", 4701)).toBe(true);
    expect(hostAllowed("evil.example.com", 4701)).toBe(false);
    expect(hostAllowed("127.0.0.1:9999", 4701)).toBe(false); // wrong port
    expect(hostAllowed(null, 4701)).toBe(false);
  });

  test("GET /api/state returns rooms with members + whiteboard", async () => {
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: "alice@x.com" });
    const res = await fetch(`${handle.url}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rooms: Array<{ roomId: string; name: string; createdBy: string; members: string[]; whiteboard: { contractsReady: unknown[] } | null }>;
    };
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0]).toMatchObject({ roomId: "checkout", name: "结账重构", createdBy: "alice@x.com" });
    expect(body.rooms[0]!.members.sort()).toEqual(["alice@x.com", "bob@x.com"]);
    expect(body.rooms[0]!.whiteboard!.contractsReady).toHaveLength(1);
  });

  test("GET / serves the dashboard HTML", async () => {
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: "alice@x.com" });
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("房间面板");
  });

  test("POST /api/rooms creates a room owned by the logged-in identity", async () => {
    const store = await seed();
    handle = startBrokerWeb({ store, port: 0, createdBy: "alice@x.com" });
    const res = await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新需求" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ roomId: "新需求", created: true });
    expect(await store.getMembers("新需求")).toEqual(["alice@x.com"]); // creator auto-joined
  });

  test("POST /api/rooms logs the new room id + join command to the broker terminal", async () => {
    const logs: string[] = [];
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: "alice@x.com", log: (m) => logs.push(m) });
    await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "新需求" }),
    });
    expect(logs.some((l) => l.includes("已创建房间 新需求") && l.includes("abg join 新需求"))).toBe(true);
  });

  test("POST /api/rooms strips control chars from the name before logging (no terminal injection, CWE-117)", async () => {
    const logs: string[] = [];
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: "alice@x.com", log: (m) => logs.push(m) });
    await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "danger\u001b[2J\r\nFAKE" }), // ANSI clear-screen + CRLF forged-line attempt
    });
    const line = logs.find((l) => l.includes("已创建房间"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\u001b"); // ESC stripped → no ANSI escape reaches the operator's terminal
    expect(line).not.toContain("\n"); // newline stripped → can't forge a separate log line
    expect(line).not.toContain("\r");
  });

  test("GET / dashboard render builds a per-room `abg join <id>` command from r.roomId (not a static string)", async () => {
    // Room cards render client-side from /api/state (asserted above), so GET / is the render() SOURCE —
    // an empty store is fine. Assert render() CONCATENATES the command from EACH room's id, so dropping
    // the join div or hardcoding the command fails here (the old toContain("abg join ") passed vacuously
    // off any occurrence, even an unrendered one).
    handle = startBrokerWeb({ store: new InMemoryStore(), port: 0, createdBy: "alice@x.com" });
    const html = await (await fetch(handle.url)).text();
    expect(html).toContain("abg join '+esc(r.roomId)"); // per-room, id-escaped — discriminating
  });

  test("POST /api/rooms is rejected when not logged in (createdBy null)", async () => {
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: null });
    const res = await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/rooms with a punctuation-only name → 400 (no valid slug)", async () => {
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: "alice@x.com" });
    const res = await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "!!!" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/rooms on an EXISTING room by a NON-member → 409 (closed-by-default, no self-grant)", async () => {
    const store = await seed(); // room "checkout" has alice + bob, NOT mallory
    handle = startBrokerWeb({ store, port: 0, createdBy: "mallory@x.com" });
    const res = await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "checkout" }), // slugifies to the existing room id
    });
    expect(res.status).toBe(409);
    expect(await store.getMembers("checkout")).not.toContain("mallory@x.com"); // never self-granted
  });

  test("POST /api/rooms on an EXISTING room by a MEMBER → 200 created:false (idempotent, no duplicate join)", async () => {
    const store = await seed();
    handle = startBrokerWeb({ store, port: 0, createdBy: "alice@x.com" });
    const res = await fetch(`${handle.url}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "checkout" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ roomId: "checkout", created: false });
    expect((await store.getMembers("checkout")).sort()).toEqual(["alice@x.com", "bob@x.com"]); // membership unchanged
  });

  test("unknown path → 404", async () => {
    handle = startBrokerWeb({ store: await seed(), port: 0, createdBy: "alice@x.com" });
    const res = await fetch(`${handle.url}/nope`);
    expect(res.status).toBe(404);
  });

  test("a non-loopback bind host is refused — forced to 127.0.0.1 (no public admin console)", () => {
    handle = startBrokerWeb({ store: new InMemoryStore(), port: 0, createdBy: null, host: "0.0.0.0" });
    // Verifies OUR enforcement logic (the host handed to Bun.serve), not Bun's socket
    // layer: a non-loopback request is forced back to 127.0.0.1 before binding.
    expect(handle.host).toBe("127.0.0.1"); // enforced loopback regardless of the caller
    expect(handle.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});
