# Budget 策略 v3 设计稿 — 窗口利用率最大化 + 任务完整性保护

> 状态：**v3.1 实施中**。Codex 对抗审 2026-06-11（4 REAL + 2 SUSPECT + 2 RECOMMEND 全采纳，Q1-Q10 共识）已落定为实施基线。**进度：P1（燃尽率展示 + Q7 doctor）已上线 master；P2（时间感知暂停线 / maximize）已实现并通过 cross-review（见 §6 P2 实现落点）；P3（三态闸门）/ P4（runway 分配判据）待实施。** 原稿基于 master dfc093b。
> 作者：Claude；评审：Codex（对抗审记录见 §8，开放问题共识见 §7）。

---

## 1. 背景与宗旨

现行 budget 协调器（v2.x）的设计哲学是「保守防超」：任一侧 `gateUtil ≥ pauseAt(90)` 即触发暂停/接力，直到 `gateUtil < resumeBelow(30)` 才解除。这套机制在防止额度爆雷上是有效的，但与用户的真实目标正面冲突。

### 三条宗旨（最高准则）

1. **周窗口用满是宗旨。** 订阅额度按窗口结算，窗口结束未用完的部分直接作废 ——「不用即浪费」。理想形态：在周刷新前一刻逼近 100% 用量，同时不被供应商限流把任务中断。
2. **5h 窗口双目标。** 用量调度服务于周目标；但 5h 窗口有一个**更高优先级**目标 —— 不让进行中的任务被中断。接近 5h 限额时进入收尾保护（不接新长任务，但放行收尾消耗），而不是硬冲或一刀切暂停。
3. **跨套餐看绝对量。** Claude 是最顶级套餐、Codex 是次顶级套餐，同样的百分比下绝对余量差很多。任务分配的判据必须从「util 百分比之差」升级为「剩余可工作时间」：`剩余% ÷ 实测燃尽率`，必要时辅以套餐容量先验。

### 今天的活案例（2026-06-11，实测数据）

`~/.budget-guard/probe_codex.json` 实拍：

```json
{
  "util": 92, "bucket_id": "rate_limit.secondary_window",
  "buckets": [
    { "id": "rate_limit.primary_window",   "util": 22, "reset_after_seconds": 1050 },
    { "id": "rate_limit.secondary_window", "util": 92, "reset_after_seconds": 23525 }
  ]
}
```

Codex 周窗口（secondary_window）用到 92%，**约 6.5 小时后（半夜）就刷新**，5h 窗口才 22%。而现行逻辑取 `gateUtil = 92 ≥ pauseAt 90`，直接进入 `pauseSide: "codex"`、闸门关闭、拒绝一切委派 —— 剩余 8% 周额度在刷新前被白白冻结。这正是宗旨 1 描述的反面教材，也是 v3 的第一验收用例。

---

## 2. 现状盘点（v2.x，带 file:line）

### 2.1 数据来源：probe 只有百分比，没有绝对量

- `src/budget/quota-source.ts:339-349` `QuotaSource.fetchBoth()` 并发执行两个外部探针（`~/.budget-guard/bin/budget-probe` 或 `probe.mjs`，`quota-source.ts:351-374` 发现逻辑，可被 `AGENTBRIDGE_QUOTA_PROBE`/`BUDGET_PROBE` env 覆盖）。
- 归一化（`quota-source.ts:208-259` `normalizeTolerantProbeRecord`）只产出：
  - `gateUtil` = `raw.util ?? raw.hard_util`（**resettable hard-winner**：所有可重置桶里 util 最高者，见 `types.ts:35`）；
  - `warnUtil` = `raw.warn_util ?? gateUtil`（含不可重置桶的全桶最大值，仅用于均衡/展示）；
  - `fiveHour` / `weekly` 两个 `BudgetWindow { util, resetEpoch }`（`identifyWindows`，`quota-source.ts:171-199`，id 匹配 `five_hour|primary_window` / `seven_day|secondary_window`，失败退位置兜底）；
  - `rateLimitedUntil` / `fetchedAt` / `stale` / `parsedVia`。
- **probe 输出没有任何绝对 token 字段** —— Claude 侧上游只给 `utilization` 百分比 + `resets_at`；Codex 侧上游给 `used_percent` + `reset_at`（含 `plan_type`，但被探针丢弃）。结论：**绝对量必须靠「套餐容量先验 + 实测燃尽率」估计，无法直接读出**。这是 v3 第 3.3 节的前提。
- 数据质量分层：`isDecisionGrade()`（`budget-state.ts:56-64`）要求存在 `resetEpoch > now` 的 fresh 窗口且 `now - fetchedAt ≤ STALE_MAX_AGE_SEC(600)`（`types.ts:17`）；不达标的记录只能展示、不能驱动决策（`quota-source.ts:309-315` `isDegradedUsage` 负责降级日志）。

### 2.2 什么时候 pause

- 入闸：`shouldEnter()`（`budget-fingerprint.ts:132-135`）—— decision-grade 且 `gateUtil ≥ cfg.pauseAt`。`computeBudgetState` 的 `pauseTrigger`（`budget-state.ts:66-76`）是同一判据的纯函数侧。
- 出闸：`canAgentResume()`（`budget-fingerprint.ts:137-141`）—— decision-grade、无有效 `rateLimitedUntil`、且 `gateUtil < cfg.resumeBelow`。
- 滞回状态机：`classifyPoll()`（`budget-fingerprint.ts:257-322`）维护 `activeSides`（渲染为 `side: claude|codex|both|null`），phantom 数据不重算指纹（防重复横幅，e7a66fc 回归基线）。
- 闸门语义（v2.4 侧别感知）：`pauseSide="claude"` 是**接力**（Claude 停手、Codex 继续，闸门开放）；`pauseSide="codex"|"both"` 才关闸（`budget-coordinator.ts:192-194` `isGateClosed`）。关闸后 daemon 在注入口拒绝（`daemon.ts:953-963`，错误码 `budget_paused`）。
- 预计恢复时间：`resumeBlockingEpoch`（`budget-gate.ts:38-43`）取有效限流 epoch 或「解释当前 gateUtil 的窗口」的重置时间（`matchingGateReset`，`budget-gate.ts:21-31`）。

### 2.3 drift 均衡与并行建议

- drift：`driftFor()`（`budget-state.ts:78-93`），判据是 `|warnUtil(claude) − warnUtil(codex)| > syncDriftPct(10)`，产出 heavier/lighter，指令文案「把可拆分任务分给 lighter」（`balanceDirective`，`budget-state.ts:158-175`）。**纯百分比之差，无绝对量概念 —— 宗旨 3 的反面。**
- parallel：双方 `remaining > minRemainingPct(60)` 且最近 5h 重置在 `timeWindowSec(3600)` 内 → 建议拆并行（`parallelState`，`budget-state.ts:95-117`）。这是 v2 里唯一一点「临近重置该多用」的萌芽，但只覆盖「额度富余」场景。
- Codex 档位经济（R5）：`warnUtil ≥ 60 → balanced`、`≥ 80 → eco`（`budget-state.ts:17-19, 194-199`）；Claude 侧 `warnUtil ≥ 80` 给 subagent 降档建议（`budget-state.ts:201-205`）。

### 2.4 轮询与配置

