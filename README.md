# AgentBridge

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文文档](README.zh-CN.md)

Local bridge for bidirectional communication between Claude Code and Codex inside the same working session.

AgentBridge uses a two-process architecture:

- **bridge.ts** is the foreground MCP client started by Claude Code via the AgentBridge plugin
- **daemon.ts** is a persistent local background process that owns the Codex app-server proxy and bridge state

When Claude Code closes, the foreground MCP process exits while the background daemon and Codex proxy keep running. When Claude Code starts again, it reconnects automatically with exponential backoff.

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
┌──────────────┐     MCP stdio / plugin     ┌────────────────────┐
│ Claude Code  │ ──────────────────────────▶ │ bridge.ts          │
│ Session      │ ◀──────────────────────────  │ foreground client  │
└──────────────┘                             └─────────┬──────────┘
                                                       │
                                                       │ control WS (:4502)
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
|-----------|------|
| **Codex -> Claude** | `daemon.ts` captures `agentMessage` -> control WS -> `bridge.ts` -> `notifications/claude/channel` |
| **Claude -> Codex** | Claude calls the `reply` tool -> `bridge.ts` -> control WS -> `daemon.ts` -> `turn/start` injects into the Codex thread |

### Loop prevention

Each message carries a `source` field (`"claude"` or `"codex"`). The bridge never forwards a message back to its origin.

## Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| [Bun](https://bun.sh) | v1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | v2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |

> **Note:** Bun is required as the runtime for the AgentBridge daemon and plugin server. Node.js alone is not sufficient.

## Quick Start

### Install via Plugin Marketplace (recommended)

Install AgentBridge directly from Claude Code using the plugin marketplace:

```bash
# 1. In Claude Code, add the AgentBridge marketplace
/plugin marketplace add raysonmeng/agent-bridge

# 2. Install the plugin
/plugin install agentbridge@agentbridge

# 3. Reload plugins to activate
/reload-plugins
```

Then install the CLI tool:

```bash
# 4. Install the CLI globally
npm install -g @raysonmeng/agentbridge

# 5. Generate project config (optional)
abg init

# 6. Start Claude Code with AgentBridge channel enabled
abg claude

# 7. Start Codex TUI connected to the bridge (in another terminal)
abg codex
```

> **Tip:** `abg` is a short alias for `agentbridge`. Both commands are identical — use whichever you prefer.

That's it. The daemon starts automatically when needed and reconnects if restarted.

#### Updating the plugin

When a new version is released, update from Claude Code:

```bash
/plugin marketplace update agentbridge
/reload-plugins
```

Or enable auto-update: run `/plugin` → **Marketplaces** tab → select **agentbridge** → **Enable auto-update**.

### Install for local development

If you want to modify AgentBridge source code, use the local development setup instead:

```bash
# 1. Clone and install dependencies
git clone https://github.com/raysonmeng/agent-bridge.git
cd agent-bridge
bun install
bun link

# 2. Set up local plugin + project config
agentbridge dev     # Register local marketplace + install plugin
agentbridge init    # Check dependencies, generate .agentbridge/config.json

# 3. Start Claude Code with AgentBridge plugin loaded
agentbridge claude

# 4. Start Codex TUI connected to the bridge (in another terminal)
agentbridge codex
```

> **Note:** `agentbridge claude` injects `--dangerously-load-development-channels plugin:agentbridge@agentbridge` automatically. This loads a local development channel into Claude Code (currently a Research Preview workflow). Only enable channels and MCP servers you trust.

#### Updating after code changes

After modifying AgentBridge source code, re-run `agentbridge dev` to sync changes to the plugin cache, then restart Claude Code or run `/reload-plugins` in an active session.

## CLI Reference

> All commands work with both `agentbridge` and the short alias `abg`.

| Command | Description |
|---------|-------------|
| `abg init` | Install plugin, check dependencies (bun/claude/codex), generate `.agentbridge/config.json` |
| `abg claude [args...]` | Start Claude Code with push channel enabled. Clears any killed sentinel from a previous `kill`. Pass-through args are forwarded to `claude` |
| `abg codex [args...]` | Start Codex TUI connected to AgentBridge daemon. Manages TUI process lifecycle (pid tracking, cleanup). Pass-through args forwarded to `codex` |
| `abg kill` | Gracefully stop both daemon and managed Codex TUI, clean up state files, write killed sentinel |
| `abg dev` | (Dev only) Register local marketplace + force-sync plugin to cache |
| `abg --help` | Show help |
| `abg --version` | Show version |

### Owned flags

Some flags are automatically injected and cannot be manually specified:

- `agentbridge claude` owns: `--channels`, `--dangerously-load-development-channels`
- `agentbridge codex` owns: `--remote`, `--enable tui_app_server`

Passing these flags manually will result in a hard error with guidance to use the native command directly.

## Project Config

Running `agentbridge init` creates a `.agentbridge/` directory in your project root:

| File | Purpose |
|------|---------|
| `config.json` | Machine-readable project config (Codex ports, turn coordination, idle shutdown) |

The config is loaded by the CLI and daemon at startup. Re-running `init` is idempotent and will not overwrite existing files.

