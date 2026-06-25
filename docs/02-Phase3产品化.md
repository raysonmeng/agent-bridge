# 02. Phase 3 产品化：两进程架构 + CLI + 插件（2026-03-25 ~ 03-27）

## 一句话定位

这一阶段把 AgentBridge 从"两个终端里能互相喊话的协作原型"推成了"别人能装、能跑、能分发的产品"——核心动作是确立**前台 bridge + 后台 daemon 的两进程架构**，配齐 `agentbridge` CLI 命令集，并打包成可经 marketplace 安装的 Claude Code 插件。

## 起点：能协作了，但"装不了"

第一阶段（v1.0–v1.3）解决的是"能不能协作"：双向消息传输、turn 协调、智能消息过滤、角色感知。到 Phase 3 之前，桥已经能让 Claude 和 Codex 互相收发消息了——但它还只是一堆需要手工拉起的脚本。摆在面前的问题变了：

- 进程怎么活？bridge 是 Claude Code 的 MCP 通道，Claude 一退它就死；可 Codex 的代理、桥的状态总不能跟着一起没。
- 状态放哪？daemon.pid、运行状态、日志、"被显式 kill 过"的标记——这些散落的东西需要一个有纪律的归宿。
- 别人怎么用？没有 `init`、没有安装入口、没有插件清单，这东西只能在作者本机跑。

一句话：**协作能力已经"能跑"，但还没有"可安装、可分发"的产品形态。** Phase 3 就是补这一跃。

## 做了什么

按交付，Phase 3 分三条任务线推进（Task 5A / 5B / 5C，外加 6A/6B 的引导命令收尾）：

**1）核心运行时服务（Task 5A）** —— 抽出三块此前内联在 `bridge.ts` / `daemon.ts` 里的逻辑，成为独立、可测的服务：
- `StateDirResolver`（`state-dir.ts`）：平台感知的状态目录解析（macOS / Linux / 环境变量覆盖）。
- `ConfigService`（`config-service.ts`）：读写项目级 `.agentbridge/config.json` 与协作内容。
- `DaemonLifecycle`（`daemon-lifecycle.ts`）：共享的 daemon 生命周期——`ensureRunning`、pid/status 管理、`kill`。daemon 自此会写出 `status.json`（含 proxyUrl/ports），供 CLI 与插件做服务发现。
这一条带来 26 个新测试（88 全绿），把"散装函数"沉淀成有契约、有测试的服务层。

**2）CLI 命令面（Task 5B）** —— `agentbridge` / `abg` 命令路由落地：`init`（项目初始化）、`claude` / `codex`（拉起两侧会话）、`kill`（停掉全部）。这是用户真正会敲的入口。

**3）插件打包 + marketplace（Task 5C）** —— 把桥包装成标准 Claude Code 插件：
- `plugins/agentbridge/.claude-plugin/plugin.json`（插件清单）、`.mcp.json`（MCP server 配置，经 `AGENTBRIDGE_DAEMON_ENTRY` 解析 daemon 入口）。
- `commands/init.md`（`/agentbridge:init` 命令）、`hooks/hooks.json`（SessionStart 健康检查，仅提示不阻断）、`scripts/health-check.sh`（带冷却的 daemon 探活）。
- `server/`：自包含的打包产物（bundle 后的 bridge-server.js / daemon.js）。
- 顶层 `.claude-plugin/marketplace.json`：marketplace 清单——让插件可被"市场化"地发现与安装。

**4）引导命令收尾（Task 6A/6B）** —— 把 `CLAUDE_INSTRUCTIONS` 收敛为纯协议内容，bootstrap 命令改为委托 `ConfigService` 统一处理配置，避免初始化逻辑各处重复。

## 关键设计决策与为什么

**为什么拆两进程，而不是一个进程包打天下？** 这是 Phase 3 的架构主干，根因在两个进程**生命周期天然不一致**：

- `bridge.ts`（前台）是 Claude Code 注册的 MCP 通道——它的命就绑在 Claude Code 上，Claude 关了它就该退。
- `daemon.ts`（后台）持有 Codex app-server 的代理，又是桥状态的唯一真相源——它必须**比任何一次 Claude Code 会话都活得久**，这样 Claude 重启时 bridge 能用指数退避重连回同一个 daemon，而不是把 Codex 代理和在途状态一起丢掉。

