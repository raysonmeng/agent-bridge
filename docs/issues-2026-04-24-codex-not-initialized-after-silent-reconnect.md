# Codex TUI 静默闪退(第三种路径)——unintentional reconnect 后 stale session 触发 "Not initialized"

> Date: 2026-04-24
> Status: analysis complete, phase 2 fix pending
> Author: Claude(现场诊断) / 请 Codex review 结论和修法
> Related commit: `f8698b8` on branch `fix/codex-exit-diagnostics`
> Related logs:
> - `~/Library/Application Support/AgentBridge/codex-wrapper.log`
> - `~/Library/Application Support/AgentBridge/agentbridge.log`

## TL;DR

我们上轮通过 `f8698b8` 加的 wrapper + adapter 日志,**第一次现场复现就抓到一个之前没覆盖的根因**。

**不是** FatalExitRequest(Codex 之前 PTY 实验里的场景 A/B),
**不是** ThreadClosed → ExitMode::Immediate(场景 C),
**是**:**我们自己的 `handleAppServerClose` 在非主动 upstream 重连时没恢复 `initialize` 状态,TUI 继续用 stale session,后续请求触发 app-server 返回 `"Not initialized"`,TUI 从 `main()` 返 `Err`,exit(1)**。

## 现场证据

### 1. codex-wrapper.log —— TUI 侧退出

```
[2026-04-24T11:00:26.116Z] spawn: codex --enable tui_app_server --remote ws://127.0.0.1:4501 --yolo
[2026-04-24T11:00:26.117Z] child pid=62380
[2026-04-24T11:36:31.833Z] exit: code=1 signal=null runtime_ms=2165717 pid=62380 classification=nonzero_exit:1
--- last stderr (377 bytes) ---
Error: turn/steer failed: Not initialized

Stack backtrace:
   0: __mh_execute_header
   1: __ZN4absl22internal_any_invocable19LocalManagerTrivialENS0_14FunctionToCallEPNS0_15TypeErasedStateES3_
   2-8: __mh_execute_header
--- end stderr ---
```

关键数据:
- runtime **36 分钟**
- exit code **1**,无 signal
- classification `nonzero_exit:1`(不是 `fatal_exit`,因为 stderr 前缀不是 `ERROR: remote app server` 而是 `Error: turn/steer failed`)
- stack backtrace 全 `__mh_execute_header` 是 release 构建 strip 后符号未解析的正常现象(即便 `RUST_BACKTRACE=full` 也无能为力)

### 2. agentbridge.log —— 上游重连时序

```
11:00:26.177  Detected initialize — reconnecting app-server for fresh session
11:00:26.178  App-server reconnected for new TUI session — replaying buffered messages
11:00:26.179  TUI → app-server: initialize
11:00:26.179  TUI → app-server: initialized

... 33 分钟正常使用 ...

11:33:34.444  App-server connection closed (intentional=false, tuiConnected=true, turnInProgress=true)  ← ⚠️ upstream 自己掉,还在 turn 中
11:33:35.446  Reconnected to app-server                                                                  ← 1 秒后重连成功
11:33:35.447  App-server reconnect successful

...           TUI 对此毫不知情,继续在 stale session 上工作 3 分钟 ...

11:36:31.806  TUI → app-server: turn/steer                                                               ← 用户按 ESC 取消 turn
11:36:31.811  TUI disconnected (appServerOpen=true, turnInProgress=false, ...)                           ← 5ms 内 TUI 死
```

关键字段:
- `intentional=false` → 这不是我们主动触发的 reconnect,是 upstream 自己掉
- `turnInProgress=true` → 掉的时候还在处理一个 turn
- `appServerOpen=true`(TUI 死的时候) → 证明死的原因不是"上游又掉了",而是 TUI 主动退出
- 时间差 3 分钟 → 排除"立即死"路径

## 为什么 Codex 之前的 PTY 实验没测到

Codex 的三个场景:
- A: `server close 1000` → 立即 FatalExit(stderr: `ERROR: remote app server ... disconnected: connection closed`)
- B: `server close 1011` → 同 A,reason 不同
- C: `thread/closed` notification → 立即 ExitMode::Immediate,空 stderr

