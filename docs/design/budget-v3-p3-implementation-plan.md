# Budget v3 — P3 三态 admission 闸门 实施计划

> 状态：**计划（待 green-light）**。由 4 个并行只读勘察 subagent（Claude 侧）对照 `budget-strategy-v3.md` §3.2 / §6 P3 + 当前代码产出并交叉收敛。设计稿自标 P3「碰 live injection/gate 语义、风险面大」。
> 生成时间：2026-06-16（利用 Claude 周额度 surplus 的产物，未动代码）。

## 0. 目标（设计稿 §3.2 / §6 P3）

把闸门从二态（paused / 否）升级为三态：

```
gateState: "open" | "admission-closed" | "closed"
```

- `open`：照常放行。
- `admission-closed`（新增，仅 maximize 生效）：**拒新任务、放收尾**。
  - 进入条件（任一）：5h 窗口 util ≥ `admissionAt`(默认 85)；或 weekly runway < `finishingHorizon×2`（RECOMMEND-7）；或 §3.1 `dynamicPauseAt` 返回 `"admission-closed"`（REAL-4 hard cap：util≥targetUtil 或临近重置收尾带）。
  - 退出（滞回）：`util < admissionAt−5` 且 weekly runway 回到下限之上，或对应窗口重置。
  - 行为：拒新 `turn/start` → 新错误码 `budget_admission`（区别 `budget_paused`）；放行 `on_busy="steer"`；放行 `wrapUp:true` 的 reply，每 5h 窗口至多 `wrapUpQuota`(默认 2) 个、**配额持久化**；**不打断进行中 turn**（等其自然完成后再发 admission directive）。
- `closed`：维持现状全拒；外加 REAL-2「系统发起的 checkpoint baton」（每窗口 1 次、仅 `turnPhase=idle`、记日志、用过即拒）。

不变量 **I2（phantom-hold）**：曾进入 admission-closed/closed 的窗口，在数据 stale 期维持原状态，绝不因数据缺失开闸。

## 1. 文件级落点（file:line 锚点）

### 1.1 类型 + 配置（纯增量，零行为变化 — 先做）
- `src/budget/types.ts`
  - 新增 `gateState: "open"|"admission-closed"|"closed"`（BudgetSnapshot 可选字段，向后兼容）。
  - `MaximizeConfig`（当前 P2 五键）+ `admissionAt`(默认 85, 范围 [50,99], 须 < targetUtil) + `wrapUpQuota`(默认 2, 范围 [0,10])。P2 已刻意留空给 P3（§P2 note ≈ L423「不做 parse-only 空键」）。
- `src/config-service.ts`
  - 解析/校验/默认这两键，套用既有关系约束模式（仿 `pauseAt ≤ resumeBelow`，`admissionAt < targetUtil` 违反则整 maximize 块回默认 + warn）。
  - env override：`AGENTBRIDGE_BUDGET_ADMISSION_AT` / `..._WRAP_UP_QUOTA`。

### 1.2 决策层
- `src/budget/budget-decision.ts`
  - `dynamicPauseAt`（L106-149）**已返回** `number | "admission-closed"` 信号；`maximizeWindowEntry`（L227-241）P2 经 I1 floor 把它映射成 closed（§P2 REAL-4 note ≈ L432）。**P3 直接消费该信号，不再 floor。**
  - 新增 `agentShouldAdmitClose` / `agentCanAdmitOpen` 谓词（与 `agentShouldPause`/`agentCanResume` 平行；同样以 `isDecisionGrade` 为前置）。

### 1.3 闸门状态机（**Q4 关键决策**）
- `src/budget/budget-fingerprint.ts`：`PauseSide`(L38) / `FingerprintState`(L63-79) / `classifyPoll`(L330-397) / `nextActiveSide`(L204-215) / `directiveFingerprint`(L274-319，刻意不含动态线，R6) / 相位保持(L370-378)。
  - **Q4 决议（本计划推荐）= 折中 A′**：在 `FingerprintState` 内**新增独立 admission 车道**（`admissionSide/admissionFingerprint/admissionResumeEpoch/admissionReason`），但保持 `classifyPoll` 为**单一 reducer + 单一 phantom-hold 守卫**覆盖两条车道；admission 的进出滞回抽到独立函数 `nextAdmissionSide`（独立可测）。
    - 理由：① I2 phantom-hold 只此一处，杜绝 Option B 双份实现漂移；② reset-epoch 600s 桶与 pause 共用，避免 bucket drift；③ admission 逻辑独立成函数，兼顾 Option B 的可测性。
    - 取舍 vs 纯并列状态机：避免 5×5 状态爆炸只有 ~10 可达；pause 优先于 admission 展示（已 paused 时抑制 admission directive）。

### 1.4 协调器
- `src/budget/budget-coordinator.ts`
  - `isGateClosed()`(L231-232) → 新 `gateState(): "open"|"admission-closed"|"closed"`（closed 优先，其次 admission，其余 open）。
  - 新 `emitAdmissionDirectivePostTurn()`（复用 `emitDirective`/`emit` 通道，新前缀 `system_budget_admission`，指纹去重）。
  - 新 `checkAndConsumeWrapUpQuota()`（读/校验当前 5h 窗口配额、原子写回）。

