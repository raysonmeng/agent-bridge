# AgentBridge Plugin

Claude Code plugin for AgentBridge. This plugin packages the AgentBridge MCP frontend, dual-mode Claude transport (push channel delivery plus pull-mode `get_messages`), the `/agentbridge:init` command, and a non-blocking SessionStart health check.

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
- Claude delivery supports both push notifications and pull-mode polling via `get_messages`, depending on the runtime mode.
- The SessionStart hook is informational only. It never starts or stops the daemon.
- The command at `/agentbridge:init` edits project-local `.agentbridge/` files only; plugin installation and marketplace registration remain terminal-side tasks (`agentbridge init` / `agentbridge dev`).
