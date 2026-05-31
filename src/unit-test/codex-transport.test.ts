import { afterEach, describe, expect, test } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { rmSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_TRANSPORT_ENV,
  TcpToUnixRelay,
  codexListenArg,
  codexSocketPath,
  ensureSocketDir,
  parseTransportMode,
  probeCodexWsSupport,
  removeSocketFile,
  resolveCodexTransport,
  stripWebSocketExtensions,
  waitForUnixWsReady,
} from "../codex-transport";

const UPGRADE_WITH_EXT =
  "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n" +
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";

let testCounter = 0;
function tmpSocket(): string {
  // Short, unique per-test socket under tmp (stays well under SUN_LEN).
  return join(tmpdir(), `abg-test-${process.pid}-${testCounter++}.sock`);
}

/**
 * Minimal fake of Codex's unix listener: completes a WS upgrade with HTTP 101
 * ONLY if the request carries no Sec-WebSocket-Extensions (mirroring the real
 * behavior we must work around), then echoes any subsequent bytes. Records the
 * exact header block it received so tests can assert the relay's rewrite.
 */
function startFakeCodexUnix(socketPath: string): Promise<{ server: Server; received: string[] }> {
  const received: string[] = [];
  const server = createServer((sock: Socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    sock.on("data", (d: Buffer) => {
      if (upgraded) { sock.write(d); return; } // echo frames verbatim
      head = Buffer.concat([head, d]);
      const sep = head.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const headers = head.subarray(0, sep).toString("utf8");
      received.push(headers);
      const rest = head.subarray(sep + 4);
      if (/sec-websocket-extensions/i.test(headers)) { sock.destroy(); return; } // mimic codex hard-close
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      upgraded = true;
      if (rest.length) sock.write(rest);
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    removeSocketFile(socketPath);
    server.listen(socketPath, () => resolve({ server, received }));
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* ignore */ }
  }
});

describe("parseTransportMode", () => {
  test("maps known values and defaults unknown/empty to auto", () => {
    expect(parseTransportMode("ws")).toBe("ws");
    expect(parseTransportMode("WS")).toBe("ws");
    expect(parseTransportMode(" unix ")).toBe("unix");
    expect(parseTransportMode("auto")).toBe("auto");
    expect(parseTransportMode("")).toBe("auto");
    expect(parseTransportMode(undefined)).toBe("auto");
    expect(parseTransportMode("garbage")).toBe("auto");
  });
});

describe("probeCodexWsSupport / resolveCodexTransport", () => {
  test("auto → ws when --help advertises ws://", () => {
    const help = () => "Supported values: `stdio://`, `unix://`, `ws://IP:PORT`, `off`";
    expect(probeCodexWsSupport(help)).toBe(true);
    expect(resolveCodexTransport("auto", help)).toBe("ws");
  });

  test("auto → unix when --help omits ws://", () => {
    const help = () => "Supported values: `stdio://`, `unix://`, `off`";
    expect(probeCodexWsSupport(help)).toBe(false);
    expect(resolveCodexTransport("auto", help)).toBe("unix");
  });

  test("auto → ws (preserve current behavior) when the probe is inconclusive", () => {
    expect(probeCodexWsSupport(() => null)).toBe(true);
    expect(resolveCodexTransport("auto", () => null)).toBe("ws");
  });

  test("explicit ws/unix are honored without probing", () => {
    let probed = false;
    const help = () => { probed = true; return "ws://"; };
    expect(resolveCodexTransport("ws", help)).toBe("ws");
    expect(resolveCodexTransport("unix", help)).toBe("unix");
    expect(probed).toBe(false);
  });
});

describe("codexSocketPath", () => {
  test("is per-port, under the SUN_LEN limit, and dir-creatable/removable", () => {
    const p = codexSocketPath(4500, tmpdir());
    expect(p).toContain("codex-4500.sock");
    expect(p.length).toBeLessThan(104);
    const p2 = codexSocketPath(4510, tmpdir());
    expect(p2).not.toBe(p); // distinct per pair/port
    ensureSocketDir(p);
    expect(existsSync(p.slice(0, p.lastIndexOf("/")))).toBe(true);
  });

  test("throws when an absurd TMPDIR would exceed the platform limit", () => {
    const longBase = "/" + "x".repeat(120);
    expect(() => codexSocketPath(4500, longBase)).toThrow(/too long/);
  });
});

describe("ensureSocketDir", () => {
  test("tightens perms to 0700 even on a pre-existing loose dir (CWE-377)", () => {
    const dir = join(tmpdir(), `abg-permtest-${process.pid}-${testCounter++}`);
    const sock = join(dir, "codex.sock");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // Pre-create the dir world-accessible (simulating a squatted/loose /tmp dir).
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    expect(statSync(dir).mode & 0o777).toBe(0o777);

    ensureSocketDir(sock);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("codexListenArg", () => {
  test("renders ws:// and unix:// forms", () => {
    expect(codexListenArg("ws", 4500, "/tmp/x.sock")).toBe("ws://127.0.0.1:4500");
    expect(codexListenArg("unix", 4500, "/tmp/x.sock")).toBe("unix:///tmp/x.sock");
  });
});

describe("stripWebSocketExtensions", () => {
  test("removes only the extensions header (case-insensitive), preserving others", () => {
    const headers = "GET / HTTP/1.1\r\nUpgrade: websocket\r\nSEC-WebSocket-Extensions: permessage-deflate\r\nSec-WebSocket-Key: abc";
    const out = stripWebSocketExtensions(headers);
    expect(out).not.toMatch(/extensions/i);
    expect(out).toContain("Upgrade: websocket");
    expect(out).toContain("Sec-WebSocket-Key: abc");
  });

  test("is a no-op when no extensions header is present", () => {
    const headers = "GET / HTTP/1.1\r\nUpgrade: websocket";
    expect(stripWebSocketExtensions(headers)).toBe(headers);
  });
});

describe("TcpToUnixRelay", () => {
  test("strips Sec-WebSocket-Extensions and forwards a full upgrade + frame echo", async () => {
    const sock = tmpSocket();
    const { server, received } = await startFakeCodexUnix(sock);
    const relay = new TcpToUnixRelay("127.0.0.1", 0, sock);
    await relay.start();
    cleanups.push(() => { relay.stop(); server.close(); removeSocketFile(sock); });

    const result = await new Promise<{ status: string; echo: string }>((resolve, reject) => {
      const client = connect(relay.port, "127.0.0.1", () => client.write(UPGRADE_WITH_EXT));
      let buf = Buffer.alloc(0);
      let status = "";
      client.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const sep = buf.indexOf("\r\n\r\n");
        if (!status && sep !== -1) {
          status = buf.toString("utf8", 0, buf.indexOf("\r\n"));
          buf = buf.subarray(sep + 4);
          client.write("PING-FRAME"); // post-upgrade bytes should echo back
          return;
        }
        if (status && buf.length >= "PING-FRAME".length) {
          resolve({ status, echo: buf.toString("utf8") });
          client.destroy();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("relay round-trip timed out")), 3000);
    });

    expect(result.status).toBe("HTTP/1.1 101 Switching Protocols");
    expect(result.echo).toBe("PING-FRAME");
    // The fake server (which closes on extensions) saw a CLEANED upgrade.
    expect(received).toHaveLength(1);
    expect(received[0]).not.toMatch(/sec-websocket-extensions/i);
    expect(received[0]).toContain("Sec-WebSocket-Key:");
    expect(relay.connectionCount).toBe(1);
  });

  test("start() rejects when the TCP port cannot be bound", async () => {
    const sock = tmpSocket();
    const { server } = await startFakeCodexUnix(sock);
    const blocker = new TcpToUnixRelay("127.0.0.1", 0, sock);
    await blocker.start();
    const port = blocker.port;
    cleanups.push(() => { blocker.stop(); server.close(); removeSocketFile(sock); });

    const conflicting = new TcpToUnixRelay("127.0.0.1", port, sock);
    await expect(conflicting.start()).rejects.toThrow();
  });

  test("stop() tears down live connections and the listener", async () => {
    const sock = tmpSocket();
    const { server } = await startFakeCodexUnix(sock);
    const relay = new TcpToUnixRelay("127.0.0.1", 0, sock);
    await relay.start();
    cleanups.push(() => { server.close(); removeSocketFile(sock); });

    const client = connect(relay.port, "127.0.0.1");
    await new Promise<void>((r) => client.once("connect", () => r()));
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.connectionCount).toBe(1);

    relay.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(relay.connectionCount).toBe(0);
    client.destroy();
  });
});

describe("waitForUnixWsReady", () => {
  test("resolves once the unix listener answers an upgrade with 101", async () => {
    const sock = tmpSocket();
    const { server } = await startFakeCodexUnix(sock);
    cleanups.push(() => { server.close(); removeSocketFile(sock); });
    await waitForUnixWsReady(sock, 10, 50); // should resolve quickly
  });

  test("rejects when no listener ever appears", async () => {
    const sock = tmpSocket(); // nothing listening here
    await expect(waitForUnixWsReady(sock, 3, 30)).rejects.toThrow(/did not become ready/);
  });
});
