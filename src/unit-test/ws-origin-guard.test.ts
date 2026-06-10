import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import {
  isAllowedWsUpgrade,
  parseAllowedWsOrigins,
  wsOriginRejectedResponse,
} from "../ws-origin-guard";

// ── helpers ─────────────────────────────────────────────────────────────────

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1/ws", { headers });
}

const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

function upgradeHandshake(origin: string | null): string {
  const originLine = origin === null ? "" : `Origin: ${origin}\r\n`;
  return (
    "GET /ws HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    `Sec-WebSocket-Key: ${WS_KEY}\r\n` +
    originLine +
    "\r\n"
  );
}

/**
 * Drive a raw HTTP WS-upgrade handshake against a port and return the first
 * status line of the response. Sending a raw socket (not `new WebSocket`) is
 * the only way to attach an arbitrary Origin header to the upgrade — a browser
 * always sends one, but the JS WebSocket constructor does not let us set it.
 */
function rawUpgradeStatus(port: number, origin: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, "127.0.0.1", () => {
      sock.write(upgradeHandshake(origin));
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("raw upgrade timeout"));
    }, 5000);
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl !== -1) {
        clearTimeout(timer);
        sock.destroy();
        resolve(buf.slice(0, nl));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── pure-function policy unit tests ─────────────────────────────────────────

describe("isAllowedWsUpgrade — default strict policy", () => {
  test("absent Origin header → allowed (legitimate CLI / Bun WebSocket)", () => {
    expect(isAllowedWsUpgrade(reqWithHeaders({}))).toBe(true);
  });

  test("empty-string Origin → allowed (Bun may surface '')", () => {
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "" }))).toBe(true);
  });

  test("present non-empty Origin → rejected (browser CSWSH)", () => {
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "http://evil.example" }))).toBe(false);
  });

  test("present Origin from a real browser localhost page → rejected by default", () => {
    // Even a localhost page is rejected when no allowlist is configured: a
    // malicious page served from any localhost port must not be trusted.
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "http://localhost:3000" }))).toBe(false);
  });
});

describe("isAllowedWsUpgrade — explicit allowlist", () => {
  test("a listed Origin is permitted, an unlisted one still rejected", () => {
    const allow = new Set(["app://agentbridge"]);
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "app://agentbridge" }), allow)).toBe(true);
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "http://evil.example" }), allow)).toBe(false);
  });

  test("allowlist never blocks the no-Origin path", () => {
    const allow = new Set(["app://agentbridge"]);
    expect(isAllowedWsUpgrade(reqWithHeaders({}), allow)).toBe(true);
  });

  test("exact-match only — a near-miss Origin is rejected", () => {
    const allow = new Set(["https://app.example"]);
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "https://app.example.evil.com" }), allow)).toBe(false);
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "http://app.example" }), allow)).toBe(false);
  });
});

describe("parseAllowedWsOrigins", () => {
  test("absent env → empty allowlist (strict no-Origin-only default)", () => {
    expect(parseAllowedWsOrigins({}).size).toBe(0);
    expect(parseAllowedWsOrigins({ AGENTBRIDGE_WS_ALLOWED_ORIGINS: "" }).size).toBe(0);
  });

  test("comma-separated env is parsed, trimmed, and empties dropped", () => {
    const set = parseAllowedWsOrigins({
      AGENTBRIDGE_WS_ALLOWED_ORIGINS: " app://a , https://b.example ,, ",
    });
    expect([...set].sort()).toEqual(["app://a", "https://b.example"]);
  });

  test("env allowlist drives isAllowedWsUpgrade end to end", () => {
    const allow = parseAllowedWsOrigins({ AGENTBRIDGE_WS_ALLOWED_ORIGINS: "app://ok" });
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "app://ok" }), allow)).toBe(true);
    expect(isAllowedWsUpgrade(reqWithHeaders({ Origin: "app://nope" }), allow)).toBe(false);
  });
});

describe("wsOriginRejectedResponse", () => {
  test("is an HTTP 403", () => {
    expect(wsOriginRejectedResponse().status).toBe(403);
  });
});

// ── integration: a Bun.serve wired exactly like production gates the upgrade ──

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  while (servers.length) {
    try {
      servers.pop()!.stop(true);
    } catch {
      /* ignore */
    }
  }
});

/**
 * Stand up a Bun.serve whose fetch handler mirrors BOTH production WS servers:
 * a plain GET /healthz that must keep working, and a /ws upgrade that is gated
 * by the shared guard. This is the structural contract both daemon.ts and
 * codex-adapter.ts now share, exercised with real sockets.
 */
function startGuardedServer(): { server: ReturnType<typeof Bun.serve>; port: number } {
  const server = Bun.serve<{ ok: true }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response("ok");
      }
      if (url.pathname === "/ws") {
        if (!isAllowedWsUpgrade(req)) {
          return wsOriginRejectedResponse();
        }
        if (srv.upgrade(req, { data: { ok: true } })) return undefined;
      }
      return new Response("fallback");
    },
    websocket: {
      open() {},
      message() {},
    },
  });
  servers.push(server);
  // server.port is always a concrete number once Bun.serve returns.
  return { server, port: server.port as number };
}

describe("WS upgrade gating over a real socket", () => {
  test("upgrade WITHOUT Origin completes the 101 handshake (legit CLI path)", async () => {
    const server = startGuardedServer();
    const status = await rawUpgradeStatus(server.port, null);
    expect(status).toContain("101");
  });

  test("upgrade WITH a browser Origin is rejected 403, not upgraded", async () => {
    const server = startGuardedServer();
    const status = await rawUpgradeStatus(server.port, "http://evil.example");
    expect(status).toContain("403");
    expect(status).not.toContain("101");
  });

  test("GET /healthz is never gated (plain HTTP, not an upgrade)", async () => {
    const server = startGuardedServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("the legit global `new WebSocket` connects (sends no Origin)", async () => {
    const server = startGuardedServer();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("ws connection rejected"));
      };
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
