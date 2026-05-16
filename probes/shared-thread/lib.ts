#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export type Json = Record<string, any>;

export interface BridgeMessage {
  id: string;
  source: "claude" | "codex";
  content: string;
  timestamp: number;
}

export interface ControlResult {
  requestId: string;
  success: boolean;
  error?: string;
}

export interface ProbeOptions {
  name: string;
  basePort?: number;
  pairReapMs?: number;
  daemonEntry?: string;
  extraEnv?: Record<string, string>;
}

const DEFAULT_BASE_PORT = Number(process.env.ABG_PROBE_BASE_PORT ?? "4820");
const DEFAULT_TIMEOUT_MS = Number(process.env.ABG_PROBE_TIMEOUT_MS ?? "120000");
const DEFAULT_CWD = process.env.ABG_PROBE_CWD ?? "/tmp/agentbridge-shared-thread-cwd";

export class ProbeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeFailure";
  }
}

export function makeToken(prefix = "abg"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function sha1_16(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProbeFailure(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  return String(data);
}

export function parseMaybeJson(data: unknown): Json | null {
  try {
    const value = JSON.parse(rawDataToString(data));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function extractItemText(item: any): string {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .join("");
  }
  return "";
}

export function marker(name: string): string {
  return `agentbridge-${name}-${randomBytes(4).toString("hex")}`;
}

function formatArgs(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

export class SharedThreadProbe {
  readonly name: string;
  readonly stateDir: string;
  readonly cwd: string;
  readonly appPort: number;
  readonly proxyPort: number;
  readonly controlPort: number;
  readonly controlUrl: string;
  readonly proxyUrl: string;
  readonly appServerUrl: string;
  readonly startedAt = Date.now();

  private daemon: ChildProcess | null = null;
  private daemonLogChunks: string[] = [];
  private readonly pairReapMs: number;
  private readonly daemonEntry: string;
  private readonly extraEnv: Record<string, string>;

  constructor(options: ProbeOptions) {
    this.name = options.name;
    const base = options.basePort ?? DEFAULT_BASE_PORT;
    this.appPort = base;
    this.proxyPort = base + 1;
    this.controlPort = base + 2;
    this.controlUrl = `ws://127.0.0.1:${this.controlPort}/ws`;
    this.proxyUrl = `ws://127.0.0.1:${this.proxyPort}`;
    this.appServerUrl = `ws://127.0.0.1:${this.appPort}`;
    this.stateDir = `/tmp/agentbridge-shared-thread-${this.name}-${process.pid}`;
    this.cwd = `${DEFAULT_CWD}-${this.name}`;
    this.pairReapMs = options.pairReapMs ?? Number(process.env.AGENTBRIDGE_PAIR_REAP_MS ?? "30000");
    this.daemonEntry =
      options.daemonEntry ??
      process.env.AGENTBRIDGE_DAEMON_ENTRY ??
      `${import.meta.dir}/../../plugins/agentbridge/server/daemon.js`;
    this.extraEnv = options.extraEnv ?? {};
  }

  log(message: string): void {
    const elapsed = Date.now() - this.startedAt;
    process.stderr.write(`[${elapsed.toString().padStart(6)}ms] [${this.name}] ${message}\n`);
  }

  async startDaemon(): Promise<void> {
    rmSync(this.stateDir, { recursive: true, force: true });
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });

    const env = {
      ...process.env,
      AGENTBRIDGE_STATE_DIR: this.stateDir,
      CODEX_WS_PORT: String(this.appPort),
      CODEX_PROXY_PORT: String(this.proxyPort),
      AGENTBRIDGE_CONTROL_PORT: String(this.controlPort),
      AGENTBRIDGE_IDLE_SHUTDOWN_MS: "300000",
      AGENTBRIDGE_FILTER_MODE: "full",
      AGENTBRIDGE_PAIR_REAP_MS: String(this.pairReapMs),
      AGENTBRIDGE_PAIR_RACE_MS: "0",
      ...this.extraEnv,
    };

    this.log(`spawning daemon: bun ${this.daemonEntry}`);
    this.daemon = spawn("bun", [this.daemonEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.daemon.stdout?.on("data", (chunk: Buffer) => this.captureDaemon("out", chunk));
    this.daemon.stderr?.on("data", (chunk: Buffer) => this.captureDaemon("err", chunk));
    this.daemon.on("exit", (code, signal) => {
      this.log(`daemon exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    });

    await this.waitReady();
  }

  private captureDaemon(stream: "out" | "err", chunk: Buffer): void {
    const text = chunk.toString("utf-8");
    this.daemonLogChunks.push(text);
    for (const line of text.split("\n")) {
      if (line.trim()) process.stderr.write(`[daemon:${stream}] ${line}\n`);
    }
  }

  async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.controlPort}/readyz`);
        if (res.ok) {
          this.log("daemon /readyz ok");
          return;
        }
      } catch {}
      await sleep(300);
    }
    throw new ProbeFailure(`daemon did not become ready on ${this.controlPort} within ${timeoutMs}ms`);
  }

  async status(): Promise<Json> {
    const res = await fetch(`http://127.0.0.1:${this.controlPort}/healthz`);
    assert(res.ok, `/healthz returned ${res.status}`);
    return await res.json();
  }

  async connectTui(token: string, name = "tui", options?: TuiOptions): Promise<TuiClient> {
    const client = new TuiClient(this, name, this.proxyUrl, options, {
      headers: { authorization: `Bearer ${token}` },
    });
    await client.connect();
    return client;
  }

  async connectProxyRaw(url: string, name = "raw", options?: RawWsOptions): Promise<RawWsClient> {
    const client = new RawWsClient(this, name, url, options);
    await client.connect();
    return client;
  }

  async connectClaude(chatId: string): Promise<ClaudeClient> {
    const client = new ClaudeClient(this, chatId);
    await client.connect();
    return client;
  }

  daemonLog(): string {
    const fromMemory = this.daemonLogChunks.join("");
    const logPath = `${this.stateDir}/agentbridge.log`;
    if (!existsSync(logPath)) return fromMemory;
    return `${fromMemory}\n${readFileSync(logPath, "utf-8")}`;
  }

  async stop(): Promise<void> {
    const proc = this.daemon;
    this.daemon = null;
    if (!proc) return;
    this.log("stopping daemon");
    try { proc.kill("SIGTERM"); } catch {}
    await sleep(1200);
    try { proc.kill("SIGKILL"); } catch {}
  }
}

export class RawWsClient {
  readonly messages: Json[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  ws: WebSocket | null = null;

  constructor(
    protected readonly probe: SharedThreadProbe,
    readonly name: string,
    readonly url: string,
    private readonly wsOptions: RawWsOptions = {},
  ) {}

  connect(timeoutMs = 20_000): Promise<void> {
    return withTimeout(new Promise<void>((resolve, reject) => {
      const ws = this.wsOptions.headers
        ? new WebSocket(this.url, { headers: this.wsOptions.headers } as any)
        : new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.probe.log(`[${this.name}] WS open ${this.url}`);
        resolve();
      };
      ws.onerror = () => {
        if (!settled) reject(new ProbeFailure(`[${this.name}] WS error during connect`));
      };
      ws.onclose = (event) => {
        this.closes.push({ code: event.code, reason: event.reason });
        this.probe.log(`[${this.name}] WS closed code=${event.code} reason=${event.reason || "-"}`);
        if (!settled) {
          settled = true;
          reject(new ProbeFailure(`[${this.name}] WS closed during connect code=${event.code} reason=${event.reason}`));
        }
      };
      ws.onmessage = (event) => {
        const parsed = parseMaybeJson(event.data);
        if (parsed) this.messages.push(parsed);
        this.onMessage(parsed, rawDataToString(event.data));
      };
    }), timeoutMs, `${this.name} connect`);
  }

  protected onMessage(_message: Json | null, _raw: string): void {}

  send(message: Json): void {
    assert(this.ws?.readyState === WebSocket.OPEN, `[${this.name}] socket is not open`);
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    try { this.ws?.close(); } catch {}
  }

  async waitForClose(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    if (this.closes.length > 0) return this.closes[this.closes.length - 1];
    return withTimeout(new Promise((resolve) => {
      const old = this.ws?.onclose;
      if (!this.ws) return;
      this.ws.onclose = (event) => {
        old?.call(this.ws, event);
        const close = { code: event.code, reason: event.reason };
        this.closes.push(close);
        resolve(close);
      };
    }), timeoutMs, `${this.name} close`);
  }
}

export interface TuiOptions {
  approvalPolicy?: string;
  autoApprove?: boolean;
}

export interface RawWsOptions {
  headers?: Record<string, string>;
}

export class TuiClient extends RawWsClient {
  readonly notifications: Json[] = [];
  readonly responses = new Map<number | string, Json>();
  readonly requests: Json[] = [];
  readonly agentMessages: string[] = [];
  readonly userMessages: string[] = [];
  readonly itemTypes: string[] = [];
  threadId: string | null = null;
  private nextId = 1;
  private readonly options: Required<TuiOptions>;

  constructor(probe: SharedThreadProbe, name: string, url: string, options?: TuiOptions, rawOptions?: RawWsOptions) {
    super(probe, name, url, rawOptions);
    this.options = {
      approvalPolicy: options?.approvalPolicy ?? "never",
      autoApprove: options?.autoApprove ?? false,
    };
  }

  protected override onMessage(message: Json | null, raw: string): void {
    if (!message) return;
    if (message.id !== undefined && message.method === undefined) {
      this.responses.set(message.id, message);
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      this.notifications.push(message);
      const item = message.params?.item;
      if (item?.type) this.itemTypes.push(item.type);
      if (message.method !== "item/agentMessage/delta") {
        this.probe.log(`[${this.name}] ${message.method}${item?.type ? ` (${item.type})` : ""}`);
      }
      if (message.method === "item/completed" && item?.type === "agentMessage") {
        this.agentMessages.push(extractItemText(item));
      }
      if (message.method === "item/completed" && item?.type === "userMessage") {
        this.userMessages.push(extractItemText(item));
      }
      return;
    }
    if (typeof message.method === "string" && message.id !== undefined) {
      this.requests.push(message);
      this.probe.log(`[${this.name}] server request ${message.method} id=${String(message.id)}`);
      if (this.options.autoApprove) this.respondToServerRequest(message, raw);
    }
  }

  private respondToServerRequest(message: Json, _raw: string): void {
    let result: Json | null = null;
    switch (message.method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "accept" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "accept" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn" };
        break;
      case "execCommandApproval":
        result = { decision: "approved" };
        break;
      case "applyPatchApproval":
        result = { decision: "denied" };
        break;
    }
    if (!result) return;
    this.send({ jsonrpc: "2.0", id: message.id, result });
  }

  async initializeAndStartThread(options?: {
    approvalPolicy?: string;
    cwd?: string;
    sandbox?: string;
  }): Promise<string> {
    const initId = this.nextId++;
    this.send({
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: { clientInfo: { name: `agentbridge-probe-${this.name}`, version: "0.0.1" } },
    });
    await this.waitForResponse(initId, 30_000);
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });

    const threadIdReq = this.nextId++;
    this.send({
      jsonrpc: "2.0",
      id: threadIdReq,
      method: "thread/start",
      params: {
        cwd: options?.cwd ?? this.probe.cwd,
        approvalPolicy: options?.approvalPolicy ?? this.options.approvalPolicy,
        ...(options?.sandbox ? { sandbox: options.sandbox } : {}),
      },
    });
    const response = await this.waitForResponse(threadIdReq, 45_000);
    const threadId = response.result?.thread?.id;
    assert(typeof threadId === "string" && threadId.length > 0, `[${this.name}] thread/start did not return thread.id`);
    this.threadId = threadId;
    this.probe.log(`[${this.name}] threadId=${threadId}`);
    return threadId;
  }

  async sendRequest(method: string, params?: Json, timeoutMs = 30_000): Promise<Json> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.waitForResponse(id, timeoutMs);
  }

  async sendTurn(text: string, options?: {
    approvalPolicy?: string;
    sandboxPolicy?: Json;
    effort?: string;
  }): Promise<string | null> {
    assert(this.threadId, `[${this.name}] no threadId`);
    const response = await this.sendRequest("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      effort: options?.effort ?? "minimal",
      ...(options?.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options?.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {}),
    }, 30_000);
    return response.result?.turn?.id ?? null;
  }

  async interrupt(turnId: string): Promise<Json> {
    assert(this.threadId, `[${this.name}] no threadId`);
    return this.sendRequest("turn/interrupt", { threadId: this.threadId, turnId }, 20_000);
  }

  async waitForResponse(id: number | string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Json> {
    return withTimeout(new Promise<Json>((resolve, reject) => {
      const poll = () => {
        const response = this.responses.get(id);
        if (!response) {
          setTimeout(poll, 50);
          return;
        }
        if (response.error) reject(new ProbeFailure(`[${this.name}] response ${String(id)} error: ${response.error.message ?? JSON.stringify(response.error)}`));
        else resolve(response);
      };
      poll();
    }), timeoutMs, `${this.name} response ${String(id)}`);
  }

  async waitForNotification(
    method: string,
    predicate: (message: Json) => boolean = () => true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Json> {
    return withTimeout(new Promise<Json>((resolve) => {
      const poll = () => {
        const found = this.notifications.find((message) => message.method === method && predicate(message));
        if (found) resolve(found);
        else setTimeout(poll, 50);
      };
      poll();
    }), timeoutMs, `${this.name} notification ${method}`);
  }

  waitForAgentMessage(contains: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    return withTimeout(new Promise<string>((resolve) => {
      const poll = () => {
        const found = this.agentMessages.find((text) => text.includes(contains));
        if (found !== undefined) resolve(found);
        else setTimeout(poll, 100);
      };
      poll();
    }), timeoutMs, `${this.name} agentMessage containing ${contains}`);
  }

  waitForUserMessage(contains: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    return withTimeout(new Promise<string>((resolve) => {
      const poll = () => {
        const found = this.userMessages.find((text) => text.includes(contains));
        if (found !== undefined) resolve(found);
        else setTimeout(poll, 50);
      };
      poll();
    }), timeoutMs, `${this.name} userMessage containing ${contains}`);
  }

  async expectNoAgentMessage(contains: string, windowMs: number): Promise<void> {
    await sleep(windowMs);
    assert(!this.agentMessages.some((text) => text.includes(contains)), `[${this.name}] unexpected agentMessage containing ${contains}`);
  }

  async waitForServerRequest(
    methodIncludes: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Json> {
    return withTimeout(new Promise<Json>((resolve) => {
      const poll = () => {
        const found = this.requests.find((req) => String(req.method).includes(methodIncludes));
        if (found) resolve(found);
        else setTimeout(poll, 50);
      };
      poll();
    }), timeoutMs, `${this.name} server request ${methodIncludes}`);
  }
}

export class ClaudeClient extends RawWsClient {
  readonly bridgeMessages: BridgeMessage[] = [];
  readonly results: ControlResult[] = [];
  readonly statuses: Json[] = [];

  constructor(probe: SharedThreadProbe, readonly chatId: string) {
    super(probe, `claude:${chatId}`, probe.controlUrl);
  }

  override async connect(timeoutMs = 20_000): Promise<void> {
    await super.connect(timeoutMs);
    this.send({ type: "claude_connect", chatId: this.chatId });
  }

  protected override onMessage(message: Json | null, _raw: string): void {
    if (!message) return;
    if (message.type === "codex_to_claude") {
      const msg = message.message as BridgeMessage;
      this.bridgeMessages.push(msg);
      this.probe.log(`[${this.name}] codex_to_claude ${msg.id} ${msg.content.slice(0, 96).replace(/\n/g, " ")}`);
      return;
    }
    if (message.type === "claude_to_codex_result") {
      this.results.push(message as ControlResult);
      this.probe.log(`[${this.name}] result ${message.requestId} success=${message.success}${message.error ? ` error=${message.error}` : ""}`);
      return;
    }
    if (message.type === "status") this.statuses.push(message.status);
  }

  async sendReply(text: string, options?: { requireReply?: boolean; timeoutMs?: number }): Promise<ControlResult> {
    const requestId = `${this.chatId}_${Date.now()}_${randomBytes(2).toString("hex")}`;
    this.send({
      type: "claude_to_codex",
      requestId,
      chatId: this.chatId,
      message: {
        id: `${this.chatId}_msg_${Date.now()}`,
        source: "claude",
        content: text,
        timestamp: Date.now(),
      },
      ...(options?.requireReply ? { requireReply: true } : {}),
    });
    return this.waitForResult(requestId, options?.timeoutMs ?? 20_000);
  }

  async waitForResult(requestId: string, timeoutMs = 20_000): Promise<ControlResult> {
    return withTimeout(new Promise<ControlResult>((resolve) => {
      const poll = () => {
        const found = this.results.find((result) => result.requestId === requestId);
        if (found) resolve(found);
        else setTimeout(poll, 50);
      };
      poll();
    }), timeoutMs, `${this.name} result ${requestId}`);
  }

  waitForBridgeMessage(
    predicate: (message: BridgeMessage) => boolean,
    label: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<BridgeMessage> {
    return withTimeout(new Promise<BridgeMessage>((resolve) => {
      const poll = () => {
        const found = this.bridgeMessages.find(predicate);
        if (found) resolve(found);
        else setTimeout(poll, 50);
      };
      poll();
    }), timeoutMs, `${this.name} bridge message ${label}`);
  }

  waitForContent(contains: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BridgeMessage> {
    return this.waitForBridgeMessage((msg) => msg.content.includes(contains), contains, timeoutMs);
  }

  waitForDedicatedThreadReady(timeoutMs = 90_000): Promise<string> {
    return withTimeout(new Promise<string>((resolve) => {
      const poll = () => {
        for (const msg of this.bridgeMessages) {
          const match = msg.content.match(/Your Codex thread is ready \(threadId=([0-9a-f-]+)\)/);
          if (match) return resolve(match[1]);
        }
        setTimeout(poll, 100);
      };
      poll();
    }), timeoutMs, `${this.name} dedicated thread ready`);
  }

  async expectNoContent(contains: string, windowMs: number): Promise<void> {
    await sleep(windowMs);
    assert(
      !this.bridgeMessages.some((message) => message.content.includes(contains)),
      `[${this.name}] unexpected bridge message containing ${contains}`,
    );
  }

  async expectNoDedicatedThreadReady(windowMs: number): Promise<void> {
    await sleep(windowMs);
    assert(
      !this.bridgeMessages.some((message) => message.content.includes("Your Codex thread is ready")),
      `[${this.name}] unexpectedly received isolated ClaudeThread ready notice`,
    );
  }
}

export async function runProbe(
  name: string,
  fn: (probe: SharedThreadProbe) => Promise<void>,
  options?: Omit<ProbeOptions, "name">,
): Promise<void> {
  const probe = new SharedThreadProbe({ name, ...options });
  let failed = false;
  try {
    await probe.startDaemon();
    await fn(probe);
  } catch (err: any) {
    failed = true;
    probe.log(`ERROR: ${err?.stack ?? err}`);
  } finally {
    await probe.stop();
  }
  probe.log(failed ? "RESULT: FAILED" : "RESULT: PASSED");
  process.exit(failed ? 1 : 0);
}

export async function expectForeignProxyRejected(
  probe: SharedThreadProbe,
  url: string,
  label: string,
  expectedCode = 4002,
  options?: RawWsOptions,
): Promise<void> {
  const client = new RawWsClient(probe, label, url, options);
  let opened = false;
  try {
    await client.connect(5_000);
    opened = true;
  } catch {
    // Upgrade rejection before open is also acceptable.
  }
  if (opened) {
    const close = await client.waitForClose(5_000);
    assert(close.code === expectedCode, `${label} expected close ${expectedCode}, got ${close.code} (${close.reason})`);
  }
}
