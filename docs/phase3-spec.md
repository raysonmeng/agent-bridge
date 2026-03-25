# Phase 3 Spec v2 — CLI + Plugin Integration

> Finalized 2026-03-25. This is the execution spec for Phase 3.

## 1. Goal

Deliver AgentBridge as a productized "one daemon, two entry points" solution:
- **CLI**: 4 commands for users (`init`, `claude`, `codex`, `kill`)
- **Plugin**: Claude Code integration (MCP server, push channel, commands, hooks)
- **Daemon**: single long-running runtime, shared state

## 2. Design Assumptions

- Users always have Claude Code
- Push mode is the primary path; `--dangerously-load-development-channels` required during research preview
- Pull mode (`get_messages`) retained as fallback for users who forget channel flags
- Plugin must be self-contained (copied to cache on install, no external path references)
- v1 depends on Bun runtime
- v1 does not support: permission relay, Windows, agents/skills default injection

## 3. Minimum Environment Requirements

- `claude` >= 2.1.80 (channels support)
- `bun` in PATH
- `codex` in PATH
- `agentbridge init` checks all of the above and gives actionable error messages

## 4. CLI Commands

### `agentbridge init`

- Check dependencies: `claude` version, `bun`, `codex`
- Install plugin to user scope via Claude CLI
- Merge `extraKnownMarketplaces` into `.claude/settings.json`
- Generate `.agentbridge/config.json` (machine-readable config)
- Generate `.agentbridge/collaboration.md` (human-editable collaboration rules)
- Prompt user to run `/reload-plugins` in current Claude session

### `agentbridge claude [args...]`

- Inject flags:
  - `--channels plugin:agentbridge@<marketplace>`
  - `--dangerously-load-development-channels plugin:agentbridge@<marketplace>`
- Pass through all other arguments
- **Hard error** if user passes `--channels` or `--dangerously-load-development-channels`
- Error message explains: what flags AgentBridge sets, why conflicts aren't allowed, how to use native `claude` command directly

### `agentbridge codex [args...]`

- Call `ensureDaemonRunning()` (auto-start daemon if not running)
- Read `proxyUrl` from daemon status or shared config (not hardcoded)
- Inject flags:
  - `--enable tui_app_server`
  - `--remote <proxyUrl>`
- Integrate terminal state protection (save/restore stty, escape sequences to /dev/tty)
- Pass through all other arguments
- **Hard error** if user passes `--remote` or `--enable tui_app_server`

### `agentbridge kill`

- Read pid/lock/status from shared state directory
- Verify target processes belong to AgentBridge runtime
- Attempt graceful shutdown first
- Force kill after timeout
- Clean up stale pid/lock/status files
- **Never** use `pkill -f` (risk of killing unrelated processes)

## 5. Argument Conflict Strategy

- AgentBridge-owned flags: **hard error**, not warning
- `agentbridge claude` owned: `--channels`, `--dangerously-load-development-channels`
- `agentbridge codex` owned: `--enable tui_app_server`, `--remote`
- All non-owned flags: passthrough
- Error message must explain:
  1. Which flags AgentBridge has already set
  2. Why they cannot be mixed
  3. How to use native commands directly for full customization

## 6. Path Conventions

### Shared Runtime State Directory

- macOS: `~/Library/Application Support/AgentBridge`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/agentbridge`
- Override: `AGENTBRIDGE_STATE_DIR` env var
- Contents:
  - `daemon.pid`
  - `daemon.lock`
  - `status.json` (daemon status, proxyUrl, ports)
  - `ports.json`
  - `agentbridge.log`

### Project Config Directory

- `.agentbridge/config.json` — machine-readable project config
- `.agentbridge/collaboration.md` — human/AI-readable collaboration rules
- Lives in repo root, can be committed and reviewed

### Claude Code Config

- `.claude/settings.json` — only for Claude Code's own config (`extraKnownMarketplaces`)

## 7. Project Config Files

### `.agentbridge/config.json`

```json
{
  "version": "1.0",
  "daemon": {
    "port": 4500,
    "proxyPort": 4501
  },
  "agents": {
    "claude": {
      "role": "Reviewer, Planner",
      "mode": "push"
    },
    "codex": {
      "role": "Implementer, Executor"
    }
  },
  "markers": ["IMPORTANT", "STATUS", "FYI"],
  "turnCoordination": {
    "attentionWindowSeconds": 15,
    "busyGuard": true
  },
  "idleShutdownSeconds": 30
}
```

### `.agentbridge/collaboration.md`

```markdown
# Collaboration Rules

## Roles
- Claude: Reviewer, Planner, Hypothesis Challenger
- Codex: Implementer, Executor, Reproducer/Verifier

## Thinking Patterns
- Analytical/review tasks: Independent Analysis & Convergence
- Implementation tasks: Architect -> Builder -> Critic
- Debugging tasks: Hypothesis -> Experiment -> Interpretation

## Communication
- Use explicit phrases: "My independent view is:", "I agree on:", "I disagree on:"
- Tag messages with [IMPORTANT], [STATUS], or [FYI]

