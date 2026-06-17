import { afterEach, describe, expect, test } from "bun:test";
import { DaemonClient } from "../daemon-client";

/**
 * Unit coverage for the on-demand budget refresh round-trip
 * (DaemonClient.requestBudgetRefresh ↔ daemon `request_budget_refresh` /
 * `budget_refresh`). Drives the client against a fake control WS so the
 * requestId-correlation (straggler-drop) and fail-open paths are exercised
 * without a real daemon.
 */

interface FakeServerOptions {
  /**
   * "reply": echo the request's requestId. "wrong-id": answer with a DIFFERENT
   * requestId (simulating a straggler reply from a timed-out earlier request).
   * "silent": never answer.
   */
  mode: "reply" | "wrong-id" | "silent";
  snapshot?: unknown;
}

let server: ReturnType<typeof Bun.serve> | null = null;

function startFakeDaemon(opts: FakeServerOptions): string {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : raw.toString();
        let msg: { type?: string; requestId?: string };
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.type !== "request_budget_refresh") return;
        if (opts.mode === "silent") return;
        const requestId = opts.mode === "wrong-id" ? "stale-straggler-id" : (msg.requestId ?? "");
        ws.send(JSON.stringify({ type: "budget_refresh", requestId, snapshot: opts.snapshot ?? null }));
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

// A full BudgetSnapshot stand-in; the client passes it through verbatim.
const SNAP = {
  phase: "normal" as const,
  updatedAt: 1_780_000_000,
  claude: null,
  codex: null,
  driftPct: 0,
  paused: false,
  gateClosed: false,
  pauseSide: null,
  pauseReason: null,
  resumeAfterEpoch: null,
  parallelRecommended: false,
  codexTier: "full" as const,
  claudeAdvice: null,
};

describe("DaemonClient.requestBudgetRefresh", () => {
  test("returns the snapshot when the daemon echoes the matching requestId", async () => {
    const url = startFakeDaemon({ mode: "reply", snapshot: SNAP });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.requestBudgetRefresh(1000)).toEqual(SNAP);
    await client.disconnect();
  });

  test("returns null when the daemon reports no snapshot (coordinator unavailable)", async () => {
    const url = startFakeDaemon({ mode: "reply", snapshot: null });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.requestBudgetRefresh(1000)).toBeNull();
    await client.disconnect();
  });

  test("IGNORES a reply whose requestId does not match (straggler) → fails open via timeout", async () => {
    const url = startFakeDaemon({ mode: "wrong-id", snapshot: SNAP });
    const client = new DaemonClient(url);
    await client.connect();
    const start = performance.now();
    const result = await client.requestBudgetRefresh(150);
    expect(result).toBeNull(); // mismatched reply ignored → waiter times out, never mis-settled
    expect(performance.now() - start).toBeGreaterThanOrEqual(140);
    await client.disconnect();
  });

  test("fails OPEN (null) on a silent daemon that never answers", async () => {
    const url = startFakeDaemon({ mode: "silent" });
    const client = new DaemonClient(url);
    await client.connect();
    expect(await client.requestBudgetRefresh(150)).toBeNull();
    await client.disconnect();
  });
});