- 自适应轮询（`budget-coordinator.ts:35-41, 103-137`）：默认 `pollSeconds(300)`；压力 ≥ 50% 减半；接近 `pauseAt−10` 或 `warnUtil ≥ 75` 收紧到 60s；paused 时 15s；并有 reset-aligned 唤醒（重置 epoch + 5s 提前对齐）。**轮询层已经是 time-aware 的，决策层不是 —— v3 主要改决策层。**
- 默认配置 `DEFAULT_BUDGET_CONFIG`（`config-service.ts:20-41`）：`enabled:true, pollSeconds:300, pauseAt:90, resumeBelow:30, syncDriftPct:10, parallel:{minRemainingPct:60, timeWindowSec:3600}, codexTierControl:false`。
- 校验：`normalizeBudgetConfig`（`config-service.ts:255-310`）+ `normalizeBoundedInteger`（`config-service.ts:204-213`）；`pauseAt ≤ resumeBelow` 时双双重置为默认（防进得去出不来）。
- env 覆盖：`applyBudgetEnvOverrides`（`config-service.ts:316-338`），`AGENTBRIDGE_BUDGET_*` 全家桶，daemon 启动时叠加（`daemon.ts:121`）。

### 2.5 任务/turn 可观测性（任务完整性保护的素材）

- `codex.turnPhase: "idle" | "running" | "stalled" | "aborted"`（`codex-adapter.ts:2236`），统一经 `turnPhaseChanged` 事件上报，daemon 写入 status（`daemon.ts:326-328`）并在 reply busy-guard、控制协议响应里携带。
- daemon 注入口顺序（`daemon.ts:886-983`）：会话校验 → busy guard → **budget 闸门（953）** → 取 tier overrides → `turn/start`。即「新任务开闸」在代码里已有单一咽喉，v3 的 admission 闸门可以精确落在这里。
- 持久化基建：`atomicWriteJson`（`src/atomic-json.ts:49`）、按 pair 的平台状态目录（`src/state-dir.ts`，`daemon.pid`/`status.json`/`agentbridge.log` 等同级，可加新文件）。
- 外部参照：`~/.budget-guard/hist_codex.jsonl` 已存在 `{"ts":epoch,"util":int}` 行式历史（quota-guard 自用，单标量、不分窗口、无所有权保证），可作为冷启动种子但不可依赖 —— v3 自采。

### 2.6 现状一页总结

| 维度 | v2 现状 | 与宗旨的冲突 |
|---|---|---|
| 暂停判据 | `gateUtil ≥ 90` 一刀切，**不看离重置还有多久** | 宗旨 1：刷新前 6.5h 冻结 8% 周额度（今日活案例） |
| 暂停粒度 | gateUtil 是全桶 hard-winner 标量，**5h 与周窗口混在一个数里** | 宗旨 2：周窗口紧张会连带冻结 5h 还很空的执行能力 |
| 闸门粒度 | 关闸 = 拒绝一切注入，不区分「新任务」与「收尾」 | 宗旨 2：进行中任务的收尾消耗也被拒 |
| 分配判据 | warnUtil 百分比之差 | 宗旨 3：无绝对量/燃尽率概念 |
| 恢复判据 | `gateUtil < 30` | 周窗口中段暂停后要等数天；好在窗口重置后 util 自然归零可出闸 |

---

## 3. v3 设计

核心翻转：**从「单标量阈值防超」到「按窗口的时间感知预算控制」**。三块新能力：燃尽率估计（3.3，地基）、时间感知暂停线（3.1，周目标）、admission/finishing 双闸门（3.2，5h 目标）、剩余工作时间分配（3.4，跨套餐）。

总开关：`budget.strategy: "conserve" | "maximize"`，默认 `"conserve"`（行为与 v2 完全一致）。maximize 是 opt-in，且设计上满足一条不变量：

> **不变量 I1（只放宽不收紧）：strategy="maximize" 下，任何暂停线都不低于 conserve 的 `pauseAt`；任何降级路径都回退到 conserve 行为。** 即 maximize 只可能比 v2 更晚暂停、更细粒度放行，绝不会更早暂停。

> **不变量 I2（phantom-hold，数据缺失绝不开闸）：曾经进入 closed / admission-closed 的窗口，在数据变 stale / 失去 decision-grade 期间维持原状态，绝不因数据缺失而开闸。**（由 R3 升格而来，RECOMMEND-8；沿用 `budget-fingerprint.ts:186-196` 既有 phantom-hold 机制；P2 验收必须含此不变量测试。）

### 3.1 时间感知的暂停线（周窗口目标）

#### 设计直觉

离窗口刷新越近，「现在多烧一点」的代价越低（反正马上刷新），可容忍的 util 越高；离刷新越远，提前打满的代价是长达数天的瘫痪期，要留缓冲。于是暂停线不再是常数，而是 `time-to-reset` 的函数，并且**按窗口分别计算**（5h 与周各有自己的重置时间与燃尽率），任一窗口越线才触发该侧暂停 —— 取代「gateUtil 标量 ≥ pauseAt」。

#### 函数形态与伪代码

```ts
interface MaximizeParams {
  targetUtil: number;          // 默认 97 —— 刷新点的目标用量（不是 100，留供应商侧抖动余量）
  reserveSlopePctPerHour: number; // 默认 0.4 —— 离刷新每远 1h 多留 0.4 个百分点
  reserveMaxPct: number;       // 默认 7 —— 缓冲上限（远期退化为接近 conserve）
  finishingHorizonMinutes: number; // 默认 30 —— 进行中任务的预计收尾时长
}

/** 单窗口的动态暂停线。
 *  返回 100 表示该窗口本轮不触发暂停（open）；
 *  返回 "admission-closed" 表示该窗口须进收尾保护闸（REAL-4 hard cap，见 3.2 三态闸门）；
 *  返回数值线时由调用方比较 util ≥ line 判定是否全暂停（closed）。 */
function dynamicPauseAt(
  window: BudgetWindow,          // util + resetEpoch（decision-grade 前提）
  burnRatePctPerHour: number,    // 该窗口的实测燃尽率（见 3.3；未知时调用方走降级）
  cfg: BudgetConfig,
  now: number,
): number | "admission-closed" {
  const tH = (window.resetEpoch - now) / 3600;
  if (tH <= 0) return 100;                       // 已过重置点：等下一轮 fresh 数据，不据旧窗口暂停

  const finishingMarginPct = clamp(
    burnRatePctPerHour * (cfg.maximize.finishingHorizonMinutes / 60),
    1, 10,                                       // 收尾余量下限 1 个点、上限 10 个点
  );

  const projectedAtReset = window.util + burnRatePctPerHour * tH;
  if (projectedAtReset <= cfg.maximize.targetUtil) {
    // (a) 完全烧不满 —— 但先过两个 hard cap（REAL-4）：即使 projected 判断"烧不满"，
    //     计量滞后 / 突发消耗也可能直接撞上供应商限流，不允许在高位敞开
    if (window.util >= cfg.maximize.targetUtil) return "admission-closed";   // util 已达目标线：无条件收闸
    if (tH < cfg.maximize.finishingHorizonMinutes / 60 &&
        window.util >= cfg.maximize.targetUtil - finishingMarginPct) {
      return "admission-closed";                 // 临近重置且已进收尾余量带：收闸而非 open
    }
    return 100;                                  // 真·烧不满：不暂停（还应建议加速，见 3.4）
  }

  // (b) 会烧满：暂停线 = 目标 − 收尾余量 − 时间缓冲
  //（注：util ≥ targetUtil 且会烧满时，(b) 给出的线必然低于 util → 全暂停 closed，比 hard cap 更强，故 cap 只需补 (a) 的洞）
  const reservePct = Math.min(
    cfg.maximize.reserveMaxPct,
    cfg.maximize.reserveSlopePctPerHour * tH,
  );
  const line = cfg.maximize.targetUtil - finishingMarginPct - reservePct;

  // 不变量 I1：地板 = conserve 的 pauseAt；天花板 99
  return clamp(line, cfg.pauseAt, 99);
}

/** 侧别入闸判定（取代 shouldEnter 的 gateUtil ≥ pauseAt）。 */
function shouldEnterMaximize(usage: AgentUsage, rates: BurnRates | null, cfg, now): boolean {
  if (!isDecisionGrade(usage, now)) return false;
  for (const [key, window] of [["fiveHour", usage.fiveHour], ["weekly", usage.weekly]]) {
    if (!window || window.resetEpoch <= now) continue;
    const rate = rates?.[key];
    if (rate == null || !rate.confident) {
      // 降级：该窗口退化为 conserve 判据
      if (window.util >= cfg.pauseAt) return true;
      continue;
    }
    const line = dynamicPauseAt(window, rate.pctPerHour, cfg, now);
    if (line === "admission-closed") { markAdmissionClosed(key); continue; } // 进 3.2 收尾闸，不算全暂停
    if (window.util >= line) return true;
  }
  // 两个窗口都无法识别（理论上 isDecisionGrade 已挡掉）：退化为 conserve
  if (!usage.fiveHour && !usage.weekly) return usage.gateUtil >= cfg.pauseAt;
  return false;
}
```