把这两种寿命塞进一个进程，要么逼着 daemon 跟着 Claude 一起死（Codex 侧断流），要么逼着前台常驻（违背 MCP 通道语义）。拆开，各自的生命周期才各得其所。配套地，所有跨会话要持久的东西都收进**平台状态目录**（`AGENTBRIDGE_STATE_DIR`，macOS 默认 `~/Library/Application Support/AgentBridge/`，Linux 走 `$XDG_STATE_HOME`），并用 `startup.lock` + `killed` sentinel 协调启动竞争与"被显式 kill 就别自动重启"的语义。

**为什么一度 Revert 重审？** Phase 3 的 PR #7–#10 一度已经 squash 合入 master，但作者在 03-25 用一个干净的 revert（fe03b68）把它们整体退回——退掉的不只是 4 个 squash 合并（Task 5A/5B、5C、6A、6B），还连带回滚了当时 313 行的 `docs/phase3-spec.md`，总计撤掉一万七千多行。revert message 写得很直白：**"pending end-to-end testing and user approval before re-merging"**（端到端测试与用户确认通过前不再保留合并）。

这正是项目"质量纪律"的体现：代码合进 master ≠ 验收通过。当端到端验证和用户确认还没到位，宁可整段退回、补做 e2e、再以更完整的形态重新合入，也不让半成品赖在主干上。随后的轨迹印证了这条纪律——重做的 `feat: core runtime services + CLI surface + e2e tests`（bbff261，注意标题里多出的 **+ e2e tests**）补齐了端到端测试，`docs: update documentation after Phase 3 completion`（0119c68）同步文档，最后由 **PR #12**（782ee52，"plugin packaging, runtime reliability, and notification UX"）把插件打包、运行时可靠性、通知 UX 一并收口落地。期间还连补了多轮 review 修复（PID 安全、startup lock、`.mcp.json` 被 gitignore 误伤导致插件不可用、health-check 权限位、版本守卫等），是经过交叉 review 才重新落库的。

## 产出

- **一套 CLI**：`agentbridge init / claude / codex / kill`（外加后续扩展的 `dev` 等）——用户从此有了标准命令入口，而不是手工脚本。
- **可分发的插件**：标准 Claude Code 插件结构 + marketplace 清单，意味着 AgentBridge 第一次具备了"被安装、被分发"的产品能力。
- **有纪律的状态与配置边界**：平台状态目录（pid / status.json / killed / startup.lock）+ 项目级 `.agentbridge/config.json`，服务发现、生命周期协调、配置读写各归其位。
- **沉淀为服务层的核心运行时**：StateDirResolver / ConfigService / DaemonLifecycle，从内联函数升格为有契约、有测试覆盖的模块。

这套两进程骨架此后一直是 AgentBridge 的地基——今天 `CLAUDE.md` 的 Architecture 章节描述的仍是同一结构（Claude Code ──MCP stdio──▶ bridge.ts ──control WS──▶ daemon.ts ──ws proxy──▶ Codex app-server），后续的多对并发、预算协调、可靠性加固，全都是在 Phase 3 奠定的这条主干上长出来的。

## 关键 PR / commit

| 提交 | 内容 |
|------|------|
| `a24cbaa` feat: extract core runtime services (Task 5A) | StateDirResolver / ConfigService / DaemonLifecycle 三服务，+26 测试 |
| `579d9a6` feat: CLI surface with init/claude/codex/kill commands (Task 5B) | `agentbridge` CLI 命令面 |
| `cab46e2` / `8454ff4` feat: plugin packaging and marketplace manifest (Task 5C) | 插件结构 + marketplace 清单 |
| `81b6e82` feat: bootstrap command delegates to ConfigService (Task 6B) | bootstrap 委托 ConfigService 统一配置 |
| `fe03b68` Revert Phase 3 PRs (#7-#10) for re-review | **质量纪律**：端到端测试 + 用户确认前整体退回重审（含撤回 313 行 phase3-spec.md） |
| `bbff261` feat: core runtime services + CLI surface **+ e2e tests** (Tasks 5A & 5B) | 补齐 e2e 后重做 |
| `0119c68` docs: update documentation after Phase 3 completion | Phase 3 完成后文档同步 |
| `782ee52` **feat: plugin packaging, runtime reliability, and notification UX (#12)** | 收口：插件打包 + 运行时可靠性 + 通知 UX，最终落地 |
