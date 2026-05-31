# Server-to-Client Request Passthrough 实现计划

> **执行模式：AgentBridge 双 Agent 协作**
> - **Codex（Builder）**：实现代码 + 写测试，在主目录 `/Users/raysonmeng/agent_bridge` 工作
> - **Claude（Critic）**：review 每个 Task 产出、跑验证、处理 git 操作（commit/push/PR）
> - 每个 Task 完成后 Claude review → 通过则 commit → 进入下一个 Task
> - Codex 不做 git 操作（sandbox 限制）

**Goal:** 修复 issue #37 — Codex 审批请求被代理丢弃导致 TUI 无法显示审批 UI、Codex 卡死

**Architecture:** 在 `codex-adapter.ts` 的 `handleAppServerPayload` 中新增 server-to-client request 分支（同时具有 `id` + `method` 的消息），内部直接发送给 TUI 并建立双向 ID mapping；TUI 的审批响应通过 `onTuiMessage` 回传给 app-server。TUI 断连时缓冲 server request，重连后重放。

**Tech Stack:** TypeScript, Bun, WebSocket, JSON-RPC

**Spec:** `docs/issue-37-server-request-passthrough-design.md` (v5)

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/codex-adapter.ts` | 修改：新增 server request 检测、转发、响应路由、缓冲重放、清理 |
| `src/codex-adapter.test.ts` | 修改：新增测试用例 |

---

## Phase 1: 核心修复（Task 1 + 2）

> Codex 实现 Task 1 和 Task 2 的全部代码和测试。完成后通知 Claude review。

### Task 1: Server request 识别与转发

**角色：Codex 实现**
**Files:**
- Modify: `src/codex-adapter.ts:19-30`（新增类型）, `src/codex-adapter.ts:343-357`（handleAppServerPayload）
- Modify: `src/codex-adapter.test.ts`

- [ ] **Step 1: 新增 `PendingServerRequest` 类型和属性**

在 `src/codex-adapter.ts` 的 `TuiSocketData` interface 后面添加：

```typescript
interface PendingServerRequest {
  serverId: number | string;
  connId: number;
  method: string;
  timestamp: number;
}
```

在 `CodexAdapter` class 的属性区域（`private nextProxyId` 附近）添加：

```typescript
private serverRequestToProxy = new Map<number, PendingServerRequest>();
private pendingServerRequests: Array<{ raw: string; serverId: number | string; method: string }> = [];
```

- [ ] **Step 2: 修改 `handleAppServerPayload` 添加 server request 分支**

修改 `src/codex-adapter.ts:343-357`，在 `parsed.id === undefined` 检查之后、`handleAppServerResponse` 调用之前，插入 server request 检测：

```typescript
private handleAppServerPayload(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);

    if (parsed.id === undefined) {
      const forwarded = this.patchResponse(parsed, raw);
      this.interceptServerMessage(parsed);
      return forwarded;
    }

    // Server-to-client request（如审批提示）— 内部直接发送给 TUI
    if (parsed.method !== undefined) {
      this.handleServerRequest(parsed);
      return null;
    }

    return this.handleAppServerResponse(parsed, raw);
  } catch {
    return raw;
  }
}
```

- [ ] **Step 3: 实现 `handleServerRequest` 方法**

在 `handleAppServerResponse` 方法之前添加：

```typescript
private handleServerRequest(parsed: any): void {
  const raw = JSON.stringify(parsed);
  const serverId = parsed.id;
  const method = parsed.method;

  if (!this.tuiWs) {
    this.pendingServerRequests.push({ raw, serverId, method });
    this.log(`Server request buffered (no TUI): ${method} (server id=${serverId})`);
    return;
  }

  const proxyId = this.nextProxyId++;
  parsed.id = proxyId;

  try {
    this.tuiWs.send(JSON.stringify(parsed));
  } catch (e: any) {
    this.log(`Server request send failed, buffering: ${method} (server id=${serverId}): ${e.message}`);
    this.pendingServerRequests.push({ raw, serverId, method });
    return;
  }

  this.serverRequestToProxy.set(proxyId, {
    serverId,
    connId: this.tuiConnId,
    method,
    timestamp: Date.now(),
  });

  this.log(`Server request: ${method} (server id=${serverId} → proxy id=${proxyId}, conn #${this.tuiConnId})`);
}
```

- [ ] **Step 4: 写测试并验证**

在 `src/codex-adapter.test.ts` 末尾新增：

```typescript
describe("CodexAdapter server-to-client request passthrough", () => {
  test("forwards server request (id + method) to TUI instead of dropping", () => {
    const adapter = createAdapter();
    const sent: string[] = [];
    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;
    adapter.tuiConnId = 1;

    const serverRequest = JSON.stringify({
      id: 42,
      method: "item/permissions/requestApproval",
      params: { permission: "network" },
    });

    const result = adapter.handleAppServerPayload(serverRequest);

    expect(result).toBeNull();
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.method).toBe("item/permissions/requestApproval");
    expect(parsed.params).toEqual({ permission: "network" });
    expect(parsed.id).not.toBe(42);
    expect(adapter.serverRequestToProxy.size).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("existing response handling is not affected by server request passthrough", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;
    adapter.upstreamToClient.set(100200, { connId: 1, clientId: "c1" });

    const forwarded = adapter.handleAppServerPayload(JSON.stringify({
      id: 100200,
      result: { ok: true },
    }));

    expect(forwarded).not.toBeNull();
    expect(JSON.parse(forwarded!).id).toBe("c1");
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("notifications without id still forwarded as before", () => {
    const adapter = createAdapter();
    const raw = JSON.stringify({ method: "item/started", params: { item: { id: "i1", type: "text" } } });
    const forwarded = adapter.handleAppServerPayload(raw);
    expect(forwarded).toBe(raw);
    adapter.clearResponseTrackingState();
  });

  test("buffers server request when no TUI connected", () => {
    const adapter = createAdapter();
    adapter.tuiWs = null;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 50,
      method: "item/fileChange/requestApproval",
      params: { file: "test.ts" },
    }));

    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(adapter.pendingServerRequests[0].serverId).toBe(50);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("falls back to buffer when TUI send fails", () => {
    const adapter = createAdapter();
    adapter.tuiWs = { send: () => { throw new Error("broken pipe"); } } as any;
    adapter.tuiConnId = 1;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 90,
      method: "item/commandExecution/requestApproval",
      params: {},
    }));

    expect(adapter.pendingServerRequests.length).toBe(1);
    expect(adapter.pendingServerRequests[0].serverId).toBe(90);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });
});
```

Run: `bun test src/codex-adapter.test.ts`
Expected: 全部 PASS

---

### Task 2: TUI 审批响应回传 + ID 归一化

**角色：Codex 实现**
**Files:**
- Modify: `src/codex-adapter.ts:303-339`（onTuiMessage）
- Modify: `src/codex-adapter.test.ts`

- [ ] **Step 1: 修改 `onTuiMessage` 添加 server request 响应路由**

在 `onTuiMessage` 方法中，在 `let forwarded = data;` 之前，添加 server request response 检查。**注意 ID 类型归一化**（TUI 可能返回 string 类型 ID）：

```typescript
private onTuiMessage(ws: ServerWebSocket<TuiSocketData>, msg: string | Buffer) {
  const data = typeof msg === "string" ? msg : msg.toString();
  const connId = ws.data.connId;

  if (connId !== this.tuiConnId) {
    this.log(`Dropping message from stale TUI conn #${connId} (current is #${this.tuiConnId})`);
    return;
  }

  // Check if this is a response to a server-originated request
  try {
    const parsed = JSON.parse(data);
    if (parsed.id !== undefined && !parsed.method) {
      const rawId = parsed.id;
      const normalizedId = typeof rawId === "number"
        ? rawId
        : (typeof rawId === "string" && /^-?\d+$/.test(rawId) ? Number(rawId) : NaN);
      const pending = !isNaN(normalizedId) ? this.serverRequestToProxy.get(normalizedId) : undefined;
      if (pending !== undefined) {
        if (pending.connId !== connId) {
          this.log(`Dropping stale server request response (proxy id=${normalizedId}, expected conn #${pending.connId}, got #${connId})`);
          return;
        }

        parsed.id = pending.serverId;
        try {
          this.appServerWs!.send(JSON.stringify(parsed));
          this.serverRequestToProxy.delete(normalizedId);
          this.log(`TUI → app-server: ${pending.method} response (proxy id=${normalizedId} → server id=${pending.serverId})`);
        } catch (e: any) {
          parsed.id = normalizedId;
          this.log(`Failed to forward approval response to app-server (proxy id=${normalizedId}): ${e.message}`);
        }
        return;
      }
    }
  } catch {
    // fall through to existing forwarding
  }

  // ... existing client request forwarding logic below (unchanged) ...
  let forwarded = data;
  try {
    const parsed = JSON.parse(data);
    // ... rest unchanged ...
```

- [ ] **Step 2: 写测试并验证**

在 `src/codex-adapter.test.ts` 的 server request passthrough describe block 中追加：

```typescript
  test("routes TUI approval response back to app-server with original server id", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100300, {
      serverId: 42,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100300, result: { approved: true } }));

    expect(appSent.length).toBe(1);
    expect(JSON.parse(appSent[0]).id).toBe(42);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("rejects stale response from old TUI without deleting mapping", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 2;

    adapter.serverRequestToProxy.set(100301, {
      serverId: 43,
      connId: 1,
      method: "item/fileChange/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 2 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 100301, result: { approved: true } }));

    expect(appSent.length).toBe(0);
    expect(adapter.serverRequestToProxy.has(100301)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("normalizes string ID to number when matching server request response", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100302, {
      serverId: 44,
      connId: 1,
      method: "item/commandExecution/requestApproval",
      timestamp: Date.now(),
    });

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: "100302", result: { approved: false } }));

    expect(appSent.length).toBe(1);
    expect(JSON.parse(appSent[0]).id).toBe(44);
    expect(adapter.serverRequestToProxy.size).toBe(0);

    adapter.clearResponseTrackingState();
  });

  test("unknown TUI response id falls through to normal client forwarding", () => {
    const adapter = createAdapter();
    const appSent: string[] = [];
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: (data: string) => appSent.push(data) } as any;
    adapter.tuiConnId = 1;

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({ id: 999, result: { ok: true } }));

    expect(appSent.length).toBe(1);

    adapter.clearResponseTrackingState();
  });
