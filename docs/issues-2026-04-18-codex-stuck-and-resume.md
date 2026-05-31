# Issues — 2026-04-18: Codex 卡死 + resume 启动失败

背景：用户在 `~/repo/quilin-agent` 使用 `agent-bridge` 时，Codex 在长任务中静默 1h+，按 Esc 后 TUI 进程猝死；随后反复重启 Claude Code 均被 daemon 4001 拒绝；最终用 `abg codex resume <thread>` 也无法启动。

日志证据：`~/Library/Application Support/agentbridge/agentbridge.log`，thread `019d9a2e-15a7-7841-a7d2-ca0e14a61f40`，时间窗 `2026-04-17T06:43 – 09:14` UTC。

---

## Issue A — daemon 的 stale frontend 无法被驱逐（P0）

**Symptom**
Claude Code 异常退出后，daemon 侧仍认为旧 frontend `#1` `readyState=1`，新 Claude 实例（`#2 – #19`，13 次）全部被 `code=4001 reason="another Claude session is already connected"` 拒绝。

日志：
```
07:56:29 Frontend socket opened (#2)
07:56:29 Rejecting Claude frontend #2 — another session (#1) is already attached (readyState=1)
... 连续 13 次 ...
09:07:56 Frontend socket opened (#19)  — 同样被拒
```

**Root Cause**
`src/daemon.ts` 的 frontend WS 服务**只看 `ws.readyState`** 判断旧连接是否仍然活着。Claude Code 进程异常退出时 OS 未发 FIN，socket 残留 OPEN。daemon 没有启用应用层 keepalive ping / idle timeout，老连接永远不会被回收。

**Fix**
- 给 frontend WS 加 `ping/pong` 保活（例如 15s ping，30s 未 pong 即 `ws.terminate()`）
- 或者新连接到达时对现有 `#1` 发送一个 liveness challenge 消息，超时无响应则驱逐老连接、接纳新连接（"last writer wins"）

**Files**
- `src/daemon.ts`（frontend WS 接入与 reject 逻辑）

---

## Issue B — `turnInProgress` 缺少 watchdog，Codex 静默导致 Claude 永远 busy（P1）

**Symptom**
`07:38:13` Codex turn 启动，随后连续收到 3 条 `Agent message completed`（07:39/07:43/07:45），但 **`agentTurnComplete` 事件从未到达**。`CodexAdapter.turnInProgress` 保持 `true`，Claude 侧 reply 连续 3 次被 `Rejected injection: Codex turn is in progress`（07:42/07:57/08:18）。

这段时间 `conn #1` 上 **1h21m 完全静默**（07:45:05 – 09:06:29），无任何 TUI↔app-server 流量。说明 Codex 自身 stream 停止推进（模型后端断流或 app-server 卡住）。

**Root Cause**
`src/codex-adapter.ts` 的 `turnInProgress` 只在收到 `agentTurnComplete` 事件时复位，一旦事件丢失就永远 stuck。

**Fix**
- 给每个活跃 turn 挂一个 watchdog：`lastEventAt + N 分钟静默` 即强制复位 `turnInProgress`
- 复位时通过 control WS 发 `system_turn_completed_forced` 通知 daemon → Claude，让用户知道是兜底复位、不是真正完成
- N 推荐 3–5 分钟，避开正常长推理（`06:45 – 07:27` 那轮正常 turn 持续 1m18s；历史日志里看到最长一轮是 15m，所以不能太短）

**Files**
- `src/codex-adapter.ts`（turn 生命周期、事件超时）
- `src/control-protocol.ts`（如需新事件类型）

---

## Issue C — `activeThreadId` 被响应字段覆盖，resume + thread/start 交错导致 pending 失配（P2）

**Symptom**
用户在 Codex TUI 重连后（`09:08 – 09:14`），日志出现 thread 风暴：
```
09:09:28 Active thread changed: 019d9ab3 → 019d9a2e (thread/resume response 3:8)
09:09:39 Active thread changed: 019d9a2e → 019d9a6d (thread/resume response 3:9)
09:10:43 Active thread changed: 019d9ab3 → 019d9a2e (thread/resume response 3:29)
09:10:59 Active thread changed: 019d9a2e → 019d9a6d (thread/resume response 3:30)
...
```
夹杂大量 `[track-resp] Unmatched response with thread.id=019d9a2e..., pending keys=[]`。