#### 默认参数的标定（用今日活案例做验收）

统一假设实测燃尽率 ≈ 1.2 pct/h，逐行标注分支归属（REAL-1 修正后）：

- **今日活案例**（`util=92, tH≈6.5h`）：hard cap 不触发（92 < 97，tH=6.5 ≥ 0.5）；`projectedAtReset = 92 + 1.2×6.5 ≈ 99.8 > 97` → 走 **(b)**；`finishingMargin = clamp(1.2×0.5, 1, 10) = 1`；`reserve = min(7, 0.4×6.5) = 2.6`；`line = 97 − 1 − 2.6 = 93.4`，clamp 后 93.4 > 92 → **不暂停，继续干**。✅
- **最后 1h 例 (i)**（`tH=1, util=92`）：`projected = 92 + 1.2×1 = 93.2 ≤ 97` → 走 **(a)** 且两个 hard cap 都不触发（92 < 97；tH=1 ≥ 0.5）→ `return 100`，**不暂停**（烧不满路径）。✅
- **最后 1h 例 (ii)**（`tH=1, util=96`）：`projected = 96 + 1.2×1 = 97.2 > 97` → 走 **(b)**；`finishingMargin = 1`；`reserve = min(7, 0.4×1) = 0.4`；`line = 97 − 1 − 0.4 = 95.6`，96 ≥ 95.6 → **触发暂停**（保护性正确：utilization 已高于线，再烧会撞穿 97）。✅
- **远期**（`tH=120`，即离刷新还有 5 天）：`projected = util + 1.2×120 = util + 144 > 97` 恒成立 → 走 **(b)**；`reserve` 顶到 7 → `line = 97 − 1 − 7 = 89 → clamp 到 pauseAt=90` → 行为与 v2 等同。✅（远期保守）

> 注（REAL-1）：宗旨 1 的「最后 1h 95% 也继续干」由 **(a) 烧不满分支自然达成**（`95 + 1.2×1 = 96.2 ≤ 97` → return 100 → continue）；(b) 分支的 95.6 线**只拦 projected 会撞穿 97 的场景**（如例 (ii) 的 util=96）。两条路径合起来才是宗旨 1 的完整语义：烧不满就放行，会撞穿才设线。

参数表是设计假设而非定论（Q2 共识：先线性形态），P2 验收必须附带一组用 burn-history 真实样本回放的参数标定表（见 §6 P2）。

#### 边界与降级（必须保守）

| 情形 | 行为 |
|---|---|
| `resetEpoch` 未知（=0，#103 形态） | 该窗口不参与 maximize 判定；若两窗口皆未知则整体退化 conserve（`gateUtil ≥ pauseAt`） |
| probe stale / 非 decision-grade | 沿用现状：不入闸不出闸（phantom hold，`budget-fingerprint.ts:186-196` 机制不变） |
| 燃尽率样本不足（`confident=false`，见 3.3） | 该窗口退化 conserve 判据；可用套餐容量先验兜底（opt-in） |
| `rateLimitedUntil > now` | 与现状一致：直接视为不可恢复侧，maximize 不豁免限流 |
| 时钟回拨 / `tH` 异常大（>8d） | clamp `tH` 到 [0, 7×24]；超界按 7d 处理并记日志 |

#### 出闸（resume）语义

`canAgentResume` 的 `gateUtil < resumeBelow` 在 maximize 下改为**对称形态**：曾触发暂停的那个窗口满足「`util < dynamicPauseAt − resumeHysteresisPct(默认 5)`」或「窗口已重置（fresh 数据下 util 断崖回落）」即可出闸。理由：maximize 下暂停点在 93~96 区间，仍要求降到 30 以下等于「周窗口暂停后必等到重置」，与现状无异（重置后 util 归零自然 < 30）；但 5h 窗口在重置后应秒级恢复，现状已能做到，维持。conserve 模式完全不动。

### 3.2 5h 任务完整性保护：admission 与 finishing 双闸门

#### 任务边界在 AgentBridge 语境的定义

- **原子任务单位 = 一个 Codex turn**（`turn/start` → `turn/completed`）。daemon 对它有完整可观测性：`codex.turnPhase`（`codex-adapter.ts:2236`，`idle|running|stalled|aborted`）+ busy guard + 注入口单一咽喉（`daemon.ts:886-983`）。
- **会话级任务 = 一次 require_reply 往返**（Claude 委派 → Codex turn → 回包）。这是「收尾」的语义边界：一个进行中的多轮协作任务，其收尾通常还需要 1-2 个短 turn（验收回包、checkpoint）。
- v3 不试图理解任务内容，只区分三类注入：
  1. **新任务 turn**：闸门 idle 状态下发起的 `turn/start`；
  2. **steer 注入**：`on_busy="steer"` 喂进运行中 turn 的中途修正（不开新 turn）；
  3. **收尾 turn**：admission 收紧后、被显式标记为收尾的短 turn（见下）。

#### 三态闸门（取代现状二态）

现状 `isGateClosed()` 只有 open/closed。v3 引入中间态：

```
gateState: "open" | "admission-closed" | "closed"
```

- `open`：一切照旧。
- `admission-closed`（新增）：以下任一条件满足时进入（仅 maximize 生效）：
  - **5h 窗口** util ≥ `admissionAt`（默认 85）；
  - **weekly runway 极短**（`runwayHours(weekly) < finishingHorizon×2`，RECOMMEND-7）—— admission 不只看 5h util，还看 weekly runway 下限，防周窗口被一个新长任务撞穿；
  - 3.1 的 hard cap 返回 `"admission-closed"`（REAL-4：util 已达 targetUtil，或临近重置且进收尾余量带）。

  行为：
  - 拒绝新任务 `turn/start`，错误码新增 `budget_admission`（区别于 `budget_paused`），错误文案明确「5h 窗口收尾保护中，仅接收收尾类注入；5h 重置时间 …」；
  - **放行** steer 注入（turn 正在跑，喂修正不显著增加新消耗，且中断它反而浪费已投入的 token）；
  - **放行**带 `wrapUp: true` 标记的 reply（control-protocol 扩展一个布尔字段，由 Claude 在收尾时显式声明；防滥用护栏：admission-closed 期间每个 5h 窗口最多放行 `wrapUpQuota`（默认 2）个 wrap-up turn，超出按 `budget_admission` 拒绝；**配额消耗持久化**到 `burn-history.json` 同级状态，防 daemon 重启清零后门，Q9 共识）；
  - 进行中 turn 永不被闸门打断（现状已如此，闸门只挡注入口）。
