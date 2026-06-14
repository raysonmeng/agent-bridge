# 设计稿：额度减速线 + 原 TUI 自动续接（跨 guard + bridge 两仓）

> 状态：实施细化稿 v0.1，待 Codex 对抗审。基于 2026-06-14 用户决策 + Claude/Codex 命门验证。
> 作者：Claude；评审：Codex（命门判断已记 §3，对抗审待补）。

## 1. 宗旨与目标

用户最高宗旨（原话）：**「既要把周窗口额度尽可能用满，又不让任务被中途打断」** + **「停了要能在原本的 Claude/Codex TUI 里全自动续接，不要后台无头进程，不要手动」**。

拆解成可实现目标：
1. 额度高位时**执行工具调用中途绝不拦**（不被"中途"打断）。
2. **一轮自然结束（轮末）到硬线时停在干净点** + 写 checkpoint（这个"停"是 watchdog/续接的前提）。
3. **窗口刷新后自动续接**，在**原本的交互式 TUI** 里继续（不要 headless `claude -p` / tmux 后台）。

## 2. 用户决策汇总（2026-06-14）

| # | 决策 |
|---|---|
| D1 | 减速线 = remind 形态 B（中途不拦 + 轮末干净点停 + 自动续），不是纯不停 |
| D2 | 自动续接要全自动、不要手动（手动 skip 退居逃生门） |
| D3 | 在原 TUI 续接，不要后台无头进程 |
| D4 | 用 AgentBridge channel/turn 注入续接（不用 guard watchdog tmux/headless） |
| D5 | Claude 侧接受 best-effort channel + 本机实测定级（Codex 侧全自动） |

## 3. 命门验证结论（Claude 实证 + Codex 查证，2026-06-14）

**Codex 侧自动续接：✅ 完全可行。** `codex-adapter.ts:503 injectMessage()` 写 `turn/start`（请求型）能主动开新 turn 驱动原 Codex TUI；`turn/started`/`turn/completed` 跟踪生命周期 + `bridgeTurnStarted`/reject 确认。

