# 设计：Server-to-Client Request 透传（Issue #37）

**日期：** 2026-03-30
**Issue：** https://github.com/raysonmeng/agent-bridge/issues/37
**状态：** v5 — 已合并 Claude + Codex 最终并行 review 反馈，设计定稿

## 问题

Codex 通过 AgentBridge 运行时，遇到沙箱权限提示（文件写入、命令执行、网络访问）时，TUI 不显示审批 UI，Codex 无限期卡死。

## 根因

`codex-adapter.ts` 中的 WebSocket 代理将 **server-to-client request** 错误地归类为 response 并丢弃。

### app-server → TUI 的 JSON-RPC 消息类型

| 类型 | 结构 | 当前处理 | 正确处理 |
|------|------|---------|---------|
| **Notification** | `{ method, params }`（无 `id`） | 转发给 TUI | 转发给 TUI |
| **Response** | `{ id, result/error }`（无 `method`） | ID 重映射后转发 | ID 重映射后转发 |
| **Server request** | `{ id, method, params }` | **误判为 response，被丢弃** | 应转发给 TUI |

### 丢弃 server request 的代码路径

`codex-adapter.ts:343-397`：

```
handleAppServerPayload(raw)
  ├─ parsed.id === undefined → notification → 转发 (OK)
  └─ parsed.id !== undefined → handleAppServerResponse()
       ├─ 找到 mapping → 重映射 id，转发 (OK，适用于 response)
       ├─ bridge request id → 消费，丢弃 (OK)
       ├─ stale proxy id → 丢弃 (OK)
       └─ 无匹配 → "Dropping unmatched app-server response" → 丢弃 (BUG)
```

像 `item/permissions/requestApproval` 这类 server request 同时具有 `id` 和 `method`，但它们不是由 TUI 发起的请求的响应——因此没有 upstream mapping，在最终 fallback 处被丢弃。

### Codex 二进制中的协议证据

通过对 `@openai/codex` 二进制的字符串分析，发现 app-server 协议包含以下消息类型：

**Server-to-client request（审批请求）：**

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

**Server-to-client notification（非审批，无需回复）：**

- `TerminalInteractionNotification` — 终端交互通知，不是审批请求
- `serverRequest/resolved` — server 端通知某个请求已解决，不是 TUI 发出的响应

**TUI 对审批请求的响应类型：**

- `CommandExecutionRequestApprovalResponse`
- `FileChangeRequestApprovalResponse`
- `PermissionsRequestApprovalResponse`

> **注意：** 审批响应的具体 payload 结构未知（不是简单的 `{ approved: true/false }`），代理应原样透传，不做任何假设。

### 卡死序列

1. Codex turn 调用了需要审批的工具
2. App-server 发送 `{ id: N, method: "item/permissions/requestApproval", params: {...} }` 给代理
3. 代理判断：`parsed.id !== undefined` → `handleAppServerResponse()`
4. 没有找到 id N 的 upstream mapping → "Dropping unmatched app-server response id N"
5. TUI 收不到审批提示 → 不渲染审批 UI
6. App-server 永远等不到对应的审批响应
7. 用户看到 Codex 停在 "Working" 状态

## 设计

### 改动 1：在 `handleAppServerPayload` 中识别 server request

在 `codex-adapter.ts:343-357` 增加判断：如果消息**同时**具有 `id` 和 `method`，则为 server-to-client request——转发给 TUI 并追踪 ID 用于回传。

```typescript
private handleAppServerPayload(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);

    if (parsed.id === undefined) {
      // Notification — 原样转发
      const forwarded = this.patchResponse(parsed, raw);
      this.interceptServerMessage(parsed);
      return forwarded;
    }

    if (parsed.method !== undefined) {
      // Server-to-client request（如审批提示）— 转发给 TUI
      return this.handleServerRequest(parsed);
    }

    // 对先前 TUI 请求的 Response
    return this.handleAppServerResponse(parsed, raw);
  } catch {
    return raw;
  }
}
```

### 改动 2：新增 `handleServerRequest` 方法

将 server request 转发给 TUI，并追踪 ID 以便 TUI 的响应能正确回传到 app-server。mapping 按 `connId` 作用域隔离，与现有 response mapping 保持一致。

