# AgentBridge

English version: [README.md](README.md)

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

让 Claude Code 和 Codex 在同一个工作会话中进行双向通信的本地 Bridge。

当前实现采用两层进程结构：

- `bridge.ts` 是由 Claude Code 启动的前台 MCP 客户端
- `daemon.ts` 是常驻本地的后台进程，持有 Codex app-server 代理和桥接状态

这意味着当 Claude Code 关闭时，前台 MCP 进程可以退出，而后台 daemon 与 Codex 代理继续存活；当 Claude Code 再次启动时，可以自动复用已有 daemon。

## 这个项目是什么 / 不是什么

**这个项目是：**

- 一个把 Claude Code 和 Codex 连接到同一工作流里的本地开发工具
- 一个在 MCP channel 与 Codex app-server 协议之间转发消息的桥接层
- 一个面向人工参与、多代理协作场景的实验性方案

**这个项目不是：**

- 一个托管服务或多租户系统
- 一个面向任意 Agent 后端的通用编排框架
- 一个可以隔离不可信工具的强化安全边界

## 架构

```
┌──────────────┐          MCP stdio          ┌────────────────────┐
│ Claude Code  │ ───────────────────────────▶ │ bridge.ts          │
│ Session      │ ◀─────────────────────────── │ 前台 MCP 客户端     │
└──────────────┘                              └─────────┬──────────┘
                                                        │
                                                        │ 本地控制 WS
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
| **Codex → Claude** | `daemon.ts` 捕获 `agentMessage` → 控制 WS → `bridge.ts` → `notifications/claude/channel` |
| **Claude → Codex** | Claude 调用 `reply` tool → `bridge.ts` → 控制 WS → `daemon.ts` → `turn/start` 注入 Codex thread |

### 防循环

每条消息都携带 `source` 字段（`"claude"` 或 `"codex"`），Bridge 永远不会把消息转发回它的来源。

## 前置条件

- [Bun](https://bun.sh)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- [Codex CLI](https://github.com/openai/codex)，且本地可直接使用 `codex` 命令

## Quick Start

```bash
# 1. 安装依赖
cd agent_bridge
bun install

# 2. 注册 MCP server
# 将 .mcp.json.example 的内容合并到 ~/.claude/.mcp.json 中，
# 并把路径替换为你本地的绝对路径：
#   "agentbridge": { "command": "bun", "args": ["run", "/absolute/path/to/agent_bridge/src/bridge.ts"] }

# 3. 启动 Claude Code 并以 channel 形式加载 AgentBridge（开发模式）
claude --dangerously-load-development-channels server:agentbridge
```

> 风险说明：`--dangerously-load-development-channels` 会把本地开发中的 channel 挂载进 Claude Code。这一能力当前属于 Research Preview。你只应启用自己信任的 channel 和 MCP server，因为对应的本地进程可以向 Claude 会话推送消息，并参与同一个工作区流程。AgentBridge 的目标是本地开发与实验，不适合放在不可信环境中使用。

`bridge.ts` 启动后会先检查本地 daemon 是否已存在。

- 如果不存在，会自动拉起 `daemon.ts`
- 如果已存在，会直接复用已有 daemon

`daemon.ts` 会自动以 WebSocket 模式启动 `codex app-server`，并在需要时通过 Claude channel 把 attach 命令提示出来。

```bash
# 4. 在另一个终端连接到 Codex 代理，查看 Codex TUI
codex --enable tui_app_server --remote ws://127.0.0.1:4501
```

> 注意：TUI 连接的是 Bridge 代理端口（默认 `4501`），不是 app-server 端口（`4500`）。Bridge 会透明转发流量，并拦截 `agentMessage`。

Codex 的 `agentMessage` 会自动推送到 Claude 会话中。Claude 可以通过 `reply` tool 回复 Codex。

## 文件结构

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/       # Bug report 和 feature request 模板
│   ├── pull_request_template.md
│   └── workflows/ci.yml      # GitHub Actions CI
├── src/
│   ├── bridge.ts             # Claude 前台 MCP 客户端，负责确保 daemon 存在并转发消息
│   ├── daemon.ts             # 常驻后台进程，持有 Codex 代理和桥接状态
│   ├── daemon-client.ts      # 前台连接 daemon 控制 WS 的客户端
│   ├── control-protocol.ts   # 前后台共享控制协议
│   ├── claude-adapter.ts     # 面向 Claude Code channel 的 MCP server 适配层
│   ├── codex-adapter.ts      # Codex app-server WebSocket 代理与消息拦截
│   └── types.ts              # 共享类型
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

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket 端口 |
| `CODEX_PROXY_PORT` | `4501` | Bridge 代理端口，Codex TUI 连接此端口 |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | `bridge.ts` 与 `daemon.ts` 之间的本地控制端口 |
| `AGENTBRIDGE_PID_FILE` | `/tmp/agentbridge-daemon-4502.pid` | daemon pid 文件，用于避免重复启动 |

## 当前限制

- 目前只转发 `agentMessage`，不转发 `commandExecution`、`fileChange` 等中间过程事件
- 当前只支持单个 Codex thread，不支持多会话
- 当前只支持单个 Claude 前台连接；新的 Claude 会话会替换旧连接

## 待优化项

- **消息过滤 / 关键节点模式**：当前所有消息都会双向全量转发，对话噪音较大。后续应支持只在关键节点转发，例如任务分配、review 请求、阶段完成等，同时过滤掉中间状态确认、日志读取等低价值交互。

## 这个项目是怎么建成的

这个项目由 **Claude Code**（Anthropic）和 **Codex**（OpenAI）通过 AgentBridge 本身进行实时双向通信，在人类开发者的指挥下协作完成。开发者负责分配任务、审查进度，并指挥两个 Agent 并行工作、互相 review。

换句话说，AgentBridge 就是它自己的 proof of concept：两个来自不同厂商的 AI Agent，通过实时连接，肩并肩地交付代码。
