# AgentBridge Plugin

Claude Code plugin for AgentBridge. This plugin packages the AgentBridge MCP frontend with acknowledged Channel delivery, the `/agentbridge:init` command, and a non-blocking SessionStart health check. Every admissible message is queued before push, receives an immutable delivery-generation ID, and remains available through `get_messages` until Claude confirms that ID with `ack_messages` (a message exceeding the mailbox size bound is not retained — it is delivered best-effort only and omitted with an observable warning).

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
- Claude delivery uses Channel push as a latency optimization over a bounded in-memory mailbox. `get_messages` repeats unacknowledged stable IDs without deleting them; `ack_messages` removes only IDs Claude has finished processing. Ordinary unacknowledged pushes retry twice by default with exponential backoff. The legacy `AGENTBRIDGE_MODE=pull` value remains ignored with a one-time warning.
- Mailbox state is not persisted. A Claude adapter/plugin process restart loses it, and Channel cannot guarantee that a fully idle Claude session wakes automatically. Delivery is at least once while the adapter is alive, not exactly once or crash durable.
- The SessionStart hook is informational only. It never starts or stops the daemon.
- The command at `/agentbridge:init` edits project-local `.agentbridge/` files only; plugin installation and marketplace registration remain terminal-side tasks (`agentbridge init` / `agentbridge dev`).