### 1.5 daemon 注入咽喉（**风险最高**）
- `src/daemon.ts`
  - 注入序（会话校验 → **budget 闸 ~L1212** → busy guard/steer L1248（steer 在闸前，天然放行）→ interrupt L1311-1406 → 注入 L1409）。
  - L1212 二态 `isGateClosed()` → 三态：`closed`→`budget_paused`；`admission-closed` 且非 steer/非 wrapUp→`budget_admission`；wrapUp→查配额放行/超额拒。
  - 新 `budgetAdmissionGateError()`（仿 `budgetPauseGateError` L491）：「5h 窗口收尾保护中，仅接收收尾类注入；5h 重置 HH:MM；剩余配额 X/Y」。
  - `turnPhaseChanged` 监听（L556-559）扩展：`running|stalled → idle` 且 admission-closed → 发 admission directive（指纹防刷屏）。
  - interrupt 路径 await 后（L1377 域）补 gateState 复检（防 await 期间翻 admission-closed 后误注新 turn）。

### 1.6 协议 + adapter
- `src/control-protocol.ts`：`claude_to_codex`(L76-101) 加 `wrapUp?: boolean`；result.code 注释加 `budget_admission`。向后兼容：缺字段→false，不需 bump contractVersion（双向可选）。
- `src/claude-adapter.ts`：`reply` 工具 schema(L393-423) 加 `wrap_up`(可选)；`ReplySender` 签名(L30-35) 透传 `wrapUp`；`handleReply`(L555-643) 抽取 + 渲染 `budget_admission` 文案。

### 1.7 持久化（新模块）
- 新 `src/budget/wrap-up-quota.ts`（仿 `pending-reader.ts` 原子读写 + 故障隔离）：`<stateDir>/wrap-up-quota.json`，按 5h `resetEpoch` 键计数；resetEpoch 跳变自动清零（Q9 共识，与 R6 抖动护栏共存）；损坏/缺失→从零开始，绝不抛。
- `src/state-dir.ts`：加 `wrapUpQuotaFile` getter。

## 2. 测试清单（仿 P2 结构）
- 新 `src/unit-test/budget-admission.test.ts`：
  - admission-closed：新 turn 拒(`budget_admission`) / steer 放 / wrapUp 配额内放、超额拒。
  - running turn 不被打断；完成后才发 directive；directive 去重（相位多次跳变只发一次）。
  - closed 优先 admission（closed 时 wrapUp 也拒，除 REAL-2 baton）。
  - 5h 重置：admission 退出、wrapUpQuota 清零。
  - **I2 phantom-hold**：admission-closed 后数据 stale，状态维持，绝不开闸。
  - weekly runway < 2×finishingHorizon 触发 admission（RECOMMEND-7）。
  - REAL-2 baton：closed + idle → 每窗口 1 次、记日志、第二次拒。
  - 配额跨 daemon 重启持久化（Q9）；resetEpoch 跳变清零。
  - 协议兼容：旧 bridge 无 `wrapUp` 字段 → 默认 false。
  - 配置：`admissionAt ≥ targetUtil` 违反 → 整块回默认 + warn。
- 更新 `budget-coordinator.test.ts` / `budget-fingerprint.test.ts` / `config-service.test.ts` / `daemon-wiring.test.ts`。

## 3. 风险登记
| 风险 | 缓解 |
|---|---|
| daemon 注入 await 期间闸状态翻转误注 | interrupt 后 L1377 域 gateState 复检 |
| wrapUp 配额因 daemon 重启清零后门 | 持久化到 `wrap-up-quota.json`，resetEpoch 跳变才清 |
| util 在 admissionAt 抖动致 directive 刷屏 | 指纹排除原始 util，仅 reset-epoch 桶 + 滞回 + phantom-hold |
| pause 与 admission 同时触发，文案重叠 | 协调器优先展示 pause，抑制 admission directive |
| 幂等重试重复扣配额 | idempotencyKey 守重放，配额只 +1（需测试坐实） |
| Q4 双份 phantom-hold 漂移 | 采折中 A′（单 reducer 单 phantom-hold） |

## 4. 实施顺序（低风险 → 高风险；每步过 cross-review gate 才提交）
1. types.ts + config-service.ts（纯增量，零行为变化）→ 单测。
2. wrap-up-quota.ts + state-dir.ts（持久化模块）→ 单测。
3. budget-decision.ts 谓词（`agentShouldAdmitClose`/`agentCanAdmitOpen`）→ 单测。
4. budget-fingerprint.ts admission 车道（Q4 A′）→ 单测。
5. budget-coordinator.ts `gateState()` + directive + 配额方法 → 单测。
6. control-protocol.ts + claude-adapter.ts（wrapUp/错误码/兼容）→ 单测。
7. daemon.ts 三态闸 + turnPhase 监听 + interrupt 复检（**风险最高，最后做**）→ 集成测试。
8. 全量 `bun run check` + `build:plugin` + 手写 E2E 测试计划 + 2-fresh-reviewer cross-review 循环至连续两轮 0 REAL。
