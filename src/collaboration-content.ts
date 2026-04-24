/**
 * Collaboration section content for CLAUDE.md and AGENTS.md.
 *
 * These are injected by `abg init` into project-level instruction files
 * so that agents auto-discover the multi-agent collaboration setup.
 *
 * Content must be generic (not project-specific) and under ~30 lines each.
 * Tool usage details are already covered by MCP server instructions —
 * these sections focus on *when* and *why* to collaborate.
 */

export const MARKER_ID = "AgentBridge";

export const CLAUDE_MD_SECTION = `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → Codex**: Use the AgentBridge MCP tools (\`reply\` / \`get_messages\`) — these are yours only.
- **Codex → Claude**: Codex has no symmetric tool. The bridge transparently intercepts Codex's normal output and forwards it to you. Messages arrive as push notifications (or via \`get_messages\` in pull mode).
- If Codex ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities you lack (e.g., sandboxed code execution, independent verification).
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Codex rather than doing everything yourself.

### Capability comparison
| Capability | Claude (you) | Codex |
|---|---|---|
| Architecture & planning | Strong | Moderate |
| Code review & analysis | Strong | Strong |
| Sandboxed code execution | No | Yes |
| File editing & refactoring | Yes (via tools) | Yes (via sandbox) |
| Web search & docs | Yes | Limited |
| Independent verification | Cross-review | Reproduce & test |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** to Codex via the reply tool.
2. State what you'll handle and what you'd like Codex to take on.
3. Ask for Codex's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;

export const AGENTS_MD_SECTION = `\
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Claude, by Anthropic) is available in a parallel session on this machine.

### Communication mechanism (read this first)
AgentBridge is a **transparent proxy** on your side. You do **not** have a tool to "send a message to Claude".

- **Codex → Claude**: Just write your normal response. The bridge intercepts your \`agentMessage\` output and forwards it to Claude automatically. No tool call needed.
- **Claude → Codex**: Claude uses its own MCP tools (\`reply\` / \`get_messages\`). Those messages arrive in your session as new user turns — you'll see them like any other user input.

**Do not** search the AgentBridge source for a Codex-side "send" / "reply" / "sendToClaude" API — it does not exist, and looking for it wastes turns. If you catch yourself thinking "I need to find how to message Claude", stop and just write your reply as normal text.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities the other agent has.
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Claude rather than doing everything yourself.

### Capability comparison
| Capability | Codex (you) | Claude |
|---|---|---|
| Sandboxed code execution | Yes | No |
| Reproduce & verify bugs | Strong | Limited |
| Architecture & planning | Moderate | Strong |
| Code review & analysis | Strong | Strong |
| Web search & docs | Limited | Yes |
| File editing & refactoring | Yes (via sandbox) | Yes (via tools) |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** in your response (Claude will receive it).
2. State what you'll handle and what you'd like Claude to take on.
3. Ask for Claude's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.`;