## Review Process
- Cross-review: author never reviews their own code
- All changes go through feature/fix branches + PR

## Custom Rules
<!-- Add your project-specific collaboration rules here -->
```

## 8. Plugin Structure

```
plugins/agentbridge/
  .claude-plugin/
    plugin.json              # manifest
  .mcp.json                  # MCP server config
  commands/
    init.md                  # /agentbridge:init command
  hooks/
    hooks.json               # SessionStart health check
  scripts/
    health-check.sh          # daemon reachability check
  server/
    bridge-server.js         # self-contained MCP + channel server bundle
    daemon.js                # daemon bundle
```

### Plugin Capabilities (v1)

- **MCP server**: reply/get_messages tools + push channel
- **Command**: `/agentbridge:init` for in-session project config updates
- **Hook**: `SessionStart` health check (hint-only, does not start daemon, does not block session)

### Not in v1

- agents / skills (deferred to v2)
- settings.json (only supports `agent` key currently)
- permission relay

## 9. Hook Strategy

- `SessionStart` only checks, does not orchestrate
- Daemon unreachable → show hint, do not start daemon (avoid competing with `ensureDaemonRunning`)
- Dedup/cooldown: limit per workspace/session to avoid repeated hints
- Hook failure must not block Claude session startup

## 10. Push / Pull Strategy

- Push is default and recommended path
- `agentbridge claude` always injects channel flags
- `get_messages` retained as:
  - Fallback when user runs native `claude` without channel flags
  - Debug / recovery tool
  - Not the primary interaction path
- Documentation must clarify this distinction

## 11. Runtime Integration

### Refactoring approach

Extract shared services from existing code, create thin entrypoints:

- `DaemonService` — from daemon.ts
- `ClaudeFrontendService` — from bridge.ts
- `ConfigService` — shared config loading/writing
- `StateDirResolver` — platform-aware state directory resolution

### Shared modules (keep as-is or light migration)

- `codex-adapter.ts`
- `claude-adapter.ts`
- `daemon-client.ts`
- `control-protocol.ts`
- `message-filter.ts`
- `tui-connection-state.ts`

### Bundling

- Bun build generates self-contained bundles
- Plugin bundle: no external `node_modules` dependency
- CLI npm package: also ships built artifacts
- Plugin and CLI publish from same version tag

## 12. Task Breakdown

### Task 5A: Core Runtime

**Deliverables:**
- DaemonService, ClaudeFrontendService, ConfigService, StateDirResolver
- ensureDaemonRunning()
- Single-instance pid/lock management
- healthz / readyz / status endpoints
- Runtime state file read/write
- Stable abstraction over control protocol
- Unit tests + integration tests

**Dependencies:** None (foundation block)

**Done when:** CLI and plugin can both reuse the same runtime core; daemon is single-instance; health/status works in all scenarios.

### Task 5B: CLI Surface

**Deliverables:**
- `agentbridge init` / `claude` / `codex` / `kill`
- Dependency checks + version checks
- Owned flags conflict detection (hard error)
- Terminal state protection integration
- npm package publish config

**Dependencies:** 5A

**Done when:** All 4 commands work on a clean machine from installed package; claude/codex auto-connect to same daemon; conflict flags produce clear errors.

### Task 5C: Plugin Packaging

**Deliverables:**
- plugin.json manifest
- .mcp.json
- bridge-server.js bundle (self-contained)
- daemon.js bundle (self-contained)
- commands/init.md
- hooks/hooks.json + health-check.sh
- Marketplace manifest
- Local dev + publish workflow

**Dependencies:** 5A

**Done when:** Plugin installs via `/plugin install`, activates via `/reload-plugins`, runs from cache directory without external dependencies.

### Task 6A: Protocol-Level Instructions

**Deliverables:**
- MCP instructions text (channel event format, reply tool usage, get_messages fallback, turn coordination, bridge contract)
- No team culture or project-specific role preferences

**Dependencies:** 5C

**Done when:** Claude correctly understands interaction protocol in both push and fallback modes.

### Task 6B: Bootstrap Command

**Deliverables:**
- `/agentbridge:init` implementation
- Shared config schema + config writer
- `.agentbridge/config.json` update logic
- `.agentbridge/collaboration.md` template update logic

**Dependencies:** 5A, 5C (shared config writer also used by CLI init in 5B)

**Done when:** CLI init and slash command produce consistent config format; users can update roles/rules in-session.

### Task 6C: Optional Collaboration Skill (v2)

Deferred. Not in v1 scope.

## 13. Acceptance Scenarios

1. Fresh install: `agentbridge init` → `/reload-plugins` → plugin active in current session
2. `agentbridge claude` → Claude starts with push channel working
3. `agentbridge codex` (daemon not running) → daemon auto-starts, Codex TUI connects
4. Plugin runs from cache directory with all paths valid
5. User passes owned flags → hard error with clear explanation
6. `agentbridge kill` → precise cleanup, no collateral damage
7. Codex TUI crash → terminal state restored
8. User runs native `claude` (no flags) → `get_messages` fallback works
