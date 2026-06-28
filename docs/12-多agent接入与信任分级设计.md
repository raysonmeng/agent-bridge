# 12 · 多 agent-type 接入 + 信任分级 + 细粒度权限（设计 / 真相源）

> 范围：本文是 authz 簇（backlog ①②④）的设计真相源。owner=Claude（本机房主侧）。
> 配套并行：aikey 侧负责 ③DM / WS 心跳 / 成员枚举过滤 / ⑥ 非破坏部署（独立 design doc）。
> **实现 scope（房主 2026-06-28 拍板：只做最高价值 1-2 项）**：
> - ① Codex / 多 agent-type 接入 v3 房间 → **实现**（最高价值，解锁公司 mini）
> - ② 成员信任分级 → **视配额实现**
> - ④ 细粒度权限 → **仅设计（docs-only），不动代码**
> 实现分支：`feat/v3-codex-join`（base=integration/v3-all，park 等宣发，不堆进集成分支）。

---

## 0. 背景与现状（代码地图摘要）

v3 房间 = 独立控制面 broker（WS:4700）。每个 pair 的 daemon 启动时起**一个** `RoomBridge`，以登录身份连 broker、订阅 cwd→room，把房间事件注入活的 **Claude** 会话。**Codex 当前完全不接 broker**——它只是 daemon 通过 `CodexAdapter.injectMessage` 驱动的本地 partner。

关键现有接缝（已为多 agent-type 预留，但没人填）：
- `PresenceMeta`（presence.ts:12）：`{ agentType?, host?, capabilities?, budgetHint? }`，全链路打通，`renderRoomEvent` 已读 `payload.host`（room-bridge.ts:202）。
- `RoomBridgeDeps.emit`（room-bridge.ts:24）：bridge 不认识 Claude，只调 `emit(text)`——**注入出口是可替换回调**。
- `BrokerClient`（broker-client.ts）：edge 客户端，构造时收 `presence`，`agentType` 目前在 room-bridge.ts:252 **硬编码 "claude"**。
- broker 授权（broker.ts:351 subscribe → isMember:687）：**只认 `identity.id`**，agentType 仅 presence meta 透传，路由/授权从不读。
- `AgentAdapter` 契约（agent-adapter.ts:24，已冻结未落地）：`register / onCompletion / receiveIntoSession`——Codex 接入即实现 `receiveIntoSession`（= `injectMessage`）。
- session 记账已按 `(workspace, agentType)` 分键（store.ts:64），Codex resume 可直接复用。

**核心判断（ponytail）**：① 不是新建子系统，而是把现有 RoomBridge 泛化成 agent-type 无关 + 换注入出口。broker/presence/store 协议层**基本不动**。

---

## 1. ① Codex / 多 agent-type 接入（实现）

### 1.1 需求
- 活的 Codex 会话能像 Claude 一样：连 broker、按 cwd→room 订阅、收房间事件（task_completed / member_joined/left / chat @ 提及）注入会话。
- Codex 在房间里是**独立身份**（独立 token + membership + `agentType:"codex"`），不与 Claude 共用 id。
- fail-inert：无 token / 未登录 / 无房间 / broker 不可达 → 绝不破坏 v1 单机 Claudex 桥。

### 1.2 技术方案（最省力路径）
复用 `RoomBridge` + `BrokerClient`，只换两处 + 解决一个 Codex 特性：

1. **泛化 RoomBridge 的 agentType**（room-bridge.ts，共享文件，我先动）
   - `RoomBridgeDeps` 增 `agentType?: string`（默认 `"claude"`，向后兼容）。
   - room-bridge.ts:252 硬编码 `presence:{agentType:"claude"}` → `presence:{agentType: deps.agentType ?? "claude", capabilities: deps.capabilities}`。
   - 去重 SEEN set、INERT 逻辑、renderRoomEvent 全部不变（已 agent 无关）。
   - **插入锚点**：`startRoomBridge` 函数体内 `new BrokerClient({...})` 调用处（broker-client 构造参数）。