**没测**:"server close → 我们立即 reconnect → TUI 继续用 session 若干分钟 → TUI 发请求 → app-server 返回错误 → TUI 退出"

这条链路依赖 **TUI 认为 session 还活着但实际 app-server 已经是全新 uninitialized 的**,需要时间差才能复现。PTY 实验一板一眼断 + 关,没打出来。

## 根因 —— 在我们自己的代码里

`src/codex-adapter.ts`:

```
handleAppServerClose()          ← upstream 非主动掉时触发
  ├─ this.appServerWs = null
  ├─ clearResponseTrackingState()
  └─ scheduleReconnect()        ← 指数退避重连
       └─ connectToAppServer(true)
            └─ onopen: this.appServerWs = appWs  ← 直接设新 socket,没 replay initialize
```

对比主动触发的 reconnect(TUI 发 `initialize` 触发):

```
reconnectAppServerForNewSession(tuiWs)
  ├─ buffer TUI 消息
  ├─ 关旧 appServerWs
  ├─ connectToAppServer(false)
  └─ replay buffered messages   ← 这里重发 initialize + initialized
```

**区别是**:主动重连有 replay 机制,非主动重连没有。
新 app-server session 是 uninitialized 的,任何需要 initialized state 的请求都会返回 `{error: "Not initialized"}`,TUI 视为 fatal,exit(1)。

## 为什么 `outageQueue`(phase 1 的修复)救不了

`outageQueue` 只 buffer **outage 期间 TUI 发的消息**。这个 case 的事件序列:

1. 11:33:34 upstream close
2. 11:33:35 我们重连(1 秒,快于 5 秒 timeout)
3. 这 1 秒内 TUI **没发任何消息** → queue 是空的
4. 等到 TUI 在 3 分钟后发 `turn/steer` 时,`appServerWs` 已经 OPEN,直接走 forward 分支
5. forward 到新 session → 新 session 说 "Not initialized" → TUI 死

**outageQueue 防的是"TUI 发的消息丢"的问题,不防"session 状态丢"的问题。这是两个不同的 failure mode。**

## Phase 2 修法:缓存 + replay initialize(用户选了 A)

### A.1 捕获阶段

在 `onTuiMessage` 里,**在 id-rewriting 之前**,识别并缓存:
- `initialize` 请求的原始 JSON(含 params)
- `initialized` notification 的原始 JSON
- 当前 `thread/start` 或 `thread/resume` 的 threadId(我们已经有 `this.threadId` 字段了)

存在新字段上,例如:
```typescript
private lastInitializeRaw: string | null = null;
private lastInitializedRaw: string | null = null;
// this.threadId 已存在
```

### A.2 replay 阶段

`scheduleReconnect` 成功 onopen 后(非主动重连路径),自动:

1. 若 `lastInitializeRaw` 存在,发给新 app-server
   - 用新的 proxy id,注意 rewrite
   - 等 response 确认才继续(需要 awaitable send helper,或基于 id 挂钩)
2. 若 `lastInitializedRaw` 存在,发过去(notification 无需等 response)
3. 若 `this.threadId` 存在,发 `thread/resume {threadId}`
4. 全部成功 → 照常服务 TUI,TUI 无感
5. 任何一步失败 → 降级成方案 B(close TUI 1011,让 codex-rs FatalExit,用户重启)

伪码:
```typescript
private async restoreSessionAfterUnintentionalReconnect() {
  if (!this.lastInitializeRaw) return true; // nothing to replay

  try {
    await this.sendAndAwait(this.lastInitializeRaw, "initialize");
    if (this.lastInitializedRaw) this.appServerWs.send(this.lastInitializedRaw);
    if (this.threadId) {
      await this.sendAndAwait(JSON.stringify({
        jsonrpc: "2.0",
        id: ...,
        method: "thread/resume",
        params: { threadId: this.threadId },
      }), "thread/resume");
    }
    this.log(`DIAGNOSTIC: session restored after unintentional reconnect (threadId=${this.threadId})`);
    return true;
  } catch (e) {
    this.log(`ERROR: session restore failed: ${e.message} — closing TUI 1011`);
    this.tuiWs?.close(1011, "agentbridge: session restore failed after app-server reconnect");
    return false;
  }
}
```