```

Run: `bun test src/codex-adapter.test.ts`
Expected: 全部 PASS

---

**Phase 1 完成后：**
- [ ] **Claude review**: 读 Codex 的代码改动，验证 typecheck + 全量测试
- [ ] **Claude commit**: `git add` + `git commit` Task 1 + 2 的改动
- [ ] **通知 Codex**: 进入 Phase 2

---

## Phase 2: 重连与清理（Task 3 + 4）

> Codex 实现 Task 3 和 Task 4 的全部代码和测试。完成后通知 Claude review。

### Task 3: TUI 重连重放

**角色：Codex 实现**
**Files:**
- Modify: `src/codex-adapter.ts:281-287`（onTuiConnect）
- Modify: `src/codex-adapter.test.ts`

- [ ] **Step 1: 修改 `onTuiConnect` 添加重放逻辑**

在 `onTuiConnect` 方法末尾添加：

```typescript
private onTuiConnect(ws: ServerWebSocket<TuiSocketData>) {
  this.tuiConnId++;
  ws.data.connId = this.tuiConnId;
  this.tuiWs = ws;
  this.log(`TUI connected (conn #${this.tuiConnId})`);
  this.emit("tuiConnected", this.tuiConnId);

  // 重放缓冲的 server request
  const remaining: typeof this.pendingServerRequests = [];
  for (const buffered of this.pendingServerRequests) {
    const proxyId = this.nextProxyId++;
    try {
      const parsed = JSON.parse(buffered.raw);
      parsed.id = proxyId;
      ws.send(JSON.stringify(parsed));
      this.serverRequestToProxy.set(proxyId, {
        serverId: buffered.serverId,
        connId: this.tuiConnId,
        method: buffered.method,
        timestamp: Date.now(),
      });
      this.log(`Replayed buffered server request: ${buffered.method} (server id=${buffered.serverId} → proxy id=${proxyId})`);
    } catch (e: any) {
      this.log(`Failed to replay buffered server request: ${buffered.method} (server id=${buffered.serverId}): ${e.message}`);
      remaining.push(buffered);
    }
  }
  this.pendingServerRequests = remaining;
}
```

- [ ] **Step 2: 写测试并验证**

```typescript
  test("replays buffered server requests on TUI reconnect", () => {
    const adapter = createAdapter();
    const sent: string[] = [];

    adapter.pendingServerRequests = [
      { raw: JSON.stringify({ id: 50, method: "item/fileChange/requestApproval", params: { file: "test.ts" } }), serverId: 50, method: "item/fileChange/requestApproval" },
    ];

    const ws = { data: { connId: 0 }, send: (data: string) => sent.push(data) } as any;
    adapter.onTuiConnect(ws);

    expect(adapter.pendingServerRequests.length).toBe(0);
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.method).toBe("item/fileChange/requestApproval");
    expect(parsed.id).not.toBe(50);
    expect(adapter.serverRequestToProxy.size).toBe(1);

    adapter.clearResponseTrackingState();
  });

  test("replay send failure: no phantom mapping, request stays buffered", () => {
    const adapter = createAdapter();

    adapter.pendingServerRequests = [
      { raw: JSON.stringify({ id: 60, method: "item/permissions/requestApproval", params: {} }), serverId: 60, method: "item/permissions/requestApproval" },
    ];

    const ws = { data: { connId: 0 }, send: () => { throw new Error("connection reset"); } } as any;
    adapter.onTuiConnect(ws);

    expect(adapter.serverRequestToProxy.size).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(1);

    adapter.clearResponseTrackingState();
  });
