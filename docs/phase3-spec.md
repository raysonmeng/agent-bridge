# AgentBridge Phase 3 Final State

## Status

Phase 3 is complete in the current codebase.

This document records what actually shipped, not the earlier proposal shape. If an older planning note or conversation describes Phase 3 as future work, this file should be treated as the source of truth for the delivered Phase 3 surface.

## What Phase 3 Delivered

Phase 3 turned AgentBridge from a repo-first prototype into a CLI-first local product flow built around a foreground Claude integration, a persistent daemon, and an attachable Codex TUI.

Delivered scope:

- A repository-local `agentbridge` CLI entrypoint via `src/cli.ts` and the package `bin` field.
- First-run setup via `agentbridge init`.
- Claude startup via `agentbridge claude`.
- Codex startup and daemon bootstrap via `agentbridge codex`.
- Controlled daemon shutdown via `agentbridge kill`.
- A developer-only local plugin workflow via `agentbridge dev`.
- Project-level config generation through `.agentbridge/config.json` and `.agentbridge/collaboration.md`.
- Shared runtime state management through `StateDirResolver`.
- Shared daemon lifecycle logic through `DaemonLifecycle`.
- Plugin-oriented runtime artifacts under `plugins/agentbridge/server/`.

## User-Facing CLI

The current command set is:

- `agentbridge init`
- `agentbridge dev`
- `agentbridge claude [args...]`
- `agentbridge codex [args...]`
- `agentbridge kill`

### `agentbridge init`

Current behavior:

- Verifies `bun`, `claude`, and `codex` are available.
- Enforces a minimum Claude Code version of `2.1.80`.
- Creates `.agentbridge/config.json` if missing.
- Creates `.agentbridge/collaboration.md` if missing.
- Attempts `claude plugin install agentbridge@agentbridge` as a best-effort step.

Important nuance:

- `init` does not patch a global Claude MCP JSON file.
- Plugin installation is best-effort and may be skipped if the marketplace is not configured yet.

### `agentbridge claude`

Current behavior:

- Rejects AgentBridge-owned flags from the user.
- Starts Claude Code with:

```bash
claude --dangerously-load-development-channels plugin:agentbridge@agentbridge
```

- Passes through additional user arguments after the injected channel flags.

Important nuance:

- The shipped implementation still uses the development-channel flag.
- It does not yet switch to `--channels`, because the current flow still depends on a development plugin/runtime path.

### `agentbridge codex`

Current behavior:

- Rejects AgentBridge-owned transport flags such as `--remote` and `--enable tui_app_server`.
- Uses `DaemonLifecycle` to reuse or launch the background daemon.
- Reads the live proxy URL from daemon status when available.
- Falls back to the project config when daemon status is unavailable.
- Launches Codex with:

```bash
codex --enable tui_app_server --remote ws://127.0.0.1:<proxy-port>
```

- Passes through additional user arguments after the injected transport flags.

### `agentbridge kill`

Current behavior:

- Marks a `killed` sentinel before shutting down the daemon.
- Prevents the foreground Claude-side bridge from racing to relaunch the daemon during disconnect handling.
- Removes stale state when no live daemon exists.

### `agentbridge dev`

Current behavior:

- Developer workflow only.
- Registers a local Claude marketplace.
- Installs the local AgentBridge plugin into Claude.
- Syncs local plugin files into Claude's plugin cache.

Important nuance:

- This command is for local development of the plugin/runtime packaging flow.
- It is not part of the normal end-user quick start.

## Actual Runtime Architecture

Phase 3 kept the two-process design, but productized it through shared lifecycle helpers and CLI commands.

### Foreground process

`src/bridge.ts` is the Claude-facing foreground process:

- starts as the MCP server runtime seen by Claude Code
- owns the `ClaudeAdapter`
- ensures the daemon exists through `DaemonLifecycle`
- connects to the daemon control socket through `DaemonClient`
- forwards Codex messages to Claude and replies back to Codex

### Background process

`src/daemon.ts` is the persistent background process:

- owns the Codex adapter and proxy
- exposes `/healthz`, `/readyz`, and `/ws` on the local control port
- survives Claude foreground restarts
- manages buffered messages, turn coordination, and Codex thread state

### Shared runtime helpers added or formalized in Phase 3

- `src/daemon-lifecycle.ts`
  - shared launch, health-check, pid, lock, and kill behavior
- `src/config-service.ts`
  - project config loading, defaults, and collaboration file generation
