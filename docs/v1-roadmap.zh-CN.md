# AgentBridge v1 路线图

> v1 的目标是在当前架构下优化体验，不做架构重构。

## 1. 当前 v1.0 状态

AgentBridge v1.0 已实现的能力：

- **双向消息桥**：Claude Code 和 Codex 之间可以互相发送消息
- **MCP 集成**：通过 MCP stdio 连接 Claude Code，提供 `reply` 工具
- **Daemon 架构**：前台 `bridge.ts` + 后台 `daemon.ts` 分离，Claude Code 退出后 daemon 和 Codex 保持运行
- **自动启动**：`bridge.ts` 自动检测并拉起 daemon，daemon 自动启动 Codex app-server
- **TUI 代理**：透明转发 TUI 流量，拦截 `agentMessage`
- **消息来源标记**：`source` 字段防止消息回环
- **Channel 集成**：Codex 消息以 `<channel>` 标签注入 Claude Code 会话

当前限制（v1.0）：

- 仅转发 `agentMessage`，不转发 `commandExecution`、`fileChange` 等中间事件
- 单 Claude 连接，新连接替换旧连接
- 单 Codex 线程
- 所有消息全量转发，无过滤
- Codex turn 进行中时无注入控制，仅打 warning
- 无协作模式概念，只是裸桥

## 2. v1 优化目标

v1 优化遵循三个原则：

1. **不改架构** — 保持当前单 Claude + 单 Codex + 单 thread 的主路径不变
2. **体验优先** — 每个改进都应让用户明显感觉到"桥更好用了"
3. **独立可发** — 每个 v1.x 版本独立交付，不互相依赖

v1 的设计哲学：**让 agent 自己做决策，bridge 只做极轻兜底**。不在桥里写复杂规则引擎或调度系统，而是通过提示词契约引导 agent 的行为，bridge 仅做标记解析和最小化兜底。

用三个词概括 v1 的方向：**降噪、控回合、定角色**。

- **v1.1** 解决"发什么消息"
- **v1.2** 解决"什么时候发消息"
- **v1.3** 解决"双方各自扮演什么角色"

## 3. v1.1 Smart Message Filtering

### 问题

当前所有 `agentMessage` 全量转发给 Claude。大量低价值的状态确认、日志读取、中间步骤消息淹没了真正重要的内容（任务委派、审查请求、阶段完成、阻塞报告）。Claude 会话噪音很大。

### 方案：Prompt Contract + Marker Protocol + 轻量桥接兜底

核心思路：不在代码里写复杂的过滤规则引擎，而是让 AI agent 自己判断什么值得转发。agent 本身就是最强的语义理解模型，应该让它在源头做决策，而不是在桥里做事后补救。

#### A. Codex 侧：Bridge Messaging Contract

在每次 Claude → Codex 转发消息时，附带一段简短的 bridge contract reminder，要求 Codex：

- 只在关键节点发送 `agentMessage`（决策请求、review、完成、失败、阻塞）
- 不要把中间琐碎步骤（文件浏览、日志读取、状态确认）放进 `agentMessage`
- 使用标记前缀标注消息优先级：
  - `[IMPORTANT]` — 需要 Claude 决策、review、有阻塞或完成报告
  - `[STATUS]` — 阶段性进展更新（含中间事件摘要：查了哪些文件、跑了什么命令、当前阶段），不需要立即响应
  - `[FYI]` — 背景信息，通常不需要转发
- 可选使用 `@codex:` / `@claude:` 前缀表达消息意图方向（v1 单对端下作为语义约定，不做真正路由）

> 为什么不改 Codex 系统提示？因为当前没有 Codex system prompt 的配置入口，最现实的做法是在转发消息时附带 contract reminder，确保约束在整个对话过程中持续生效。

#### B. Claude 侧：Channel Instructions 更新

在 Claude channel instructions 中加入 marker 解释：

- `[IMPORTANT]` — 认真处理并优先响应
- `[STATUS]` — 作为进度上下文理解，不必每条都立即回复。`[STATUS]` 也承载中间事件摘要（命令执行、文件变更、测试结果等），帮助理解 Codex 的工作进度
- `[FYI]` — 视为背景信息，除非明显需要跟进

#### C. Bridge 侧：轻量 Marker-Aware 过滤

Bridge 只做极轻的标记解析和兜底，不做复杂分类：

