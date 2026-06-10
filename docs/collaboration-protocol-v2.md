# Collaboration Protocol v2 — 设计契约 / Design Contract

> 状态：PR A 实施中。本文档是 Claude × Codex 两轮设计共识的固化版本（2026-06-10），
> 实施任何一个 PR 时以此为契约；修改契约需双方重新共识。
>
> Status: PR A in progress. This document freezes the two-round design
> consensus between Claude and Codex (2026-06-10). Implementations MUST follow
> it; contract changes require renewed consensus.

## 背景 / Background

架构审视中双方独立得出的最强共识：协作链路要从「文本暗号（⏳/✅）+ 注释维系的隐式
状态」升级为「结构化、可观测、可关联」的显式契约。`turnInProgress`（issue #102）
是第一块砖。

The strongest dual-consensus from the architecture review: upgrade the
collaboration channel from text markers and implicit state to a structured,
observable, correlatable contract.

## PR 切分 / PR split

实施顺序固定为 A → B → C；每个 PR 不得偷带后续 PR 的行为（reviewer 验收项）。

### PR A — Turn 状态契约 / turn-state contract（本 PR）

- `DaemonStatus.turnPhase: "idle" | "running" | "stalled" | "aborted"`
  - **严格只表达 Codex turn 生命周期**。
  - `stalled` 是当前态：watchdog 判定无活动；活动恢复后回到 `running`
    （与 turnStalled 通知的 at-most-once 去重集合分离）。
  - `aborted` = 最近一个 turn 异常结束（turnAborted）且其后没有新 turn。
- `DaemonStatus.attentionWindowActive: boolean` — 桥的路由/出站窗口，
  **独立轴，刻意不混入 turnPhase**。
- `turnInProgress` 兼容保留一个版本，语义固定为映射
  `turnPhase ∈ {running, stalled}`；新消费者一律读 `turnPhase`。
- 一致性要求：`/healthz`（currentStatus）、status.json（writeStatusFile）、
  control `status` 三个 payload 字段一致；turn 转移与 attention 转移
  都会刷新 status.json（经 tryWriteStatusFile，观测写失败不阻断核心路径）。

### PR B0 — busy 转向注入 / steer-on-busy（已实施）

- `reply` 工具新增 `on_busy: "reject" | "steer"`，**默认 `reject`，旧调用行为
  不变**；`steer` 仅在 Codex turn 运行中生效，经 app-server `turn/steer`
  把消息喂进**当前 turn**（不新开 turn、不打断、不丢已有工作）。
- daemon 侧统一加 `[STEER from Claude]` 前缀 framing，让 Codex 能区分
  mid-turn 更新与原始任务指令。
- wire 前置条件：`turn/steer` 自引入（rust-v0.99）起即要求必填
  `expectedTurnId`（当前活跃 turn id，缺失/不匹配即拒）。bridge 侧由
  codex-adapter 从 turn/started 跟踪的活跃 turn id 自动填充；若活跃 turn
  无可寻址 id（防御分支，真实 codex 的 turn id 为 UUID 不会触发），steer
  在本地 transport-reject、不发往 app-server，错误文案按 turn 是否仍在
  运行分叉（防「改发普通 reply」↔ busy guard 的建议乒乓）。
- steer 被 app-server 拒绝（`missing field expectedTurnId`、
  `ExpectedTurnMismatch`、`ActiveTurnNotSteerable`（Review/Compact turn）、
  `NoActiveTurn` race 等）**不是 turn 终结**：不发 `turnAborted`、不改
  `turnPhase`；以 `system_steer_failed` 系统消息显式告知 Claude
  「消息没送进去，原 turn 不受影响」。
- `require_reply × steer` 在 B0 **显式不支持**（tool 层 + daemon 层双重
  loud reject）——steer 加入的是正在运行的 turn，reply 追踪语义需要
  PR B 的幂等状态机（"steer-accept 之后、terminal 之前的新 agentMessage"）。
- race 退化：发送时 turn 已结束 → 自动退化为普通 `turn/start` 注入
  （无 `[STEER]` 前缀）；caller 侧的判别能力由 PR B 的
  `turn_started` ACK 补足。
- `turn/interrupt`（打断入口）**不在 B0**，与 ACK/幂等机制一起进 PR B。

### PR B — 核心协议：ACK + 幂等 / core protocol: ACK + idempotency（未实施）

- `claude_to_codex_result` 维持即时返回，语义收窄为 **accepted** =
  「daemon 已接收并已尝试写入 turn/start」；Claude 侧 15s 超时仅适用于
  accepted 未返回。
- 新增独立 control event `turn_started`，携带关联字段
  `requestId / idempotencyKey / threadId / turnId` —— 没有关联字段
  Claude 无法判断是哪次 reply 开始了。
- 幂等键状态机（daemon/codex-adapter 侧）：
  `(threadId, idempotencyKey): accepted → started(turnId) → terminal`
  - terminal = `completed | aborted | rejected`；**`stalled` 不是 terminal**。
  - **terminal 后保留 tombstone，TTL 20 分钟** —— 否则快速完成的 turn 会让
    迟到重试在 terminal 后再次注入，幂等破功。
  - terminal 边界（codex-adapter 内）：
    - `turn/completed` 按 turnId 终结对应 key；
    - `turnAborted` / app-server close / reconnect / stop 终结该 thread 下
      全部 pending/running keys；
    - started 之前的 bridge-originated JSON-RPC error → `rejected`。
- 结构化 result 最小版：`{ok:false, code, phase?, retryAfterMs?, retryAfterEpoch?}`；
  旧 `error` 字符串并存一个版本。`phase` 引用 turnPhase 值域；
  `code/phase/retryAfter` 是 per-request 诊断，不与 status 状态合并改造。

### PR C — 预算指令降噪分层 / budget directive layering（未实施）

- `pause / handoff / resume` 保持系统消息强通知。
- `balance / parallel` 默认仅进入 status/get_budget；仅在阶段转换时发一条摘要。
- snapshot 必须保留 `lastAdviceAt` / 当前 phase —— Claude 不主动查 budget
  时不能完全失明。

## v2.2（后续，另行排期）

- **baton/handoff schema**：
  `{goal, done[], breakpoint, next[], artifacts[], acceptance[], budgetState}`，
  其中 `budgetState` 为摘要五元组 `{phase, pauseSide, resumeAfter, codexTier, dataAge}`
  （不塞完整 snapshot）。`reply` 增加 `baton` 参数：模板化渲染为可读消息，
  raw schema 留存日志/doctor。
- **Codex 出站可观测**：`lastOutbound: {marker, length, action, observedAt, forwardedAt?}`，
  `action ∈ buffer|drop|forward`，仅 forward 填 `forwardedAt`。
  **不新增 Codex 侧 send API**（维持透明截获设计）。

## 验收清单 / Reviewer checklist（PR A）

- [ ] turnPhase 只表达 turn 生命周期，四值齐全且语义如上
- [ ] attentionWindowActive 独立，未混入 turnPhase
- [ ] turnInProgress 兼容映射 = running|stalled
- [ ] /healthz、status.json、control status 三 payload 一致
- [ ] 未偷带 PR B 的 ACK/幂等任何行为