- `src/state-dir.ts`
  - OS-specific shared runtime state directory resolution
- `src/daemon-client.ts`
  - foreground client for daemon control WebSocket traffic

### Plugin-oriented delivery shape

The runtime is designed around Claude-side plugin or channel delivery:

- source entrypoints live under `src/`
- bundled runtime artifacts live under `plugins/agentbridge/server/`
- the CLI is the main operator-facing surface

This means Phase 3 shipped the plugin-oriented architecture, even though packaging and marketplace polish are still evolving.

## Configuration and State

Phase 3 split persistent data into two layers.

### Project-level config

Stored in the repo under `.agentbridge/`:

- `config.json`
- `collaboration.md`

This data is project-specific and travels with the working tree.

### Machine-local runtime state

Resolved by `StateDirResolver`:

- macOS: `~/Library/Application Support/AgentBridge`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/agentbridge`
- override: `AGENTBRIDGE_STATE_DIR`

Files maintained there include:

- `daemon.pid`
- `daemon.lock`
- `status.json`
- `agentbridge.log`
- `killed`

This split is intentional:

- `.agentbridge/` is for shared project defaults and collaboration rules
- the state dir is for local process lifecycle and diagnostics

## Phase 3 Runtime Controls

The current implementation uses these environment variables as the main runtime controls:

| Variable | Purpose |
| --- | --- |
| `AGENTBRIDGE_STATE_DIR` | Override the machine-local runtime state directory |
| `AGENTBRIDGE_DAEMON_ENTRY` | Override the daemon entrypoint used by `DaemonLifecycle` |
| `AGENTBRIDGE_CONTROL_PORT` | Control HTTP/WebSocket port between foreground and daemon |
| `CODEX_WS_PORT` | Codex app-server listen port |
| `CODEX_PROXY_PORT` | AgentBridge proxy port used by the Codex TUI |
| `AGENTBRIDGE_MODE` | Claude delivery mode override: `push`, `pull`, or `auto` |
| `AGENTBRIDGE_MAX_BUFFERED_MESSAGES` | Pull-mode queue bound and buffering limit |
| `AGENTBRIDGE_FILTER_MODE` | Codex message filtering mode |
| `AGENTBRIDGE_IDLE_SHUTDOWN_MS` | Daemon idle shutdown override |
| `AGENTBRIDGE_ATTENTION_WINDOW_MS` | Claude attention-window override |

## Where Phase 3 Landed Differently Than The Earlier Proposal

Phase 3 shipped the intended product direction, but not every original proposal detail survived unchanged.

### Shipped differently

- The CLI exists, but the package is still repository-local today.
  - `package.json` exposes the `agentbridge` bin, but the package is still marked `private`.
- The command surface is more opinionated than the original generic lifecycle proposal.
  - Shipped commands are `init`, `dev`, `claude`, `codex`, and `kill`.
  - Proposed commands such as `doctor`, `status`, `start`, `stop`, and `attach` did not ship in Phase 3.
- `init` generates project config and attempts plugin installation, but it does not rewrite global Claude configuration files.
- Claude startup still uses the development-channel path instead of a stable marketplace `--channels` flow.
- Delivery mode auto-detection is intentionally conservative.
  - `auto` resolves to push mode today.
  - API-key users can force pull mode with `AGENTBRIDGE_MODE=pull`.

### Why those differences are acceptable for v1

- The current command set matches the real user workflow more directly.
- The daemon lifecycle is now precise enough that a generic `start` or `attach` command is not required for normal use.
- Keeping `claude` and `codex` as explicit commands makes the startup contract easier to understand and test.
- Explicit pull-mode override solves the practical API-key case without over-engineering capability negotiation.

## Validation Shipped With Phase 3

Phase 3 is backed by targeted automated coverage in the repository:

- CLI helper and flag handling tests
- config and lifecycle tests
- daemon client tests
- CLI end-to-end harness coverage for:
  - `init`
  - `claude`
  - `codex`
  - daemon reuse
  - concurrent startup lock behavior
  - `kill`
  - killed-sentinel reconnect behavior

## Remaining Follow-Ups After Phase 3

Phase 3 is complete, but these items remain follow-up work rather than part of the shipped baseline:

- publishing a non-private npm package
- stabilizing marketplace packaging and plugin manifests
- deciding whether `doctor` or `status` are still worth adding
- replacing development-channel startup with a stable marketplace path when available
- broader multi-session and multi-agent work, which remains v2+ scope