| 标记 | Bridge 行为 |
|------|-------------|
| `[IMPORTANT]` | 立即转发 |
| `[STATUS]` | 进入 summary buffer，合并后转发 |
| `[FYI]` | 默认丢弃（debug/full 模式下转发） |
| 无标记 | 默认立即转发（兼容无标记消息） |

**Summary flush 条件：**
- 缓存 STATUS 条数达到 3 条
- 距上一条 STATUS 超过 15 秒
- 收到 `[IMPORTANT]` 消息前先 flush
- Turn 完成时 flush
- Claude 重连时 flush

#### 模式配置

默认启用 `filtered` 增强模式：

- `filtered`（默认）— Prompt Contract + Marker 过滤 + Summary 合并
- `full` — 全量转发，保持原始行为（用于调试）

### 方案优势

- **让最强模型做决策**：agent 自己理解上下文，比任何规则引擎都准确
- **代码改动极小**：主要是提示词和轻量标记解析，不引入重度架构逻辑
- **体验自然**：agent 在源头就做了语义压缩，而不是桥里事后删减
- **为未来留空间**：v2/v3 可以将 marker 语义正式化为协议的一部分

### 已知局限

- Codex 不一定总是遵守 contract 打标（提示词是软约束，不是硬保证）
- Marker 语义可能漂移（该标 IMPORTANT 的可能标成 STATUS）
- v1.1 接受这种不完美，因为目标是"体验明显变好"而非"形式上绝对正确"

### 改动范围

- `claude-adapter.ts`：更新 channel instructions
- `daemon.ts`：消息转发路径增加 marker 解析 + summary buffer/flush
- Claude → Codex 转发时附带 contract reminder
- 预计 1-2 天

### 预期效果

- 立刻减少 Claude 会话噪音
- 用户能聚焦于真正需要关注的消息
- Agent 之间的沟通更有目的性和结构化

## 4. v1.2 Bidirectional Coordination

### 问题

当前 agent 之间的消息传递没有协调机制，导致双向都存在问题：

- **Claude → Codex**：Codex 正在执行任务（turn in progress）时，Claude 的回复被注入，可能导致 Codex 在错误的上下文中理解新消息、任务被打断或产生混乱输出
- **Codex → Claude**：Codex 在 Claude 正在思考/回应时不断推送低价值消息，打断 Claude 的注意力
- 当前代码已能检测 `turnInProgress` 状态，但只是打 warning，没有实际控制
- 未来多 agent 场景下，协调需要是双向甚至多向的

### 方案：Hard Turn Signals + Soft Attention Window + Minimal Busy Guard

协调是**双向**的，但两个方向的实现机制不对称，因为技术约束不同：

- **Codex 忙碌**：有硬信号（`turnInProgress`），bridge 能可靠检测
- **Claude 忙碌**：无法可靠检测（Claude 没有等价的 turn 生命周期），改用**软性 attention window**

统一概念：每个 agent 都有协作状态（`busy` / `ready` / `attention-window`），但实现不强求对称。

#### A. Claude → Codex 方向：Hard Turn Signals

利用现有的 `turnInProgress` 检测能力，向 Claude 推送状态通知：

- **Turn 开始时**：bridge 推送 "⏳ Codex is working on the current task. Wait for completion before replying."
- **Turn 完成时**：bridge 推送 "✅ Codex finished the current turn. You can reply now if needed."
- **Claude instructions**：收到 busy 通知后不调用 `reply`，等 ready 后再回复
- **Busy reject 兜底**：万一 Claude 仍然调用 `reply`，bridge 返回 `{ success: false, error: "Codex is currently executing a turn." }`

> 需要补一个 `turnStarted` 事件从 `codex-adapter.ts` 上抛。

#### B. Codex → Claude 方向：Soft Attention Window

Claude 侧没有硬信号，改用 **attention window**（发言窗口）机制：

- 当以下事件发生时，认为 **Claude 持有 floor**：
  - Codex 发出 `[IMPORTANT]` 消息
  - Codex turn 完成并发出结果
  - Bridge 推送 "Codex finished" 通知
- 从那一刻起，进入一个短暂的 `claudeAttentionWindow`（如 15-20 秒，或直到 Claude 调用一次 `reply`）
- 在这个窗口内：
  - `[IMPORTANT]` — 仍然直通（真正紧急的不应被挡）
  - `[STATUS]` — 进入 buffer，不立即推送
  - `[FYI]` — 继续 drop
- 窗口结束后恢复正常转发

这样 Claude 获得了"思考和回应的空间"，Codex 不会用进度噪音不断打断，而 bridge 不需要知道 Claude 内部是否真的在思考。