- `closed`：语义同现状（3.1 的动态线触发，或 conserve 的 pauseAt 触发）。steer 与 wrap-up 不放行（此时是「真没了」，与 quota-guard 硬线对齐）。**唯一例外（REAL-2）—— system-initiated checkpoint baton**：closed 触发时若 `turnPhase === "idle"` 且本窗口尚未用过，放行**恰好一个**系统发起的小型 checkpoint turn（写 checkpoint / 交接收尾；由 daemon/协调器发起，区别于用户新任务；每窗口至多 1 次，每次放行记日志）。动机：避免动态线触发的瞬间连「写 checkpoint 收尾」都做不了，复现今天「冻住最后 8%」的反面案例。其余注入全拒不变。

入/出 admission-closed 同样走滞回：进按上述三条件任一（`≥ admissionAt` / weekly runway 触下限 / hard cap），出要求 `util < admissionAt − 5` 且 weekly runway 回到下限之上，或对应窗口重置。admission 判定**主看 5h 窗口**，外加 weekly runway 下限与 3.1 hard cap 两条护栏（RECOMMEND-7 / REAL-4）；周窗口的常规水位仍由 3.1 的动态线管，「按窗口决策」的解耦原则不变。

#### 与 turnPhase 的协同

- `turnPhase === "running"|"stalled"` 且进入 admission-closed → 不动作，等 turn 自然完成；完成后向 Claude 发一条 admission 指令（复用 directive 通道，指纹机制防刷屏）：「5h 收尾保护中：请把当前协作收到可暂停点，写 checkpoint；新任务等 HH:MM 5h 重置后再派」。
- `turnPhase === "idle"` 且 admission-closed → 指令直接发，Claude 侧不再发起新委派。

### 3.3 绝对量与燃尽率：从百分比到「还能干多久」

#### 为什么燃尽率天然解决跨套餐问题

probe 只有百分比（2.1 已证）。但宗旨 3 要的其实不是绝对 token 数，而是**「这套百分比下双方各还能干多久」**。实测燃尽率（pct/h）天然吸收了套餐容量差：同样的协作负载，顶级套餐烧 0.8 pct/h、次级套餐烧 2 pct/h —— 容量差直接体现在燃尽率里，无需知道分母是多少 token。所以：

```
剩余可工作时间 runwayHours(window) = (限制线 − util) / burnRatePctPerHour，再被 timeToReset 截断
runwayHours(agent) = min over decision-grade windows
```

套餐容量先验只在**冷启动**（无历史样本）时使用，做法 (a)+(b)+(c) 分层：

- **(a) 容量先验（opt-in 配置）**：`budget.capacity.{claude,codex}.tier` 填档位（如 `"max20x"` / `"pro"`），映射到一组「典型协作负载下的预设燃尽率」；或直接填 `assumedPctPerHour`。只作为 EWMA 冷启动的初值与 `confident=false` 期间的兜底。
- **(b) 实测燃尽率（核心）**：协调器每次 poll 顺手采样，持久化 + 滑动估计（下详）。
- **(c) 剩余工作时间**：上式，作为 3.4 分配判据与 `abg budget`/`get_budget` 的新展示行（「Claude 约可再工作 ~Xh / Codex ~Yh」）。

#### 分层修正案（2026-06-11，取代本节原"bridge 自采"方案）

**分工：采集/EWMA/置信/持久化全部下沉到 agent-quota-guard；bridge 是纯消费端。** 原因：guard 已经拥有 probe 数据源、缓存与历史文件（`hist_*.jsonl`），在 bridge 侧重复实现采样与 EWMA 是双写两套估计器——一处口径漂移就会出现两个互相矛盾的"还能干多久"。修正案由用户提出，Claude 与 Codex 双方确认。

**guard probe 字段契约（probe_schema: 2，可选顶层字段，不强依赖）**——每个 bucket 可选追加：

```
burn_rate_pct_per_hour : number   // EWMA 燃尽率（pct/h），guard 计算
burn_confident         : boolean  // guard 的置信门槛判定
runway_seconds         : number   // 中性口径：到 100% 被窗口 reset 截断
depleted_at_epoch      : number   // 预计耗尽时刻（unix 秒）
```

样本不足时字段省略。bridge 侧（`quota-source.ts` parseBurnFields）严格校验：present-but-invalid（非数值/负值/NaN/非布尔）→ **整组丢弃**，窗口本身保留。

**Codex 两条验收约束（原文收录）**：

1. *bridge 对缺字段/旧 schema/非数值/stale/reset-unknown 一律退 conserve（无 runway 即不展示）*——落地在 `burn-view.ts`：`agentRunway` 要求 `!stale && ok && isDecisionGrade && resetEpoch > now && burn_confident === true && runway_seconds 存在`，任一不满足即返回 null，渲染层不出 runway 行。
2. *bridge 禁止自己重算 burn-rate——只用 guard 给的 decision-grade 字段*——bridge 仅做：字段校验透传（quota-source）、跨窗口取最小 runway 的**选择**（burn-view）、时长/钟点**格式化**（render）。原 `burn-history.ts`（采样/EWMA/SUSPECT-5/持久化）整体删除；展示层的 guard-硬线 clamp 改为**文案注明**（"runway 为中性口径，Claude 会先在硬线被外层停住"），不做等比折算——折算假设线性燃烧且与 reset 截断语义冲突，等价于变相重算。

**bridge 消费链**：`quota-source.ts`（解析+严格校验）→ `BudgetWindow.{burnRate,burnConfident,runwaySeconds,depletedAtEpoch}` → `burn-view.ts`（rates 投影 + min-runway 选择）→ `BudgetSnapshot.{burnRate,runway}`（可选字段，旧消费者不破）→ `render.ts`（`燃尽率 ≈X.XX%/h · 约可再工作 X小时Y分钟（至 HH:MM，…窗口为约束）`；runway≈reset 间隔时注"窗口刷新即截断"；非 confident 显"采样中"）。

注意：额度仍是**账号级**口径（同机其他会话共享同一池），guard 估出的燃尽率即账号总体消耗速度——对分配决策恰好正确。原 SUSPECT-5 悲观抖动防护、EWMA 半衰期、置信门槛等估计细节随采集一并归属 guard 侧实现。本仓库不再有 `burn-history.json`、`budget.burnRate.{enabled,sampleCap}` 配置键与 `AGENTBRIDGE_BUDGET_BURN_RATE_ENABLED` env。

### 3.4 分配判据：从 warnUtil 差到剩余工作时间差

#### 新判据

