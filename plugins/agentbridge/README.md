# AgentBridge Plugin

Claude Code plugin for AgentBridge. This plugin packages the AgentBridge MCP frontend with push channel delivery (a failed push falls back to an in-memory queue drained by `get_messages`), the `/agentbridge:init` command, and a non-blocking SessionStart health check.

## Structure

```text
plugins/agentbridge/
├── .claude-plugin/plugin.json
├── .mcp.json
├── commands/init.md
├── hooks/hooks.json
├── scripts/health-check.sh
└── server/
    ├── bridge-server.js
    └── daemon.js
```

## Build

Run:

```bash
bun run build:plugin
```

This creates self-contained bundles at:

- `plugins/agentbridge/server/bridge-server.js`
- `plugins/agentbridge/server/daemon.js`

## Local Testing

1. Build the plugin bundles: `bun run build:plugin`
2. In Claude Code, load the plugin from this repo or install it from the marketplace manifest in `.claude-plugin/marketplace.json`
3. Reload plugins in the active session with `/reload-plugins`

## Notes

- The plugin frontend launches the sibling daemon bundle via `AGENTBRIDGE_DAEMON_ENTRY=./daemon.js`.
- Claude delivery is always push notifications. If a push fails, the message is queued and can be drained via `get_messages` (per-message fallback — the legacy `AGENTBRIDGE_MODE=pull` mode was removed and the env var is ignored with a one-time warning).
- The SessionStart hook is informational only. It never starts or stops the daemon.
- The command at `/agentbridge:init` edits project-local `.agentbridge/` files only; plugin installation and marketplace registration remain terminal-side tasks (`agentbridge init` / `agentbridge dev`).
