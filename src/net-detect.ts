/**
 * net-detect.ts — 网络可达性检测 + 连接卡生成（纯只读，无副作用除 tailscale 子命令）
 * 供 `abg broker start` 打印「邀请别人加入的连接命令」，以及 join 侧探测 broker 可达性。
 */

import { networkInterfaces } from "os";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  ipv4: string | null;
  backendState: string | null;
}

export interface ConnectionCard {
  primary: string | null;
  lines: string[];
}

// ── 内部工具 ─────────────────────────────────────────────────────────────────

/**
 * True iff `host` 在 Tailscale CGNAT 段 100.64.0.0/10（second octet 64–127）。
 * ponytail: 与 cli/broker.ts 中同名函数复制而非 import，避免循环耦合。
 */
function isTailscaleCgnat(host: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(host);
  if (!m) return false;
  const octet = Number(m[1]);
  return octet >= 64 && octet <= 127;
}

/** 是否是「具体可路由」地址（非 loopback、非全绑、非空）。 */
function isPrimaryCandidate(host: string): boolean {
  if (!host) return false;
  if (new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"]).has(host)) return false;
  if (/^127\./.test(host)) return false;
  return true;
}

// ── detectTailscale ──────────────────────────────────────────────────────────

const NULL_TS: TailscaleStatus = { installed: false, running: false, ipv4: null, backendState: null };

/**
 * Spawn `tailscale status --json`，解析输出。
 * 命令不存在 / 超时(2s) / 非法 JSON / 任何错 → 返回 NULL_TS。绝不抛。
 */
export async function detectTailscale(): Promise<TailscaleStatus> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });

    const textP = new Response(proc.stdout).text();
    // ponytail: race + kill 作为 2s 超时；kill 让 stdout 关闭，textP 随即 resolve。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        reject(new Error("timeout"));
      }, 2000);
    });

    const text = await Promise.race([textP, timeoutP]);
    if (timer) clearTimeout(timer); // textP won — don't leak the 2s timer
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return NULL_TS;

    const p = parsed as Record<string, unknown>;
    const backendState = typeof p.BackendState === "string" ? p.BackendState : null;
    const running = backendState === "Running";
    const selfIps: unknown = (p.Self as Record<string, unknown> | undefined)?.TailscaleIPs;
    const ips: string[] = Array.isArray(selfIps) ? (selfIps as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const ipv4 = ips.find(isTailscaleCgnat) ?? null;

    return { installed: true, running, ipv4, backendState };
  } catch {
    return NULL_TS;
  }
}

// ── localIPv4s ───────────────────────────────────────────────────────────────

/** os.networkInterfaces() 中所有非 internal、family IPv4、非 127.x 地址（去重）。 */
export function localIPv4s(): string[] {
  const seen = new Set<string>();
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.family === "IPv4" && !iface.address.startsWith("127.")) {
        seen.add(iface.address);
      }
    }
  }
  return [...seen];
}

// ── buildConnectionCard ──────────────────────────────────────────────────────

/**
 * 生成 `abg broker start` 要打印的「连接卡」行。
 *
 * 主地址优先级：
 *   tailscale.running&&ipv4 → 100.x（跨网就绪）
 *   > bindHost 若是具体可路由地址
 *   > lanIps[0]（仅局域网，带提示）
 *   > null（仅本机 loopback，带提示）
 */