```ts
// strategy="maximize" 且双方燃尽率 confident 时启用；否则回退现状 warnUtil 差
function allocationDrift(claude: RunwayEstimate, codex: RunwayEstimate, cfg): Drift {
  const ratio = Math.min(claude.hours, codex.hours) / Math.max(claude.hours, codex.hours);
  if (ratio >= cfg.allocation.minRunwayRatio /*默认 0.5*/ &&
      Math.abs(claude.hours - codex.hours) < cfg.allocation.minRunwayGapHours /*默认 2*/) {
    return { heavier: null, lighter: null };   // 足够均衡
  }
  const shorter = claude.hours < codex.hours ? "claude" : "codex";
  return { heavier: shorter, lighter: other(shorter) };  // runway 短的一侧是"heavier"
}
```

balance 指令文案同步改写：「Claude 按当前燃尽率约可再工作 ~3.2h、Codex ~9.5h（周窗口为约束），请把后续可拆分任务优先派给 Codex」—— 比「warnUtil 高 12 个百分点」可操作得多，且天然正确处理了「Codex 92% 但 6.5h 后刷新 → runway 被 timeToReset 截断后反而不短」的今日案例。

#### 「烧不满」时的加速建议

3.1(a) 检测到 `projectedAtReset ≤ targetUtil`（按当前速度到刷新点用不满，且未触发 REAL-4 hard cap，即真·return 100 路径）时，发 parallel 型指令的强化版：「按当前燃尽率周窗口刷新时只会用到 ~78%，距刷新还有 ~Xh —— 建议拆更多并行子任务/提高委派密度，否则约 19% 额度将作废」。现有 `parallelState`（`budget-state.ts:95-117`）保留为 conserve 模式的形态；maximize 模式下由这条 projected-underutilization 建议取代（指纹机制防刷屏照旧）。

两条护栏：① 加速/欠载类建议受 **per-account advice cooldown** 约束（默认同账号 30 分钟内不重复发同向建议，防多 pair 集体怂恿过度并行，见 R8 / SUSPECT-6）；② 5h 窗口也加一条**弱化版欠载提示**（Q3 共识），但**只做展示、不驱动分配** —— 5h 持续欠载是周欠载的先行指标，提示即可，不值得为它引入新的分配压力。

---

## 4. 配置与兼容

### 4.1 新增 BudgetConfig 键（全部有默认值，向后兼容）

```ts
interface BudgetConfig {
  // ---- 现有键全部保留，语义不变（conserve 模式 = v2 行为）----
  enabled, pollSeconds, pauseAt, resumeBelow, syncDriftPct, parallel, codexTierControl, codexTiers;

  // ---- v3 新增 ----
  strategy: "conserve" | "maximize";        // 默认 "conserve"
  maximize: {
    targetUtil: number;                     // 默认 97，范围 [90, 99]
    reserveSlopePctPerHour: number;         // 默认 0.4，范围 [0, 5] pct/h（小数键，走 normalizeBoundedNumber，Q6 共识）
    reserveMaxPct: number;                  // 默认 7，范围 [0, 30]
    finishingHorizonMinutes: number;        // 默认 30，范围 [5, 180]
    admissionAt: number;                    // 默认 85，范围 [50, 99]，须 < targetUtil（违反则双双回默认）
    wrapUpQuota: number;                    // 默认 2，范围 [0, 10]
    resumeHysteresisPct: number;            // 默认 5，范围 [1, 30]
  };
  burnRate: {
    enabled: boolean;                       // 默认 true（P1 起纯采集无行为影响）
    sampleCap: number;                      // 默认 500，范围 [50, 5000]
  };
  capacity: {                               // 冷启动先验，全可选
    claude: { assumedPctPerHour5h?: number; assumedPctPerHourWeekly?: number } | null;  // 默认 null
    codex:  { ... } | null;
  };
  allocation: {
    minRunwayRatio: number;                 // 默认 50（百分数存整数），范围 [10, 100]
    minRunwayGapHours: number;              // 默认 2，范围 [1, 168]
  };
}
```

- 整数键校验走 `normalizeBoundedInteger`（`config-service.ts:204`）现有模式；小数参数（reserveSlope 等）**新增 `normalizeBoundedNumber`**（Q6 共识：×10 整数存储是 hack，且后续小数参数会变多，一次把基建补齐）。
- 关系约束（仿 `pauseAt ≤ resumeBelow` 的既有处理，`config-service.ts:270-273`）：`admissionAt ≥ targetUtil` 或 `targetUtil ≤ pauseAt` 时，整个 maximize 块回退默认并记一条 warn（策略仍生效，只是参数复位）。
- env 覆盖扩展：`AGENTBRIDGE_BUDGET_STRATEGY`、`AGENTBRIDGE_BUDGET_TARGET_UTIL`、`AGENTBRIDGE_BUDGET_ADMISSION_AT`、`AGENTBRIDGE_BUDGET_BURN_RATE_ENABLED` 等，沿 `applyBudgetEnvOverrides`（`config-service.ts:316`）现有模式；嵌套小众键（capacity/allocation）与 codexTiers 一样保持 file-config only。

### 4.2 与现有机制的关系

| 机制 | v3 处置 |
|---|---|
| `pauseAt` / `resumeBelow` | **保留为安全网**：conserve 模式的主判据；maximize 模式的暂停线地板（不变量 I1）与一切降级路径的归宿。不废弃。 |
| `AGENTBRIDGE_BUDGET_*` env | 全部兼容；新键按同模式追加。旧 env 在 maximize 下仍有意义（PAUSE_AT 调地板）。 |
| `gateUtil`（hard-winner 标量） | 保留字段与展示；决策层在 maximize 下改为按窗口判定，gateUtil 退居 conserve 判据与降级兜底。 |
| 指纹/滞回状态机（`classifyPoll`） | 结构不动；`shouldEnter`/`canAgentResume` 注入策略函数（conserve 实现 = 现函数原样）。admission 态作为新的 side-车道并入 FingerprintState（或并列小状态机，开放问题 Q4）。 |
| Codex tier 经济（R5） | 不动（warnUtil 档位独立于暂停决策）；maximize 下可考虑「烧不满时强制 full 档」，列开放问题 Q8。 |
| quota-guard（`~/.budget-guard`，外部系统） | **分工边界 + 不可越过的外层硬边界（REAL-3）**：guard 管「Claude 自己这个进程」的硬停（T1 80 / T2 90 / T3 92 轮末强停），是账号自保的最后防线，v3 不接管、不绕过、**也不可越过** —— Claude 侧开 maximize 后，92→97 区间在 guard 解锁前**事实上不可达**，这是边界而非文档提示。落实（Q7 共识 = 增强版 B，进 P1）：① `abg doctor` 检测 `strategy=maximize` 且 guard hardline < `targetUtil` 时给 warning；② `abg budget` / `get_budget` 展示里显式标出「外层 guard 硬线 92（v3 不可越过）」；③ Claude 侧 runway / 动态线**展示层 clamp 到 guard 线**（只 clamp 展示，不改策略层 —— 策略层 Claude 侧 target 仍 97，但文档明示该区间会被 guard 先停；想真用到 97 需用户自行调 guard 侧 `BUDGET_HARD`，本仓库不动）。Codex 侧无此约束，maximize 全区间生效 —— 这恰好覆盖今天的活案例。 |
| `abg budget` / `get_budget` / DaemonStatus.budget | `BudgetSnapshot` 追加可选字段：`burnRate`、`runwayHours`、`gateState`、`dynamicPauseAt`（已生效值）；`render.ts` 增行展示。字段全部 optional，旧消费者不破。 |

