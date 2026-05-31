/**
 * Codex transport selection + TCP↔AF_UNIX relay (#85).
 *
 * Background: the adapter always connects to the Codex app-server with
 * `new WebSocket(ws://127.0.0.1:<appPort>)`. Some Codex builds drop `ws://`
 * from `app-server --listen` (removed in 0.131.0-alpha.9, restored in 0.131.0
 * stable / present in 0.135.0), while `unix://` works across versions.
 *
 * To keep the adapter (and its secondary "picker" connections) byte-for-byte
 * unchanged when only a unix socket is available, we run a transparent
 * TCP↔AF_UNIX relay: a `net` server listens on 127.0.0.1:<appPort> and forwards
 * raw bytes to/from the Codex unix socket. The WebSocket upgrade + frames pass
 * through, with ONE rewrite: the relay strips the `Sec-WebSocket-Extensions`
 * header from the client's upgrade request, because Bun's `new WebSocket()`
 * always offers `permessage-deflate` and Codex's unix listener closes the
 * connection on that offer (verified empirically against codex 0.135.0).
 *
 * Verified facts (codex 0.135.0, see scripts/probe-codex-unix*.mjs):
 *   - `--listen` supports stdio:// (default), unix://, unix://PATH, ws://IP:PORT, off.
 *   - The unix listener speaks WebSocket (HTTP 101 upgrade), NOT raw/LSP JSON-RPC.
 *   - The unix listener does NOT serve the HTTP `/healthz` endpoint → unix-mode
 *     readiness is a WS-upgrade probe, not an HTTP fetch.
 *
 * stdio transport is intentionally deferred: the adapter opens a primary plus
 * several picker WebSocket connections, which a single stdio stream cannot model.
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** How the adapter reaches the Codex app-server. */
export type CodexTransport = "ws" | "unix";

/** User-facing selection, including `auto` (probe + fall back). */
export type CodexTransportMode = "auto" | "ws" | "unix";

export const CODEX_TRANSPORT_ENV = "AGENTBRIDGE_CODEX_TRANSPORT";

const HEADER_SEP = "\r\n\r\n";
const EXTENSIONS_HEADER_RE = /^sec-websocket-extensions:/i;
/** Cap on buffered upgrade-header bytes before we give up rewriting and pass through. */
const MAX_UPGRADE_HEADER_BYTES = 64 * 1024;

/**
 * Parse the transport mode from an env value. Unknown / empty → `auto`.
 * Accepts case-insensitively so `WS`/`Unix`/`AUTO` all work.
 */
export function parseTransportMode(raw: string | undefined): CodexTransportMode {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "ws":
      return "ws";
    case "unix":
      return "unix";
    case "auto":
    case "":
      return "auto";
    default:
      return "auto";
  }
}

/**
 * Detect whether this Codex build still supports `ws://` for `app-server
 * --listen` by parsing `codex app-server --help`. Returns true if the help text
 * advertises `ws://`. If the probe cannot run (codex missing/erroring), returns
 * `true` so `auto` preserves today's ws behavior rather than switching paths on
 * a broken install.
 */
export function probeCodexWsSupport(
  runHelp: () => string | null = defaultRunCodexAppServerHelp,
): boolean {
  const help = runHelp();
  if (help === null) return true; // inconclusive → keep current (ws) behavior
  return help.includes("ws://");
}

