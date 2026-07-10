# E2E 测试计划：可插拔协作注入 / Pluggable collaboration injection

- **分支 / Branch**: `feat/pluggable-injection`
- **日期 / Date**: 2026-07-10
- **前置 / Precondition**: `bun run typecheck && bun test src` 全绿；改过 `src/` 后已执行 `bun run build:plugin`（安装的插件加载的是 bundle，不是 TS 源码）。

## 变更摘要 / What changed

静态注入退役为可选项：`abg init` 不再默认写 `CLAUDE.md` / `AGENTS.md`。协作指引改为运行时下发：

- **Claude 侧**：SessionStart hook（`health-check.sh` → `bridge-server.js --print-session-context`）在 daemon 健康 + Codex TUI 已连接时输出完整协作上下文（绕过冷却戳，每个新会话必达）；桥不在时只有原有短提示。
- **Codex 侧**：daemon 的 codex proxy 在 `thread/start` 合并注入 `developerInstructions`，对既有线程在 `thread/resume` 后、放行首个 turn 前用 `thread/inject_items` 注入 developer contract item；按 `(threadId, contractHash())` 幂等，hash 变化走 `codexContractSupersedePayload`（重发完整合同）。
- **CLI**：`abg init --inject-docs`（旧行为，选择性开启）、`abg deinit`（摘除存量注入段落）。
- **配置**：`.agentbridge/config.json` 的 `injection.runtime: false` 关闭双侧运行时注入——Codex 侧 proxy 完全旁路，Claude 侧 SessionStart hook 对该工作区**完全静默**（唯一例外：resume-ack 恢复哨兵，一次性消费）。接受的拼写与 `normalizeBoolean` 一致（`false`/`"false"`/`"0"` 关，`true`/`"true"`/`"1"` 开，其余走默认开）。
- **裁定备注**：桥未启动时的"如何启动"短提示是运营提示、先于本 PR 存在，默认配置下保留（A3/A4）；用户显式 `runtime=false` 表达的是"这个项目别打扰我"，因此该配置下短提示也一并静默（A5）。

## A. Claude 侧 hook（人工 / manual）

| # | 步骤 | 预期 |
|---|------|------|
| A1 | 桥全启（`abg claude` + `abg codex`），另开一个新 Claude Code 会话 | SessionStart 附加上下文包含 "AgentBridge is running" 状态行 + `[AgentBridge runtime context]` 完整协作块 |
| A2 | A1 后 2 分钟内（冷却窗口内）再开一个新会话 | 仍然收到完整协作块（上下文路径绕过冷却） |
| A3 | `abg kill` 后开新会话 | 只有 "daemon is not reachable" 短提示，无协作块 |
| A4 | daemon 在跑但 Codex TUI 未连接时开新会话 | 只有 "Codex TUI is not connected" 短提示，无协作块 |
| A5 | 项目 config 写入 `{"injection": {"runtime": false}}`，桥全启，开新会话 | hook **零输出**（无协作块、无短提示；`"false"`/`"0"` 拼写等效） |
| A5b | 同 A5 配置但桥未启动，开新会话 | 同样零输出（短提示也被显式退出静默） |
| A6 | 直接执行 `bun plugins/agentbridge/server/bridge-server.js --print-session-context --workspace <项目路径> --notice ""` | stdout 输出单行合法 hook JSON；不启动任何桥进程、不创建 state 目录 |

## B. init / deinit（人工 / manual）

| # | 步骤 | 预期 |
|---|------|------|
| B1 | 空目录 `abg init` | 生成 `.agentbridge/config.json`；**不创建/不修改** `CLAUDE.md` / `AGENTS.md`；输出说明运行时下发 + 两个相关命令 |
| B2 | `abg init --inject-docs` | 与旧版一致：两文件写入 `<!-- AgentBridge:start/end -->` 段落，幂等可重跑 |
| B3 | B2 之后 `abg deinit` | 两文件恢复原状（仅注入块的文件变空并提示可删除）；重复执行提示 "no AgentBridge section found" |
| B4 | 对本仓库执行 `abg deinit`（真实存量项目） | 仅摘除 marker 块，块外内容零丢失（`git diff` 验证） |
| B5 | 手工破坏 marker（删掉 end 标记）后 `abg deinit` | 报 "skipped — Malformed"，文件未被改动 |

## C. Codex 侧 developer contract（Codex 负责验证 / verified by Codex）

| # | 场景 | 预期 |
|---|------|------|
| C1 | 桥接下新建线程 | 真实 `thread/start` 请求携带合并后的 `developerInstructions`（不覆盖客户端已有值）；pair state 记录 `(threadId, contractHash())` |
| C2 | 首次桥接一个既有线程（resume） | resume 成功响应被扣住，`thread/inject_items`（role=developer）成功且 pair state 原子落盘后才放行；注入失败/超时以明确错误结束原请求，resume 不悬挂 |
| C3 | 同一线程再次 resume（hash 未变） | 不重复注入 |
| C4 | 修改合同内容后（hash 变化）resume 老线程 | 注入 `codexContractSupersedePayload(旧hash)`（取代头 + 完整新合同），落账新 hash |
| C5 | `injection.runtime=false` | 双向完全旁路，行为与改动前一致 |
| C6 | 老版本 Codex（协议无该字段） | 显式兼容性错误，不静默回退写 AGENTS.md |
| C7 | 残留边界确认：桥接过的线程脱离桥后 `codex resume` | 旧合同仍在 rollout（已知硬边界）；观察模型遵循开头失效条款（无桥消息即独立工作，不等待 Claude） |

## D. 回归 / Regression

| # | 步骤 | 预期 |
|---|------|------|
| D1 | `bun run check` | typecheck + 全量测试 + plugin sync + plugin versions 全绿 |
| D2 | 正常双端会话互发消息（[IMPORTANT]/[STATUS]） | 路由行为与改动前一致（marker 规则现在随 contract 下发） |
| D3 | `abg doctor` | 无新增 FAIL |