2. **daemon 单 bridge → per-agent-type**（daemon.ts，共享文件，我先动）
   - `let roomBridge: RoomBridgeHandle | null`（daemon.ts:240）→ `const roomBridges = new Map<string, RoomBridgeHandle>()`。
   - boot 末尾（daemon.ts:2497）现有 Claude bridge 实例化保留（emit→emitToClaude），**新增** Codex bridge 实例化：
     ```
     void startRoomBridge({
       cwd, log, agentType: "codex", capabilities: ["implement","execute"],
       emit: (text) => enqueueCodexRoomInject(text),   // 见 1.3 排队
       dbPath: <codex 独立 collab db / token>,          // 见 1.4 身份
     }).then(h => roomBridges.set("codex", h))
     ```
   - 关停（daemon.ts:2402）：遍历 `roomBridges.values()` 各 `stop()` 后 `clear()`。
   - **插入锚点**：`roomBridge` 声明处（:240）、boot 实例化处（:2497）、shutdown 处（:2402）。

3. **Codex 注入排队（唯一真新增逻辑）**（codex-adapter.ts，我独占文件）
   - 问题：`codex.injectMessage` 在 `turnInProgress` 时返回 null（codex-adapter.ts:528）——Claude 是 push 到 socket 无此限制，Codex 房间事件可能丢。
   - 方案：复用现有 `ResumeInjectionQueue`（daemon.ts:169）模式或在 codex-adapter 加一个轻量 `roomInjectQueue`：turn 结束事件（已有 turn-complete 信号）触发 flush。
   - `enqueueCodexRoomInject(text)`：`canInject()` 真 → 立即 `injectMessage`；否则入有界队列（cap，drop-oldest + log），下次 turn 空闲 flush。
   - **不要用 steerMessage**（会污染正在跑的 turn 语义）；房间事件是旁路通报，排队等空闲注入更对。

### 1.3 出站（Codex → room 发言/完成）
- **MVP 不做 Codex 主动 room_say 工具**（Codex 工具面是透明拦截，加出站通道复杂；房主 scope 是 1-2 项，优先入站）。
- **完成事件复用现有 hook**：PR7 的 `abg publish`（Stop hook）是 agent 无关 CLI——Codex 的完成只要 Codex 侧也挂同样的 Stop hook + 有 Codex 的 collab 身份，就能发 `task_completed` 进房间，**零新代码**。设计文档标注，实现期验证。

### 1.4 Codex 独立身份/token
- Codex 需要自己的 broker 身份（`agentId`，type=codex）+ token + room membership。
- 复用现有 onboarding 原语：`abg auth issue --id codex@<host>`（broker 签）+ `abg room invite <room> codex@<host>`（addMember）。
- daemon 侧 Codex bridge 读 Codex 的 token：`<collabDir>/auth-token-codex`（与 Claude 的 `auth-token` 分开），或 env `AGENTBRIDGE_CODEX_TOKEN`。**collab-store.ts 加 `readAuthToken(dbPath, agentType?)` 变体**（我独占文件）。
- fail-inert：无 Codex token → Codex bridge 直接 INERT，Claude bridge 不受影响。

### 1.5 broker 是否要改？→ **否（① 范围内）**
- 授权是 id-based（isMember 查 membership 数组）。只要 Codex 的 id 被 invite 进房，broker 订阅授权天然放行，**broker.ts 不用动**。
- agentType 只走 presence meta 渲染（对端看到 "codex 加入"），协议层零改。
- ✅ 这意味着 broker.ts 的共享文件争用在 ① 范围内**消失**——我只动 room-bridge.ts + daemon.ts。

---

## 2. ② 成员信任分级（视配额实现）

### 2.1 需求
房主预授权"可信成员"，使其房间消息不必每条都人工确认放行（呼应安全前缀注入闸：room-bridge.ts renderRoomEvent 的 UNTRUSTED 前缀）。

### 2.2 方案
- Store 加每成员信任级：`membership` 记录从 `agentId: string` 升级为 `{ agentId, trust: "untrusted"|"trusted" }`（默认 untrusted，向后兼容：旧记录视为 untrusted）。
  - **store.ts / sqlite-store**：`addMember(roomId, agentId, trust?)`、`getMemberTrust(roomId, agentId)`。
  - room-service / room-manager：`setMemberTrust(roomId, agentId, trust)`（仅房主可调）。