#### C. 统一概念模型（为未来多 agent 留空间）

虽然 v1 只有两个 agent，但概念上统一为：

| Agent | 协作状态 | 检测方式 |
|-------|----------|----------|
| Codex | `busy` / `ready` | 硬信号：`turn/started` / `turn/completed` |
| Claude | `ready` / `attention-window` | 软信号：由对话节奏推断 |

未来 v2 多 agent 场景下，每个 agent 都有自己的协作状态，机制相同只是扩展到 N 个。v1 不搭框架，只做最小实现。

### 方案优势

- **真正双向**：不只是 Claude → Codex 单向控制
- **统一概念、不对称实现**：承认两侧技术约束不同，不强装对称
- **代码改动极小**：turnStarted 事件 + busy guard + attention window timer
- **为多 agent 留空间**：概念上可扩展，但 v1 不搭重框架

### 已知局限

- Claude attention window 是启发式的，不是精确的忙碌检测
- Claude 软约束不一定总是遵守，所以 Codex → Claude 方向没有硬 reject
- 不支持消息队列和自动重发

### 为什么不做消息队列

- Queue 会引入更多状态语义（排几条、什么时候 flush、用户取消怎么办）
- 容易滑向 generalized coordination framework
- v1.2 的双向目标是：inform → respect floor → minimal reject

### 改动范围

- `codex-adapter.ts`：补 `turnStarted` 事件上抛
- `claude-adapter.ts`：更新 channel instructions 加入双向协调行为
- `daemon.ts`：订阅 turn 事件推通知 + busy guard + attention window 逻辑
- 预计 2-3 天

### 预期效果

- 双向协调：两个方向的消息冲突都得到控制
- Claude 获得思考空间，不被 Codex 进度噪音打断
- Codex 的执行不被 Claude 中途注入打乱
- 交互更有序、更自然

## 5. v1.3 Role-Aware Collaboration and Thinking Patterns

### 问题

当前 AgentBridge 只是一个裸桥，存在两层缺失：

1. **角色缺失**：Claude 和 Codex 没有默认的角色分工，用户需要每次手动描述期望的协作方式
2. **协作过程缺失**：两个 agent 不知道如何共同思考问题——不会独立分析、不会交叉验证、不会辩论分歧，容易变成一方指挥另一方执行

### 方案：Role Contract + Thinking Patterns

> **范围说明**：v1 中，这些模式应用于当前单 Claude + 单 Codex 的协作路径。在概念上，它们也兼容未来的多 agent 协作场景——模式的定义不绑定"恰好两个参与者"。

v1.3 覆盖两个正交维度：

- **Role Contract**：谁更偏向做什么（职责分工）
- **Thinking Patterns**：怎么互动地产出更好的结论（协作过程）

#### A. 默认角色分工（Role Contract）

通过 bridge contract 和 channel instructions 建立默认角色：

**Claude 侧默认角色：**
- Reviewer — 审查代码和方案质量
- Planner — 制定计划和约束
- Hypothesis Challenger — 在调试中质疑和验证假设

**Codex 侧默认角色：**
- Implementer — 执行代码编写和修改
- Executor — 运行命令和测试
- Reproducer / Verifier — 复现问题和验证修复

关键约束：
- 不要把对方当成被动下属——角色不等于上下级
- 当任务需要交叉验证时，双方应该能互相 challenge

#### B. 协作思考模式（Thinking Patterns）

定义 3 个核心协作思考模式，根据任务类型默认启用：

##### 模式 1：Independent Analysis & Convergence

适用于：架构判断、方案选型、代码 review、风险评估

5 步协议：
1. **独立思考**：双方各参与者各自先形成自己的判断，不受其他参与者影响
2. **交换结论**：各参与者交换各自的分析和结论
3. **识别共识**：找出一致的部分，直接采纳
4. **辩论分歧**：对不一致的部分，用证据和推理辩论，而不是重复立场
5. **收敛决策**：达成共识，或者明确记录剩余的分歧与不确定性

关键约束：
- 不要镜像其他参与者的结论而没有自己的分析
- 如果不同意，明确说出来并解释原因
- 如果被说服，明确说"我被说服了"并更新结论
- 如果不确定性仍然存在，总结未解决的点而不是假装共识

##### 模式 2：Architect → Builder → Critic

适用于：明确的工程实现任务

