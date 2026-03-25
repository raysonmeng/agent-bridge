---
description: Create or update the AgentBridge project config files in the current workspace
allowed-tools: Bash
---

Bootstrap or update AgentBridge's project-local configuration in this workspace.

Follow these rules:

1. Do not install plugins or modify `.claude/settings.json` here. Terminal `agentbridge init` handles plugin installation and marketplace setup.
2. Do not hand-write `.agentbridge/config.json` or `.agentbridge/collaboration.md` in this command. Use the bundled bootstrap script so ConfigService remains the single source of truth.
3. The bootstrap script checks prerequisites (`bun`, `codex`) and initializes defaults through ConfigService.
4. Existing project config files must be preserved. If they already exist, report that they were left unchanged.

Execute exactly this command with the Bash tool:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/init-project.js" "${CLAUDE_PROJECT_DIR:-$PWD}"
```

Then:

1. Parse the JSON output from the script.
2. Tell the user which prerequisites were confirmed.
3. Tell the user whether `.agentbridge/config.json` and `.agentbridge/collaboration.md` were created or already existed.
4. End with concise next steps:
   - Edit `.agentbridge/config.json` to customize roles and bridge behavior.
   - Edit `.agentbridge/collaboration.md` to add project-specific collaboration rules.
   - Use `agentbridge claude` and `agentbridge codex` from the terminal when they want to start the bridge runtime.