**Root Cause**
`CodexAdapter` 用响应里 `thread.id` 字段直接更新 `activeThreadId`。当 TUI conn #2 `thread/resume` 老 thread、conn #3 又 `thread/start` 新 thread 时，两路响应交错到达，`activeThreadId` 被反复覆盖。

pending 响应表的 key 形如 `threadId:reqId`。thread 切换后旧 thread 的响应到达时找不到对应 entry，`pending keys=[]` → 响应无法 correlate。这是"resume 后 thread 再也恢复不回来"的直接原因。

**Fix**
- `activeThreadId` 变更必须由 **显式请求**（`thread/start` / `thread/resume` 的 request 侧）驱动，而不是被任意响应里的 `thread.id` 覆盖
- pending map 不应把 threadId 当作 partition key（或 resume 时显式迁移 key）
- 对多连接的 TUI 场景（conn #2 / #3 同时存在）需要有明确语义：是 last-wins、reject 还是 multiplex

**Files**
- `src/codex-adapter.ts`（thread tracking、pending response map）

---

## Issue D — `abg codex resume <session-id>` 无法启动（P1）

**Symptom**
用户报告 `abg codex resume xxxxx` 无法启动。

**Root Cause**
`src/cli/codex.ts:126-130` 对所有子命令用同一个 args 拼接策略：

```typescript
const fullArgs = [
  "--enable", "tui_app_server",
  "--remote", proxyUrl,
  ...args,   // 用户传的是 ["resume", "xxxxx"]
];
// 结果：codex --enable tui_app_server --remote ws://127.0.0.1:4501 resume xxxxx
```

问题在 clap 的 subcommand 解析规则：
- `codex --help` 与 `codex resume --help` 输出显示，`--enable` 和 `--remote` 在**顶层**与 **resume 子命令**下**分别各自定义**（不是 `global = true`）
- 当前拼法把 `--enable tui_app_server --remote ws://...` 放在 `resume` 之前 → clap 把它们当作**顶层 codex 命令**的 options 消化
- 然后看到 `resume` 切换到 resume 子命令 → **resume 子命令自己的 `--remote` / `--enable` 是 None**
- 结果：resume 子命令不会连到 bridge proxy `:4501`，也没启用 `tui_app_server` feature，行为退化为"在没有 bridge 的环境下 resume"——可能直接失败、或起了个孤立的 TUI（跟 Claude 侧完全不通）

**Fix**
wrapper 需要识别 codex 的 TUI-mode 子命令（`resume` / `fork`），把 owned flags 插到子命令之后：

```typescript
const TUI_SUBCOMMANDS = new Set(["resume", "fork"]);
let fullArgs: string[];
if (args[0] && TUI_SUBCOMMANDS.has(args[0])) {
  fullArgs = [args[0], "--enable", "tui_app_server", "--remote", proxyUrl, ...args.slice(1)];
} else {
  fullArgs = ["--enable", "tui_app_server", "--remote", proxyUrl, ...args];
}
```

边界 case：非 TUI 子命令（`exec` / `review` / `login` 等）本来就不该加这两个 flag —— 当前实现对这些命令也会错误地注入，应该一并限定只对 "裸 `codex`"（进 TUI）和 `resume` / `fork` 生效。

**Workaround（用户马上可用）**
直接跑原生 codex 命令，绕开 wrapper：
```bash
codex resume --enable tui_app_server --remote ws://127.0.0.1:4501 <session-id>
```
daemon 仍由 `abg claude` / `abg codex`（首次启动时）管理，proxy port `4501` 已开，resume 能连上。

**Files**
- `src/cli/codex.ts`（args 拼接逻辑）
- `src/cli/claude.ts`（可能也有类似问题，需一起检查 `--resume` 位置）

---

## 优先级与顺序

| 优先级 | Issue | 用户体验收益 |
|---|---|---|
| P0 | A — stale frontend 驱逐 | 根治"重启 Claude 连不上" |
| P1 | D — resume 子命令参数位置 | 根治"`abg codex resume` 无法启动" |
| P1 | B — turn watchdog | Codex 静默后 Claude 不被锁死 |
| P2 | C — thread tracking 语义修正 | resume 风暴时 bridge 状态不乱 |

建议开 4 个独立 PR（单一职责，独立 review）。A、D 改动小、风险低，可并行先落。B、C 涉及状态机语义，需要额外单测覆盖。