流程：
1. 一个或多个参与者给出约束、边界、验收标准
2. 一个或多个参与者实现或推进
3. 其他参与者回到 critic/verifier 角色审查
4. 形成"方案 + 实现 + 反证"的闭环
5. 角色根据任务需要分配，不绑定到固定 agent

##### 模式 3：Hypothesis → Experiment → Interpretation

适用于：bug 排查、flaky tests、runtime 异常、性能问题

流程：
1. 一个参与者提出假设
2. 另一个参与者负责最小验证实验
3. 各参与者根据结果更新判断
4. 重复直到定位问题

#### C. 任务类型与模式映射

不需要用户手动选择模式。根据任务的自然语义，bridge contract 引导双方自动进入对应模式：

| 任务类型 | 触发语义 | 默认模式 |
|----------|----------|----------|
| 方案/架构讨论 | "先分别想想" / "你们各自分析" / 设计决策类问题 | Independent Analysis & Convergence |
| review | "review this" / "check this" | Independent Analysis & Convergence |
| 实现 | "implement" / "build" / "code this" | Architect → Builder → Critic |
| 调试 | "debug" / "why is this failing" | Hypothesis → Experiment → Interpretation |

#### D. 显式句式（不新增 marker）

不新增正式 marker（v1.1 的 marker 已经够多），而是在 contract 中要求使用显式句式：

- `My independent view is: ...`（我的独立判断是）
- `I agree on: ...`（我同意的部分）
- `I disagree on: ... because ...`（我不同意的部分及原因）
- `I am persuaded because: ...`（我被说服了，因为）
- `Current consensus: ...`（当前共识）
- `Remaining uncertainty: ...`（剩余的不确定性）

### 方案优势

- **零额外架构成本**：本质是提示词调整
- **真正的协作**：不是一方指挥另一方执行，而是双方独立思考后交叉验证
- **降低从众**：要求独立分析，提高发现盲点的概率
- **与 v1.1/v1.2 统一**：同样是 prompt contract 主导
- **持续可迭代**：可以不断添加新的思考模式

### 已知局限

- Agent 可能不总是精确遵守角色边界和思考协议
- 思考模式的自动触发依赖 agent 对任务类型的理解
- 简单执行类任务不需要辩论流程，过度协作反而降低效率
- v1 不做辩论轮次管理——由 agent 自己判断何时收敛

### 改动范围

- `claude-adapter.ts`：channel instructions 加入角色分工 + 思考模式
- Claude → Codex 转发时的 contract reminder 加入协作协议
- 预计 2-3 天

### 预期效果

- 用户感觉"这不只是一个裸桥，而是两个能独立思考、互相 challenge 的协作者"
- 减少"一方盲从另一方"的情况
- 方案质量更高，因为经过了交叉验证
- 调试效率更高，因为有结构化的假设-实验循环

## 6. 产品分发与快速启动

### 目标

让用户从"clone 仓库、装依赖、改配置"变成一行命令就能用。

### 方案：CLI-First

以 npm package 作为分发渠道，`agentbridge` CLI 作为产品界面。不先做 Claude Code extension 或 plugin——CLI 更通用，能覆盖整个本地链路的 bootstrap。

**核心命令：**

| 命令 | 用途 |
|------|------|
| `agentbridge init` | 检查环境（Node/Bun、Claude Code、Codex）、写入 MCP 配置、生成项目文件骨架 |
| `agentbridge doctor` | 诊断环境问题（依赖缺失、端口冲突、配置错误） |
| `agentbridge start` | 启动 daemon（或复用已有） |
| `agentbridge stop` | 停止 daemon |
| `agentbridge status` | 查看 daemon、agent、连接状态 |
| `agentbridge attach` | 连接 Codex TUI |

**安装体验：**

```bash
# 首次安装和配置
npx agentbridge init

# OAuth 用户（实时 push 模式）
claude --dangerously-load-development-channels plugin:agentbridge@agentbridge

# API key 用户（tool pull 模式，无需特殊标志）
claude
```

> `npx` 作为安装器，不作为长期运行时入口。`init` 完成后 MCP 配置指向本地稳定的可执行入口，避免每次启动都临时解析远程包。

**技术难点：**

- **Bun 依赖**：当前代码依赖 Bun 运行时，npm 生态默认 Node。需要去 Bun 化或打包成独立可执行文件
- **MCP 配置写入**：需要安全地合并到用户已有的 `~/.claude/.mcp.json`，处理已有配置和错误恢复
- **Codex 发现**：CLI 需要检测 `codex` 命令是否存在、版本是否兼容
- **Daemon 生命周期**：启动、复用、僵尸 PID、端口冲突的产品化处理
- **跨平台**：macOS / Linux 优先，Windows 需要额外适配