---

## 5. 风险与护栏

| # | 风险 | 护栏 |
|---|---|---|
| R1 | 逼近 100% 时供应商硬限流把进行中任务腰斩 | ① `targetUtil=97` 而非 100（供应商侧计量滞后/抖动余量）；② finishing margin 按实测燃尽率预留进行中任务的收尾消耗（3.1）；③ admission 闸门保证越线前已停止接新任务，越线时在飞的最多是收尾 turn；④ `rateLimitedUntil` 一旦出现立即视同 closed（现状语义保留）。 |
| R2 | 燃尽率估计失真（突发大任务、并行 subagent 风暴、同账号其他会话） | ① EWMA 对突发有惯性 → 悲观侧取「最近 3 瞬时样本中至少 2 点连续同向的最大瞬时值」与 EWMA 的较大者（单点尖峰不参与悲观判定，SUSPECT-5，详见 3.3）；runway 展示只用 EWMA（中性侧）；② `confident` 门槛 + 不 confident 即退 conserve；③ 采样剔除跨重置/回退样本对。 |
| R3 | probe stale / rate-limited 期间误放行 | **已升格为不变量 I2（§3 开头，RECOMMEND-8）**：`isDecisionGrade` 是所有入闸判定的前置（maximize 不豁免），曾 closed/admission-closed 的窗口在数据 stale 期维持原状态（phantom-hold 既有机制原样保留），绝不因数据缺失开闸；P2 验收含此不变量测试。降级矩阵见 3.1。 |
| R4 | maximize 下周窗口中段一旦误暂停，resume 等不到（resumeBelow=30 太深） | 3.1 的对称出闸（`util < line − 5` 或窗口重置）专治此点；conserve 不动。 |
| R5 | wrap-up 标记被滥用变成绕闸后门 | 每 5h 窗口 `wrapUpQuota`(2) 上限 + 指令文案明示配额余量 + 日志记每次放行。 |
| R6 | 时钟漂移 / reset_epoch 抖动导致动态线抖动 | 沿用指纹桶（600s，`budget-fingerprint.ts:38`）思想：动态线参与指纹时按 1 pct 量化，tH 按 0.5h 量化，防 directive 刷屏。 |
| R7 | burn-history.json 损坏 | 读失败 → 重建空历史 + `confident=false`（自动退 conserve），原子写防半截文件；版本字段防 schema 漂移。 |
| R8 | 多 pair 同账号重复采样导致估计偏差 / 多 daemon 集体发加速建议（SUSPECT-6） | 采样无偏差风险（probe 同源同值，各 pair 估出的是同一账号燃尽率），仅磁盘冗余，接受。但多个 daemon 同时发加速/欠载建议会集体怂恿过度并行 → **per-account advice cooldown**：加速/欠载类建议带账号级冷却（默认 30 分钟内同账号不重复发同向建议；实现：directive 指纹加「账号 × 建议方向 × 时间桶」维度）。 |

---

## 6. 分期实施计划（每期独立 PR）

### P1 — 燃尽率采集 + 绝对量/runway 估计（纯增量，零行为变化）

- **改动文件**：新 `src/budget/burn-history.ts`（采样、EWMA、持久化、恢复）；`src/budget/types.ts`（`BurnRate`/`RunwayEstimate` + `BudgetSnapshot` 可选字段）；`src/budget/budget-coordinator.ts`（pollOnce 采样钩子）；`src/state-dir.ts`（`burnHistoryPath()`）；`src/budget/render.ts` + `src/cli/*`（展示「约可再工作 ~Xh」）；`src/config-service.ts`（`burnRate.{enabled,sampleCap}` 键 + `strategy` 键解析先行落地，P1 阶段行为仍全等 conserve、仅供 doctor 检测）。
- **Q7 增强版 B 交付物（REAL-3，从 P3 文档提示提前到 P1）**：① `abg doctor` 检测 `strategy=maximize` 且 guard hardline < `targetUtil` 时给 warning；② `abg budget` / `get_budget` 展示显式标出「外层 guard 硬线 92（v3 不可越过）」；③ Claude 侧 runway / 动态线展示层 clamp 到 guard 线。提前理由：否则 P1 一上线，runway 展示就会误导用户以为 Claude 侧能烧到 97。
- **测试要点**：样本对剔除（跨重置/util 回退/时间倒流）；EWMA 收敛与半衰期；ring 截断；corrupt 文件恢复；daemon 重启恢复 confident 状态；snapshot 字段 optional 兼容（旧消费者反序列化不破）；doctor warning 触发矩阵（strategy × guard 硬线组合）；guard 线展示与 runway 展示层 clamp（只影响渲染、不影响内部估计值）。
- **风险**：低。决策路径零接触；最坏情况是展示一行错误的预估。

### P2 — 时间感知暂停线（opt-in `strategy:"maximize"`）— ✅ 已实现（2026-06-15，feat/budget-v3-p2-maximize-pause-line）

> **实现落点（与原设计的差异）**：决策逻辑收敛到新模块 `src/budget/budget-decision.ts`（单一决策源：`dynamicPauseAt` / `agentShouldPause` / `agentCanResume` / `resumeBlockingEpochFor` / `effectiveDynamicLine` / `isDecisionGrade`），由 `budget-state.pauseTrigger` 与 `budget-fingerprint.shouldEnter/canAgentResume` 共同消费，杜绝两处分叉（cross-review 共识）。指纹量化采取更严格路线——动态线**完全不进**指纹（见 budget-fingerprint.ts directiveFingerprint 注释），比设计的「量化后进指纹」更稳，无新指纹轴。maximize 块 P2 只落 `targetUtil/reserveSlopePctPerHour/reserveMaxPct/finishingHorizonMinutes/resumeHysteresisPct` 五键，`admissionAt/wrapUpQuota` 留给 P3（不做 parse-only 空键）。

