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