export function buildConnectionCard(opts: {
  bindHost: string;
  brokerPort: number;
  tailscale: TailscaleStatus;
  lanIps: string[];
}): ConnectionCard {
  const { bindHost, brokerPort, tailscale, lanIps } = opts;

  // ── 选 primary ──
  let primary: string | null = null;
  if (tailscale.running && tailscale.ipv4) {
    primary = tailscale.ipv4;
  } else if (isPrimaryCandidate(bindHost)) {
    primary = bindHost;
  } else if (lanIps.length > 0) {
    primary = lanIps[0]!;
  }

  const lines: string[] = [];

  // ── 地址清单 ──
  if (tailscale.running && tailscale.ipv4) {
    lines.push(`  Tailscale:  ${tailscale.ipv4}  ✅ 跨网就绪`);
  } else if (tailscale.installed) {
    lines.push(`  Tailscale:  未运行（${tailscale.backendState ?? "未知状态"}）`);
  } else {
    lines.push("  Tailscale:  未安装");
  }
  if (lanIps.length > 0) {
    lines.push(`  局域网:    ${lanIps.join(", ")}  （仅局域网可达）`);
  }
  lines.push(`  本机:      ${bindHost || "127.0.0.1"}  （仅本机）`);

  // ── 协作者命令块 ──
  lines.push("");
  lines.push("── 把下面的命令发给协作者 ──────────────────────────");
  if (primary) {
    lines.push(`  export AGENTBRIDGE_BROKER_URL=ws://${primary}:${brokerPort}/ws`);
  } else {
    lines.push(`  # ⚠️ broker 只本机可达，跨机请先绑定可路由地址（见下方指引）`);
    lines.push(`  export AGENTBRIDGE_BROKER_URL=ws://127.0.0.1:${brokerPort}/ws`);
  }
  lines.push("  abg auth login --token <带外分发的 PSK>");
  lines.push("  abg join <roomId>");

  // ── Tailscale 未运行指引 ──
  if (!tailscale.running) {
    lines.push("");
    lines.push("── 对方没装 Tailscale？────────────────────────────");
    lines.push("  1. 安装（对方自行确认并执行）：");
    lines.push("     curl -fsSL https://tailscale.com/install.sh | sh");
    lines.push("  2. 加入你的 tailnet（二选一）：");
    lines.push("     • 管理员在 https://login.tailscale.com 发邀请链接");
    lines.push("     • tailscale up --authkey=<在管理面板生成的 pre-auth key>");
  }

  // ── 仅 loopback 额外提示 ──
  if (!primary) {
    lines.push("");
    lines.push("  ⚠️ broker 只本机可达，跨机需 --host 绑 Tailscale 100.x 或局域网 IP");
  }

  return { primary, lines };
}

// ── probeBroker ──────────────────────────────────────────────────────────────

/**
 * join 侧探测：尝试 WS 连 url，成功返回 ok:true。
 * 失败按现象给中文 hint。绝不抛。
 */
export async function probeBroker(
  url: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; hint: string | null }> {
  const hostMatch = /^wss?:\/\/([^/:]+)/.exec(url);
  const host = hostMatch?.[1] ?? "";

  // 提前查本机 Tailscale 状态，供 hint 分支判断
  const ts = await detectTailscale();

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, hint: string | null): void => {
      if (done) return;
      done = true;
      resolve({ ok, hint });
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      finish(false, "连接地址格式错误或无法解析");
      return;
    }

    const buildFailHint = (): string => {
      if (isTailscaleCgnat(host) && !ts.running) {
        return "你没连 tailnet，先执行 tailscale up 加入网络";
      }
      return "连接被拒或超时——broker 可能没起，或地址/端口（默认 4700）不对，或对方未放行防火墙";
    };

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      finish(false, buildFailHint());
    }, timeoutMs);

    ws.onopen = () => {
      clearTimeout(timer);
      finish(true, null); // set done BEFORE ws.close() so the resulting onclose is a no-op
      ws.close();
    };

    ws.onerror = () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      finish(false, buildFailHint());
    };

    // Closed before open (e.g. broker sends a WS Close on auth failure) → report
    // unreachable now instead of waiting out the full timeout. The `done` guard makes
    // this a no-op when onopen/onerror already settled (onopen's ws.close() fires it).
    ws.onclose = () => {
      clearTimeout(timer);
      finish(false, buildFailHint());
    };
  });
}