```

Run: `bun test src/codex-adapter.test.ts`
Expected: 全部 PASS

---

### Task 4: TTL 清理 + app-server 重连清理

**角色：Codex 实现**
**Files:**
- Modify: `src/codex-adapter.ts:610-621`（retireConnectionState）, `src/codex-adapter.ts:663-676`（clearResponseTrackingState）
- Modify: `src/codex-adapter.test.ts`

- [ ] **Step 1: 修改 `retireConnectionState` 添加 TTL 清理**

在 `retireConnectionState` 方法末尾添加：

```typescript
  // TTL cleanup for server request mappings belonging to this connection
  for (const [proxyId, pending] of this.serverRequestToProxy.entries()) {
    if (pending.connId === connId) {
      const timer = setTimeout(() => {
        if (this.serverRequestToProxy.get(proxyId)?.connId === connId) {
          this.serverRequestToProxy.delete(proxyId);
          this.log(`Expired stale server request mapping (proxy id=${proxyId}, method=${pending.method})`);
        }
      }, CodexAdapter.RESPONSE_TRACKING_TTL_MS);
      timer.unref?.();
    }
  }
```

- [ ] **Step 2: 修改 `clearResponseTrackingState` 添加 server request 清理**

在 `clearResponseTrackingState` 末尾添加：

```typescript
  // Clear server request state (session-scoped)
  this.serverRequestToProxy.clear();
  this.pendingServerRequests = [];