```typescript
interface PendingServerRequest {
  serverId: number | string;
  connId: number;       // 发送给哪个 TUI 连接
  method: string;       // 用于日志和调试
  timestamp: number;    // 用于超时清理
}

private serverRequestToProxy = new Map<number, PendingServerRequest>();

private handleServerRequest(parsed: any): string | null {
  const raw = JSON.stringify(parsed);
  const serverId = parsed.id;
  const method = parsed.method;

  if (!this.tuiWs) {
    // TUI 未连接，缓冲 server request 等待重连
    this.pendingServerRequests.push({ raw, serverId, method });
    this.log(`Server request buffered (no TUI): ${method} (server id=${serverId})`);
    return null;
  }

  // 直接在此方法内发送给 TUI，而非返回 payload 让外层 handler 发送
  // 这样可以在 send 失败时回退到缓冲，避免外层 handler 的 "log and drop" 路径丢失消息
  const proxyId = this.nextProxyId++;
  parsed.id = proxyId;

  try {
    this.tuiWs.send(JSON.stringify(parsed));
  } catch (e: any) {
    // TUI 连接在半关闭状态，send 失败 → 回退到缓冲
    this.log(`Server request send failed, buffering: ${method} (server id=${serverId}): ${e.message}`);
    this.pendingServerRequests.push({ raw, serverId, method });
    return null;
  }

  // send 成功后才建立 mapping
  this.serverRequestToProxy.set(proxyId, {
    serverId,
    connId: this.tuiConnId,
    method,
    timestamp: Date.now(),
  });

  this.log(`Server request: ${method} (server id=${serverId} → proxy id=${proxyId}, conn #${this.tuiConnId})`);

  // 返回 null —— 已在此方法内完成发送，外层 handler 不需要再发
  return null;
}
```

### 改动 3：在 `onTuiMessage` 中处理 TUI 对 server request 的响应

在 `onTuiMessage` 中，在现有的 client-request ID 重写逻辑之前，检查消息是否为 **server request 的响应**（有 `id` 但无 `method`）。**增加 connId 验证**，拒绝来自旧 TUI 连接的过期响应。

```typescript
private onTuiMessage(ws, msg) {
  const parsed = JSON.parse(data);
  const connId = ws.data.connId;

  // 检查是否为对 server request 的响应
  if (parsed.id !== undefined && !parsed.method) {
    // 归一化 ID 类型：TUI 可能返回 string "100050" 而非 number 100050
    const rawId = parsed.id;
    const normalizedId = typeof rawId === "number"
      ? rawId
      : (typeof rawId === "string" && /^-?\d+$/.test(rawId) ? Number(rawId) : NaN);
    const pending = !isNaN(normalizedId) ? this.serverRequestToProxy.get(normalizedId) : undefined;
    if (pending !== undefined) {
      // 先验证 connId，再决定是否删除 mapping
      if (pending.connId !== connId) {
        // 不删除 mapping —— 正确的 TUI 连接可能稍后回复
        this.log(`Dropping stale server request response (proxy id=${normalizedId}, expected conn #${pending.connId}, got #${connId})`);
        return;
      }

      // connId 匹配，尝试转发给 app-server
      parsed.id = pending.serverId;
      try {
        this.appServerWs.send(JSON.stringify(parsed));
        // 发送成功，安全删除 mapping
        this.serverRequestToProxy.delete(normalizedId);
        this.log(`TUI → app-server: ${pending.method} response (proxy id=${normalizedId} → server id=${pending.serverId})`);
      } catch (e: any) {
        // 发送失败，mapping 保留至 TTL 过期清理（无主动重试机制——TUI 不会重发用户操作）
        parsed.id = normalizedId;
        this.log(`Failed to forward approval response to app-server (proxy id=${normalizedId}): ${e.message}`);
      }
      return; // 不走正常的请求转发流程
    }
  }

  // ... 现有的 client request 转发逻辑 ...
}
```

### 改动 4：TUI 重连时的处理

TUI 重连时采用以下策略：

1. **重放缓冲的 server request**：TUI 断连期间到达的 server request 被缓冲在 `pendingServerRequests` 中，重连后立即用新 proxyId 发送给新 TUI
2. **不重发已发给旧 TUI 的 request**：已经发送但未收到响应的 server request 不主动重发——因为 app-server 可能会在 TUI 重连后重新发送审批请求（以新 id），代理不应假设重发行为。旧 mapping 保留至 TTL 超时，connId 检查会拒绝旧连接的过期响应

```typescript
private pendingServerRequests: Array<{ raw: string; serverId: number | string; method: string }> = [];