- **改动文件**：`src/budget/budget-decision.ts`（新增，单一决策源）；`src/budget/budget-state.ts`（`pauseTrigger` 委派 + 恢复文案 strategy 化）；`src/budget/budget-fingerprint.ts`（`shouldEnter`/`canAgentResume`/`resumeAfterEpoch` 改调决策源）；`src/budget/budget-coordinator.ts`（snapshot 动态线 + recovery 文案 strategy 化）；`src/config-service.ts`（maximize 键 + 关系约束 + env + shape/doctor 一致性）；`src/budget/render.ts`（展示动态线）；`src/cli/doctor.ts`（Q7 读 config targetUtil）；`src/daemon.ts`（reply gate 错误文案 strategy 化）；`src/budget/types.ts`（MaximizeConfig + snapshot.dynamicPauseLine）。
- **测试要点**：**今日活案例回归**（codex weekly 92 / tH 6.5h / rate 1.2 → 不暂停）；远期（tH 120h）行为 = conserve；最后 1h 95% 继续（走 (a) 烧不满路径）；降级矩阵全分支（resetEpoch=0 / stale / 非 confident / 双窗口未知）；出闸对称性与窗口重置秒级恢复；不变量 I1 的 property 测试（任意参数下 maximize 线 ≥ pauseAt）。
- **验收追加（对抗审落定）**：
  - **REAL-1 修正后的标定表回归**：§3.1 标定表全部行逐行断言分支归属 —— (a) 烧不满 return 100（tH=1/util=92）、(b) 触线暂停（tH=1/util=96 → 95.6 线）、(b) 远期 clamp 到 pauseAt（tH=120）、hard cap → admission-closed（util ≥ 97 等 REAL-4 情形）。
  - **不变量 I2 phantom-hold 测试**：closed / admission-closed 后数据转 stale，状态必须维持，绝不开闸。
  - **Q2 参数标定表**：✅ 默认 0.4/7 用 2026-06-15 实拍燃尽率做了 sanity 校验（Claude 5h≈1.33%/h·周≈0.44%/h；Codex 5h≈0.37%/h·周≈5.16%/h），标定表四行（今日案例/最后1h (a)+(b)/远期）落 `budget-maximize.test.ts` 逐行断言。**遗留**：用 guard `hist_*.jsonl` 历史样本批量回放的完整参数扫描表延后到参数调优阶段（非阻塞 P2 功能正确性，已显式记此口）。
  - **Q10 出闸对称化牵连清单 checklist**（✅ 已逐项核实并落代码）：`resumeBlockingEpochFor`（maximize 取阻塞窗口 reset 最小值）、`agentCanResume`（per-window 对称出闸）、coordinator 的 RESUME 指令生成（`recoveryDirective` strategy 化）、snapshot 的 `paused`/`gateClosed`/`pauseReason`/`resumeAfterEpoch`、fingerprint 去重（动态线不进指纹）、budget CLI/`get_budget` 渲染（`render.ts` 动态线行）、reply gate 错误文案（`daemon.ts budgetPauseGateError` strategy 化）、checkpoint/handoff 文案（`renderBudgetInterventionDirective` strategy 化）、测试中 gate reopen 断言（coordinator maximize recovery 测试）。
- **REAL-4 过渡说明**：P2 阶段尚无三态闸门，hard cap 的 `"admission-closed"` 信号暂映射为 closed —— **但必须过 I1 floor**：`blocks = window.util >= cfg.pauseAt`。hard cap 子情形 1（`util ≥ targetUtil`）因 `targetUtil > pauseAt` 恒满足 floor；子情形 2（临近重置收尾余量带）可能 `util < pauseAt`（如 pauseAt90/target97/finishingHorizon30/rate20/tH0.25/util88 → admission-closed 但 88<90），此时 floor 后**退化为 open**（P2 不暂停），P3 三态闸门接管后才由 `dynamicPauseAt` 返回值直接驱动 admission-closed。代码见 `budget-decision.ts maximizeWindowEntry`。
- **风险**：中。决策路径核心改动；靠默认 conserve + 全降级路径退 conserve 控制爆炸半径。

### P3 — 任务完整性 admission（三态闸门）

- **改动文件**：`src/daemon.ts`（注入口三态判定 + `budget_admission` 错误路径）；`src/control-protocol.ts`（`wrapUp` 字段 + 新错误码）；`src/claude-adapter.ts`（reply 工具透传 wrapUp + 错误文案）；`src/budget/budget-fingerprint.ts` 或新文件（admission 滞回小状态机 + directive）；`src/budget/types.ts`（`gateState`）。
- **测试要点**：admission-closed 下新 turn 拒 / steer 放 / wrap-up 配额内放、超额拒；running turn 不被打断、完成后才发 directive；closed 优先于 admission-closed；5h 重置后秒级回 open；协议兼容（旧 bridge 不带 wrapUp 字段 → 默认 false）；weekly runway 下限触发 admission（RECOMMEND-7）；closed 态 system-initiated checkpoint baton（REAL-2：每窗口恰好 1 次、`turnPhase=idle` 前提、放行记日志、用过即拒）；wrap-up/baton 配额持久化跨 daemon 重启（Q9 共识，resetEpoch 跳变清零与 R6 抖动护栏共存）。
- **风险**：中。涉及协议与注入口；wrap-up 配额防后门是验收重点。

### P4 — 分配指令改剩余工作时间判据

- **改动文件**：`src/budget/budget-state.ts`（`allocationDrift` + 烧不满加速建议 + 文案）；`src/budget/budget-fingerprint.ts`（balance 指纹兼容新判据）；`src/budget/render.ts`。
- **测试要点**：runway 截断逻辑（timeToReset 截断后今日案例 Codex 不算「短」）；ratio/gap 双门槛；非 confident 回退 warnUtil 差；directive 防刷屏；underutilization 建议触发与消失。
- **风险**：低-中。纯建议层（不碰闸门），文案与判据正确性为主。

依赖关系：P2/P3/P4 都依赖 P1 的燃尽率；P3 与 P2 **可并行开发、但必须按序合入**（分期修订②：P3 依赖 P2 的出闸/指纹语义稳定 —— admission 滞回、hard cap 信号映射、指纹聚合都建立在 P2 落定的语义之上，乱序合入会让回归无法定位）。

---

## 7. 开放问题清单（Q1-Q10，共识已落定）

原问题全部保留存档；「共识」行为 2026-06-11 对抗审落定结论。

- **Q1 — targetUtil 的安全边际**：97 是拍的。供应商计量有多少滞后/抖动？Codex 侧 `used_percent` 的更新粒度若是分钟级整数，97 + 1.2pct/h 燃尽率意味着最后 2.5h 都在盲区里烧。要不要按燃尽率动态收缩 target（`target = 100 − 3×burnRate×probeIntervalH` 之类）？
  - **共识**：默认 97 保留；`timeToReset < 1h` 或 probe lag 明确存在时收缩到 96。
- **Q2 — reserve 函数形态**：线性 `slope×tH` 截断是最简单形态。要不要改成凸函数（如 `sqrt(tH)`，近端更激进、远端更快饱和）？默认参数（0.4/7）需用 P1 收集的真实 burn-history 回放标定，标定方法本身要不要进 P2 验收？
  - **共识**：先线性 `0.4×tH`；**P2 验收必须含参数标定表**（burn-history 真实样本回放）；sqrt 凸形态后置。
- **Q3 — 5h 窗口要不要也吃 maximize 线**：当前设计 5h 只走 admission/finishing（宗旨 2 优先），不追求 5h 用满。但「5h 用满」其实是周用满的子目标 —— 5h 持续欠载周必然欠载。要不要给 5h 也加一个弱化版 underutilization 建议？
  - **共识**：5h 加弱化版欠载建议，但**只做展示、不驱动分配**（见 3.4）。
- **Q4 — admission 态与 FingerprintState 的关系**：并入现有状态机（side 车道加 "admission" 维度）还是并列一个独立小状态机？并入改动集中但状态空间翻倍；并列简单但两台机器的指令可能交错刷屏。我倾向并列 + 共享指纹前缀，求对抗意见。
  - **共识**：并列小状态机，**输出走同一 fingerprint 聚合器**（防 enter/exit 交错刷屏）。
- **Q5 — burn-history 的存放层级**：按 pair 存（无锁、冗余）vs 账号级共享文件（单份、要跨进程锁）。我选了按 pair（registry 锁教训），但多 pair 下 directive 可能基于略有相位差的估计 —— 可接受吗？
  - **共识**：按 pair 存，P1 够用；账号级共享等「多 pair 过度建议」被实测证实后再做（其建议侧风险已由 R8 的 per-account cooldown 兜住）。
- **Q6 — 小数配置参数**：×10 整数存储（丑但零新基建）vs 新增 `normalizeBoundedNumber`（干净但破坏「全整数」现状约定）。
  - **共识**：新增 `normalizeBoundedNumber`（×10 是 hack，小数参数后续会变多）。
