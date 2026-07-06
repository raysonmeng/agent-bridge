<p align="center"><img src="site/assets/logo.svg" width="72" alt="AgentBridge logo" /></p>

# AgentBridge

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文文档](README.zh-CN.md)

**🌐 Website: [raysonmeng.github.io/agent-bridge](https://raysonmeng.github.io/agent-bridge/)**, with an animated replay of a real session.

> Discussed on [LINUX DO](https://linux.do) — the developer community. / 在 [LINUX DO](https://linux.do) 开发者社区交流。

Local bridge for bidirectional communication between Claude Code and Codex inside the same working session.

What that buys you, concretely:

- **Cross-review** — Codex implements; Claude reviews the diff *inside the same session* and pushes change requests straight back into Codex's thread. Two providers check each other's work without copy-paste.
- **Task splits from one prompt** — ask either agent to propose a division of labor with the other, and they negotiate who does what before writing code. You steer; they coordinate.
- **Quota relay for overnight runs** — when one side's subscription window runs dry, it stops cleanly at a turn boundary and hands the task off to the other side, so a long job keeps moving instead of dying at a limit.

<!-- TODO: assets/demo.gif — see docs/demo/RECORDING.md -->
▶ **[Watch the demo on the website](https://raysonmeng.github.io/agent-bridge/)**: an animated replay of a real session. Codex pushes a reply into Claude's live session, Claude injects a note mid-turn, and the task survives a quota handoff.

> **This tool was largely built by Claude Code and Codex collaborating through it.**
> **Every PR written by one agent was reviewed by the other.** AgentBridge is its own proof of concept.

## Why not just…

- **…run two terminals and copy-paste?** You can, but then you are the message bus: you ferry text by hand and guess when it is safe to interrupt. AgentBridge automates the relay: messages flow on their own, a busy-guard blocks replies during an active turn, and the bridge filters noisy intermediate events so each side sees only the other's meaningful output.
- **…use a one-way delegation plugin?** Tools like `openai/codex-plugin-cc` let a host *call* Codex and get one answer back: request in, response out, no standing peer on the other side. AgentBridge keeps **both** agents live as persistent peers, and either side can push a message **mid-turn** (a review comment lands while the other is still working), not only at call boundaries.
- **…wire up an external orchestrator?** A god-process scheduling dumb terminals is top-down: one brain, N workers that never talk to each other. AgentBridge is peer-to-peer: two full agents converse in-session, propose their own splits, and review each other, with the human steering instead of scripting every hop.

## What this project is / is not

**This project is:**

- A local developer tool for connecting Claude Code and Codex in one workflow
- A bridge that forwards messages between an MCP channel and the Codex app-server protocol
- An experimental setup for human-in-the-loop collaboration between multiple agents

**This project is not:**

- A hosted service or multi-tenant system
- A generic orchestration framework for arbitrary agent backends
- A hardened security boundary between tools you do not trust

## Features

- **Bidirectional Claude ↔ Codex messaging** in one working session — the daemon intercepts Codex output and pushes it to Claude as channel notifications; Claude replies via the `reply` MCP tool, and the bridge injects the reply into the Codex thread as a `turn/start`.
- **Push delivery with fallback** — messages arrive as channel notifications; a failed push falls back to an in-memory queue drained by `get_messages`. Loop prevention via the per-message `source` field.
- **Turn coordination** — a busy-guard rejects replies during an active Codex turn; a per-turn inactivity watchdog stops a lost `turn/completed` from locking injection forever; noisy intermediate events are collapsed so only meaningful `agentMessage` payloads reach Claude.
- **Multiple pairs side by side** — one Claude+Codex pair per project directory, ports allocated per pair in +10 strides from 4500. Pair-aware `claude` / `codex` / `resume` / `kill` / `doctor` / `budget` via `--pair`.
- **Resilient lifecycle** — a persistent background daemon survives Claude Code restarts (auto-reconnect with backoff); orphan-process cleanup; `abg doctor` read-only diagnostics; `abg pairs prune` reclaims stranded state.
- **Thread auto-resume** — bare `abg codex` resumes the pair's last Codex thread; `abg resume` prints/performs the resume commands for both sides.
- **Budget coordination, slowdown-line & fully-automatic resume** — keep a long task moving across subscription-quota windows instead of dying at a limit. See [Budget Coordination](#budget-coordination--auto-resume).

## Context handling — real-time, without the context blowing up

A common worry about real-time bidirectional messaging is that the two agents' contexts merge and grow without bound. They don't. **The bridge passes messages, not context** — each agent keeps its own context window, and the bridge never copies one agent's full transcript into the other. Three filters keep what actually crosses small:

1. **Only `agentMessage` crosses.** The daemon forwards an agent's actual output, not its tool-call noise — `commandExecution`, `fileChange`, and reasoning deltas never reach the other side. Each agent sees the other's conclusions, not its scrollback.
2. **Three-tier marker routing** (default `filtered` mode). Each message is tagged and the daemon routes by tag: `[IMPORTANT]` forwards immediately, `[STATUS]` is buffered and batched into one periodic summary (default: 3 updates or 15s), `[FYI]` is dropped. The marker rules live once in the project's `AGENTS.md` (written by `abg init`), loaded at agent startup.
3. **The collaboration contract lives once** in `AGENTS.md`, not appended to every message (which would pollute every thread and its resume title).

Net effect: each side receives a curated stream of meaningful messages, so context grows with the number of real exchanges — not the other agent's raw activity. Set `AGENTBRIDGE_FILTER_MODE=full` (or the config equivalent) when you *do* want the unfiltered stream.

## Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| [Bun](https://bun.sh) | v1.3.11+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | v2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |

> **Bun is required** as the runtime for the AgentBridge daemon and plugin server. Node.js alone is not enough. If `abg` installs but won't run, install Bun first (see [Troubleshooting](docs/TROUBLESHOOTING.md)).

## Quick Start

Five steps from nothing to a running pair:

```bash
# 1. Install Bun (the runtime; Node alone won't work)
curl -fsSL https://bun.sh/install | bash

# 2. Install the CLI. postinstall auto-registers the Claude Code plugin
#    marketplace AND installs the plugin (best-effort; needs bun + claude present).
npm install -g @raysonmeng/agentbridge

# 3. Initialize the project (check deps, install plugin if needed, write .agentbridge/config.json)
abg init

# 4. Start Claude Code with the AgentBridge channel enabled
abg claude

# 5. In another terminal, start Codex TUI connected to the same bridge
abg codex
```

That's it: the daemon starts automatically when needed and reconnects if restarted. (`abg` is a short alias for `agentbridge`; both are identical.) If the postinstall plugin step was skipped (e.g. Claude Code wasn't installed yet), run `abg init` to retry it, or see the [manual install fallback](#manual-plugin-install-fallback).

> [!WARNING]
> **`abg claude` launches with `--dangerously-skip-permissions` and `abg codex` launches with `--yolo` by default.** This is deliberate: an unattended agent pair can't stop to ask you for each permission. It means both agents can run commands and edit files **without prompting**. Only do this in a workspace you trust. To launch with normal prompts, add `--safe` (`abg claude --safe`, `abg codex --safe`) or set `AGENTBRIDGE_SAFE=1`. The defaults are also auto-suppressed if you pass your own permission flags.

### Your first collaboration

With both sides running, give Claude a task that wants a second agent, e.g.:

> **Ask Claude:** *"Propose a task split with Codex for &lt;your task&gt;, then have Codex implement its part while you review."*

You should see Claude send a proposed division of labor into Codex's session, Codex accept (or counter) and start working, and Codex's completion push back into Claude's session for review, without you relaying anything by hand.

### Manual plugin install (fallback)

If the automatic postinstall didn't register the plugin, do it from inside Claude Code:

```bash
# 1. Add the AgentBridge marketplace
/plugin marketplace add raysonmeng/agent-bridge

# 2. Install the plugin
/plugin install agentbridge@agentbridge

# 3. Reload plugins to activate
/reload-plugins
```

To update later: `/plugin marketplace update agentbridge` then `/reload-plugins` (or enable auto-update under `/plugin` → **Marketplaces** → **agentbridge**).

### Install for local development

If you want to modify AgentBridge source code, use the local development setup instead:

```bash
git clone https://github.com/raysonmeng/agent-bridge.git
cd agent-bridge
bun install
bun link

agentbridge dev     # Register local marketplace + install plugin
agentbridge init    # Check dependencies, generate .agentbridge/config.json
agentbridge claude  # Start Claude Code with plugin loaded
agentbridge codex   # (another terminal) Start Codex TUI connected to the bridge
```

> **Note:** `agentbridge claude` injects `--dangerously-load-development-channels plugin:agentbridge@agentbridge` (a Research Preview workflow). Only enable channels and MCP servers you trust. After changing source, re-run `agentbridge dev` and restart Claude Code (or `/reload-plugins`).

## CLI Reference

> All commands work with both `agentbridge` and the short alias `abg`.

| Command | Description |
|---------|-------------|
| `abg init` | Install plugin, check dependencies (bun/claude/codex), generate `.agentbridge/config.json` |
| `abg claude [args...]` | Start Claude Code with push channel enabled. **Runs with `--dangerously-skip-permissions` by default** (opt out: `--safe` or `AGENTBRIDGE_SAFE=1`). Clears any killed sentinel from a previous `kill`. Pass-through args are forwarded to `claude` |
| `abg codex [args...]` | Start Codex TUI connected to AgentBridge daemon. **Bare `abg codex` auto-resumes the pair's last thread; use `abg codex --new` for a fresh thread. TUI launches run with `--yolo` by default** (opt out: `--safe` or `AGENTBRIDGE_SAFE=1`; non-TUI subcommands like `exec` are never touched). Pass-through args forwarded to `codex` |
| `abg resume [claude\|codex]` | No target: print the resume commands for this directory's last Claude session and this pair's current Codex thread. With a target: resume that side directly |
| `abg pairs` | List registered pairs; `abg pairs rm <name\|id>` removes one; `abg pairs prune` previews reclaimable orphan dirs + stranded registry entries, `--apply` deletes them |
| `abg doctor [--json]` | Read-only diagnosis: env, daemon health/readiness, build drift, artifact alignment, TUI attachment, logs |
| `abg budget [--json]` | Both agents' subscription quota snapshot (5h/weekly windows, drift, pause state) |
| `abg logs [--codex] [-f] [-n N]` | Tail this pair's daemon log (or the Codex wrapper log with `--codex`); `-f` follows, `-n N` sets the line count (default 100) |
| `abg kill` | Gracefully stop this pair's daemon and managed Codex TUI, write killed sentinel; `abg kill --all` stops every pair |
| `abg dev` | (Dev only) Register local marketplace + force-sync plugin to cache |
| `abg --help` / `abg --version` | Show help / version |

### Cross-network collaboration *(v3 preview)*

The v3 collaboration layer (shared rooms across machines/agents over a broker: `auth`, `broker`, `room`, `join`, `publish`) is in preview on the [`integration/v3-all`](https://github.com/raysonmeng/agent-bridge/tree/integration/v3-all) branch and lands here with v3. Spec: [docs/09-v3协作系统规格.md](docs/09-v3协作系统规格.md).

The pair-aware commands (`claude`, `codex`, `resume`, `kill`, `doctor`, `budget`, `logs`) accept `--pair <name>` to target a specific pair; one pair per project directory by default, with ports allocated per pair in +10 strides from 4500.

### Owned flags

Some flags are automatically injected and cannot be manually specified:

- `agentbridge claude` owns: `--channels`, `--dangerously-load-development-channels`
- `agentbridge codex` owns: `--remote`, `--enable tui_app_server`
- Both launchers consume the wrapper flag `--safe` (it is never forwarded): it disables the max-permission defaults for that launch. The defaults are also auto-suppressed when you pass any explicit permission flag yourself (`-a`/`--ask-for-approval`/`-s`/`--sandbox` for codex; `--permission-mode`/`--allow-dangerously-skip-permissions` for claude) — injecting `--yolo` next to an explicit approval policy is a hard codex CLI conflict.

Passing an owned flag manually is a hard error with guidance to use the native command directly.

> **Note on flag positioning for `agentbridge codex`:** for the bare TUI form, bridge flags are injected at the front; for TUI subcommands that carry per-subcommand args (`resume`, `fork`), they are injected *after* the subcommand name; non-TUI subcommands (`exec`, `mcp`, `plugin`, …) are passed through unchanged. See `src/cli/codex.ts buildCodexArgs`.

## Architecture

AgentBridge is a **two-process** local bridge:

- **bridge.ts** — the foreground MCP client started by Claude Code via the AgentBridge plugin. It exits when Claude Code closes.
- **daemon.ts** — a persistent local background process that owns the Codex app-server proxy and the single source of truth for bridge state. It survives Claude Code restarts; `bridge.ts` reconnects with exponential backoff.

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

## Project Config

Running `agentbridge init` creates a `.agentbridge/` directory in your project root:

| File | Purpose |
|------|---------|
| `config.json` | Machine-readable project config (Codex ports, turn coordination, idle shutdown) |

The config is loaded by the CLI and daemon at startup. Re-running `init` is idempotent and will not overwrite existing files.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | `4501` | Bridge proxy port for the Codex TUI |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | Control port between bridge.ts and daemon.ts |
| `AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS` | `3000` | Maximum wait for incumbent Claude pong before evicting on contention (issue #68) |
| `AGENTBRIDGE_TURN_WATCHDOG_MS` | `300000` | Per-turn inactivity watchdog: force-completes a turn after this many ms of app-server silence so a lost `turn/completed` can't lock injection forever (issue #69) |
| `AGENTBRIDGE_CODEX_TRANSPORT` | `auto` | How the daemon reaches the Codex app-server: `auto` (probe `codex app-server --help`, use `ws://` if supported else fall back to a `unix://` socket via a transparent relay), `ws` (force ws), or `unix` (force unix socket + relay). For builds that drop `ws://` listen support (issue #85) |
| `AGENTBRIDGE_STATE_DIR` | Platform default | State directory for pid, status, logs (macOS: `~/Library/Application Support/agentbridge/`, Linux: `$XDG_STATE_HOME/agentbridge/`) |
| `AGENTBRIDGE_DAEMON_ENTRY` | `./daemon.ts` | Override daemon entry point (used by plugin bundles) |
| `NO_UPDATE_NOTIFIER` | unset | Set to any value to disable the "update available" notice (ecosystem-standard opt-out) |
| `AGENTBRIDGE_NO_UPDATE_NOTIFIER` | unset | Namespaced opt-out for the update notice (same effect as `NO_UPDATE_NOTIFIER`) |
| `AGENTBRIDGE_UPDATE_PROMPT` | unset | Set to `0` to disable the interactive update prompt and keep pure notice-only behavior |
| `AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS` | `86400000` | How often `abg claude`/`abg codex` may check npm for a newer version (default once/day). The notice is otherwise printed from cache — zero network on most runs |

### Update notifications

`abg claude` and `abg codex` print a one-line notice to stderr when a newer **stable** AgentBridge is published to npm. The check is best-effort: printed from a cached result, the npm check runs at most once per day in the background, and any network/registry failure is silently ignored. On an interactive TTY, a cached update prompts before launch; answering `y` runs the upgrade, while `N` (or no answer within 15 seconds) dismisses that version and continues. Disable with `NO_UPDATE_NOTIFIER=1`, or keep notice-only with `AGENTBRIDGE_UPDATE_PROMPT=0`.

### State Directory

The daemon stores runtime state in a platform-aware directory:

| Platform | Default Path |
|----------|-------------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/` (fallback: `~/.local/state/agentbridge/`) |

Contents: `daemon.pid`, `status.json`, `agentbridge.log`, `killed` (sentinel), `startup.lock`

## Budget Coordination & Auto-Resume

AgentBridge can keep a long task moving across subscription-quota windows instead of letting it die when one agent hits its limit. The capability is driven by the companion tool **[agent-quota-guard](https://www.npmjs.com/package/agent-quota-guard)** ([repo](https://github.com/raysonmeng/agent-quota-guard) · v0.2.0, 2026-06-13). Install the guard to enable it.

- **Snapshot** — the daemon polls both agents' account-level 5h/weekly quota via the guard's probe; `abg budget [--json]` prints the live snapshot (both windows, drift, pause state). This works with just the guard's probe.
- **Slowdown-line (no mid-task cut)** — near the quota hard-line the guard does *not* deny mid-tool-call; it lets the current turn finish, stops cleanly at the turn boundary, writes a `.agent/checkpoint.md`, and drops a `pending` record the bridge detects.
- **Automatic resume** — when the paused side's window refreshes, the bridge resumes the task **in the original interactive TUI**: Codex via a queued `turn/start` injection, Claude via a channel push it acks with `ack_resume`. Per-pending idempotency tombstones ensure a resume is injected at most once, even across daemon restarts.

> **Experimental / opt-in.** This is a companion-guard feature. The Claude-side resume is best-effort (ack + retry + a `SessionStart` fallback): channel pushes to a fully idle session have known upstream variability, so the bridge only marks a side resumed once it sees a real `ack_resume`.

## Current Limitations

- Only forwards `agentMessage` items, not intermediate `commandExecution`, `fileChange`, or similar events
- Single Codex thread per pair, no multi-session support within a pair yet
- Single Claude foreground connection per pair; a new Claude session replaces the previous one
- Multiple pairs run side-by-side on one machine (one per project directory); Windows is not an officially supported platform yet

For dormant/disabled bridge states, the Codex `.git` restriction, and other gotchas, see **[Troubleshooting](docs/TROUBLESHOOTING.md)**.

## Roadmap

- **More adapters** — AgentBridge wires Claude Code ↔ Codex today. Candidates for the next agent: **OpenCode, OpenClaw, Hermes Agent, Gemini CLI**. Vote in the [adapter roadmap issue](https://github.com/raysonmeng/agent-bridge/issues/212).
- **Capability mesh** — beyond messaging: connected agents will publish their commands / skills / MCP tools so a peer can invoke them directly, moving from messaging to capability invocation.
- **v2 — multi-agent foundation** (partly landed): room-scoped collaboration, stable identity, a formal control protocol, stronger recovery. See [docs/08-v2架构愿景.md](docs/08-v2架构愿景.md).
- **v3 — cross-network collaboration** (preview on the [`integration/v3-all`](https://github.com/raysonmeng/agent-bridge/tree/integration/v3-all) branch): shared rooms across machines and agents over a broker. See [docs/09-v3协作系统规格.md](docs/09-v3协作系统规格.md).

## Docs

- **[Troubleshooting](docs/TROUBLESHOOTING.md)** — disabled-state recovery, the Codex `.git` hang, "installed but won't run", Bun version requirements
- **[User manual (EN)](https://github.com/raysonmeng/agent-bridge/blob/integration/v3-all/docs/manual/manual-en.md)** — end-to-end usage walkthrough
- **[Project growth timeline](docs/README.md)** — how AgentBridge was built, stage by stage (01–11)

## How This Project Was Built

This project was built collaboratively by **Claude Code** (Anthropic) and **Codex** (OpenAI), communicating through AgentBridge itself, the very tool they were building together. A human developer coordinated the effort: assigning tasks, reviewing progress, and directing the two agents to work in parallel and review each other's output. Two AI agents from different providers, connected in real time, shipping code side by side.

## Contact

This is my first open-source project! I'd love to connect with anyone interested in multi-agent collaboration, AI tooling, or just building cool things together. Feel free to reach out:

- **Website**: [raysonmeng.pages.dev](https://raysonmeng.pages.dev/)
- **Twitter/X**: [@raysonmeng](https://x.com/raysonmeng)
- **Xiaohongshu**: [Profile](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
- **WeChat**: Scan the QR code below to add me

<img src="assets/wechat-qr.jpg" alt="WeChat QR Code" width="300" />