- broker 在事件扇出时把发送方 trust 放进 envelope（`from.trust`），edge `renderRoomEvent` 据此决定前缀：trusted → 去掉 UNTRUSTED 前缀（仍保 source="room"）；untrusted → 维持现状。
- CLI：`abg room trust <roomId> <agentId>` / `abg room untrust ...`（房主 only，broker 端校验身份===createdBy，参照 @all 房主闸门）。
- **安全红线**：trusted 只去前缀提示，**绝不**让外部消息变成"可执行指令"——注入仍是旁路通报，破坏性动作仍需人工确认。这条写死在 docs + 注释。

### 2.3 文件归属（我独占 + 共享）
- 独占：room-manager / room-service / collab-store / sqlite-store（store 信任字段）。
- 共享 room-bridge.ts：renderRoomEvent 前缀闸（我先动，已在 ① 的锚点区）。

---

## 3. ④ 细粒度权限（docs-only，不实现）

### 3.1 设计（留作真相源，不动代码）
- 目标：per-room per-agent 的能力位（可发言 / 可 @所有人 / 可 publish 完成 / 可邀请）。
- 模型建议：membership 记录再加 `caps: string[]`（位集），broker 授权层在 subscribe/publish/mention 各检查点查 caps。
- 与 ② 同属 authz：实现时应与 trust 字段同一次 store schema 迁移，避免两次改 membership 结构。
- broker.ts 授权层（subscribe:351 / @all 闸门 / publish）会需要新增 caps 检查维度——这是与 aikey 心跳/枚举改动的潜在 broker.ts 重叠点，**实现期再议**（④ 现不实现，无冲突）。
- 现状缺口诚实标注：今天**不做**，房间授权仍是"成员即全权"（除 @所有人 房主闸门）。

---

## 4. 共享文件清单 + 交叉核对锚点（给 aikey）

| 文件 | 我（① ②）动的区域 | aikey 动的区域 | 冲突治理 |
|---|---|---|---|
| `room-bridge.ts` | startRoomBridge 的 BrokerClient 构造（agentType 参数化）+ renderRoomEvent 前缀闸（②） | DM 注入渲染 | **我先落**，aikey 后 rebase；开码前对这两区域 cross-check |
| `daemon.ts` | roomBridge 单→Map（:240/:2497/:2402）+ Codex 注入排队接线 | 心跳/枚举如需 daemon 接线 | **我先落**，aikey 后 rebase |
| `broker.ts` | **① 不动**（id-based 授权够用）；④ 不实现 | 心跳/枚举/to[] 路由 | ① 范围内**无重叠** ✅ |

我独占（aikey 不碰）：codex-adapter.ts / presence.ts / room-manager / room-service / collab-store / sqlite-store(信任字段)。
aikey 独占（我不碰）：claude-adapter.ts / cli/* / daemon-lifecycle.ts / budget。

---

## 5. 实现顺序 + 验收

1. Phase A：本设计文档 → 发 aikey 交叉核对 room-bridge.ts/daemon.ts 锚点不相交。
2. ① 实现（room-bridge 泛化 → daemon per-agent-type → codex-adapter 排队 → collab-store codex token → 身份 provisioning）。
3. ① 测试：room-bridge agent-type 参数化单测；Codex bridge fail-inert（无 token）单测；Codex 注入排队（turnInProgress 时入队、空闲 flush）单测；多机/双 agent Docker E2E（参照 §13 harness，加一个 codex 容器收 task_completed）。
4. ②（视配额）：store 信任字段迁移 + setMemberTrust + 前缀闸 + CLI + 测试。
5. 每步双轮 cross-review（连续两轮0）+ `bun run check` exit0 + build:plugin。不直推 master。
6. 验收：真机/Docker 跑通"Codex 会话收到房间 task_completed 注入"即 ① 达标。

## 6. 不做 / 边界（诚实标注）
- ④ 细粒度权限：仅设计。
- Codex 主动 room_say 工具：MVP 不做（仅入站 + 完成事件走 hook）。
- 多 agent-type 中的"其它 agent"（gemini 等）：本轮只接 Codex；RoomBridge 泛化后其它 agent-type 是同模式扩展，留 backlog。