function defaultRunCodexAppServerHelp(): string | null {
  try {
    const res = spawnSync("codex", ["app-server", "--help"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (res.error || typeof res.stdout !== "string") return null;
    return res.stdout + (res.stderr ?? "");
  } catch {
    return null;
  }
}

/**
 * Resolve a concrete transport from a mode. `auto` probes ws support and falls
 * back to `unix`. `ws`/`unix` are honored as-is (no probe).
 */
export function resolveCodexTransport(
  mode: CodexTransportMode,
  runHelp: () => string | null = defaultRunCodexAppServerHelp,
): CodexTransport {
  if (mode === "ws") return "ws";
  if (mode === "unix") return "unix";
  return probeCodexWsSupport(runHelp) ? "ws" : "unix";
}

/**
 * Short, per-user, per-port unix socket path that stays under the macOS
 * `sun_path` limit (~104 bytes incl. NUL). We deliberately avoid the platform
 * state dir (which can be a long "~/Library/Application Support/…" path) and
 * use a uid-scoped dir under the OS temp dir instead.
 *
 * Layout: <tmp>/agentbridge-<uid>/codex-<appPort>.sock
 * The appPort is unique per pair (slot N → 4500 + N*10), so distinct pairs get
 * distinct sockets without any extra hashing.
 */
export function codexSocketPath(appPort: number, baseTmpDir: string = tmpdir()): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = join(baseTmpDir, `agentbridge-${uid}`);
  const path = join(dir, `codex-${appPort}.sock`);
  if (path.length >= 104) {
    throw new Error(
      `Codex unix socket path is too long for the platform (${path.length} >= 104): ${path}. ` +
      `Set a shorter TMPDIR or use ${CODEX_TRANSPORT_ENV}=ws.`,
    );
  }
  return path;
}

/** Ensure the parent dir of a socket exists with owner-only perms (0700). */
export function ensureSocketDir(socketPath: string): void {
  const dir = socketPath.slice(0, socketPath.lastIndexOf("/"));
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` only applies when the dir is CREATED. Enforce owner-only
  // perms even if it pre-existed with looser permissions (CWE-377: the path is
  // predictable under /tmp). If we cannot chmod it — e.g. another local user
  // owns a squatted dir — fail loudly rather than expose Codex's control socket.
  try {
    chmodSync(dir, 0o700);
  } catch (err) {
    throw new Error(
      `Refusing to use Codex socket dir ${dir}: cannot enforce 0700 perms ` +
      `(${(err as Error).message}). Remove it or set a private TMPDIR.`,
    );
  }
}

/** Remove a stale socket file (best-effort; ignores if already gone). */
export function removeSocketFile(socketPath: string): void {
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // best-effort cleanup
  }
}

/** The `--listen` argument value for a given transport. */
export function codexListenArg(transport: CodexTransport, appPort: number, socketPath: string): string {
  return transport === "unix" ? `unix://${socketPath}` : `ws://127.0.0.1:${appPort}`;
}

/**
 * Strip the `Sec-WebSocket-Extensions` header line from an HTTP upgrade request
 * header block (the text before the first CRLFCRLF). Returns the cleaned header
 * text (without the trailing separator). Other headers are preserved verbatim.
 */
export function stripWebSocketExtensions(headerBlock: string): string {
  return headerBlock
    .split("\r\n")
    .filter((line) => !EXTENSIONS_HEADER_RE.test(line))
    .join("\r\n");
}

/**
 * Transparent TCP→AF_UNIX relay. Listens on `tcpHost:tcpPort` and forwards each
 * accepted TCP connection to a fresh unix-socket connection. The only rewrite is
 * stripping `Sec-WebSocket-Extensions` from the upgrade request (see file header);
 * everything else — WS frames in both directions — is byte-for-byte verbatim.
 * One unix connection per inbound TCP connection (primary + N pickers).
 */
export class TcpToUnixRelay {
  private server: Server | null = null;
  private readonly pairs = new Set<{ tcp: Socket; unix: Socket }>();

  constructor(
    private readonly tcpHost: string,
    private readonly tcpPort: number,
    private readonly unixPath: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Start listening. Rejects if the TCP port cannot be bound. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((tcp) => this.handleConnection(tcp));
      const onListenError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onListenError);
        // Post-listen errors must never throw: log and keep serving.
        server.on("error", (err) => this.log(`relay server error: ${err.message}`));
        this.server = server;
        resolve();
      };
      server.once("error", onListenError);
      server.once("listening", onListening);
      server.listen(this.tcpPort, this.tcpHost);
    });
  }

  private handleConnection(tcp: Socket): void {
    const unix = connect(this.unixPath);
    const pair = { tcp, unix };
    this.pairs.add(pair);

    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      this.pairs.delete(pair);
      tcp.destroy();
      unix.destroy();
    };

    // C→S: intercept ONLY the first HTTP header block to strip
    // Sec-WebSocket-Extensions, then hand the rest to pipe() (which gives us
    // backpressure for free). S→C is always verbatim.
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf(HEADER_SEP);
      if (sep === -1) {
        // Not a complete header block yet. If it grows implausibly large it is
        // not an HTTP upgrade — stop rewriting and pass everything through.
        if (head.length > MAX_UPGRADE_HEADER_BYTES) {
          tcp.removeListener("data", onData);
          unix.write(head);
          head = Buffer.alloc(0);
          tcp.pipe(unix);
        }
        return;
      }
      tcp.removeListener("data", onData);
      const headers = head.subarray(0, sep).toString("utf8");
      const rest = head.subarray(sep + HEADER_SEP.length);
      unix.write(stripWebSocketExtensions(headers) + HEADER_SEP);
      head = Buffer.alloc(0);
      // Put any post-header bytes back so pipe() forwards them in order with
      // proper backpressure.
      if (rest.length) tcp.unshift(rest);
      tcp.pipe(unix);
    };
    tcp.on("data", onData);
    unix.pipe(tcp);

    tcp.on("error", (e) => { this.log(`relay tcp error: ${e.message}`); teardown(); });
    unix.on("error", (e) => { this.log(`relay unix error: ${e.message}`); teardown(); });
    tcp.on("close", teardown);
    unix.on("close", teardown);
  }

  /** Number of live relayed connection pairs (for tests/diagnostics). */
  get connectionCount(): number {
    return this.pairs.size;
  }

  /** The actually-bound TCP port (resolves an ephemeral `tcpPort=0` after start). */
  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : this.tcpPort;
  }

  /** Stop listening and tear down all live relayed connections. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const { tcp, unix } of this.pairs) {
      tcp.destroy();
      unix.destroy();
    }
    this.pairs.clear();
  }
}

/**
 * Readiness probe for unix transport: the Codex unix listener does NOT serve
 * HTTP `/healthz`, so we instead attempt a WebSocket upgrade directly against
 * the unix socket and treat an HTTP 101 as "ready". Retries until the listener
 * is up. Resolves on success, rejects after exhausting retries.
 */
export async function waitForUnixWsReady(
  socketPath: string,
  maxRetries = 40,
  delayMs = 250,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (await attemptUnixWsUpgrade(socketPath)) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Codex unix app-server at ${socketPath} did not become ready`);
}

/** Single WS-upgrade attempt against a unix socket. Resolves true on HTTP 101. */
function attemptUnixWsUpgrade(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    const socket = connect(socketPath, () => {
      // A fixed sample key — we never read frames, only the status line, so the
      // accept value does not need verifying. No extensions offered (see strip).
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("\r\n")) done(buf.startsWith("HTTP/1.1 101"));
    });
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}