挂在 `connectToAppServer` 的 `onopen` 里,仅在 `isReconnect === true` 时触发(跳过首次连接)。

### A.3 边界情况

- **TUI 还没发过 initialize** → 没缓存 → reconnect 后直接走老路(可能后续也没事,可能 TUI 还会主动重新 initialize)
- **app-server 明确拒绝 replay 后的 initialize**(schema 不兼容、seq 校验等) → 降级关 TUI 1011
- **replay 期间 TUI 又发了新消息** → 复用 `pendingTuiMessages` + `reconnectingForNewSession` 已有机制,buffer 后 flush
- **`this.threadId` 为 null** 但 initialize 已发(TUI 还没进 thread) → 只 replay initialize + initialized,不发 thread/resume
- **`clearResponseTrackingState` 和 cache 的互斥**:replay 的消息不应当受 clearResponseTrackingState 影响 —— cache 字段要独立存活

### A.4 风险点(需要 Codex 从 codex-rs 源码确认)

**请 Codex 下次 session 重点查**:

1. **`initialize` handler 对重复调用的行为**
   - 若 idempotent,replay 安全
   - 若返回 error(如 "already initialized"),replay 要先 close-then-open
2. **`thread/resume` 能否在 fresh session 上直接用**
   - 还是必须先重新 `initialize` 再 `thread/resume`
   - 还是需要额外的 `thread/attach` 或 `session/attach` 语义
3. **`initialize` 的 params 里有没有 session-unique 字段**
   - 比如 client nonce、challenge token、timestamp 校验
   - 如果有,直接 replay 会被 app-server 拒
4. **TUI 启动时有没有除了 initialize 以外的"session bootstrap"请求**
   - 比如 `account/read`、`skills/list` 等(我们日志里看到过)
   - 这些是幂等的还是 session-dependent,影响要不要也一起 replay

**如果 codex-rs 源码显示 initialize 不可重放**,那方案 A 不可行,回退到方案 B(直接关 TUI 1011,让用户感知到断连)。

### A.5 测试策略

- 单测:构造一个 mock app-server,先正常 handshake,然后主动 close,再接受新连接,验证 adapter 自动发了 initialize + (optional) thread/resume
- 集成测:模拟上游 1s 短断,观察 `codex-wrapper.log` 里没有"闪退"记录,TUI 继续可用
- E2E:用户实际跑一次 `abg codex`,人为杀掉 daemon 里的 app-server 连接(需要暴露一个测试端口或 SIGUSR1),看 TUI 是否无感续用

## 分类 regex 建议同步扩

当前 `src/cli/codex.ts` 的启发式分类:
```typescript
if (/ERROR: remote app server/.test(tail)) classification = "fatal_exit";
else if (signal) classification = `signal:${signal}`;
else if (typeof code === "number" && code !== 0) classification = `nonzero_exit:${code}`;
else if (code === 0 && tail.trim().length === 0) classification = "exit_0_empty_stderr";
```

**新增规则**(Claude 这轮 phase 2 会一起加上):
```typescript
else if (/Error: .* failed: Not initialized/.test(tail)) classification = "not_initialized_after_reconnect";
else if (/Error: .* failed:/.test(tail)) classification = "rpc_error_exit";
```

这样以后再出类似闪退,wrapper log 的 classification 字段直接就能告诉人是不是这个 bug 或类似 bug。

## 当前状态

- `f8698b8` 已 push 到 `fix/codex-exit-diagnostics`(远程)
- phase 1(诊断基建)工作如预期 —— 这次闪退**全程 on record**,可复盘
- phase 2(replay initialize)Claude 这轮继续做,Codex 下次上线请先 review 本文档再动工
- 用户未开 PR,等本 bug 也修完一并开

## 给 Codex 的明确问题清单

1. 同意"真正根因是非主动 reconnect 没 replay initialize"这个判断吗?有没有更简单的解释我们漏了?
2. 对 A.4 的 4 个风险点,codex-rs 源码侧答案是什么?
3. 如果 A 不可行,降级到 B(立即关 TUI 强制重启)你觉得用户能接受吗?还是要做 C(replay 后若失败再降级 B)?
4. A 方案的 `sendAndAwait` helper 要不要抽成公共工具,后续别的 replay 场景也能用?
