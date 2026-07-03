<p align="center"><img src="site/assets/logo.svg" width="72" alt="AgentBridge logo" /></p>

# AgentBridge

English version: [README.md](README.md)

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**🌐 官网：[quilin-ai.github.io/agent-bridge/zh/](https://quilin-ai.github.io/agent-bridge/zh/)** —— 附真实会话的动画演示。

让 Claude Code 和 Codex 在同一个工作会话中进行双向通信的本地 Bridge。

具体能换来什么：

- **不只是互相说话，是互相 review** —— Codex 写实现，Claude 在**同一会话内**实时 review 这个 diff，并把修改意见直接推回 Codex 的 thread。两家模型互相盯着对方，不用复制粘贴。
- **一句 prompt 完成分工** —— 让任一侧提出与对方的分工方案，两个 agent 先商量好谁做什么再动手写代码。你把舵，它们协调。
- **通宵任务的额度接力** —— 一侧订阅额度窗口烧到线时，它在回合边界干净停下，把任务交接给另一侧，让长任务继续跑,而不是撞到上限就死掉。

<!-- TODO: assets/demo.gif — see docs/demo/RECORDING.md -->
▶ **[在官网看演示](https://quilin-ai.github.io/agent-bridge/zh/)** —— 真实会话的动画重放：Codex 回复推进 Claude 活跃会话、回合中途插入、额度接力。

> **这个工具很大程度上就是 Claude Code 和 Codex 通过它本身协作写出来的。**
> **一个 agent 写的每个 PR,都由另一个 agent review。** AgentBridge 就是它自己的 proof of concept。

## Why not just…（换个方案不行吗)

- **……开两个终端手动复制粘贴?** 可以——但你就成了消息总线,手动搬运文本、靠肉眼判断什么时候能插话。AgentBridge 把这套中转自动化了:消息自己流动,busy-guard 在活跃 turn 期间挡住回复,噪声中间事件被过滤,每一侧只看到对方有意义的输出。
- **……用一个单向委派插件?** 像 `openai/codex-plugin-cc` 这类工具,是宿主**调用** Codex、拿回一个答案——问进去、答出来,对面没有一个常驻的对等体。AgentBridge 让**两个** agent 都作为常驻对等体活着,任一侧都能在**回合中途**推消息(review 意见在对方还在干活时就落进它会话),而不只是在调用边界。
- **……接一个外部编排器?** 一个上帝进程调度哑终端是自上而下的:一个大脑、N 个互不说话的 worker。AgentBridge 是对等的——两个完整 agent 在会话内对话、自己提分工、互相 review,人在旁边把舵,而不是脚本化每一跳。

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

## 前置条件

| 依赖 | 版本 | 安装方式 |
|------|------|----------|
| [Bun](https://bun.sh) | v1.3.11+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | v2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |

> **Bun 是必要运行时**（AgentBridge daemon 和插件服务器都跑在 Bun 上），仅有 Node.js 不够——如果 `abg` 装上了却跑不起来，八成就是缺 Bun（见 [排错](docs/TROUBLESHOOTING.md)）。

## Quick Start

从零到一对跑起来，四步：

```bash
# 1. 装 Bun（运行时——只有 Node 不行）
curl -fsSL https://bun.sh/install | bash

# 2. 装 CLI。postinstall 会自动注册 Claude Code 插件市场并安装插件
#    （best-effort;需要本机已有 bun + claude）。
npm install -g @raysonmeng/agentbridge

# 3. 启动 Claude Code 并启用 AgentBridge channel
abg claude

# 4. 在另一个终端启动 Codex TUI 连接同一个 bridge
abg codex
```

就这样——daemon 会在需要时自动启动，重启后自动重连。（`abg` 是 `agentbridge` 的简写别名，两者完全等价。）如果 postinstall 的插件步骤被跳过（比如当时还没装 Claude Code），运行 `abg init` 重试，或见 [手动安装插件（兜底）](#手动安装插件兜底)。

> [!WARNING]
> **`abg claude` 默认带 `--dangerously-skip-permissions` 启动，`abg codex` 默认带 `--yolo` 启动。** 这是故意的——无人值守的 agent 对没法为每个权限停下来问你——但这意味着两个 agent 都能**不经询问**执行命令、改文件。只在你信任的工作区里这么用。要恢复正常询问，加 `--safe`（`abg claude --safe`、`abg codex --safe`）或设 `AGENTBRIDGE_SAFE=1`；你自己显式传权限参数时,默认值也会被自动抑制。

### 你的第一次协作

两侧都跑起来后，给 Claude 一个需要第二个 agent 的任务，例如：

> **对 Claude 说：** *「为 &lt;你的任务&gt; 和 Codex 提一个分工方案，然后让 Codex 实现它那部分、你来 review。」*

你应该会看到：Claude 把一个分工提案发进 Codex 会话、Codex 接受（或反提议）并开始干活、Codex 完成后推回 Claude 会话让它 review——全程不用你手动中转任何东西。

### 手动安装插件（兜底）

如果自动 postinstall 没能注册插件，在 Claude Code 里手动来：

```bash
# 1. 添加 AgentBridge 市场
/plugin marketplace add raysonmeng/agent-bridge

# 2. 安装插件
/plugin install agentbridge@agentbridge

# 3. 重新加载插件以激活
/reload-plugins
```

之后更新：`/plugin marketplace update agentbridge` 然后 `/reload-plugins`（或在 `/plugin` → **Marketplaces** → **agentbridge** 里启用自动更新）。

### 本地开发安装

如需修改 AgentBridge 源码，使用本地开发模式：

```bash
git clone https://github.com/raysonmeng/agent-bridge.git
cd agent-bridge
bun install
bun link

agentbridge dev     # 注册本地 marketplace + 安装插件
agentbridge init    # 检查依赖、生成 .agentbridge/config.json
agentbridge claude  # 启动 Claude Code（自动加载插件）
agentbridge codex   # （另一个终端）启动 Codex TUI 连接 Bridge
```

> **注意：** `agentbridge claude` 会注入 `--dangerously-load-development-channels plugin:agentbridge@agentbridge`（Research Preview 工作流）。请只启用你信任的 channel 和 MCP server。改完源码后，重新执行 `agentbridge dev` 并重启 Claude Code（或 `/reload-plugins`）。

## CLI 命令参考

> 所有命令同时支持 `agentbridge` 和简写别名 `abg`。

| 命令 | 说明 |
|------|------|
| `abg init` | 安装插件、检查依赖（bun/claude/codex）、生成 `.agentbridge/config.json` |
| `abg claude [args...]` | 启动 Claude Code 并启用 push channel。**默认带 `--dangerously-skip-permissions`**（关闭：`--safe` 或 `AGENTBRIDGE_SAFE=1`）。自动清除上次 `kill` 留下的 sentinel。额外参数透传给 `claude` |
| `abg codex [args...]` | 启动连接 AgentBridge daemon 的 Codex TUI。**裸 `abg codex` 自动续接该对上次的 thread；`abg codex --new` 开新 thread。TUI 默认带 `--yolo`**（关闭：`--safe` 或 `AGENTBRIDGE_SAFE=1`；`exec` 等非 TUI 子命令不受影响）。额外参数透传给 `codex` |
| `abg resume [claude\|codex]` | 不带目标：打印本目录上次 Claude 会话 + 本对当前 Codex thread 的续接命令。带目标：直接续接该侧 |
| `abg pairs` | 列出已注册的对；`abg pairs rm <name\|id>` 删除一个；`abg pairs prune` 预览可回收的孤儿目录 + 滞留 registry 条目，`--apply` 执行删除 |
| `abg doctor [--json]` | 只读诊断：环境、daemon 健康/就绪、构建漂移、产物对齐、TUI 连接、日志 |
| `abg budget [--json]` | 两侧订阅额度快照（5h/周窗口、漂移、暂停态） |
| `abg logs [--codex] [-f] [-n N]` | tail 本对的 daemon 日志（或加 `--codex` tail Codex wrapper 日志）；`-f` 跟随，`-n N` 指定行数（默认 100） |
| `abg kill` | 优雅停止本对 daemon 和托管的 Codex TUI，写入 killed sentinel；`abg kill --all` 停止所有对 |
| `abg dev` | （开发用）注册本地 marketplace + 强制同步插件到缓存 |
| `abg --help` / `abg --version` | 显示帮助 / 版本 |

### 跨网协作 *(v3 预览)*

v3 协作层(跨机器/跨 agent 的共享房间,含 `auth` / `broker` / `room` / `join` / `publish` 命令)目前在 [`integration/v3-all`](https://github.com/quilin-ai/agent-bridge/tree/integration/v3-all) 分支预览,将随 v3 落地本分支。规格见 [docs/09-v3协作系统规格.md](docs/09-v3协作系统规格.md)。

成对命令（`claude`、`codex`、`resume`、`kill`、`doctor`、`budget`、`logs`）接受 `--pair <name>` 指定具体的对——默认每个项目目录一对，端口按 +10 步长从 4500 分配。

### Owned flags

部分参数由 CLI 自动注入，不可手动指定：

- `agentbridge claude` 拥有：`--channels`、`--dangerously-load-development-channels`
- `agentbridge codex` 拥有：`--remote`、`--enable tui_app_server`
- 两个启动器都消费包装参数 `--safe`（永不透传）：它关闭该次启动的最大权限默认值。当你自己显式传任何权限参数时（codex 的 `-a`/`--ask-for-approval`/`-s`/`--sandbox`；claude 的 `--permission-mode`/`--allow-dangerously-skip-permissions`），默认值也会自动抑制——在显式审批策略旁再注入 `--yolo` 会触发 codex CLI 硬冲突。

手动传入被拥有的参数会报错，并提示使用原生命令。

> **关于 `agentbridge codex` 参数位置：** 无子命令的 TUI 形式，bridge 参数注入到最前面；带自身参数的 TUI 子命令（`resume`、`fork`）注入到子命令名之后；`exec`、`mcp`、`plugin` 等非 TUI 子命令原样透传。完整逻辑见 `src/cli/codex.ts` 的 `buildCodexArgs`。

## 架构

AgentBridge 是一个**两进程**本地 Bridge：

- **bridge.ts** —— 由 Claude Code 通过 AgentBridge 插件启动的前台 MCP 客户端，Claude Code 关闭时退出。
- **daemon.ts** —— 常驻本地后台进程，持有 Codex app-server 代理和桥接状态这一唯一真源。跨 Claude Code 重启存活；`bridge.ts` 以指数退避重连。

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

## 项目配置

运行 `agentbridge init` 会在项目根目录创建 `.agentbridge/` 目录：

| 文件 | 用途 |
|------|------|
| `config.json` | 机器可读的项目配置（Codex 端口、回合协调、空闲关闭） |

CLI 和 daemon 启动时会加载该配置。重复运行 `init` 是幂等的，不会覆盖已有文件。

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

`abg claude` 和 `abg codex` 在 npm 上有更新的**稳定**版本时，会向 stderr 打印一行提示。该检查是 best-effort：从缓存打印，npm 检查每天最多在后台跑一次，任何网络/registry 失败都静默忽略。交互式 TTY 下，命中缓存更新会在启动前询问；输入 `y` 执行升级，`N`（或 15 秒内无应答）记住本版本已拒绝并继续。可用 `NO_UPDATE_NOTIFIER=1` 关闭，或用 `AGENTBRIDGE_UPDATE_PROMPT=0` 保持纯打印。

### 状态目录

daemon 在平台感知的目录中存储运行时状态：

| 平台 | 默认路径 |
|------|---------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/`（回退：`~/.local/state/agentbridge/`） |

内容：`daemon.pid`、`status.json`、`agentbridge.log`、`killed`（sentinel）、`startup.lock`

## 额度协调与自动续接

AgentBridge 能让长任务跨订阅额度窗口持续推进，而不是某一侧撞到上限就中断。这套能力由配套工具 **[agent-quota-guard](https://www.npmjs.com/package/agent-quota-guard)**（[repo](https://github.com/raysonmeng/agent-quota-guard) · v0.2.0，2026-06-13）驱动——装上 guard 才启用。

- **快照** —— daemon 经 guard 的探针轮询两侧账号级 5h/周额度；`abg budget [--json]` 打印实时快照（两个窗口、漂移、暂停态）。只要装了 guard 的探针就能用。
- **减速线（中途不腰斩）** —— 接近额度硬线时，guard **不**在工具调用中途 deny，而是让当前 turn 跑完、在回合边界干净停下、写 `.agent/checkpoint.md`，并落一条 bridge 能检测的 `pending` 记录。
- **全自动续接** —— 被暂停一侧窗口刷新后，bridge 在**原本的交互式 TUI** 里续接：Codex 经排队的 `turn/start` 注入，Claude 经 channel push 并由 `ack_resume` 回执。每条 pending 的幂等墓碑保证同一续接最多注入一次，跨 daemon 重启亦然。

> **实验性 / opt-in。** 这是依赖配套 guard 的能力。Claude 侧续接是 best-effort（ack + 重试 + `SessionStart` 兜底）：对完全空闲会话的 channel push 存在已知上游不确定性，故 bridge 只有看到真正的 `ack_resume` 才标记该侧已续接。

## 当前限制

- 目前只转发 `agentMessage`，不转发 `commandExecution`、`fileChange` 等中间过程事件
- 每对只有单个 Codex thread，对内暂不支持多会话
- 每对只有单个 Claude 前台连接；新的 Claude 会话会替换旧连接
- 多对可在同机并行（每个项目目录一对）；Windows 暂非官方支持平台

休眠/禁用状态、Codex `.git` 限制及其它坑，见 **[排错文档](docs/TROUBLESHOOTING.md)**。

## Roadmap

- **更多 adapter** —— 今天 AgentBridge 接的是 Claude Code ↔ Codex。下一个候选：**OpenCode、OpenClaw、Hermes Agent、Gemini CLI**。到 [adapter roadmap issue](https://github.com/quilin-ai/agent-bridge/issues/212) 投票。
- **能力网格（Capability mesh）** —— 超越消息传递：连上的 agent 会发布自己的命令 / skills / MCP tools，让对等体直接调用——从「传消息」走向「调能力」。
- **v2 —— 多 Agent 基础设施**（部分已落地）：Room 作用域协作、稳定身份、正式控制协议、更强恢复。见 [docs/08-v2架构愿景.md](docs/08-v2架构愿景.md)。
- **v3 —— 跨网协作**（preview，见上面的实验性 CLI）：跨机器、跨 agent 的共享房间，经 broker。见 [docs/09-v3协作系统规格.md](docs/09-v3协作系统规格.md)。

## 文档

- **[排错 / Troubleshooting](docs/TROUBLESHOOTING.md)** —— 禁用状态恢复、Codex `.git` 挂死、「装了却跑不起来」、Bun 版本要求
- **[使用手册](https://github.com/quilin-ai/agent-bridge/blob/integration/v3-all/docs/manual/使用手册.md)**（[English](https://github.com/quilin-ai/agent-bridge/blob/integration/v3-all/docs/manual/manual-en.md)）—— 端到端使用走查
- **[项目成长编年史](docs/README.md)** —— AgentBridge 是怎么一步步长起来的（阶段 01–11）

## 这个项目是怎么建成的

这个项目由 **Claude Code**（Anthropic）和 **Codex**（OpenAI）通过 AgentBridge 本身进行实时双向通信，在人类开发者的指挥下协作完成。开发者负责分配任务、审查进度，并指挥两个 Agent 并行工作、互相 review。换句话说，AgentBridge 就是它自己的 proof of concept：两个来自不同厂商的 AI Agent，通过实时连接，肩并肩地交付代码。

## 联系方式

这是我首次开源的项目！欢迎对多 Agent 协作、AI 工具链感兴趣的朋友来交流，一起做一些更好玩的事情。

- **Twitter/X**: [@raysonmeng](https://x.com/raysonmeng)
- **小红书**: [主页](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
- **微信**: 扫描下方二维码添加好友

<img src="assets/wechat-qr.jpg" alt="微信二维码" width="300" />
