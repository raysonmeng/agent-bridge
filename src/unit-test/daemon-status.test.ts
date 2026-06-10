import { afterEach, describe, expect, test } from "bun:test";

import { fetchDaemonStatus } from "../daemon-status";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  if (server) {
    server.stop(true);
    server = null;
  }
});

describe("fetchDaemonStatus", () => {
  test("fetches daemon status from /readyz as well as /healthz", async () => {
    const requestedPaths: string[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestedPaths.push(url.pathname);
        return Response.json({
          bridgeReady: url.pathname === "/readyz",
          tuiConnected: false,
          threadId: null,
          queuedMessageCount: 0,
          proxyUrl: "ws://127.0.0.1:4501",
          appServerUrl: "ws://127.0.0.1:4500",
          pid: 123,
          pairId: url.pathname,
        });
      },
    });

    const port = server.port;
    if (port === undefined) throw new Error("expected Bun.serve to assign a port");

    const health = await fetchDaemonStatus(port, "/healthz");
    const ready = await fetchDaemonStatus(port, "/readyz");

    expect(health?.pairId).toBe("/healthz");
    expect(ready?.bridgeReady).toBe(true);
    expect(requestedPaths).toEqual(["/healthz", "/readyz"]);
  });

  test("returns null for non-2xx daemon status responses", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not ready", { status: 503 });
      },
    });

    const port = server.port;
    if (port === undefined) throw new Error("expected Bun.serve to assign a port");

    expect(await fetchDaemonStatus(port, "/readyz")).toBeNull();
  });

  test("returns null when the daemon status request times out", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });

    const port = server.port;
    if (port === undefined) throw new Error("expected Bun.serve to assign a port");

    expect(await fetchDaemonStatus(port, "/healthz", 10)).toBeNull();
  });
});
