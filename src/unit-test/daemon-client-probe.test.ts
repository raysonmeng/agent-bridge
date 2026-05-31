import { afterEach, describe, expect, test } from "bun:test";
import { DaemonClient } from "../daemon-client";

/**
 * Unit coverage for the conflict-guard protocol path (issue: `abg claude` must
 * detect a LIVE incumbent before launching). Drives DaemonClient.probeIncumbent
 * against a fake control WS that mimics the daemon's `probe_incumbent` handler.
 */

interface FakeServerOptions {
  /** What to reply with on `probe_incumbent`. "silent" sends nothing; "close" drops the socket. */
  mode: "reply" | "silent" | "close";
  connected?: boolean;
  alive?: boolean;
}

let server: ReturnType<typeof Bun.serve> | null = null;
const received: string[] = [];

function startFakeDaemon(opts: FakeServerOptions): string {
  received.length = 0;
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : raw.toString();
        let msg: { type?: string };
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type) received.push(msg.type);
        if (msg.type !== "probe_incumbent") return;
        if (opts.mode === "silent") return;
        if (opts.mode === "close") {
          ws.close();
          return;
        }
        ws.send(
          JSON.stringify({
            type: "incumbent_status",
            connected: opts.connected ?? false,
            alive: opts.alive ?? false,
          }),
        );
      },
    },
  });
  return `ws://127.0.0.1:${server.port}/ws`;
}

afterEach(() => {
  if (server) {
    server.stop(true);
    server = null;
  }
});

describe("DaemonClient.probeIncumbent", () => {
  test("reports a live incumbent (connected + alive)", async () => {
    const url = startFakeDaemon({ mode: "reply", connected: true, alive: true });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.probeIncumbent(1000)).toEqual({ connected: true, alive: true });
    await client.disconnect();
  });

  test("reports a stale half-open incumbent (connected, NOT alive) so the caller can take over", async () => {
    const url = startFakeDaemon({ mode: "reply", connected: true, alive: false });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.probeIncumbent(1000)).toEqual({ connected: true, alive: false });
    await client.disconnect();
  });

  test("reports no incumbent when none is attached", async () => {
    const url = startFakeDaemon({ mode: "reply", connected: false, alive: false });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.probeIncumbent(1000)).toEqual({ connected: false, alive: false });
    await client.disconnect();
  });

  test("fails OPEN on a silent (old) daemon that never answers probe_incumbent", async () => {
    const url = startFakeDaemon({ mode: "silent" });
    const client = new DaemonClient(url);
    await client.connect();
    const start = performance.now();
    const result = await client.probeIncumbent(150);
    expect(result).toEqual({ connected: false, alive: false });
    // Resolved via the timeout, not hung.
    expect(performance.now() - start).toBeGreaterThanOrEqual(140);
    await client.disconnect();
  });

  test("fails OPEN if the daemon drops the socket mid-probe", async () => {
    const url = startFakeDaemon({ mode: "close" });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.probeIncumbent(1000)).toEqual({ connected: false, alive: false });
  });

  test("is non-attaching: only `probe_incumbent` is sent, never `claude_connect`", async () => {
    const url = startFakeDaemon({ mode: "reply", connected: true, alive: true });
    const client = new DaemonClient(url);
    await client.connect();
    await client.probeIncumbent(1000);
    expect(received).toContain("probe_incumbent");
    expect(received).not.toContain("claude_connect");
    await client.disconnect();
  });
});