## File Structure

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/           # Bug report and feature request templates
│   ├── pull_request_template.md
│   └── workflows/ci.yml          # GitHub Actions CI
├── assets/                        # Static assets (images, etc.)
├── docs/
│   ├── phase3-spec.md            # Phase 3 design spec (CLI + Plugin)
│   ├── v1-roadmap.md             # v1 feature roadmap
│   └── v2-architecture.md        # v2 multi-agent architecture design
├── plugins/agentbridge/           # Claude Code plugin bundle
│   ├── .claude-plugin/plugin.json
│   ├── commands/init.md
│   ├── hooks/hooks.json
│   ├── scripts/health-check.sh
│   └── server/                    # Bundled bridge-server.js + daemon.js
├── src/
│   ├── bridge.ts                  # Claude foreground MCP client (plugin entry point)
│   ├── daemon.ts                  # Persistent background daemon
│   ├── daemon-client.ts           # WebSocket client for daemon control port
│   ├── daemon-lifecycle.ts        # Shared daemon lifecycle (ensureRunning, kill, startup lock)
│   ├── control-protocol.ts        # Foreground/background control protocol types
│   ├── claude-adapter.ts          # MCP server adapter for Claude Code channels
│   ├── codex-adapter.ts           # Codex app-server WebSocket proxy and message interception
│   ├── config-service.ts          # Project config (.agentbridge/) read/write
│   ├── state-dir.ts               # Platform-aware state directory resolver
│   ├── message-filter.ts          # Smart message filtering (markers, summary buffer)
│   ├── types.ts                   # Shared types
│   ├── cli.ts                     # CLI entry point and command router
│   └── cli/
│       ├── init.ts                # agentbridge init
│       ├── claude.ts              # agentbridge claude
│       ├── codex.ts               # agentbridge codex
│       ├── kill.ts                # agentbridge kill
│       └── dev.ts                 # agentbridge dev
├── CLAUDE.md                      # Project rules for AI agents
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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | `4501` | Bridge proxy port for the Codex TUI |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | Control port between bridge.ts and daemon.ts |
| `AGENTBRIDGE_STATE_DIR` | Platform default | State directory for pid, status, logs, persisted pull queue, and audit transcript (macOS: `~/Library/Application Support/agentbridge/`, Linux: `$XDG_STATE_HOME/agentbridge/`) |
| `AGENTBRIDGE_MODE` | `auto` (resolves to `pull`) | Message delivery mode (`push` for channels, `pull` for queue-only delivery, `dual` for channel push plus persisted pull queue) |
| `AGENTBRIDGE_DAEMON_ENTRY` | `./daemon.ts` | Override daemon entry point (used by plugin bundles) |

### State Directory

The daemon stores runtime state in a platform-aware directory:

| Platform | Default Path |
|----------|-------------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/` (fallback: `~/.local/state/agentbridge/`) |

Contents: `daemon.pid`, `status.json`, `agentbridge.log`, `queue.db`, `transcript.jsonl`, `killed` (sentinel), `startup.lock`

## Current Limitations

- Only forwards `agentMessage` items, not intermediate `commandExecution`, `fileChange`, or similar events
- Single Codex thread, no multi-session support yet
- Single Claude foreground connection; a new Claude session replaces the previous one
- Fixed ports mean only one AgentBridge instance per machine (multi-project support planned for post-v1)

### Codex git restrictions

Codex runs in a sandboxed environment that **blocks all writes to the `.git` directory**. This means Codex cannot run `git commit`, `git push`, `git pull`, `git checkout -b`, `git merge`, or any other command that modifies git metadata. Attempting these commands will cause the Codex session to hang indefinitely.

**Recommendation:** Let Claude Code handle all git operations (branching, committing, pushing, creating PRs). Codex should focus on code changes and report completed work via `agentMessage`, then Claude Code takes care of the git workflow.

## Roadmap

- **v1.x (current)**: Improve the single-bridge experience without architectural refactoring -- less noise, better turn discipline, and clearer collaboration modes. See [docs/v1-roadmap.md](docs/v1-roadmap.md).
- **v2 (planned)**: Introduce the multi-agent foundation -- room-scoped collaboration, stable identity, a formal control protocol, and stronger recovery semantics. See [docs/v2-architecture.md](docs/v2-architecture.md).
- **v3+ (longer term)**: Explore smarter collaboration, richer policies, and more advanced orchestration across runtimes.

## How This Project Was Built

This project was built collaboratively by **Claude Code** (Anthropic) and **Codex** (OpenAI), communicating through AgentBridge itself -- the very tool they were building together. A human developer coordinated the effort, assigning tasks, reviewing progress, and directing the two agents to work in parallel and review each other's output.

In other words, AgentBridge is its own proof of concept: two AI agents from different providers, connected in real time, shipping code side by side.

## Contact

This is my first open-source project! I'd love to connect with anyone interested in multi-agent collaboration, AI tooling, or just building cool things together. Feel free to reach out:

- **Twitter/X**: [@raysonmeng](https://x.com/raysonmeng)
- **Xiaohongshu**: [Profile](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
- **WeChat**: Scan the QR code below to add me

<img src="assets/wechat-qr.jpg" alt="WeChat QR Code" width="300" />
