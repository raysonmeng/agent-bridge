/**
 * `abg broker start` — run the always-on control-plane broker (§11.1).
 *
 * Opens the local collab Store (shared with `abg auth login`), authenticates
 * connections by PSK, and routes Envelopes. Binds a configurable host (default
 * loopback; for Tailscale pass the 100.x address, never 0.0.0.0 — §7.3).
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Broker, DEFAULT_BROKER_PORT } from "../broker";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { startBrokerWeb, DEFAULT_DASHBOARD_PORT } from "../broker-web";
import { readAuthToken, resolveDbPath } from "../collab-store";
import { detectTailscale, localIPv4s, buildConnectionCard } from "../net-detect";

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

/** Best-effort: open `url` in the default browser. Never throws (a headless host just won't open). */
function openBrowser(url: string, log: (m: string) => void): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch (e) {
    log(`无法自动打开浏览器：${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runBrokerStart(argv: string[]): Promise<void> {
  let host = "127.0.0.1";
  let port = DEFAULT_BROKER_PORT;
  let db: string | undefined;
  let webPort = DEFAULT_DASHBOARD_PORT;
  let web = true;
  let autoOpen = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--host") host = argv[++i] ?? host;
    else if (a.startsWith("--host=")) host = a.slice("--host=".length);
    else if (a === "--port") port = parseInt(argv[++i] ?? "", 10);
    else if (a.startsWith("--port=")) port = parseInt(a.slice("--port=".length), 10);
    else if (a === "--db") db = argv[++i];
    else if (a.startsWith("--db=")) db = a.slice("--db=".length);
    else if (a === "--web-port") webPort = parseInt(argv[++i] ?? "", 10);
    else if (a.startsWith("--web-port=")) webPort = parseInt(a.slice("--web-port=".length), 10);
    else if (a === "--no-web") web = false;
    else if (a === "--no-open") autoOpen = false;
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`无效的 --port：${port}`);
    process.exit(1);
    return;
  }
  if (web && (!Number.isInteger(webPort) || webPort < 0 || webPort > 65535)) {
    console.error(`无效的 --web-port：${webPort}`);
    process.exit(1);
    return;
  }
  const bind = resolveBindHost(host);
  if (bind.warning) console.error(bind.warning);

  const dbPath = resolveDbPath(db);
  const dir = dirname(dbPath);
  // Same 0700 lockdown as `abg auth login`: the collab DB holds PSK tokens (hashed at rest §11.3) + identity PII.
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

  // Graceful shutdown (§8.2): register IMMEDIATELY after bind — BEFORE the slow
  // connectivity probe / web startup below — so a SIGTERM/Ctrl-C arriving right after
  // the "已启动" line is handled (exit 0) rather than left to the default signal (kill).
  // The handler reads `webHandle` lazily; if a signal beats web startup it's a no-op.
  // db.close() checkpoints the WAL so pending_deliveries survive the restart. `once`
  // so a second signal during teardown doesn't re-enter; exit 0 even if close() rejects.
  let webHandle: { url: string; stop(): void } | undefined;
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[broker] ${sig} 收到，正在优雅关闭…`);
    // Ordered teardown: web first (stop accepting requests), then broker (drain in-flight WS),
    // then store (WAL checkpoint). Failures must not prevent process.exit(0).
    // ponytail: 10s force-exit is a safety valve against Bun.serve.stop() hanging;
    // upgrade to configurable --shutdown-timeout if operational needs arise.
    void (async () => {
      const forceExit = setTimeout(() => {
        console.error("[broker] 关闭超时（10s），强制退出");
        process.exit(1);
      }, 10_000);
      try {
        webHandle?.stop();
        await broker.stop();
        await store.close();
      } catch (e) {
        console.error(`[broker] 关闭出错：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    })();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // Connectivity card (§ cross-network onboarding): detect Tailscale/LAN reach and
  // print the exact connect command to hand a collaborator. Detection only — never
  // auto-install or auto-invite (user decision: detect + guide).
  try {
    const card = buildConnectionCard({
      bindHost: bind.host,
      brokerPort: bound.port,
      tailscale: await detectTailscale(),
      lanIps: localIPv4s(),
    });
    console.log("");
    console.log("📡 网络可达性 / 邀请协作者：");
    for (const line of card.lines) console.log(line);
  } catch {
    // detection is best-effort; never block broker startup
  }

  // Local admin dashboard (§ web console): a LOOPBACK-ONLY Bun.serve on its own
  // port to view rooms/members/whiteboards + create a room from a browser. Never
  // bound to the broker's public interface (that would be an unauthenticated admin
  // console). For remote viewing: SSH-forward this port or `tailscale serve` it.
  if (web) {
    // Fail-inert: the dashboard is a convenience. If its port is taken or it fails
    // to bind, log and keep the broker running — never let it take down the broker.
    try {
      const token = readAuthToken(dbPath);
      const createdBy = token ? await store.resolveToken(token) : null;
      webHandle = startBrokerWeb({ store, port: webPort, createdBy, log: (m) => console.error(`[web] ${m}`) });
      console.log(`管理面板（仅本机）：${webHandle.url}`);
      if (!createdBy) console.log("（未登录：面板可查看，建房需先 abg auth login）");
      const isSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY);
      if (autoOpen && !isSsh) openBrowser(webHandle.url, (m) => console.error(`[web] ${m}`));
      else if (isSsh) console.log("检测到 SSH 会话，未自动打开浏览器；远程访问请 SSH 端口转发或 tailscale serve 该端口。");
    } catch (e) {
      console.error(`[web] 管理面板启动失败（不影响 broker）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
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
      console.error(
        "用法：abg broker start [--host <ip>] [--port <n>] [--db <path>] [--web-port <n>] [--no-web] [--no-open]",
      );
      process.exit(1);
  }
}