**Claude 侧自动续接：⚠️ best-effort（有官方不可靠性）。**
- 活跃 loop 下 channel push 能触发 Claude 行动——**本场协作已实证**（Codex 发消息 Claude 即行动）。
- 但 idle（`❯` 提示符）时不保证唤醒：官方 issue [#44380](https://github.com/anthropics/claude-code/issues/44380) 实锤——idle 时 channel 消息只显示、Claude 不自动处理、要手动敲；issue [#61797](https://github.com/anthropics/claude-code/issues/61797) 报告 idle notification 变量性丢失。
- `server.notification()` 无执行 ACK——只代表写入 transport，不代表 Claude 已处理。

**三档能力结论（2026-06-14 本机实测更新）：**
| 路径 | 能力 | 代价 |
|---|---|---|
| Codex turn/start | fully automatic | 无 |
| **Claude channel** | **fully automatic（本机实测推翻 best-effort 判断，见下）** | 偶发丢失风险（#61797），保留 ACK+少量重试兜底 |
| Claude SessionStart | 可靠 fallback（仅 channel 偶发失败时兜底） | 要重启/恢复 TUI |

**🎯 本机实测结论（2026-06-14，决定性数据，推翻官方 issue 悲观判断）：**
- 测法：Claude 真 idle（非 require_reply 武装态）时，Codex 经 bridge channel push 一条普通消息，观测 Claude 是否自动响应（用户全程不碰 Claude 键盘）。
- **测试 1**：消息一到 Claude 立即自动打字、不停留输入框、用户未碰键盘 → ✅ 唤醒。
- **测试 2（排除隐性等待）**：Claude 明确收尾「不等任何东西」+ 纯空闲约 3 分钟后，Codex 再发 → ✅ 依然自动响应。
- **结论**：本机 Claude Code + AgentBridge channel 实现，**纯 idle 能可靠唤醒**，比官方 issue #44380 描述强（疑似该版已修，或 bridge channel 投递方式恰好能唤醒 loop）。Claude 侧续接 = **fully automatic**，不需 SessionStart 作主路径。
- **残留风险**：issue #61797 报过 idle notification 变量性丢失。故设计仍保留 ACK + 少量重试兜底（不是因为唤不醒，是防偶发丢消息），channel 连续失败 N 次才降级 SessionStart。

## 3.5 设计共识（Claude + Codex，2026-06-14 实测后达成）

- **能力定级**：本机 Claude Code + AgentBridge channel 下，Claude 与 Codex **都走自动续接主路径**（fully automatic in supported local environment, with ACK/retry for reliability）。官方 #44380/#61797 保留为版本/环境风险注记，非当前能力结论。
- **两侧差异**：Claude = channel push + `ack_resume` MCP tool；Codex = queued `turn/start` + `bridgeTurnStarted` 确认。
- **ACK 角色**：确认 + 幂等（不再承担"证明能否唤醒"）。`ack_resume` 仍 P1——notification 无执行 ACK，bridge 需知 resume_id 是否被接收并开始处理。
- **SessionStart**：纯兜底逃生门（channel 连续未 ACK / frontend 离线 / 能力探测失败时），不进正常路径。
- **guard pending = 续接源头**；**ResumeInjectionQueue = Codex 侧必补的可靠性层**。

## 4. 设计与分工

### 4.1 guard 侧（agent-quota-guard）—— 减速线，不 deny
`lib/guard/hook.mjs` + `claude-budget-guard/budget_guard.sh` + `codex-budget-guard/budget_guard.sh`：
- **phasePre（中途）**：去掉硬线 deny（hook.mjs:347-366）→ 改强提醒 `additionalContext`/`systemMessage`，**绝不 deny**。
- **收尾保护线**：probe runway 字段可用且 confident 时，`runway_seconds < FINISHING_HORIZON_SEC`（默认 1800s，可配）→ 强提醒写 checkpoint（比静态 92% 更准）。runway 不可用 → 退静态线提醒。
- **phaseStop（轮末）**：到硬线**停在干净点** + 写 checkpoint + 写 pending（供 bridge 检测）。**保留这个"停"**（是续接前提）。
- probe / 数据源：不动。

### 4.2 bridge 侧（agent_bridge）—— 检测刷新 + 注入续接（新功能，核心）
budget 协调器（`budget-coordinator.ts` + `daemon.ts`）：
- **检测"曾暂停的 agent 窗口刷新了"**：复用现有 `system_budget_resume`/`claude_recovered` 状态机（budget-coordinator.ts:360-364）。
- **续接注入**：
  - **Codex**：新增 coordinator/system → Codex 的受控 `turn/start` 注入入口（现在只有 Claude reply 触发 injectMessage，daemon.ts:1154），注入 resume turn（"从 checkpoint 下一步继续"）。
  - **Claude**：channel push 一条带 `resume_id` 的 resume 指令。
- **ACK + 幂等 + 重传**（Claude 侧关键）：
  - resume 消息带 `resume_id`。bridge 只有看到 Claude **真 ACK**（调用 MCP tool 确认 / 用 reply 交接 / 有后续活动）才标记 resumed。
  - 没 ACK → 超时重传 N 次 → 仍无 → **降级到 SessionStart fallback**（提示/触发重启恢复）或留待用户手动。
  - 幂等：同 resume_id 不重复注入（防刷屏/重复续接）。

### 4.3 续接指令内容
复用 guard watchdog 的 RESUME_PROMPT 风格：「继续上次未完成的任务，从 .agent/checkpoint.md 的「下一步」接着做；完成后停下并标 DONE」。

## 5. 实测计划（best-effort 定级，D5）
在用户本机目标 Claude Code 版本上实测：
1. Claude TUI idle（`❯`）时，bridge channel push 一条消息 → Claude 会不会自动开始处理？
2. 若会 → Claude 侧定级 fully automatic；若不会 → 定级 best-effort（配 SessionStart fallback）。
3. Codex idle 时 turn/start 注入 → 确认开新 turn。

## 6. 影响面 + 测试要点
- guard：hook 三阶段改 + 收尾保护线 + bash/node 双实现一致；测试 deny→remind、runway 触发、watchdog/pending 保留。
- bridge：续接状态机 + Codex turn/start system 入口 + Claude channel resume + ACK/重传/幂等/降级；测试刷新检测、注入、ACK 观测、超时降级、幂等。

## 7. 风险
| # | 风险 | 护栏 |
|---|---|---|
| R1 | Claude idle 唤不醒（官方 #44380） | best-effort + ACK 超时降级 SessionStart；实测定级 |
| R2 | 腰斩（中途不停撞限流） | 收尾保护线提前提醒 + checkpoint 纪律 |
| R3 | 重复续接刷屏 | resume_id 幂等 |
| R4 | bridge 误判已续接（notification 无 ACK） | 必须看到 Claude 真 ACK 才标 resumed |
| R5 | guard bash/node 双实现漂移 | 两套都改 + 对照测试 |
| R6 | watchdog 续接 vs bridge 续接重复 | 二选一：bridge 续接为主，guard watchdog 不装（避免两套都唤醒）|

## 8. 实施后补充说明（fast-follow，2026-06-14）

落地后的几条非阻塞决策，记此备查（对应 PR4/PR5 cross-review 的 RECOMMEND/SUSPECT）：

- **降级 sentinel 陈旧门（degradedAt TTL）**：`health-check.sh` 读 sentinel 的 `degradedAt`（epoch 毫秒），超过 `AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC`（默认 **86400s=24h**）即丢弃且仍消费（删除），不再弹「从 checkpoint 续接」误导。默认 24h 的取舍：**覆盖一夜离开的核心场景**（醒来通知还在），又压住多日陈旧。**fail-open**：`degradedAt` 缺失/非数字 → 当作新鲜照常弹（绝不静默吞掉可能真实的恢复）。
- **bash↔TS 一致性**：`src/integration-test/health-check-resume-sentinel.test.ts` spawn 真实 `health-check.sh` + 真实 `writeResumeAckDegradedSentinel`，端到端钉死「TS 写 → bash 读」（resumeId 提取、charset guard、TTL 门、消费一次）。非 bash 平台（Windows）自动 skip。
- **`ack_resume` 不做 token 闸门 = 有意为之**：`daemon.ts` 控制开关里 `ack_resume` 与 `status`/`probe_incumbent` 同级、均不过 `validateClaudeClientIdentity`；只有消息注入路径 `claude_to_codex` 是特权。边界 = localhost + Origin/CSWSH 守卫；`ack_resume` 是纯控制面信号、非注入，符合既有信任模型。最坏情形仅「本地进程在 ack 窗口内猜中低熵 resumeId、压掉一次自动续接」，可手动续，影响有界。
- **Codex 注入 confirm 时序（PR3 → PR-B 已采 Option B）**：原 `onBridgeTurnStarted` 确认后立刻 `tryInjectNext()`，与刚开的 turn 有竞争（codex-rs 不保证 turn/start 响应早于 turn/started 通知）。**PR-B 改为 drain-only**：`onBridgeTurnStarted` 只确认/consume/delete/onConfirmed，**不再推进**队列；下一条 pending 只在 terminal/drain 边界推进，时序对正确性不再相关。推进点（每条至多一次，无 churn）：
  - 正常完成：`turnCompleted`（adapter 直发，非经 resetTurnState）→ daemon → `onTurnDrained()`。**隐式不变量**：`resetTurnState` 三处调用点（codex-adapter.ts:447/855/934）恒 `emitCompleted=false`，故正常完成不经 resetTurnState；若哪天改成 `true`，会同时 emit `turnCompleted`(→onTurnDrained) **与** `turnTrackingReset`(→onTurnTrackingReset) 造成**双推进**（重复 turn/start），届时须改接线或保持该参数为 false。
  - 中止/重连/关闭：`resetTurnState` 发 `turnAborted`（若 wasInProgress）**再**发 `turnTrackingReset` → daemon → `onTurnTrackingReset()`：**清扫**每个条目（supersede awaiting→pending / clear / count-or-abandon），`resetSweepDepth` 守卫期间**绝不注入**。清扫后**无需显式再注入**——每个未 abandon 的条目都经 `countRealAttemptOrAbandon → scheduleRetry` 挂上 retry timer，由它推进。**故意不在 `turnAborted` 上 drain**：它早于 `turnTrackingReset`，那样会注入一个随即被清扫 supersede 的 turn（向 Codex 发 spurious turn/start）。
  - 注入被拒（无 reset，codex-adapter.ts:1853-1854 发 `turnAborted`+`bridgeTurnRejected`）：经 `onBridgeTurnRejected` 重试/abandon 推进，不经此处。
  - `turnStalled`：活 turn 无 terminal 边界，**不** drain（不该给活 turn 再发续接）。
  - `resetSweepDepth`：仅抑制 reset sweep 内部经 abandon 的重入注入；bridge reject / confirm-timeout / 正常 abandon 等非 reset 路径照常推进。每条 turn 生命周期路径都有推进点（正常完成 onTurnDrained / 中止 retry timer / 拒绝 onBridgeTurnRejected），不 stall、不 churn。Codex 跨引擎复核已实证无 drain 缺口。

## 9. 续接幂等契约 + 状态生命周期（backlog 清理，2026-06-14）

**幂等身份（R6 atomic claim）**：续接注入的去重身份 = `sha256(agent \0 sessionId \0 realpath(cwd) \0 contentHash)`（`tryClaimPendingResume`）。`contentHash` 取自 guard pending 文件内容——guard 每次降级用新内容重写 pending → 新 contentHash → 新身份。

**落盘位置（重要）**：`claims/` 与 `consumed/` 写在 **guard 共享状态目录** `budgetGuardStateDir()` = `$BUDGET_STATE_DIR ?? ~/.budget-guard`（`daemon.ts` 调 `tryClaimPendingResume({ stateDir: budgetGuardStateDir() })`），**全机所有 pair 共享同一目录**——隔离靠**文件名 = identity sha256**（不是 per-pair 子目录）。唯一 per-pair 的是降级 sentinel `resume-ack-degraded.json`（写在 AgentBridge per-pair state dir）。
- `~/.budget-guard/claims/<identity>.json`：**在途锁**（`claimed_at`，秒）。`writeJsonWx`（`O_EXCL`）保证跨进程/跨重启同一身份只有一个在途注入；`consume()` 成功即删，`release()` 在 abandon/dedup/stop 删。超过 `claimTtlSec`（默认 300s）的为 stale 可回收（进程死了没 release 的孤儿）。
- `~/.budget-guard/consumed/<identity>.json`：**幂等墓碑**（`consumed_at`，秒）。确认续接后写，挡住同一 pending 再次注入。**必须跨重启/跨 kill 存活**——否则 `abg kill` + 重开会把升级/重启前已消费的续接重新注入。

**状态 GC / 清理**：
- `tryClaimPendingResume` 每次（仅预算恢复时触发，频率极低）顺手 prune：`consumed/` 超 `DEFAULT_CONSUMED_TTL_SEC`（默认 **7 天**，远超任何 pending 相关期；daemon 不传 `consumedTtlSec` 故用此默认）+ `claims/` 超 `claimTtlSec` 的孤儿 → 长寿 daemon 不会无限增长。注意 daemon 传的 `claimTtlSec = resumeClaimTtlSec()`（默认时序下 ≈ **320s** = ⌈(60000×5 + 5000×4)/1000⌉，**非** `DEFAULT_STALE_CLAIM_TTL_SEC=300` 默认），与同身份 stale-claim reclaim 用同一 TTL，故 ≤320s 的在途 claim 永不被误扫，只回收真孤儿。损坏 / 无时间戳 / 非 `.json` 文件一律不动（不激进删——绝不误删幂等墓碑）。
- **`abg kill` 有意 NOT 清 `claims/`/`consumed/`**：① 它们在**共享** `~/.budget-guard`，per-pair kill 盲删会误伤其它在跑 pair 的墓碑；② `consumed/` 是**幂等墓碑，本就该跨 kill 存活**（删了会重注入已消费续接）；③ `claims/` 孤儿由上面的 TTL prune 自动回收。故无界增长问题已被 TTL prune 解决，kill 不需也不应动它们。降级 sentinel 是 per-pair 且有 24h TTL（见 §8），kill 也不删——保留跨会话续接连续性，陈旧由 TTL 兜底。