**不先做的形态：**

- Claude Code extension / packaged channel — 等 CLI 稳定后再做薄封装
- 桌面 App — v3/v4 的事

## 7. 协作意识注入

### 问题

每个 agent 默认都认为自己是唯一在工作的。它不知道有其他 agent 在协作，也不知道该怎么和别人配合。

### 方案

Bridge 连接后，自动向每个 agent 注入两件事：

1. **你不是一个人** — 告诉它现在有其他 agent 在跟它协作，是谁、是什么类型
2. **怎么协作** — 告诉它协作规则：消息标记（v1.1）、轮次协调（v1.2）、角色分工和思考模式（v1.3）

用户不需要手动写任何额外文件。这些由 bridge 在以下时机自动完成：

- **Claude 侧**：通过 channel instructions 注入（`claude-adapter.ts`），Claude 启动时就知道协作规则
- **Codex 侧**：通过 bridge contract reminder 注入（每次转发消息时附带），持续强化协作意识

### 注入内容

| 注入给 | 内容 |
|--------|------|
| Claude | "你正在通过 AgentBridge 与 Codex 协作。Codex 是一个执行型 agent，擅长代码编写和命令执行。消息使用 [IMPORTANT]/[STATUS]/[FYI] 标记。Codex 忙时不要发消息。遇到设计决策先独立分析再和 Codex 对比结论。" |
| Codex | "你正在通过 AgentBridge 与 Claude 协作。Claude 是一个分析型 agent，擅长审查和规划。只在关键节点发送 agentMessage，使用 [IMPORTANT]/[STATUS]/[FYI] 标记。有分歧时用证据辩论，不要盲从。" |

### 关键原则

- **自动注入，零用户配置** — 用户不需要写提示词文件，bridge 负责一切
- **v1.1/v1.2/v1.3 的内容统一在这里注入** — 消息标记、轮次协调、角色分工不是分散的，而是作为一个完整的协作意识包注入
- **未来多 agent 时自动扩展** — 新 agent 加入后，bridge 自动告诉所有参与者"现在多了一个队友"

## 8. 双模式消息传输：Channel Push + Tool Pull

### 问题

当前 bridge 完全依赖 Claude Code 的实验性 Channel 能力（`notifications/claude/channel`）来实时传递 Codex 消息。这要求用户必须使用 `--dangerously-load-development-channels` 标志启动 Claude Code，而该标志又强制要求 OAuth 认证。使用 API key 认证的用户完全无法使用 AgentBridge。

这是一个硬性的使用门槛。API key 用户占 Claude Code 用户的重要比例，对一个本地开发工具强制要求 OAuth 是不必要的障碍。

### 方案：双模式并行，自动检测切换

在同一个 bridge 内支持两种并行的消息传递模式，共享相同的 daemon、消息队列和回复路径：

**Channel Push 模式（OAuth 用户）：**
- Channel 能力可用时，通过 `notifications/claude/channel` 实时推送消息
- 与当前 v1.0 行为完全一致
- Claude 自动收到 `<channel>` 标签注入的消息
- 无需用户操作，消息自动出现

**Tool Pull 模式（API key 用户）：**
- Channel 能力不可用时，消息在 bridge 侧排队
- 提供 `get_messages` 工具，Claude 主动调用获取待处理消息
- 以结构化的工具返回值呈现排队消息
- 更新 MCP instructions，告知 Claude `get_messages` 工具的用法和使用时机

### 检测策略

Bridge 启动时自动检测可用模式并选择：

1. MCP server 始终在 capabilities 中声明 `experimental: { "claude/channel": {} }`
2. 在 MCP 初始化握手期间，检查客户端 capabilities 是否支持 channel
3. 检测到 channel 支持 → 使用 push 模式，消息通过 `notifications/claude/channel` 实时推送
4. 未检测到 channel 支持 → 使用 pull 模式，消息排队等待 `get_messages` 工具拉取

备选检测方式：

- 始终注册 `get_messages` 工具（两种模式都可用）
- 同时尝试发送 channel 通知
- 支持环境变量 `AGENTBRIDGE_MODE=push|pull|auto` 作为显式覆盖

### Pull 模式设计

#### 消息队列

