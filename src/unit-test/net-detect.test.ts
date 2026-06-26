import { describe, expect, test } from "bun:test";
import {
  buildConnectionCard,
  detectTailscale,
  localIPv4s,
  probeBroker,
  type ConnectionCard,
  type TailscaleStatus,
} from "../net-detect";

// ── localIPv4s ────────────────────────────────────────────────────────────────

describe("localIPv4s", () => {
  test("返回数组，且不含 127.x loopback", () => {
    const ips = localIPv4s();
    expect(Array.isArray(ips)).toBe(true);
    for (const ip of ips) {
      expect(ip).toBeString();
      expect(ip.startsWith("127.")).toBe(false);
    }
  });
});

// ── buildConnectionCard — 4 分支 ──────────────────────────────────────────────

describe("buildConnectionCard", () => {
  const PORT = 4700;

  // 分支 1：tailscale running + ipv4 → primary = Tailscale 100.x
  test("分支1 tailscale running+ipv4 → primary = 100.x", () => {
    const ts: TailscaleStatus = {
      installed: true,
      running: true,
      ipv4: "100.90.1.42",
      backendState: "Running",
    };
    const card: ConnectionCard = buildConnectionCard({
      bindHost: "127.0.0.1",
      brokerPort: PORT,
      tailscale: ts,
      lanIps: ["192.168.1.5"],
    });

    expect(card.primary).toBe("100.90.1.42");
    // 命令块含 Tailscale IP
    expect(card.lines.some((l) => l.includes("ws://100.90.1.42:4700/ws"))).toBe(true);
    // 协作者命令块
    expect(card.lines.some((l) => l.includes("abg auth login --token"))).toBe(true);
    expect(card.lines.some((l) => l.includes("abg join <roomId>"))).toBe(true);
    // tailscale running → 不显示「没装 Tailscale」指引
    expect(card.lines.some((l) => l.includes("没装 Tailscale"))).toBe(false);
  });

  // 分支 2：未装 Tailscale + 有局域网 IP → primary = lanIps[0]
  test("分支2 未装 tailscale + 有 LAN IP → primary = lanIps[0]", () => {
    const ts: TailscaleStatus = {
      installed: false,
      running: false,
      ipv4: null,
      backendState: null,
    };
    const card: ConnectionCard = buildConnectionCard({
      bindHost: "127.0.0.1",
      brokerPort: PORT,
      tailscale: ts,
      lanIps: ["192.168.0.100"],
    });

    expect(card.primary).toBe("192.168.0.100");
    expect(card.lines.some((l) => l.includes("ws://192.168.0.100:4700/ws"))).toBe(true);
    expect(card.lines.some((l) => l.includes("abg auth login --token"))).toBe(true);
    // tailscale 未运行 → 含「没装 Tailscale」指引
    expect(card.lines.some((l) => l.includes("没装 Tailscale"))).toBe(true);
    expect(card.lines.some((l) => l.includes("tailscale.com/install.sh"))).toBe(true);
  });

  // 分支 3：未装 Tailscale + 仅 loopback → primary = null
  test("分支3 未装 tailscale + 仅 loopback → primary = null，含仅本机可达提示", () => {
    const ts: TailscaleStatus = {
      installed: false,
      running: false,
      ipv4: null,
      backendState: null,
    };
    const card: ConnectionCard = buildConnectionCard({
      bindHost: "127.0.0.1",
      brokerPort: PORT,
      tailscale: ts,
      lanIps: [],
    });

    expect(card.primary).toBeNull();
    // 含仅本机可达警告
    expect(card.lines.some((l) => l.includes("只本机可达"))).toBe(true);
    // 仍然包含协作者命令块（fallback 地址）
    expect(card.lines.some((l) => l.includes("abg auth login --token"))).toBe(true);
    expect(card.lines.some((l) => l.includes("abg join <roomId>"))).toBe(true);
    // tailscale 未运行 → 含「没装 Tailscale」指引
    expect(card.lines.some((l) => l.includes("没装 Tailscale"))).toBe(true);
  });

  // 分支 4：bindHost 已是具体 100.x（tailscale 未运行）→ primary = bindHost
  test("分支4 bindHost 是具体 100.x → primary = bindHost", () => {
    const ts: TailscaleStatus = {
      installed: false,
      running: false,
      ipv4: null,
      backendState: null,
    };
    const card: ConnectionCard = buildConnectionCard({
      bindHost: "100.90.0.5",
      brokerPort: PORT,
      tailscale: ts,
      lanIps: [],
    });

    expect(card.primary).toBe("100.90.0.5");
    expect(card.lines.some((l) => l.includes("ws://100.90.0.5:4700/ws"))).toBe(true);
    expect(card.lines.some((l) => l.includes("abg auth login --token"))).toBe(true);
  });
});

// ── detectTailscale ───────────────────────────────────────────────────────────

describe("detectTailscale", () => {
  test("不抛，且返回结构完整", async () => {
    const result = await detectTailscale();
    expect(result).toBeDefined();
    expect(typeof result.installed).toBe("boolean");
    expect(typeof result.running).toBe("boolean");
    // ipv4 / backendState 允许 null 或 string
    expect(result.ipv4 === null || typeof result.ipv4 === "string").toBe(true);
    expect(result.backendState === null || typeof result.backendState === "string").toBe(true);
  });
});

// ── probeBroker ───────────────────────────────────────────────────────────────

describe("probeBroker", () => {
  test("连不上的地址 → ok:false，hint 非空", async () => {
    // port 1 on loopback 必然被拒
    const result = await probeBroker("ws://127.0.0.1:1/ws", 4000);
    expect(result.ok).toBe(false);
    expect(typeof result.hint).toBe("string");
    expect((result.hint ?? "").length).toBeGreaterThan(0);
  }, 8000 /* 给够 WS 连接 + detectTailscale 超时 */);
});
