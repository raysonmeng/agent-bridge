/**
 * `abg broker start` — run the always-on control-plane broker (§11.1).
 *
 * Opens the local collab Store (shared with `abg auth login`), authenticates
 * connections by PSK, and routes Envelopes. Binds a configurable host (default
 * loopback; for Tailscale pass the 100.x address, never 0.0.0.0 — §7.3).
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Broker, DEFAULT_BROKER_PORT } from "../broker";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { StateDirResolver } from "../state-dir";

function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTBRIDGE_COLLAB_DB;
  if (env && env.length > 0) return env;
  return join(new StateDirResolver().dir, "collab.db");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * True iff `host` is in the Tailscale CGNAT range 100.64.0.0/10 (second octet
 * 64–127). A bare `/^100\./` would wrongly silence the warning for PUBLIC 100.x
 * addresses (e.g. 100.0.x / 100.200.x) that are NOT Tailscale.
 */
function isTailscaleCgnat(host: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(host);
  if (!m) return false;
  const octet = Number(m[1]);
  return octet >= 64 && octet <= 127;
}

/**
 * Normalise the bind host and decide whether to warn (§7.3). Empty → loopback (a
 * malformed/unset `--host` must NOT silently bind all interfaces) and is therefore
 * SILENT (no warning). Warn on any other non-loopback, non-Tailscale address — a
 * WHITELIST, so `0.0.0.0` / `::` / a LAN IP / a public 100.x all surface the
 * exposure warning (the prior `=== "0.0.0.0"` blacklist missed `::` and a bare LAN IP).
 */
export function resolveBindHost(raw: string): { host: string; warning: string | null } {
  const host = raw === "" ? "127.0.0.1" : raw;
  if (LOOPBACK_HOSTS.has(host) || isTailscaleCgnat(host)) return { host, warning: null };
  return {
    host,
    warning:
      "⚠️ 绑定非 loopback 地址会把 broker 暴露给物理 LAN/WiFi。跨网请绑 Tailscale 的 100.x 地址（§7.3）。",
  };
}

export async function runBrokerStart(argv: string[]): Promise<void> {
  let host = "127.0.0.1";
  let port = DEFAULT_BROKER_PORT;
  let db: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--host") host = argv[++i] ?? host;
    else if (a.startsWith("--host=")) host = a.slice("--host=".length);
    else if (a === "--port") port = parseInt(argv[++i] ?? "", 10);
    else if (a.startsWith("--port=")) port = parseInt(a.slice("--port=".length), 10);
    else if (a === "--db") db = argv[++i];
    else if (a.startsWith("--db=")) db = a.slice("--db=".length);
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`无效的 --port：${port}`);
    process.exit(1);
    return;
  }
  const bind = resolveBindHost(host);
  if (bind.warning) console.error(bind.warning);

  const dbPath = resolveDbPath(db);
  const dir = dirname(dbPath);
  // Same 0700 lockdown as `abg auth login`: the collab DB holds raw PSK tokens + PII.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const store = new SqliteStore(dbPath);
  const broker = new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: bind.host,
    port,
    log: (m) => console.error(`[broker] ${m}`),
  });
  const bound = broker.start();
  console.log(`AgentBridge broker 已启动，监听 ${bound.host}:${bound.port}`);
  console.log(`协作数据库：${dbPath}`);
  console.log("用 abg auth login 签发的 token 连接；Ctrl-C 停止。");

  // Graceful shutdown (§8.2): on SIGTERM/SIGINT, stop the server then close the
  // Store — db.close() checkpoints the WAL so pending_deliveries survive the
  // restart and a reconnecting member can still drain them. `once` so a second
  // signal during teardown doesn't re-enter; exit 0 even if close() rejects.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[broker] ${sig} 收到，正在优雅关闭…`);
    broker.stop();
    store.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  // Bun.serve keeps the event loop alive — the process stays up until a signal.
}

export async function runBroker(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "start":
      await runBrokerStart(args.slice(1));
      break;
    default:
      console.error(`未知的 broker 子命令：${sub ?? "(空)"}`);
      console.error("用法：abg broker start [--host <ip>] [--port <n>] [--db <path>]");
      process.exit(1);
  }
}
