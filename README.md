# AgentBridge

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文文档](README.zh-CN.md)

Local bridge for bidirectional communication between Claude Code and Codex inside the same working session.

The current implementation uses a two-process architecture:

- `bridge.ts` is the foreground MCP client started by Claude Code
- `daemon.ts` is a persistent local background process that owns the Codex app-server proxy and bridge state

This means the foreground MCP process can exit when Claude Code closes, while the background daemon and Codex proxy keep running. When Claude Code starts again, it can reuse the existing daemon automatically.

## What this project is / is not

**This project is:**

- A local developer tool for connecting Claude Code and Codex in one workflow
- A bridge that forwards messages between an MCP channel and the Codex app-server protocol
- An experimental setup for human-in-the-loop collaboration between multiple agents

**This project is not:**

- A hosted service or multi-tenant system
- A generic orchestration framework for arbitrary agent backends
- A hardened security boundary between tools you do not trust

## Architecture

```
┌──────────────┐          MCP stdio          ┌────────────────────┐
│ Claude Code  │ ───────────────────────────▶ │ bridge.ts          │
│ Session      │ ◀─────────────────────────── │ foreground client  │
└──────────────┘                              └─────────┬──────────┘
                                                        │
                                                        │ local control WS
                                                        ▼
                                              ┌────────────────────┐
                                              │ daemon.ts          │
                                              │ bridge daemon      │
                                              └─────────┬──────────┘
                                                        │
                                      ws://127.0.0.1:4501 proxy
                                                        │
                                                        ▼
                                              ┌────────────────────┐
                                              │ Codex app-server   │
                                              └────────────────────┘
```

### Data flow

| Direction | Path |
|------|------|
| **Codex → Claude** | `daemon.ts` captures `agentMessage` → control WS → `bridge.ts` → `notifications/claude/channel` |
| **Claude → Codex** | Claude calls the `reply` tool → `bridge.ts` → control WS → `daemon.ts` → `turn/start` injects into the Codex thread |

### Loop prevention

Each message carries a `source` field (`"claude"` or `"codex"`). The bridge never forwards a message back to its origin.

## Prerequisites

- [Bun](https://bun.sh)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- [Codex CLI](https://github.com/openai/codex) with the `codex` command available

## Quick Start

```bash
# 1. Install AgentBridge CLI
npm install -g agentbridge

# 2. Initialize (installs plugin, checks dependencies, generates project config)
agentbridge init

# 3. Start Claude Code with push channel enabled
agentbridge claude

# 4. In another terminal, start Codex TUI
agentbridge codex
```

The `agentbridge claude` command wraps `claude` with the necessary channel flags. The `agentbridge codex` command wraps `codex` with the correct proxy connection and terminal state protection. Both commands pass through any additional arguments you provide:

```bash
agentbridge claude --resume          # passes --resume to claude
agentbridge codex --model o3         # passes --model o3 to codex
```

> Warning: AgentBridge uses Claude Code's channel system (currently Research Preview) to enable real-time push messaging. Only enable channels and MCP servers you trust. AgentBridge is intended for local experimentation and development, not for untrusted environments.

### How it works

- `agentbridge init` installs the AgentBridge plugin into Claude Code and generates project config (`.agentbridge/`)
- The plugin's MCP server auto-starts a background daemon when Claude Code connects
- The daemon manages the Codex app-server proxy and all bridge state
- `agentbridge codex` connects the Codex TUI to the same daemon

### Emergency reset

If anything gets stuck, kill all AgentBridge processes:

```bash
agentbridge kill
```

### Manual setup (development)

For local development without the CLI package, see the [development setup](#development) section below.

Codex `agentMessage` items are pushed into the Claude session automatically. Claude can reply back through the `reply` tool.

## File Structure

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/       # Bug report and feature request templates
│   ├── pull_request_template.md
│   └── workflows/ci.yml      # GitHub Actions CI
├── assets/                    # Static assets (images, etc.)
├── src/
│   ├── bridge.ts             # Claude foreground MCP client that ensures the daemon exists and forwards messages
│   ├── daemon.ts             # Persistent background process that owns the Codex proxy and bridge state
│   ├── daemon-client.ts      # Foreground client for the daemon control WS
│   ├── control-protocol.ts   # Shared foreground/background control protocol
│   ├── claude-adapter.ts     # MCP server adapter for Claude Code channels
│   ├── codex-adapter.ts      # Codex app-server WebSocket proxy and message interception
│   ├── message-filter.ts     # Smart message filtering with [IMPORTANT]/[STATUS]/[FYI] markers
│   ├── tui-connection-state.ts  # TUI connection state machine with grace window
│   └── types.ts              # Shared types
├── plugins/
│   └── agentbridge/          # Claude Code plugin (MCP server, commands, hooks)
├── cli/                       # CLI commands (init, claude, codex, kill)
├── docs/
│   ├── v1-roadmap.md         # v1 feature roadmap
│   ├── v2-architecture.md    # v2 multi-agent architecture plan
│   └── phase3-spec.md        # Phase 3 CLI + Plugin integration spec
├── scripts/
│   └── agentbridge-attach.sh # Terminal-safe Codex TUI wrapper
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── README.zh-CN.md
├── SECURITY.md
├── package.json
└── tsconfig.json
```

## Configuration

| Environment variable | Default | Description |
|----------|--------|------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | `4501` | Bridge proxy port for the Codex TUI |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | Local control port between `bridge.ts` and `daemon.ts` |
| `AGENTBRIDGE_PID_FILE` | `/tmp/agentbridge-daemon-4502.pid` | Daemon pid file used to avoid duplicate startup |

## Current Limitations

- Only forwards `agentMessage` items, not intermediate `commandExecution`, `fileChange`, or similar events
- Single Codex thread, no multi-session support yet
- Single Claude foreground connection; a new Claude session replaces the previous one

## Roadmap

- **v1.x (current)**: Improve the single-bridge experience without architectural refactoring — less noise, better turn discipline, and clearer collaboration modes. See [docs/v1-roadmap.md](docs/v1-roadmap.md).
- **v2 (planned)**: Introduce the multi-agent foundation — room-scoped collaboration, stable identity, a formal control protocol, and stronger recovery semantics. See [docs/v2-architecture.md](docs/v2-architecture.md).
- **v3+ (longer term)**: Explore smarter collaboration, richer policies, and more advanced orchestration across runtimes.

## How This Project Was Built

This project was built collaboratively by **Claude Code** (Anthropic) and **Codex** (OpenAI), communicating through AgentBridge itself — the very tool they were building together. A human developer coordinated the effort, assigning tasks, reviewing progress, and directing the two agents to work in parallel and review each other's output.

In other words, AgentBridge is its own proof of concept: two AI agents from different providers, connected in real time, shipping code side by side.

## Contact

This is my first open-source project! I'd love to connect with anyone interested in multi-agent collaboration, AI tooling, or just building cool things together. Feel free to reach out:

- **Twitter/X**: [@raysonmeng](https://x.com/raysonmeng)
- **Xiaohongshu**: [Profile](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
- **WeChat**: Scan the QR code below to add me

<img src="assets/wechat-qr.jpg" alt="WeChat QR Code" width="300" />