```

- [ ] **Step 3: 写测试并验证**

```typescript
  test("server request mappings survive TUI disconnect (TTL cleanup)", () => {
    const adapter = createAdapter();
    adapter.tuiConnId = 1;

    adapter.serverRequestToProxy.set(100400, {
      serverId: 70,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });

    adapter.retireConnectionState(1);
    expect(adapter.serverRequestToProxy.has(100400)).toBe(true);

    adapter.clearResponseTrackingState();
  });

  test("app-server close clears all server request state", () => {
    const adapter = createAdapter();

    adapter.serverRequestToProxy.set(100401, {
      serverId: 71,
      connId: 1,
      method: "item/permissions/requestApproval",
      timestamp: Date.now(),
    });
    adapter.pendingServerRequests = [
      { raw: "{}", serverId: 72, method: "item/fileChange/requestApproval" },
    ];

    adapter.clearResponseTrackingState();
    adapter.activeTurnIds.clear();
    adapter.turnInProgress = false;

    expect(adapter.serverRequestToProxy.size).toBe(0);
    expect(adapter.pendingServerRequests.length).toBe(0);
  });

  test("server request and client request share nextProxyId without collision", () => {
    const adapter = createAdapter();
    const sent: string[] = [];
    adapter.tuiWs = { send: (data: string) => sent.push(data) } as any;
    adapter.tuiConnId = 1;
    adapter.appServerWs = { readyState: WebSocket.OPEN, send: () => {} } as any;

    adapter.handleAppServerPayload(JSON.stringify({
      id: 80,
      method: "item/permissions/requestApproval",
      params: {},
    }));

    const ws = { data: { connId: 1 } } as any;
    adapter.onTuiMessage(ws, JSON.stringify({
      id: "client-1",
      method: "thread/start",
      params: {},
    }));

    const serverProxyId = JSON.parse(sent[0]).id;
    const clientMapping = [...adapter.upstreamToClient.entries()];
    expect(clientMapping.length).toBe(1);
    expect(clientMapping[0][0]).not.toBe(serverProxyId);

    adapter.clearResponseTrackingState();
  });
