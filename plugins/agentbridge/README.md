# AgentBridge Plugin

Claude Code plugin for AgentBridge. This plugin packages the AgentBridge MCP frontend, push channel bridge, `/agentbridge:init` command, and a non-blocking SessionStart health check.

## Structure

```text
plugins/agentbridge/
├── .claude-plugin/plugin.json
├── .mcp.json
├── commands/init.md
├── hooks/hooks.json
├── scripts/health-check.sh
├── scripts/init-project.js
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
- `plugins/agentbridge/scripts/init-project.js`

## Local Testing

1. Build the plugin bundles: `bun run build:plugin`
2. In Claude Code, load the plugin from this repo or install it from the marketplace manifest in `.claude-plugin/marketplace.json`
3. Reload plugins in the active session with `/reload-plugins`

## Notes

- The plugin frontend launches the sibling daemon bundle via `AGENTBRIDGE_DAEMON_ENTRY=./daemon.js`.
- The SessionStart hook is informational only. It never starts or stops the daemon.
- The command at `/agentbridge:init` runs the bundled `init-project.js` helper, which uses ConfigService to initialize project-local `.agentbridge/` files. Plugin installation remains the job of terminal `agentbridge init`.