private onTuiConnect(ws) {
  // ... 现有逻辑 ...

  // 重放缓冲的 server request —— 逐条尝试发送，失败的保留在队列中
  const remaining: typeof this.pendingServerRequests = [];
  for (const buffered of this.pendingServerRequests) {
    const proxyId = this.nextProxyId++;
    try {
      const parsed = JSON.parse(buffered.raw);
      parsed.id = proxyId;
      ws.send(JSON.stringify(parsed));
      // send 成功后才建立 mapping（避免 send 失败时产生幽灵条目）
      this.serverRequestToProxy.set(proxyId, {
        serverId: buffered.serverId,
        connId: this.tuiConnId,
        method: buffered.method,
        timestamp: Date.now(),
      });
      this.log(`Replayed buffered server request: ${buffered.method} (server id=${buffered.serverId} → proxy id=${proxyId})`);
    } catch (e: any) {
      // send 失败，不建立 mapping，request 保留在队列中等待下次重连
      this.log(`Failed to replay buffered server request: ${buffered.method} (server id=${buffered.serverId}): ${e.message}`);
      remaining.push(buffered);
    }
  }
  this.pendingServerRequests = remaining;

  // 注意：已发送给旧 TUI 的 pending server request 不主动重发
  // 因为我们不确定 app-server 是否会重新发送
  // 旧的 mapping 保留，但 connId 检查会拒绝来自旧连接的响应
  // 如果 app-server 重发审批请求，将以新的 id 进入，走正常流程
}
```

### 改动 5：断连清理策略

TUI 断连时**不立即清空** `serverRequestToProxy`，而是保留一段时间（与现有的 `RESPONSE_TRACKING_TTL_MS` 一致，30 秒），之后超时清理：

```typescript
private retireConnectionState(connId: number) {
  // ... 现有清理逻辑 ...

  // 对于 serverRequestToProxy 中属于此 connId 的条目，
  // 不立即删除，保留用于拒绝可能到来的过期响应
  // 超时后由定期清理任务移除
  for (const [proxyId, pending] of this.serverRequestToProxy.entries()) {
    if (pending.connId === connId) {
      setTimeout(() => {
        if (this.serverRequestToProxy.get(proxyId)?.connId === connId) {
          this.serverRequestToProxy.delete(proxyId);
          this.log(`Expired stale server request mapping (proxy id=${proxyId}, method=${pending.method})`);
        }
      }, RESPONSE_TRACKING_TTL_MS);
    }
  }
}
```

### 改动 7：app-server 重连时清理审批状态

当 app-server 连接关闭并重新连接时，所有 pending 的审批请求 ID 失效（新 session 的 ID 空间独立）。需要在现有的 app-server close handler 中同步清理 `serverRequestToProxy` 和 `pendingServerRequests`：

```typescript
private onAppServerClose() {
  // ... 现有清理逻辑（reset turn state, clear response tracking）...

  // 审批状态是 session-scoped，app-server 重连后旧 ID 无效
  const pendingCount = this.serverRequestToProxy.size;
  const bufferedCount = this.pendingServerRequests.length;
  this.serverRequestToProxy.clear();
  this.pendingServerRequests = [];
  if (pendingCount > 0 || bufferedCount > 0) {
    this.log(`App-server reconnect: discarded ${pendingCount} pending + ${bufferedCount} buffered server requests`);
  }
}
```

### 改动 8：日志

为所有审批相关消息添加结构化日志：

```
[CodexAdapter] Server request: item/permissions/requestApproval (server id=42 → proxy id=100050, conn #3)
[CodexAdapter] Server request buffered (no TUI): item/fileChange/requestApproval (server id=43)
[CodexAdapter] Replayed buffered server request: item/fileChange/requestApproval (server id=43 → proxy id=100051)
[CodexAdapter] TUI → app-server: item/permissions/requestApproval response (proxy id=100050 → server id=42)
[CodexAdapter] Dropping stale server request response (proxy id=100050, expected conn #3, got #4)
[CodexAdapter] Expired stale server request mapping (proxy id=100050, method=item/permissions/requestApproval)
```

## 改动文件

| 文件 | 改动内容 |
|------|---------|
| `src/codex-adapter.ts` | 新增 server request 检测、`handleServerRequest()` 方法、TUI 响应回传路由（含 connId 验证）、缓冲与重放、TTL 清理 |

## 测试

### 单元测试

**Happy path：**

1. **Server request 被转发** — 具有 `{ id, method }` 的 app-server 消息被转发给 TUI（不被丢弃）
2. **Server request ID 被重映射** — server id 被替换为 proxy id 发给 TUI，mapping 被存储（含 connId）
3. **TUI 响应正确回传** — TUI 用 proxy id 的响应被重映射为 server id 发回 app-server
4. **原有 response 处理不受影响** — 现有的 response 处理逻辑仍然正常工作

**重连与边界情况：**

5. **TUI 未连接时 server request 被缓冲** — 消息存入 `pendingServerRequests`，不丢弃
6. **TUI 重连后缓冲的 server request 被重放** — 重连时立即发送，mapping 正确建立
7. **旧 TUI 连接的过期响应被拒绝** — connId 不匹配时 drop 并打日志
8. **重连后 app-server 重发审批请求** — 新 request 以新 id 正常处理，不与旧 mapping 冲突
9. **TTL 超时清理** — 超过 30 秒的 stale mapping 被自动清除

**并发与 ID 安全：**

10. **server request 和 client request 并发** — 两者共用 `nextProxyId` 计数器，ID 不冲突
11. **重复/未知 TUI 响应 ID** — 不在 `serverRequestToProxy` 中的响应 ID 不影响现有逻辑，走正常的 client response 路径
12. **notification 不受影响** — `TerminalInteractionNotification` 等无 `id` 的消息仍走现有 notification 路径

**Transport failure：**

13. **重放 send 失败** — 缓冲重放时 `ws.send` 抛异常，失败的 request 保留在 `pendingServerRequests` 中等待下次重连，**不产生幽灵 mapping**
14. **审批响应 send 失败** — `appServerWs.send` 失败时 mapping 不被删除，日志记录错误
15. **server request 发送失败回退到缓冲** — TUI 半关闭状态下 `handleServerRequest` 内 send 失败，request 回退到 `pendingServerRequests`
16. **ID 类型归一化** — TUI 返回 string 类型 ID（如 `"100050"`）时正确匹配到 number 类型的 mapping key
17. **app-server 重连清理** — app-server 连接关闭后 `serverRequestToProxy` 和 `pendingServerRequests` 被清空

### E2E 测试

**场景 1：正常审批流程**
1. 启动 AgentBridge 和 Codex
2. 让 Codex 执行需要审批的操作（如在 suggest 模式下运行 shell 命令）
3. **验收标准：** 审批提示必须出现在 TUI 中，用户可以操作
4. 批准后 Codex 继续执行并完成 turn；拒绝后 Codex 中止当前操作并返回可交互状态

**场景 2：重连期间的审批**
1. 在审批等待期间断开 TUI
2. 重连 TUI
3. **验收标准：** 以下两种结果之一均可接受：
   - 审批 UI 重新出现，用户可以继续审批操作
   - turn 被确定性地中断/失败，TUI 显示明确的错误状态（非无限 "Working"）
4. **不可接受：** Codex 无限期卡在 "Working" 状态且无任何用户可见的反馈

## 风险

- **ID 冲突**：server request 和 client request 共用 `nextProxyId` 单调递增计数器，不会冲突。app-server 的原始 server request ID 被重映射后不参与 proxy 命名空间。
- **未知的 server request method**：可能存在我们尚未发现的 server-to-client request。修复是通用的（任何 `{ id, method }` 消息），因此可以处理所有情况。
- **app-server 重连行为未知**：我们不确定 app-server 在 TUI 重连后是否会重发 pending 的审批请求。当前设计采用防御性策略：缓冲断连期间到达的 server request 并在重连时重放，但不主动重发已经发给旧 TUI 的 request。如果 app-server 重发，新 request 会以新 id 正常处理。
- **缓冲区大小**：`pendingServerRequests` 理论上可能无限增长。实际场景中，TUI 断连窗口很短（2.5 秒 grace period），且审批请求频率低，不太可能积压。可选加上限（如 50 条）。

## 后续跟进项

- **`serverRequest/resolved` 清理语义**：当代理收到 `serverRequest/resolved` notification 时，可能应该清理对应的 `serverRequestToProxy` mapping（而非仅依赖 TTL）。需要先确认该 notification 的 payload 是否包含对应的 request id，以及它和 TUI response 的时序关系。建议在实现核心修复后，通过抓取实际协议流量来验证。

## 不在本次范围内

- 将审批请求转发给 Claude（未来增强）
- stderr 镜像到 TUI/Claude（次要的可观测性改进）
- 通过 `--approval` 参数配置审批策略（互补功能，单独 PR）

## Review 记录

### v1 → v2 变更（基于 Codex 第一轮 review）

1. **[High] 修复重连期间审批请求丢失**：新增 `pendingServerRequests` 缓冲区，TUI 断连时缓冲 server request，重连后重放
2. **[Medium] 修正协议模型**：区分 server request（需回复）和 notification（无需回复），`TerminalInteractionNotification` 和 `serverRequest/resolved` 归类为 notification，审批响应 payload 不做假设（原样透传）
3. **[Medium] mapping 增加 connId 作用域**：`serverRequestToProxy` 存储 `connId`，拒绝来自旧连接的过期响应，与现有 response mapping 的隔离策略一致
4. **[Medium] 补充边界测试**：新增 TUI 未连接时缓冲、重连重放、过期响应拒绝、TTL 清理、并发 ID 安全等测试用例

### v2 → v3 变更（基于 Codex 第二轮 review）

1. **[High] 修复 delete-before-validate bug**：`onTuiMessage` 中 `serverRequestToProxy.delete()` 移到 connId 验证通过之后，避免旧连接的过期响应错误删除 mapping 导致正确响应无法匹配
2. **[Medium] 统一重连语义**：移除"迁移 pending request 到新 connId"的描述，明确策略为仅重放缓冲的 server request，不重发已发给旧 TUI 的 request
3. **[Medium] 收紧 E2E 验收标准**：明确两种可接受的重连结果（审批 UI 恢复 或 确定性失败），明确不可接受的结果（无限卡死）
4. **[Low] `serverRequest/resolved` 提升为跟进项**：从"不在范围内"移到"后续跟进项"，说明需要协议流量验证后决定清理策略

### v3 → v4 变更（基于 Codex 第三轮 review）

1. **[Medium] 缓冲重放逐条容错**：`pendingServerRequests` 重放改为逐条 try-catch，send 失败的保留在队列中等待下次重连，不再整体清空
2. **[Low] 审批响应发送容错**：`appServerWs.send` 失败时不删除 mapping（保留以便重试），记录错误日志

### v4 → v5 变更（基于 Claude + Codex 最终并行 review）

1. **[High, Claude] ID 类型归一化**：`onTuiMessage` 中 server request 响应的 ID 查找增加 string→number 归一化，与现有 `handleAppServerResponse` 的处理一致。不修复会导致 TUI 返回 string ID 时 lookup 失败，重现卡死
2. **[High, Codex] server request 内部发送**：`handleServerRequest` 改为内部直接 `tuiWs.send()`，send 失败时回退到缓冲。不再返回 payload 给外层 handler（避免外层 "log and drop" 路径丢失审批请求）。send 成功后才建立 mapping（避免失败时产生幽灵条目）
3. **[Medium, Codex] 重放 mapping 顺序修正**：重放时 `serverRequestToProxy.set()` 移到 `ws.send()` 成功之后，失败时不产生幽灵 mapping
4. **[Medium, Codex] app-server 重连清理**：新增改动 7，app-server 连接关闭时清空 `serverRequestToProxy` 和 `pendingServerRequests`（审批状态是 session-scoped，旧 ID 在新 session 中无效）
5. **[Low, Claude] 注释修正**：审批响应发送失败时的注释从"以便重试"改为"保留至 TTL 过期清理"（实际无主动重试机制）