```

Run: `bun test src/codex-adapter.test.ts`
Expected: 全部 PASS

---

**Phase 2 完成后：**
- [ ] **Claude review**: 读 Codex 的代码改动，验证 typecheck + 全量测试
- [ ] **Claude commit**: `git add` + `git commit` Task 3 + 4 的改动
- [ ] **通知 Codex**: 进入 Phase 3

---

## Phase 3: 最终验证与发布（Claude + Codex 协作）

### Task 5: 集成验证

**角色：Claude 主导，Codex 辅助**

- [ ] **Step 1: Claude 运行 typecheck**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 2: Claude 运行全量测试**

Run: `bun test src/`
Expected: 全部 PASS（原有 133 + 新增测试）

- [ ] **Step 3: Claude 创建 PR**

```bash
git checkout -b fix/server-request-passthrough
git push -u origin fix/server-request-passthrough
gh pr create --title "fix: passthrough server-to-client requests for approval UI (issue #37)" ...
```

- [ ] **Step 4: Codex review PR diff**

Claude 发 PR diff 给 Codex 做交叉 review

- [ ] **Step 5: E2E 验证（手动）**

1. 启动 AgentBridge 和 Codex
2. 让 Codex 执行需要审批的操作
3. 验证审批提示出现在 TUI 中
4. 批准/拒绝后验证 Codex 正确继续/停止

---

## 协作协议

### 通信格式

Codex 完成一个 Phase 后发送：
```
[IMPORTANT] Phase N 完成。改动文件：src/codex-adapter.ts, src/codex-adapter.test.ts
请 review 并 commit。
```

Claude review 后发送：
```
Phase N review 通过。已 commit: <commit hash>
进入 Phase N+1，请实现 Task X + Y。
```

### 错误处理

- Codex 测试失败 → Codex 自行修复，修复后重新通知 Claude
- Claude review 发现问题 → 发给 Codex 具体行号和修复建议
- typecheck 失败 → Claude 发错误信息给 Codex 修复

### Git 操作（仅 Claude 执行）

- 所有 commit 由 Claude 在 worktree 或当前分支上执行
- 每个 Phase 一个 commit（squash Task 1+2 为一个，Task 3+4 为一个）
- PR 由 Claude 创建，Codex review

---

## Self-Review Checklist

- [x] **Spec 覆盖**: v5 设计文档的全部改动点都有对应 Task
- [x] **无占位符**: 所有 step 包含完整代码
- [x] **类型一致**: `PendingServerRequest`, `serverRequestToProxy`, `pendingServerRequests` 全文一致
- [x] **角色分工明确**: 每个 Task 标注了由谁执行
- [x] **Phase 边界清晰**: 每个 Phase 结束有明确的 review + commit checkpoint