- **Q7 — Claude 侧 92→97 区间的归属**：quota-guard `BUDGET_HARD=92` 会先于 v3 的动态线停掉 Claude。方案 A：文档提示用户自行调 guard；方案 B：`abg doctor` 检测 strategy=maximize 且 guard hard < targetUtil 时给 warning；方案 C：v3 干脆把 Claude 侧 targetUtil clamp 到 guard 硬线以下（读 guard 配置？跨系统耦合）。我倾向 B，求对抗意见。
  - **共识**：**增强版 B**（REAL-3）：doctor warning + `abg budget`/`get_budget` 显式标出「外层 guard 硬线 92（v3 不可越过）」+ Claude 侧 runway/动态线展示层 clamp 到 guard 线（不改策略层，target 仍 97，文档明示 92→97 区间会被 guard 先停）。**落实进 P1**。
- **Q8 — tier 经济与 maximize 的互动**：烧不满（underutilization）时把 Codex 强制回 full 档（反正用不完，何必省）？还是 tier 维持独立判据避免耦合？
  - **共识**：不强制 full 档（tier 维持独立判据）；欠载建议文案里可提示「可考虑 full」。
- **Q9 — wrap-up 配额的计数窗口**：按 5h 窗口计还是按 admission-closed 会话计？窗口重置清零的实现要依赖 resetEpoch 跳变检测，与 R6 的抖动护栏如何共存？
  - **共识**：按 5h 窗口计；resetEpoch 跳变清零；**配额消耗持久化**（写进 `burn-history.json` 或同级状态文件，防 daemon 重启重置后门）。
- **Q10 — 出闸对称性的回归面**：maximize 出闸条件改了，`resumeBlockingEpoch`（`budget-gate.ts:38`）的「预计恢复时间」估算要同步改（否则 directive 里的恢复时间与实际出闸点不一致）。这条牵连面我可能没数全，请重点审。
  - **共识**：出闸对称化必须**同步改全部派生面**，牵连清单（待代码核实）：`resumeBlockingEpoch`、budget-gate 的 `canAgentResume`/`shouldBlock`、coordinator 的 STOP/RESUME 指令生成、snapshot 的 `paused`/`gateClosed`/`pauseReason`/`resumeAfterEpoch`、fingerprint 去重、budget CLI/`get_budget` 渲染、reply gate 错误文案、checkpoint/handoff 文案、测试中 gate reopen 断言 —— 此清单进 P2 验收 checklist（见 §6 P2）。

---

## 8. 对抗审记录（Codex，2026-06-11）

| # | 类型 | 议题 | 处置 |
|---|---|---|---|
| REAL-1 | REAL | §3.1 标定表「最后 1h line=95.6」例与 (a)/(b) 分支归属不符（tH=1/util=92/rate=1.2 实走 (a) return 100，到不了 95.6） | 采纳：标定表改为两个准确例子（util=92 烧不满不暂停 / util=96 触 95.6 线暂停）+ 补宗旨 1 达成路径注记，全表分支归属重核 |
| REAL-2 | REAL | closed 全拒与防中断宗旨张力（动态线触发瞬间连写 checkpoint 都不行，复现「冻住最后 8%」） | 采纳：closed 态加 system-initiated checkpoint baton（turnPhase=idle 前提、每窗口至多 1 次、记日志） |
| REAL-3 | REAL | 外层 quota-guard 是不可越过边界，不只是文档提示 | 采纳：Q7 落定增强版 B（doctor warning + guard 硬线显式展示 + Claude 侧展示层 clamp），提前进 P1 |
| REAL-4 | REAL | (a) 分支 return 100「永不暂停」过强（计量滞后/突发可直接限流） | 采纳：(a) 分支前置两个 hard cap（util ≥ targetUtil / 临近重置且进收尾余量带 → admission-closed） |
| SUSPECT-5 | SUSPECT | `max(EWMA, 瞬时)` 悲观判定被单点尖峰放大成误暂停 | 采纳：瞬时值需「最近 3 样本中至少 2 点连续同向」方可参与悲观判定，否则只用 EWMA（等效 winsorize） |
| SUSPECT-6 | SUSPECT | 多 pair 同账号各自发加速建议，集体怂恿过度并行 | 采纳：per-account advice cooldown（30 分钟账号级同向建议冷却，directive 指纹加账号维度时间桶） |
| RECOMMEND-7 | RECOMMEND | weekly runway 极短时 admission 也应禁新任务（防周窗口被新长任务撞穿） | 采纳：admission 入闸条件加 `runwayHours(weekly) < finishingHorizon×2` 下限 |
| RECOMMEND-8 | RECOMMEND | phantom-hold（stale 不开闸）应升格为不变量 | 采纳：R3 升级为不变量 I2 写进 §3 开头，P2 验收必须含此不变量测试 |

注：Codex 受其本地 quota-guard 92 硬线限制，以纯推理模式完成本轮审查；§2 现状盘点的 file:line 留待其解锁后补核。Q1-Q10 共识逐条见 §7「共识」行。

---

## 附：本设计引用的现状代码索引

| 主题 | 位置 |
|---|---|
| 默认配置 | `src/config-service.ts:20-41` |
| 配置校验/env | `src/config-service.ts:204-213, 255-338` |
| 入闸/出闸/状态机 | `src/budget/budget-fingerprint.ts:132-141, 257-322` |
| 纯决策函数 | `src/budget/budget-state.ts:207-270`（pauseTrigger 66-76、drift 78-93、parallel 95-117、tier 194-205） |
| decision-grade | `src/budget/budget-state.ts:56-64` + `src/budget/types.ts:17` |
| probe 归一化 | `src/budget/quota-source.ts:208-259`（窗口识别 171-199） |
| 恢复 epoch | `src/budget/budget-gate.ts:21-43` |
| 自适应轮询 | `src/budget/budget-coordinator.ts:35-41, 103-137` |
| 注入口闸门 | `src/daemon.ts:886-983`（budget 闸 953） |
| turnPhase | `src/codex-adapter.ts:2236` |
| 原子写/状态目录 | `src/atomic-json.ts:49` / `src/state-dir.ts` |

### 8.1 分层修正案记录（2026-06-11，用户提出、双方确认）

- **提案**：燃尽率采集/EWMA/持久化从 bridge 下沉到 agent-quota-guard（probe 输出追加 decision-grade 字段），bridge 改纯消费端。由用户提出，Claude 与 Codex 双方确认通过。
- **动机**：避免双估计器口径漂移；guard 是数据源属主（probe 缓存 + hist 历史），估计放在源头一次做对；bridge 删掉 ~460 行采样/EWMA/持久化代码与 burn-history.json 状态文件。
- **Codex 验收约束**（已在 §3.3 分层版原文收录）：① 缺字段/旧 schema/非数值/stale/reset-unknown 一律退 conserve，无 runway 即不展示；② bridge 禁止重算 burn-rate，只消费 guard 字段（允许的操作仅限校验、min 选择、格式化）。
- **接口**：probe_schema: 2（可选、不强依赖）；每 bucket 可选 burn_rate_pct_per_hour / burn_confident / runway_seconds / depleted_at_epoch；guard 侧由另一实施线同步落地，字段名与本稿严格一致。
- **展示决策**：Claude 侧 guard-硬线 clamp 放弃等比折算（≈变相重算 + 与 reset 截断冲突），改为如实展示中性 runway + 文案注明硬线先生效——最诚实不误导方案。
