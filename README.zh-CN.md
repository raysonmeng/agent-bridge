# AgentBridge

English version: [README.md](README.md)

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

让 Claude Code 和 Codex 在同一个工作会话中进行双向通信的本地 Bridge。

AgentBridge 采用两层进程结构：

- **bridge.ts** 是由 Claude Code 通过 AgentBridge 插件启动的前台 MCP 客户端
- **daemon.ts** 是常驻本地的后台进程，持有 Codex app-server 代理和桥接状态

当 Claude Code 关闭时，前台 MCP 进程退出，后台 daemon 与 Codex 代理继续存活。当 Claude Code 再次启动时，会自动重连（指数退避）。

## 这个项目是什么 / 不是什么

**这个项目是：**

- 一个把 Claude Code 和 Codex 连接到同一工作流里的本地开发工具
- 一个在 MCP channel 与 Codex app-server 协议之间转发消息的桥接层
- 一个面向人工参与、多代理协作场景的实验性方案

**这个项目不是：**

- 一个托管服务或多租户系统
- 一个面向任意 Agent 后端的通用编排框架
- 一个可以隔离不可信工具的强化安全边界

## 功能

- **Claude ↔ Codex 双向消息**（同一工作会话）：拦截 Codex 输出并以 channel 通知推给 Claude；Claude 用 `reply` MCP tool 回复，作为 `turn/start` 注入 Codex thread。
- **Push 投递 + 兜底**：消息以 channel 通知投递；推送失败回退到内存队列，由 `get_messages` 排空。靠每条消息的 `source` 字段防循环。
- **回合协调**：busy-guard 在 Codex 活跃 turn 期间拒绝回复；单 turn 非活动看门狗避免丢失 `turn/completed` 永久锁死注入；折叠噪声中间事件，只把有意义的 `agentMessage` 送达 Claude。
- **多对并行**：每个项目目录一对 Claude+Codex，端口按 +10 步长从 4500 分配；`claude` / `codex` / `resume` / `kill` / `doctor` / `budget` 支持 `--pair` 指定。
- **韧性生命周期**：常驻后台 daemon 跨 Claude Code 重启存活（指数退避自动重连）；孤儿进程清理；`abg doctor` 只读诊断；`abg pairs prune` 回收滞留状态。
- **Thread 自动续接**：裸 `abg codex` 续接该对上次的 Codex thread；`abg resume` 打印/执行两侧的续接命令。
- **额度协调、减速线与全自动续接**：让长任务跨订阅额度窗口持续推进，而不是撞到上限就中断。见 [额度协调与自动续接](#额度协调与自动续接)。

## 架构

```
┌──────────────┐    MCP stdio / plugin     ┌────────────────────┐
│ Claude Code  │ ─────────────────────────▶ │ bridge.ts          │
│ Session      │ ◀─────────────────────────  │ 前台 MCP 客户端     │
└──────────────┘                            └─────────┬──────────┘
                                                      │
                                                      │ 控制 WS (:4502)
                                                      ▼
                                            ┌────────────────────┐
                                            │ daemon.ts          │
                                            │ 常驻后台桥接进程    │
                                            └─────────┬──────────┘
                                                      │
                                    ws://127.0.0.1:4501 proxy
                                                      │
                                                      ▼
                                            ┌────────────────────┐
                                            │ Codex app-server   │
                                            └────────────────────┘
```

### 数据流

| 方向 | 链路 |
|------|------|
| **Codex -> Claude** | `daemon.ts` 捕获 `agentMessage` -> 控制 WS -> `bridge.ts` -> `notifications/claude/channel` |
| **Claude -> Codex** | Claude 调用 `reply` tool -> `bridge.ts` -> 控制 WS -> `daemon.ts` -> `turn/start` 注入 Codex thread |

### 防循环

每条消息都携带 `source` 字段（`"claude"` 或 `"codex"`），Bridge 永远不会把消息转发回它的来源。

## 前置条件

| 依赖 | 版本 | 安装方式 |
|------|------|----------|
| [Bun](https://bun.sh) | v1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | v2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |

> **注意：** Bun 是 AgentBridge daemon 和插件服务器的必要运行时，仅有 Node.js 不够。

## Quick Start

### 通过插件市场安装（推荐）

在 Claude Code 中直接安装 AgentBridge 插件：

```bash
# 1. 在 Claude Code 中，添加 AgentBridge 市场
/plugin marketplace add raysonmeng/agent-bridge

# 2. 安装插件
/plugin install agentbridge@agentbridge

# 3. 重新加载插件以激活
/reload-plugins
```

然后安装 CLI 工具：

```bash
# 4. 全局安装 CLI
npm install -g @raysonmeng/agentbridge

# 5. 生成项目配置（可选）
abg init

# 6. 启动 Claude Code（自动加载 AgentBridge channel）
abg claude

# 7. 在另一个终端启动 Codex TUI 连接 Bridge
abg codex
```

> **提示：** `abg` 是 `agentbridge` 的简写别名，两个命令完全等价，用哪个都行。

就这样。Daemon 会在需要时自动启动，重启后自动重连。

#### 更新插件

新版本发布后，在 Claude Code 中更新：

```bash
/plugin marketplace update agentbridge
/reload-plugins
```

或启用自动更新：执行 `/plugin` → **Marketplaces** 标签页 → 选择 **agentbridge** → **Enable auto-update**。

### 本地开发安装

如需修改 AgentBridge 源码，使用本地开发模式：

```bash
# 1. 克隆并安装依赖
git clone https://github.com/raysonmeng/agent-bridge.git
cd agent-bridge
bun install
bun link

# 2. 安装本地插件 + 生成项目配置
agentbridge dev     # 注册本地 marketplace + 安装插件
agentbridge init    # 检查依赖、生成 .agentbridge/config.json

# 3. 启动 Claude Code（自动加载 AgentBridge 插件）
agentbridge claude

# 4. 在另一个终端启动 Codex TUI 连接 Bridge
agentbridge codex
```

> **注意：** `agentbridge claude` 会自动注入 `--dangerously-load-development-channels plugin:agentbridge@agentbridge`。这会把本地开发中的 channel 挂载进 Claude Code（当前属于 Research Preview）。请只启用你信任的 channel 和 MCP server。

#### 修改代码后更新

修改 AgentBridge 源码后，重新执行 `agentbridge dev` 同步插件到缓存，然后重启 Claude Code 或在活跃会话中执行 `/reload-plugins`。

## CLI 命令参考

> 所有命令同时支持 `agentbridge` 和简写别名 `abg`。

| 命令 | 说明 |
|------|------|
| `abg init` | 安装插件、检查依赖（bun/claude/codex）、生成 `.agentbridge/config.json` |
| `abg claude [args...]` | 启动 Claude Code 并启用 push channel。**默认带 `--dangerously-skip-permissions`**（关闭：`--safe` 或 `AGENTBRIDGE_SAFE=1`）。自动清除上次 `kill` 留下的 sentinel。额外参数透传给 `claude` |
| `abg codex [args...]` | 启动连接 AgentBridge daemon 的 Codex TUI。**裸 `abg codex` 自动续接该对上次的 thread；`abg codex --new` 开新 thread。TUI 默认带 `--yolo`**（关闭：`--safe` 或 `AGENTBRIDGE_SAFE=1`；`exec` 等非 TUI 子命令不受影响）。管理 TUI 进程生命周期（pid 跟踪、清理）。额外参数透传给 `codex` |
| `abg resume [claude\|codex]` | 不带目标：打印本目录上次 Claude 会话 + 本对当前 Codex thread 的续接命令。带目标：直接续接该侧 |
| `abg pairs` | 列出已注册的对；`abg pairs rm <name\|id>` 删除一个；`abg pairs prune` 预览可回收的孤儿目录 + 滞留 registry 条目（cwd 不存在/已死/>1 天），`abg pairs prune --apply` 执行删除 |
| `abg doctor [--json]` | 只读诊断：环境、daemon 健康/就绪、构建漂移、产物对齐、TUI 连接、日志 |
| `abg budget [--json]` | 两侧订阅额度快照（5h/周窗口、漂移、暂停态） |
| `abg logs [--codex] [-f] [-n N]` | tail 本对的 daemon 日志（或加 `--codex` tail Codex wrapper 日志）；`-f` 跟随，`-n N` 指定行数（默认 100） |
| `abg kill` | 优雅停止本对 daemon 和托管的 Codex TUI，写入 killed sentinel；`abg kill --all` 停止所有对 |
| `abg dev` | （开发用）注册本地 marketplace + 强制同步插件到缓存 |
| `abg --help` | 显示帮助 |
| `abg --version` | 显示版本 |

成对命令（`claude`、`codex`、`resume`、`kill`、`doctor`、`budget`、`logs`）接受 `--pair <name>` 指定具体的对——默认每个项目目录一对，端口按 +10 步长从 4500 分配。

### Owned flags

部分参数由 CLI 自动注入，不可手动指定：

- `agentbridge claude` 拥有：`--channels`、`--dangerously-load-development-channels`
- `agentbridge codex` 拥有：`--remote`、`--enable tui_app_server`
- 两个启动器都消费包装参数 `--safe`（永不透传）：它关闭该次启动的最大权限默认值。当你自己显式传任何权限参数时（codex 的 `-a`/`--ask-for-approval`/`-s`/`--sandbox`；claude 的 `--permission-mode`/`--allow-dangerously-skip-permissions`），默认值也会自动抑制——在显式审批策略旁再注入 `--yolo` 会触发 codex CLI 硬冲突。

手动传入被拥有的参数会报错，并提示使用原生命令。

> **关于 `agentbridge codex` 参数位置的说明：** 对于无子命令的 TUI 形式
> （`agentbridge codex …`），bridge 注入的参数放在最前面。对于带有自己参数的
> TUI 子命令（`resume`、`fork`），bridge 参数注入到**子命令名之后**（这样
> clap 才会把它们解析为该子命令的选项，而不是根命令的）。`exec`、`mcp`、
> `plugin`、`remote-control`、`update` 等非 TUI 子命令则原样透传，不注入
> bridge 参数。完整定位逻辑见 `src/cli/codex.ts` 的 `buildCodexArgs`。

## 项目配置

运行 `agentbridge init` 会在项目根目录创建 `.agentbridge/` 目录：

| 文件 | 用途 |
|------|------|
| `config.json` | 机器可读的项目配置（Codex 端口、回合协调、空闲关闭） |

CLI 和 daemon 启动时会加载该配置。重复运行 `init` 是幂等的，不会覆盖已有文件。

## 文件结构

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/           # Bug report 和 feature request 模板
│   ├── pull_request_template.md
│   └── workflows/ci.yml          # GitHub Actions CI
├── assets/                        # 图片资源
├── docs/                          # 项目成长编年史（阶段 01-09，索引见 docs/README.md）
│   ├── 01-起步与v1协作核心.md       # 阶段 1：双向桥 + v1 协作核心
│   ├── 02-Phase3产品化.md          # 阶段 2：两进程架构 + CLI + 插件
│   ├── …(03-08)                    # 发布 / 可靠性 / 多对 / 协作协议 v2 / 额度 / v2 架构愿景
│   └── 09-v3协作系统规格.md         # 阶段 9：最新 v3 跨网协作系统规格
├── plugins/agentbridge/           # Claude Code 插件包
│   ├── .claude-plugin/plugin.json
│   ├── commands/init.md
│   ├── hooks/hooks.json
│   ├── scripts/health-check.sh
│   └── server/                    # 打包的 bridge-server.js + daemon.js
├── src/
│   ├── bridge.ts                  # Claude 前台 MCP 客户端（插件入口）
│   ├── daemon.ts                  # 常驻后台 daemon
│   ├── daemon-client.ts           # daemon 控制端口的 WebSocket 客户端
│   ├── daemon-lifecycle.ts        # 共享 daemon 生命周期（ensureRunning、kill、启动锁）
│   ├── control-protocol.ts        # 前后台控制协议类型
│   ├── claude-adapter.ts          # Claude Code channel 的 MCP server 适配层
│   ├── codex-adapter.ts           # Codex app-server WebSocket 代理与消息拦截
│   ├── config-service.ts          # 项目配置（.agentbridge/）读写
│   ├── state-dir.ts               # 平台感知的状态目录解析
│   ├── message-filter.ts          # 智能消息过滤（标记、摘要缓冲）
│   ├── types.ts                   # 共享类型
│   ├── cli.ts                     # CLI 入口和命令路由
│   └── cli/
│       ├── init.ts                # agentbridge init
│       ├── claude.ts              # agentbridge claude
│       ├── codex.ts               # agentbridge codex
│       ├── kill.ts                # agentbridge kill
│       └── dev.ts                 # agentbridge dev
├── CLAUDE.md                      # AI Agent 项目规则
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── README.zh-CN.md
├── SECURITY.md
├── package.json
└── tsconfig.json
```

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket 端口 |
| `CODEX_PROXY_PORT` | `4501` | Bridge 代理端口，Codex TUI 连接此端口 |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | bridge.ts 与 daemon.ts 之间的控制端口 |
| `AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS` | `3000` | 等待在位 Claude pong 的最长时间，超时后在争用时驱逐（issue #68） |
| `AGENTBRIDGE_TURN_WATCHDOG_MS` | `300000` | 单 turn 非活动看门狗：app-server 静默超过该毫秒数后强制完成该 turn，避免丢失 `turn/completed` 永久锁死注入（issue #69） |
| `AGENTBRIDGE_CODEX_TRANSPORT` | `auto` | daemon 连接 Codex app-server 的方式：`auto`（探测 `codex app-server --help`，支持 `ws://` 则用 ws，否则经透明中继回退到 `unix://` socket）、`ws`（强制 ws）、`unix`（强制 unix socket + 中继）。用于去掉 `ws://` listen 支持的 Codex 版本（issue #85） |
| `AGENTBRIDGE_STATE_DIR` | 平台默认 | 状态目录（pid、status、日志）。macOS: `~/Library/Application Support/agentbridge/`，Linux: `$XDG_STATE_HOME/agentbridge/` |
| `AGENTBRIDGE_DAEMON_ENTRY` | `./daemon.ts` | 覆盖 daemon 入口（插件包使用） |
| `NO_UPDATE_NOTIFIER` | 未设置 | 设为任意值即关闭「有新版本」提示（生态通用 opt-out） |
| `AGENTBRIDGE_NO_UPDATE_NOTIFIER` | 未设置 | 命名空间化的关闭开关（效果同 `NO_UPDATE_NOTIFIER`） |
| `AGENTBRIDGE_UPDATE_PROMPT` | 未设置 | 设为 `0` 可关闭交互询问，恢复纯打印提示 |
| `AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS` | `86400000` | `abg claude`/`abg codex` 多久查一次 npm 新版本（默认每天一次）。其余时候只读缓存打印，大多数调用零网络 |

### 更新提示

`abg claude` 和 `abg codex` 在 npm 上有更新的**稳定**版本时,会向 stderr 打印一行提示,例如:

```
⚠ AgentBridge update available: 0.1.6 → 0.1.7
  CLI:    npm install -g @raysonmeng/agentbridge@latest
  Plugin: /plugin marketplace update agentbridge   (then /reload-plugins)
```

该检查是 best-effort：提示从缓存打印，npm 检查每天最多在后台跑一次，任何网络/registry 失败都静默忽略。交互式 TTY 下，命中缓存更新会在启动前询问；输入 `y` 会运行 `npm install -g @raysonmeng/agentbridge@latest`，输入 `N`（或 15 秒内无应答）会记住本版本已拒绝并继续启动。非交互(管道)输出和 CI 下绝不询问，可用 `NO_UPDATE_NOTIFIER=1` 关闭提示，或用 `AGENTBRIDGE_UPDATE_PROMPT=0` 保持纯打印。

### 状态目录

daemon 在平台感知的目录中存储运行时状态：

| 平台 | 默认路径 |
|------|---------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/`（回退：`~/.local/state/agentbridge/`） |

内容：`daemon.pid`、`status.json`、`agentbridge.log`、`killed`（sentinel）、`startup.lock`

### Bridge 禁用状态

Bridge 在无法接受新 MCP 回复时会进入若干休眠状态。每种状态都会以错误信息返回给 agent；瞬态状态还会推送一条带内通知：

| 状态 | 原因 | 恢复方式 |
|------|------|---------|
| `killed` | 运行过 `agentbridge kill`，存在 sentinel 文件。 | 重启 Claude Code（`agentbridge claude`），切换到新会话，或运行 `/resume`。 |
| `rejected` | daemon 拒绝连接：已有另一个 Claude 会话连接中。 | 先关闭另一个会话，或运行 `agentbridge kill` 重置，然后重新 `agentbridge claude`。 |
| `evicted` | 在位会话未响应存活探测，被更新的会话驱逐（issue #68）。 | 关闭本会话，用 `agentbridge claude` 重新启动一个。 |
| `probe_in_progress` | 当前正在对在位会话执行存活探测——争用窗口期。瞬态（在 `DISABLED_RECOVERY_INTERVAL_MS` × 重试上限内自动恢复，约 30 秒）。 | 无需操作；恢复轮询会在槽位释放后自动重连。 |
| `auto_recovery_exhausted` | `probe_in_progress` 的自动恢复轮询用尽了完整的重试预算（6 次，约 30 秒）仍未成功。终态。 | 手动用 `agentbridge claude` 重试。 |

## 额度协调与自动续接

AgentBridge 能让长任务跨订阅额度窗口持续推进，而不是某一侧撞到上限就中断。这套能力由配套的 **agent-quota-guard** 工具驱动：bridge 读它的额度探针和 `pending` 记录——装上 guard 才会启用。

daemon 里的额度协调器轮询**两侧**账号级 5h/周额度（经 guard 的探针）并协调两边；`abg budget [--json]` 打印实时快照（两个窗口、漂移、暂停态）。装上 guard 后再激活两项能力：

- **减速线——中途不腰斩。** 接近额度硬线时，guard **不**在工具调用中途 deny，而是给一条提醒、让当前 turn 跑完，在**回合边界干净停下**，写 `.agent/checkpoint.md`，并落一条 bridge 能检测的 `pending` 记录。
- **窗口刷新后全自动续接。** 当被暂停一侧的额度窗口刷新，bridge 在**原本的交互式 TUI** 里续接任务——不开后台无头进程、不需手动：
  - **Codex**：排队的 `turn/start` 注入（`ResumeInjectionQueue`）开一个新 turn，从 checkpoint 接着干。全自动。
  - **Claude**：channel push 一条带稳定 `resume_id` 的指令；Claude 经 `ack_resume` MCP tool 回执。未回执则用新 delivery id 重推（`resume_id` 不变）；重试耗尽后落 `SessionStart` 降级 sentinel，下个会话读到恢复提示。
  - **幂等**：每条 pending 一个 claim/consumed 墓碑（agent+session+cwd+内容哈希 的 sha256），保证同一续接最多注入一次，跨 daemon 重启亦然；陈旧墓碑按 TTL 清理。

任务运行中 bridge 可能发的协调指令：**balance**（把更多活分给 runway 更长 / 剩余可工作时间更多的一侧）、**underutilized**（账号周额度在刷新前烧不满时——多拆并行子任务 / 提高委派密度）、**pause / handoff / resume**。

> 减速线 + 自动续接是可选的、依赖配套 guard 的能力。Claude 侧续接是 best-effort（ack + 重试 + SessionStart 兜底）：对完全空闲会话的 channel push 存在已知的上游不确定性，故 bridge 只有看到真正的 `ack_resume` 才标记该侧已续接。

## 当前限制

- 目前只转发 `agentMessage`，不转发 `commandExecution`、`fileChange` 等中间过程事件
- 每对只有单个 Codex thread，对内暂不支持多会话
- 每对只有单个 Claude 前台连接；新的 Claude 会话会替换旧连接
- 多对可在同机并行（每个项目目录一对、按对分配端口）；Windows 暂非官方支持平台

### Codex 的 Git 操作限制

Codex 运行在沙箱环境中，**禁止对 `.git` 目录进行任何写操作**。这意味着 Codex 无法执行 `git commit`、`git push`、`git pull`、`git checkout -b`、`git merge` 等任何修改 Git 元数据的命令。尝试执行这些命令会导致 Codex 会话无限期挂起。

**建议做法：** 让 Claude Code 负责所有 Git 操作（创建分支、提交、推送、创建 PR）。Codex 专注于代码修改，通过 `agentMessage` 汇报完成的工作，由 Claude Code 负责 Git 工作流。

## Roadmap

- **v1.x（当前）**：在不改变架构的前提下优化单桥体验 -- 降噪、控回合、定角色。详见 [docs/01-起步与v1协作核心.md](docs/01-起步与v1协作核心.md)。
- **v2（规划中）**：引入多 Agent 基础设施 -- Room 作用域协作、稳定身份、正式控制协议、更强的恢复语义。详见 [docs/08-v2架构愿景.md](docs/08-v2架构愿景.md)。
- **v3+（远期）**：更智能的协作、更丰富的策略、跨 runtime 的高级编排。

## 这个项目是怎么建成的

这个项目由 **Claude Code**（Anthropic）和 **Codex**（OpenAI）通过 AgentBridge 本身进行实时双向通信，在人类开发者的指挥下协作完成。开发者负责分配任务、审查进度，并指挥两个 Agent 并行工作、互相 review。

换句话说，AgentBridge 就是它自己的 proof of concept：两个来自不同厂商的 AI Agent，通过实时连接，肩并肩地交付代码。

## 联系方式

这是我首次开源的项目！欢迎对多 Agent 协作、AI 工具链感兴趣的朋友来交流，一起做一些更好玩的事情。

- **Twitter/X**: [@raysonmeng](https://x.com/raysonmeng)
- **小红书**: [主页](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
- **微信**: 扫描下方二维码添加好友

<img src="assets/wechat-qr.jpg" alt="微信二维码" width="300" />