- Bridge 维护内存消息队列，存储待处理的 Codex 消息
- 消息从 daemon 到达时追加到队列
- Claude 调用 `get_messages` 时，返回所有排队消息并清空队列
- 队列大小受 `AGENTBRIDGE_MAX_BUFFERED_MESSAGES` 限制（已有配置，默认 100）

#### `get_messages` 工具

返回上次调用以来的所有新消息：

```json
{
  "name": "get_messages",
  "description": "Check for new messages from Codex. Call this periodically or when you expect a response.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

有消息时返回格式化的消息列表：

```
[2 new messages from Codex]

---
[1] 2024-01-15T10:30:00Z
Codex: I've finished implementing the feature...

---
[2] 2024-01-15T10:30:05Z
Codex: Tests are passing...
```

无消息时返回：

```
No new messages from Codex.
```

#### Instructions 更新

Pull 模式下，MCP server instructions 应告诉 Claude：

- `get_messages` 工具可用于检查 Codex 消息
- 发送 reply 后调用 `get_messages` 检查回复
- 用户询问 Codex 状态或进展时调用 `get_messages`
- `reply` 工具在两种模式下行为完全一致

#### Reply 响应中的消息提示

当有待处理消息时，`reply` 工具的返回中附带提示：

```
Reply sent to Codex. Note: 3 pending messages from Codex — call get_messages to read them.
```

这让 Claude 有自然的动机去检查新消息，不需要额外的轮询逻辑。

### 共享行为

两种模式共享：

- 相同的 `reply` 工具和回复传递路径
- 相同的 daemon 和 control WebSocket
- 相同的 Codex adapter 和消息拦截
- 相同的消息格式（`BridgeMessage`）

唯一差异是传递方向：push（server → client notification）vs. pull（client → server tool call）。

### 改动范围

- `claude-adapter.ts`：增加模式检测逻辑、`get_messages` 工具注册、pull 模式消息队列、reply 响应中的待处理消息提示
- `bridge.ts`：调整 `codexMessage` handler，根据检测到的模式选择 push 或排队
- `types.ts`：无需改动，`BridgeMessage` 共享
- 新增 `AGENTBRIDGE_MODE` 环境变量（`auto` | `push` | `pull`，默认 `auto`）
- 更新 MCP instructions 覆盖两种模式

### 预期效果

- API key 用户首次能够使用 AgentBridge，无需任何特殊标志
- OAuth 用户保持完整的实时 push 行为不变
- API key 用户的启动命令简化为普通的 `claude`
- `get_messages` 工具提供清晰、显式的消息获取接口
- reply 响应中的待处理消息提示自然引导 Claude 检查新消息

### 已知局限

- Pull 模式本质上不如 push 模式实时。Claude 只在主动调用 `get_messages` 时才能看到新消息
- Pull 模式下没有机制"唤醒" Claude。需要用户或 Claude 主动发起检查
- 如果 Claude 不调用 `get_messages`，消息会静默堆积
- 这些是支持 API key 认证的可接受折中

## 9. v1 范围外的项目

以下项目明确不在 v1 范围内，留给 v2 或更后续版本：

| 项目 | 原因 | 目标版本 |
|------|------|----------|
| Multi-session support | 需要 AgentRegistry + Room 模型，超出当前架构 | v2 |
| 单 Claude 连接互踢修复 | 需要将 `attachedClaude` 改为 `Map<agentId, AgentInfo>` | v2 |
| 真正的多 Codex 线程并发 | 需要多 adapter 实例 + 消息路由 | v2 |
| Gemini CLI 三方通信 | 需要 Room 模型和多出口路由 | v2+ |
| 完整的 Policy 系统 | 需要 Agent Registry + Room + Policy 接口 | v2 |
| SQLite 持久化 | 需要先有稳定的身份和 room 模型 | v2 |
| 断线恢复（resume） | 需要 agentId/sessionId 分离 + 持久化 | v2 |
| Runtime 级事件流拦截 | 需要深入 Codex app-server 协议，属于 v2 richer observability | v2+ |
| 完整的显式寻址路由 | 需要 Room + 多 agent，v1 单对端无实际路由价值 | v2 |

## 10. 版本演进定位

| 版本 | 一句话定位 |
|------|-----------|
| **v1** | 单桥体验优化 — 降噪、控回合、定角色 |
| **v2** | 多 agent 基础设施 — Room、Identity、Protocol、Recovery |
| **v3** | 智能协作 — 成熟的 Policy、Workflow Orchestration、丰富的可观测性 |
| **v4** | 高级编排 — 跨 runtime 的多方代理协作智能 |
