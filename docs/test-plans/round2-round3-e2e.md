# AgentBridge — Round-2 / Round-3 端到端测试计划 (E2E Test Plan)

> **目标版本 / Target build:** git `master` @ `ddca101` (round-3 #150–#153 已合入), 全局安装 `agentbridge v0.1.12`
> **执行者 / Executors:** 已通过 bridge 连接的 Claude + Codex 一对 (live pair)
> **运行时 / Runtime:** Bun。源码改动后需 `bun run build:plugin` 才能让安装版插件加载到新代码。
> **覆盖 / Covers:** 健康检查 / 消息收发 / turn 生命周期 / reconnect(#150) / corrupt-registry 降级(#152) / codex boot-retry(#153) / daemon identity(#149) / CLI 硬化(#151) / kill+多 pair。

---

## 0. 约定与公共设置 (Conventions & Common Setup)

### 0.1 标签 (Tags)

每个用例标注归属与执行方式:

- **[P0]** smoke — 必须先全绿才继续。
- **[P1]** core — 核心功能。
- **[P2]** edge — 边界 / 韧性。
- **[USER]** 需要真人操作 (启动交互式 Claude Code / Codex TUI、Ctrl+C、观察 TUI 通知)。
- **[CODEX-SANDBOX]** Codex 可在 sandbox 内全自动跑 (纯 CLI / 文件 / 子进程, 不需要交互式 TUI)。
- **[MIXED]** 一部分自动、一部分需真人确认。

### 0.2 binary 与路径 (Binaries & paths)

```bash
# 实测安装位置 (本机快照)
abg          -> ~/.nvm/versions/node/v22.20.0/bin/abg   (== agentbridge)
agentbridge  -> 同上
abg --version  # 期望: agentbridge v0.1.12

# macOS 平台 state 根目录 (darwin)
STATE_ROOT="$HOME/Library/Application Support/AgentBridge"
# pair 状态目录: $STATE_ROOT/pairs/<pairId>/   含 daemon.pid daemon.json status.json killed control-token registry…
# pair registry:  $STATE_ROOT/pairs/registry.json
# 日志:           $STATE_ROOT/pairs/<pairId>/agentbridge.log  (daemon) / codex-wrapper.log
```

> 注: 在 darwin 上 `StateDirResolver.platformBaseDir` 早返回 `~/Library/Application Support/AgentBridge`，**不读 XDG_STATE_HOME**。涉及 XDG 的子用例 (T8.3) 仅能在 Linux 或通过单元测试覆盖 — 见该用例的 SKIP 说明。

### 0.3 fake-codex fixture (隔离 codex app-server)

需要"强制 codex app-server 行为"的用例 (T6 boot-retry、T3 turn 协议) 用仓库自带的参数化 fake codex，**避免依赖真 Codex 的网络/订阅**:

```bash
REPO=/Users/raysonmeng/repo/agent_bridge
FAKE=$REPO/src/integration-test/fixtures/fake-codex.ts
# 造一个临时 PATH 目录，里面放 codex shim → daemon 会 spawn 它而非真 codex
TMPBIN=$(mktemp -d)
cat > "$TMPBIN/codex" <<EOF
#!/usr/bin/env bash
export FAKE_CODEX_CAPABILITY="\${FAKE_CODEX_CAPABILITY:-command-driven}"
exec bun run "$FAKE" "\$@"
EOF
chmod 755 "$TMPBIN/codex"
export PATH="$TMPBIN:$PATH"        # 仅在该用例子 shell 内生效
codex --version                     # 期望: "codex fake"
```

fixture 关键 env (来自 `fake-codex.ts`):
- `FAKE_CODEX_CAPABILITY=minimal|handshake|command-driven`
- `FAKE_CODEX_FAIL_FIRST_BOOT=<counter-file>` — 第一个 spawn 的实例拒绝 WS upgrade (503)，后续正常 → T6。
- `FAKE_APP_COMMAND_FILE=<file>` — 写入 `start-turn` / `complete-turn` / `agent-message:<text>` / `exit-process` / `close-app-server` 驱动 app-server 行为 → T3/T7。
- `FAKE_APP_TURNSTART_LOG` / `FAKE_APP_TURNSTEER_LOG` — 记录收到的 turn/start、turn/steer params → T3 断言。

### 0.4 环境重置 (Environment reset between tests) — **强制**

每个用例**开始前**与**结束后**执行，避免脏 daemon / 残留 registry / 端口锁互相污染:

```bash
# 1. 停掉所有 pair 的 daemon + TUI (全盘扫描，corrupt registry 也能降级停止)
abg kill all

# 2. 确认没有残留进程占用 slot-0 端口三元组 (4500/4501/4502) 及常见 +10 步进
for p in 4500 4501 4502 4510 4511 4512; do lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null; done
#   期望: 无输出。若有，记录 pid 并 `kill <pid>`，再重跑 abg kill all。

# 3. 备份并清空 registry (仅当上一个用例篡改过 registry，如 T5)
REG="$STATE_ROOT/pairs/registry.json"
[ -f "$REG.bak" ] && mv "$REG.bak" "$REG"   # 恢复 T5 的备份

# 4. 清掉测试 pair 目录 (仅清测试期间造的；不要动你日常 main pair)
abg pairs prune --apply   # 干掉孤儿目录 + 永久失效条目 (有 live 守护)
```

> **绝不**手动 `rm -rf` 整个 `$STATE_ROOT` — 那会连同你日常 pair 一起抹掉。只用 `abg kill all` + `abg pairs prune --apply` + 针对性删测试 pair。

### 0.5 通用 PASS/FAIL 基线

- 任何用例若 daemon 进程 **未按预期退出 / 端口未释放** → 该用例 FAIL 且必须在下一个用例前手动清理。
- 任何 `abg` 子命令 **崩溃 (uncaught exception / 非预期非零退出 + stack trace)** → FAIL (恢复命令尤其不允许崩)。

---

## P0 — Smoke (必须先全绿)

### T1. 健康三连: doctor / budget / pairs

**Tag:** [P0] [CODEX-SANDBOX] (纯只读 CLI，无需交互式前端)
**触及代码:** `cli/doctor.ts` `cli/budget.ts` `cli/pairs.ts` (`collectRows`/`printTable`)

#### T1.1 `abg doctor` (无 daemon 时)

```bash
abg kill all                  # 确保无 daemon
cd "$REPO"
abg doctor
echo "exit=$?"
```

**Observe:**
- 顶部打印 `AgentBridge doctor: <pairId>` / `cwd:` / `state:` / `ports: 4500/4501/4502` (slot-0)。
- `WARN daemon health: no daemon reachable on :4502` 且带 `↳` 中文 hint (运行 `abg claude` 自动启动)。
- daemon 相关检查 (readiness / codex app-server / build drift) 合理地 **skip** 而非堆叠三个 WARN。
- 结尾 `结论: N WARN（无 FAIL）…`。

**PASS/FAIL:**
- PASS: 命令不崩溃，无 daemon 状态被如实呈现为 WARN/skip，`exit=0` (无 FAIL → 不置 exitCode 1)。
- FAIL: 抛异常、把"未启动"误报为 FAIL、或退出码非 0。

#### T1.2 `abg doctor --json`

```bash
abg doctor --json | tee /tmp/doctor.json | head -c 200; echo
bun -e 'JSON.parse(require("fs").readFileSync("/tmp/doctor.json","utf8")); console.log("valid-json")'
```

**Observe:** stdout 是**合法 JSON** (含 `cwd` `pair` `env` `daemon` `tui` `checks[]`)。
**PASS/FAIL:** PASS = `valid-json` 打印且包含 `checks` 数组; FAIL = JSON.parse 抛错 (说明有非 JSON 噪声混进 stdout)。

#### T1.3 `abg budget --json` (无 daemon 时)

```bash
abg budget --json; echo "exit=$?"
```

**Observe:** 该目录已注册过 pair 但 daemon 未运行 → `{"ok":false,"pairId":"...","error":"daemon_unreachable"}` (或未注册时 `{"ok":false,"error":"pair_not_registered"}`)，`exit=1`。
**PASS/FAIL:** PASS = 输出是单行合法 JSON 且 `ok:false` + 明确 error 码 + 退出码 1; FAIL = 崩溃 / 非 JSON / 退出码 0。

#### T1.4 `abg pairs` 与 `abg pairs --json`

```bash
abg pairs
abg pairs --json | bun -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(Array.isArray(r)?"array len="+r.length:"NOT-ARRAY")'
abg pairs --threads   # 含 threadId / thread 列
```

**Observe:** 表头 `name pairId slot app/proxy/control source status pid cwd`; `--json` 是数组; `--threads` 多出 thread 列。
**PASS/FAIL:** PASS = 表格对齐、`--json` 是数组、`--threads` 增列且不崩; FAIL = 崩溃或 JSON 非数组。

---

### T9 (P0 部分). kill / doctor sanity 闭环

**Tag:** [P0] [USER] (启动真前端)
**触及代码:** `cli/kill.ts` `formatKillReport` / `cli/claude.ts` `cli/codex.ts`

```bash
# 终端 A
cd "$REPO" && abg claude          # 期望 stderr: pair "<id>" (slot 0) — control :4502 …
# 终端 B
cd "$REPO" && abg codex           # 期望: "Connecting Codex TUI to AgentBridge at ws://127.0.0.1:4501…"
# 终端 C
abg doctor                        # daemon health OK / codex tui (this pair) OK
abg kill                          # 停本目录 pair
```

**Observe (kill 输出):** `总结（共 N 个目标）` + `✅ 已停止 …（daemon + Codex TUI）` + `已写入 killed 哨兵` + restart 提示用与调用名一致的 `abg`。
**PASS/FAIL:** PASS = doctor 在 live 态全绿关键项 (daemon health / codex tui this pair = OK)，kill 报告已停止 daemon+TUI 且写 killed 哨兵; FAIL = doctor 误报、kill 漏杀 daemon 或 TUI、端口未释放。

---

## P1 — Core

### T2. Bridge 双向消息 + loop-prevention

**Tag:** [P1] [USER] (两侧都是 live agent，靠 reply/get_messages 工具)
**触及代码:** `claude-adapter.ts` (`reply`/`get_messages` + `notifications/claude/channel`)、数据流不变量 `source` 防回环。

**Setup:** 终端 A `abg claude`，终端 B `abg codex`，确认两侧已连。

**Steps:**
1. Claude 侧调用 `reply` 工具发一条可识别消息，例如 `"[T2-probe] Claude→Codex ping #1"`，带正确 `chat_id`。
2. 观察 Codex TUI: 应收到 `<channel source="agentbridge" user="Codex" …>` 推送，内容含 `[T2-probe] … ping #1`。
3. Codex 侧回一条 `"[T2-probe] Codex→Claude pong #1"`。
4. Claude 侧应通过 push channel 收到该 pong (而非自己刚发的 ping)。
5. 若 push 失败 (网络抖动)，Claude 调 `get_messages` 排空 fallback 队列，确认仍能取到 pong。

**Observe (loop-prevention 关键):**
- Claude 发出的 `[T2-probe] … ping #1` **绝不**回流到 Claude 自己 (源是 claude → 不回送 claude)。
- Codex 发出的 `pong` **绝不**回流到 Codex 自己。
- 每条 `BridgeMessage` 只到达**对端**一次。

**PASS/FAIL:**
- PASS: ping 单向到 Codex、pong 单向到 Claude，双方都收不到自己发的那条 (零回环)，get_messages 能排空任何 fallback 残留。
- FAIL: 任一侧收到自己发的消息 (回环)、消息重复投递、或 push 失败后 get_messages 也取不到。

---

### T3. Turn 生命周期: 正常 turn / busy guard / on_busy=steer

**Tag:** [P1] [MIXED] (推荐用 fake-codex command-driven 自动化 turn 状态; busy guard / steer 的真机版需 USER 观察 TUI)
**触及代码:** `codex-adapter.ts` (turn/start 注入、busy 状态、turn/steer + `expectedTurnId`)、turn 协调协议。

> **方案 A — fake-codex 自动化 (CODEX-SANDBOX，推荐先跑):**

```bash
# 用 0.3 的 TMPBIN/codex (command-driven) + 命令文件驱动 turn 状态
CMDF=$(mktemp); STEERLOG=$(mktemp); STARTLOG=$(mktemp)
export FAKE_APP_COMMAND_FILE="$CMDF" FAKE_APP_TURNSTEER_LOG="$STEERLOG" FAKE_APP_TURNSTART_LOG="$STARTLOG"
abg claude      # (或直接驱动 daemon；真前端可省，关键是 daemon+fake app-server 起来)
abg codex
```

**Steps (自动化):**
1. **正常 turn:** `printf 'start-turn'  > "$CMDF"` → fake 发 `turn/started{turn-1}`；Claude 侧应观察到 `⏳ Codex is working`。再 `printf 'agent-message:hello-from-codex' > "$CMDF"` → Claude 应收到一条 agentMessage `hello-from-codex`。最后 `printf 'complete-turn' > "$CMDF"` → Claude 侧 `✅ Codex finished`。
2. **busy guard 拒绝 mid-turn reply:** 重新 `printf 'start-turn' > "$CMDF"` 进入 busy。Claude 侧调 `reply` (不带 on_busy) → **应返回 busy 错误** (Codex still executing)，消息**未注入**。验证 `cat "$STARTLOG"` 在此刻**没有新增** turn/start 行。
3. **on_busy=steer 注入进行中的 turn (不重启):** Claude 侧 `reply` 同一目标，带 `on_busy="steer"` **且必须带 `expectedTurnId="turn-1"`**。fake 的 turn/steer 校验要求 expectedTurnId 为当前 turn id (见 fake-codex.ts L210–228)。验证:
   - `cat "$STEERLOG"` 出现一行含 `"expectedTurnId":"turn-1"` 的 turn/steer params。
   - **没有**新的 `turn/start` (即没有把 turn 重启)：`wc -l < "$STARTLOG"` 不增加。
   - turn 仍是 `turn-1` (未被 interrupt/重启)。
4. 收尾 `printf 'complete-turn' > "$CMDF"`。

**Observe / PASS-FAIL:**
- 正常 turn: started→agentMessage→completed 三段齐全 → PASS。
- busy guard: 裸 reply 被拒、消息未注入 (STARTLOG 不增) → PASS；若 reply 在 busy 期成功注入或静默吞掉 → FAIL。
- steer: STEERLOG 收到带正确 `expectedTurnId` 的 turn/steer **且** turn 未重启 (STARTLOG 不增、turn id 不变) → PASS；若 steer 触发了新 turn/start、或因缺 expectedTurnId 被 fake 拒 (`missing field expectedTurnId`) → FAIL。

> **方案 B — 真 Codex (USER):** 给 Codex 派一个会跑一会儿的任务 (如"列出 src 下所有 .ts 并统计行数")。看到 `⏳ Codex is working` 时:
> - 裸 `reply` → 期望 busy 错误。
> - `reply` + `on_busy="steer"` + `expectedTurnId=<当前 turnId>` → 该指令**喂进**正在跑的 turn (不打断、不重启)，Codex 继续原任务并纳入新指示。
> - PASS = busy 拒裸 reply + steer 不重启地注入; FAIL = steer 重启了 turn 或 busy 期裸 reply 被接受。

---

### T4. Reconnect (#150): daemon 死后干净重连 + 不误报 reconnected

**Tag:** [P1] [USER] (live 前端 + 杀 daemon)
**触及代码:** `bridge.ts` `reconnectToDaemon` + `bridge-disabled-state.ts` `shouldEmitReconnectSuccess`。

#### T4.1 daemon 被杀后干净重连

**Steps:**
1. 终端 A `abg claude` (live 前端)，终端 B `abg codex`，确认已连。
2. 找到 daemon pid 并**直接杀掉** (绕过 abg kill，模拟崩溃):
   ```bash
   PAIRDIR=$(abg pairs --json | bun -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=r.find(x=>x.running);console.log(p.pid)')
   kill -9 "$PAIRDIR"      # SIGKILL daemon
   ```
   (注意: 不要写 killed 哨兵 — 我们要的是崩溃后自动重连，不是显式 kill)
3. 等几秒，前端 `bridge.ts` 以指数退避重连；daemon 由存活前端的 ensureRunning / 重连逻辑重新拉起 (或 `abg codex` 再跑一次触发 ensureRunning)。
4. 重连成功后 Claude 侧日志应出现 `Reconnected to AgentBridge daemon successfully` 并推 `system_daemon_reconnected`。

**Observe:** `tail -f "$STATE_ROOT/pairs/<id>/agentbridge.log"` (或 `abg logs -f`) 看到重连成功一次。
**PASS/FAIL:** PASS = daemon 崩溃后前端干净重连、消息恢复双向; FAIL = 前端卡死、重连风暴、或重连后 reply 仍报 disabled。

#### T4.2 evicted / contract-mismatch 的 attach **不**误报 "reconnected successfully" (#150 核心)

> 这是 #150 修复点: mid-loop 被驱逐 (EVICTED_STALE / REPLACED / CONTRACT_MISMATCH) 后，`connectToDaemon` 在 disabled 态静默早返回，旧代码会落入成功分支误打 "Reconnected successfully"。

**自动化优先 (CODEX-SANDBOX) — 单元层实证:**
```bash
cd "$REPO"
bun test src -t "shouldEmitReconnectSuccess"     # bridge-disabled-state 上的 #150 helper 测试
```
**Observe:** 测试断言 `shouldEmitReconnectSuccess({daemonDisabled:true}) === false`、`({daemonDisabled:false}) === true`。

**真机版 (USER, 触发驱逐):**
1. 终端 A `abg claude` 起 D1 前端。
2. 制造 contract-mismatch: 用一个**旧 build 的 daemon** 抢同一 pair (或人为篡改 contract version)，使在役前端被 daemon 以 CONTRACT_MISMATCH 驱逐 mid-loop。
3. 观察 Claude 侧日志: 应出现驱逐/契约不符通知，**且其后不应出现** `Reconnected to AgentBridge daemon successfully`，reply 工具应返回 disabledReplyError。

**PASS/FAIL:**
- PASS: 单元测试通过；真机版中驱逐后**没有**矛盾的 "reconnected successfully"，reply 返回 disabled 错误。
- FAIL: 驱逐通知后又紧跟一条 "Reconnected successfully" (自相矛盾)，或 `shouldEmitReconnectSuccess` 测试失败。

---

### T6. Codex boot-retry 恢复 (#153): 首次 boot 失败重试成功 + 不误发 codex-exit 警告

**Tag:** [P1] [CODEX-SANDBOX] (fake-codex `FAKE_CODEX_FAIL_FIRST_BOOT`)
**触及代码:** `codex-adapter.ts` `start()` 失败即 `cleanupAfterFailedStart` (幂等)、`daemon.ts` `codex.on("exit")` 把 `system_codex_exit` 警告 + armBootDeadline 门控到 `wasBootstrapped`。

> 直接复现首启失败：fixture 的第一个 app-server 实例 healthz 绿但**拒绝 WS upgrade (503)** → `start()` reject → daemon SIGKILL 该子进程 (cleanupAfterFailedStart) → 触发 boot 重试期的 `codex.on("exit")`；第二次 spawn 正常 boot。验证整个重试无 10s healthz 等待、且重试期那次 exit **不**发"重启 Codex 手动"警告。

**自动化优先 — 集成测试实证:**
```bash
cd "$REPO"
bun test src/integration-test/daemon-wiring.test.ts
# 关键用例: boot 重试期 exit 不发 system_codex_exit；boot 成功后 exit 才发。
bun test src/unit-test/codex-adapter.test.ts -t "start"
# 关键用例: start() teardown 后端口可重新 bind / catch rethrow 原错 / 成功路径不清理。
```

**真机风格 (用 fake-codex 起真 daemon):**
```bash
# 见 0.3 装好 TMPBIN/codex (command-driven)
COUNTER=$(mktemp); rm -f "$COUNTER"     # 计数文件，首个实例失败
export FAKE_CODEX_FAIL_FIRST_BOOT="$COUNTER"
LOG="$STATE_ROOT/pairs/<id>/agentbridge.log"
abg codex          # daemon 起 codex；第一个实例被 SIGKILL，第二个正常 boot
sleep 3
grep -c "system_codex_exit\|重启 Codex 手动\|Codex app-server exited, restart it manually" "$LOG"
cat "$COUNTER"     # 期望 >= 2 (第一个失败 + 第二个成功)
abg doctor         # codex app-server / readiness 最终应 OK
```

**Observe:**
- `$COUNTER` 内容 ≥ 2 (第一次失败、第二次成功)。
- daemon 最终把 Codex bootstrap 成功 (doctor `daemon readiness` / `codex app-server` 走向 OK)。
- 重试期被 SIGKILL 的那次 exit **没有**给用户发 `system_codex_exit` / "restart it manually" 警告 (grep 计数为 0)。

**PASS/FAIL:**
- PASS: 集成 + 单元用例通过；真机中重试恢复成功且重试期 exit 警告计数为 0。
- FAIL: 首启失败后 daemon 放弃重试 (boot deadline 自退)、或重试期误发"重启 Codex 手动"警告、或 `start()` 失败后端口/relay 泄漏导致重试 checkPorts 判 foreign。

---

## P2 — Edge / Robustness

### T5. Corrupt-registry 降级磁盘扫描 (#152): pairs / pairs prune 不崩

**Tag:** [P2] [CODEX-SANDBOX] (纯文件 + CLI)
**触及代码:** `cli/pairs.ts` (`isRegistryCorruptError` / `collectDiskScanRows` / `pruneOrphanDirs` degrade)、`pair-registry.ts` `removeOrphanPairDirIgnoringRegistry`。

> `readRegistry` 对 **重复 slot** 或 **重复 pairId** 故意抛 `PAIR_REGISTRY_CORRUPT`。`abg pairs` / `abg pairs prune` 经 `readRegistry`，必须**降级为磁盘扫描**而不崩，并打印 registry 路径、退出码 2，且**保护 live pair 目录**不被删。

**Setup — 先造一个 live pair 再篡改 registry:**
```bash
REG="$STATE_ROOT/pairs/registry.json"
cp "$REG" "$REG.bak"                 # 备份 (0.4 reset 会恢复)
# 起一个真 pair 占据 live 目录，用于验证"保护 live"
cd "$REPO" && abg claude &           # 或用 fake-codex 起 daemon；记下其 pairId
LIVE_ID=$(abg pairs --json | bun -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.find(x=>x.running).pairId)')
# 篡改: 写入一个 DUPLICATE slot / duplicate pairId 使 readRegistry 抛 corrupt
bun -e '
  const fs=require("fs"); const p=process.env.REG;
  const raw=JSON.parse(fs.readFileSync(p,"utf8"));
  const arr = Array.isArray(raw)?raw:(raw.pairs||[]);
  const first = arr[0] || {pairId:"dup-a",name:"x",slot:0,cwd:"/tmp",source:"cwd"};
  // 制造重复 slot + 重复 pairId
  arr.push({...first}); arr.push({...first, pairId:first.pairId, slot:first.slot});
  const out = Array.isArray(raw)?arr:{...raw,pairs:arr};
  fs.writeFileSync(p, JSON.stringify(out,null,2));
' REG="$REG"
```

**Steps & Observe:**

```bash
# (1) list 降级
abg pairs; echo "exit=$?"
```
- stderr 出现 `⚠️  pair registry 不可读（…）` + **registry 文件路径** + "降级为磁盘扫描列出 …"。
- stdout 仍打印表格 (slot/name/cwd 显示为 `-`)，`exit=2`。

```bash
# (2) --json 仍是合法 JSON (警告走 stderr)
abg pairs --json 2>/dev/null | bun -e 'JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("json-ok")'
```
- `json-ok` 打印 (stdout 无警告污染)。

```bash
# (3) prune 干跑降级 (默认 dry-run，不删)
abg pairs prune; echo "exit=$?"
```
- stderr `⚠️ pair registry 不可读 … 跳过 registry 条目回收，降级为磁盘扫描清理孤儿目录`，`exit=2`。
- 输出 "Would remove …" 不含 LIVE_ID (live 目录被 `pairDirDaemonAlive` 守护)。

```bash
# (4) prune --apply 降级删孤儿 (走 removeOrphanPairDirIgnoringRegistry，仅 liveness gate)
ORPHAN="$STATE_ROOT/pairs/orphan-deadbeef00000000"; mkdir -p "$ORPHAN"   # 造一个无 daemon 的孤儿目录
abg pairs prune --apply; echo "exit=$?"
ls -d "$ORPHAN" 2>/dev/null && echo "ORPHAN-STILL-THERE" || echo "ORPHAN-REMOVED"
ls -d "$STATE_ROOT/pairs/$LIVE_ID" >/dev/null && echo "LIVE-PROTECTED" || echo "LIVE-DELETED-BUG"
```
- 孤儿目录被删 (`ORPHAN-REMOVED`)，**LIVE pair 目录仍在** (`LIVE-PROTECTED`)，`exit=2`。

**PASS/FAIL:**
- PASS: list / --json / prune / prune --apply **全部不崩**，stderr 打印 registry 路径、退出码 2、`--json` stdout 合法、孤儿被回收、**live pair 目录受保护**。
- FAIL: 任一命令崩溃 (uncaught PAIR_REGISTRY_CORRUPT)、`--json` stdout 被警告污染、退出码非 2、或 live pair 目录被误删。

**Reset:** `kill %1 2>/dev/null; abg kill all; mv "$REG.bak" "$REG"; rm -rf "$ORPHAN"`。

---

### T7. Daemon identity (#149): bind 竞争不抹活 daemon + system_ready 不跨重启被去重

**Tag:** [P2] [CODEX-SANDBOX] (主要靠单元 + 集成实证; 真机竞态 USER)
**触及代码:** `daemon.ts` (control-server bind try/catch、owner-aware remove*、pid/token 延后到 bind 成功后、SYSTEM_MSG_SALT)、`daemon-identity-ownership.ts`。

#### T7.1 control-port bind 竞争 — loser 不破坏 incumbent 身份

> #149 HIGH-1: 输掉 control-port bind 的 D2 因 EADDRINUSE `process.exit(0)`，**不做破坏性清理** (remove* 是 owner-gated)，且 pid/token 写入延后到 bind 成功后 → D1 的 `daemon.pid` / `status.json` / `control-token` 不被 D2 覆写/删除。

**自动化优先:**
```bash
cd "$REPO"
bun test src/unit-test/daemon-identity-ownership.test.ts     # pidFileOwnedByUs 严格整数匹配
bun test src -t "bind"                                        # control bind race / EADDRINUSE 不破坏 incumbent
```

**真机竞态 (USER, 选做):**
```bash
# 起 D1
abg claude &                       # 或 fake-codex 起 daemon
sleep 2
D1_PID=$(cat "$STATE_ROOT/pairs/<id>/daemon.pid")
TOKEN_BEFORE=$(cat "$STATE_ROOT/pairs/<id>/control-token" 2>/dev/null)
# 几乎同时手动再起第二个 daemon 进程抢同一 control port (4502)
# (用 bun src/daemon.ts 或 abg codex 第二次，制造 EADDRINUSE)
abg codex   # ensureRunning 看到 healthy D1 应直接复用，不该起 D2；若强行起 D2 应 EADDRINUSE 干净退出
sleep 1
D1_PID_AFTER=$(cat "$STATE_ROOT/pairs/<id>/daemon.pid")
TOKEN_AFTER=$(cat "$STATE_ROOT/pairs/<id>/control-token" 2>/dev/null)
kill -0 "$D1_PID" 2>/dev/null && echo "D1-ALIVE" || echo "D1-DEAD-BUG"
[ "$D1_PID" = "$D1_PID_AFTER" ] && echo "PID-FILE-INTACT" || echo "PID-FILE-CLOBBERED-BUG"
[ "$TOKEN_BEFORE" = "$TOKEN_AFTER" ] && echo "TOKEN-INTACT" || echo "TOKEN-CLOBBERED-BUG"
```

**PASS/FAIL:**
- PASS: 单元/集成用例通过；真机中 D1 仍活、`daemon.pid` 仍指向 D1、`control-token` 未变 (loser 没破坏 incumbent)。
- FAIL: D1 被抹身份 (`D1-DEAD-BUG` / `PID-FILE-CLOBBERED-BUG` / `TOKEN-CLOBBERED-BUG`)，导致 `pairDirDaemonAlive=false` / prune 删活 pair / kill 打不到 D1。

#### T7.2 system_ready 不跨 daemon 重启被去重抑制

> #149 HIGH-2: systemMessage id 原为 `prefix_++n`，counter 每进程重置 → 重启后 `system_ready_1` 被 bridge deduper (20min TTL 按 id) 当旧 daemon 重复而抑制。修复: 每进程 `SYSTEM_MSG_SALT`，id=`prefix_SALT_++n`。

**Steps (USER):**
1. `abg claude` 起前端，观察 Claude 侧收到一次 `system_ready` (✅ AgentBridge bridge is ready 类)。
2. **20 分钟内**重启 daemon: `abg kill` 然后 `abg claude` (或杀 daemon 进程让前端重连拉起新 daemon)。
3. 观察 Claude 侧应**再次**收到 `system_ready` (新 daemon 的 ready)，而不是被去重静默吞掉。

**自动化辅助:** `grep -o 'system_ready_[a-f0-9]*_' "$STATE_ROOT/pairs/<id>/agentbridge.log" | sort -u` — 两次 ready 应有**不同 salt** 前缀。
**PASS/FAIL:** PASS = 重启后 20min 内再次收到 system_ready (id salt 不同); FAIL = 第二次 ready 被去重吞掉 (前端没收到新 ready)。

---

### T8. CLI 硬化 (#151): signal 退出码 / 负 idle / 空 XDG

**Tag:** [P2] [CODEX-SANDBOX] (纯函数 + 单元) / 部分 [USER]
**触及代码:** `cli/claude.ts` `mapChildExitCode`、`config-service.ts` `normalizeBoundedInteger`、`state-dir.ts` `resolveXdgStateBase`。

#### T8.1 `abg claude` 子进程被信号杀死 → 退出码 128+N (非 0)

**自动化优先:**
```bash
cd "$REPO"
bun test src/unit-test/cli.test.ts -t "mapChildExitCode"
# 断言: SIGINT→130, SIGTERM→143, SIGKILL→137, 未知 signal→128, 无 signal→code??0
```
**真机版 (USER):**
```bash
abg claude &                # 真起 claude
CLAUDE_WRAP=$!
sleep 3
# 杀掉 claude 子进程 (wrapper 应映射 128+N 退出)
pkill -TERM -P "$CLAUDE_WRAP"   # 给 wrapper 的子 claude 发 SIGTERM
wait "$CLAUDE_WRAP"; echo "wrapper-exit=$?"
```
**Observe / PASS-FAIL:** PASS = `mapChildExitCode` 单元全绿；真机 wrapper 退出码为 143 (SIGTERM) / 130 (SIGINT) 等 **非 0**; FAIL = 信号杀死后 wrapper 报 exit 0 (脚本化破功)。

#### T8.2 负 idleShutdownSeconds 回落默认 → daemon 不即起即死

> #151 FIX3: 负 `idleShutdownSeconds`*1000 被 setTimeout 钳到 0 → daemon boot 后~立即自退 (即起即死)。修复后越界回落默认。

**自动化优先:**
```bash
cd "$REPO"
bun test src/unit-test/config-service.test.ts -t "idleShutdownSeconds"
bun test src/unit-test/config-service.test.ts -t "normalizeBoundedInteger"
```
**真机版 (USER/CODEX-SANDBOX):**
```bash
# 在一个临时项目目录写 .agentbridge/config.json 带负 idle
T=$(mktemp -d); cd "$T"; mkdir -p .agentbridge
echo '{"idleShutdownSeconds":-5}' > .agentbridge/config.json
abg doctor    # config.json 检查: 应为 parsed (默认生效) 而非 corrupt；负值已回落
abg claude &  # daemon 应稳定存活 (不在 boot 后立即自退)
sleep 6; abg doctor | grep -i "daemon health"   # 期望 OK，证明没即起即死
abg kill
```
**PASS/FAIL:** PASS = config 单元全绿；真机 daemon 启动 5s+ 后仍 healthy (负 idle 已回落默认 ≥1s); FAIL = daemon boot 后秒退 (idle 钳 0)。

#### T8.3 空 `XDG_STATE_HOME` 不解析到 cwd 相对目录

> #151 FIX2: `XDG_STATE_HOME=""` 经 `??` 不回落，`join("","agentbridge")` → 相对路径 `agentbridge` → state 落到 cwd。修复: `resolveXdgStateBase("")` 回落 `~/.local/state/agentbridge`。

**⚠️ darwin SKIP:** macOS 上 `platformBaseDir` 早返回 `~/Library/Application Support/AgentBridge`，**不读 XDG** → 真机用例只能在 **Linux** 跑。darwin 下改用单元测试实证 (跨平台可跑):
```bash
cd "$REPO"
bun test src/unit-test/state-dir.test.ts -t "resolveXdgStateBase"
# 断言: resolveXdgStateBase("") === resolveXdgStateBase(undefined) === ~/.local/state/agentbridge
#       且绝不返回相对路径 "agentbridge"
```
**Linux 真机 (若有 Linux 机):**
```bash
cd /tmp/somewhere && rm -rf ./agentbridge
XDG_STATE_HOME="" abg pairs >/dev/null 2>&1
ls -d ./agentbridge 2>/dev/null && echo "RELATIVE-LEAK-BUG" || echo "NO-CWD-LEAK"
```
**PASS/FAIL:** PASS = `resolveXdgStateBase` 单元全绿 (空串回落 `~/.local/state/agentbridge`)；Linux 上 cwd 下不出现 `./agentbridge`; FAIL = 单元失败或 cwd 下泄漏出 `agentbridge/` 目录。

---

### T9 (P2 部分). 多 pair side-by-side

**Tag:** [P2] [USER] (多前端)
**触及代码:** `pair-resolver.ts` slot 分配 (+10 步进)、`cli/claude.ts` conflict guard、`cli/kill.ts --pair`。

**Steps:**
```bash
cd "$REPO"
abg --pair work claude     # 终端 1: pair "work" → slot 0 (4500/4501/4502) 或下一个空 slot
abg --pair review claude   # 终端 2: pair "review" → 下一 slot (+10: 4510/4511/4512)
abg pairs                  # 两行，slot/ports 互不重叠
# 冲突守卫: 对已 live 的 work 再起一个
abg --pair work claude     # 终端 3: 应被拒 (Pair "work" … already has an active Claude session)
# 单独停一个，另一个不受影响
abg --pair work kill
abg pairs                  # work 停止 / review 仍 running
abg --pair review kill
```

**Observe:**
- `abg pairs` 两个 pair 的 `app/proxy/control` 端口三元组**不重叠** (slot 0 vs slot 1: 4500/4501/4502 vs 4510/4511/4512)。
- 重复启动 live `work` → 终端 3 被拒，终端 1 不受影响。
- `abg --pair work kill` 只停 work，review 仍 running。

**PASS/FAIL:**
- PASS: 两 pair 端口隔离并存、冲突守卫拒第二个 live work、`--pair` kill 精准只停目标。
- FAIL: 端口冲突 / 两 pair 互相干扰 / 冲突守卫漏判 / `--pair kill` 误杀另一个 pair。

---

## 已知 flaky / 跳过 (Known-flaky / Skip)

| 用例 | 原因 / Reason | 处置 |
|---|---|---|
| **T3 steer (真机)** | 本地 steer **必须**带 `expectedTurnId` (CLAUDE.md + fake-codex.ts L216 实证: 缺字段 → app-server 直接 `missing field expectedTurnId` 拒绝, B0 曾因此每条 steer 反弹)。真机取当前 turnId 有时序窗口。 | 优先用 fake-codex 方案 A 自动化; 真机 steer 失败先确认是否漏带 expectedTurnId 再判 FAIL。 |
| **T8.3 空 XDG (真机)** | darwin `platformBaseDir` 早返回、不读 XDG → 真机不可复现。 | darwin 上 **SKIP 真机**, 用 `resolveXdgStateBase` 单元实证; 仅 Linux 跑真机版。 |
| **T4.2 / T7 真机竞态** | EVICTED/CONTRACT_MISMATCH 驱逐与 control-port bind race 需精确时序，手动难稳定复现。 | 以单元/集成用例为 source of truth (`shouldEmitReconnectSuccess` / `daemon-identity-ownership` / `bind` race); 真机版为加分验证, 复现不出**不判 FAIL**。 |
| **T4 daemon SIGKILL 重连** | 前端重连依赖指数退避 + ensureRunning 时序; codex resume 有上游 bug (GitHub #14470/#12382)。 | 重连不上时先 `abg codex` 手动触发 ensureRunning; codex 侧建议开新会话而非 resume。 |
| **Codex active turn 期发 reply** | busy guard 会拒; 看到 `⏳ Codex is working` 应等 `✅ Codex finished` (除非有意测 T3 busy/steer)。 | 非 T3 用例避免在 turn 中途发 reply。 |
| **真 Codex 网络/订阅** | T3/T6/T7 真机版依赖真 codex app-server, 受网络与额度影响。 | 这些用例**首选 fake-codex fixture** (确定性、无网络), 真机版仅作补充。 |

---

## 分工建议 (Work split — Claude × Codex)

- **Codex (sandbox 全自动)** 包揽: T1 (健康三连)、T5 (corrupt-registry)、T6 (boot-retry, fake-codex)、T3 方案 A (fake-codex turn)、以及所有 `bun test` 实证子用例 (T4.2 / T7 / T8 的单元+集成层)。
- **Claude / 真人** 负责: T2 (双向消息 loop-prevention)、T4.1 (live 前端杀 daemon 重连)、T7.2 (system_ready 跨重启)、T8.1/T8.2 真机版、T9 (多 pair 真前端)、以及所有需观察交互式 TUI 通知的步骤。
- 每个用例跑完按 **0.4 环境重置**，再交叉复核对方结论 (Claude review Codex 的自动结果, Codex 复跑 Claude 报告里能脚本化的断言)。

---

### Related

- Round-3 fixes: #150 (reconnect)、#151 (CLI/config/state 硬化)、#152 (corrupt-registry 降级)、#153 (codex boot-retry)
- Round-2 fixes: #149 (daemon identity & lifecycle)
- Unit/integration: `src/unit-test/{cli,config-service,state-dir,codex-adapter,pair-registry,pairs-corrupt-registry,daemon-identity-ownership}.test.ts`、`src/integration-test/{daemon-wiring,e2e-reconnect,e2e-cli}.test.ts`
- Fixture: `src/integration-test/fixtures/fake-codex.ts`
