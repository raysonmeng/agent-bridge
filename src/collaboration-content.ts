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
- **Codex → Claude**: Codex has no symmetric tool. The bridge transparently intercepts Codex's normal output and forwards it to you as push notifications (if a push fails, drain the fallback queue with \`get_messages\`).
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
4. After task completion, **cross-review** each other's work.

### Budget awareness (active when agent-quota-guard is installed)
- Goal: **keep the task moving while fully using the subscription quota**. The bridge polls both agents' account-level 5h/weekly windows and may send \`system_budget_*\` notices: **balance** (route more work to the lighter side), **parallel** (quota surplus near the 5h reset — split more parallel subtasks), **pause/handoff/resume**.
- \`get_budget\` shows BOTH sides' quota — re-check it **before every task-allocation decision**. NEVER rely on quota numbers remembered from earlier in the conversation: the weekly window can refresh EARLY (resetting both 5h and weekly), so a side you remember as nearly exhausted may be fully restored.
- Side-aware pause semantics:
  - **Codex exhausted** (\`system_budget_pause\`): the reply gate closes. Do not retry replies; continue solo on independent work, note the split point in a checkpoint.
  - **You (Claude) exhausted** (\`system_budget_handoff\`): the gate stays OPEN — immediately send ONE handoff reply to Codex packaging the remaining task list, context, artifact locations and acceptance criteria, then stop working (your own quota-guard will hard-stop you at 92%). Codex relays the baton.
  - **Both exhausted**: joint pause; checkpoint and wait for the resume notice.
- Save quota with model tiers: route mechanical subagent work to **haiku**, routine work to **sonnet**, reserve **opus** for architecture decisions; when your side is the heavier consumer, delegate more to Codex.`;

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
4. After task completion, **cross-review** each other's work.

### Message markers
Put a marker at the **very start** of each \`agentMessage\` (it must be the first text — e.g. \`[IMPORTANT] Task done\`, not \`Task done [IMPORTANT]\`):
- \`[IMPORTANT]\` — decisions, reviews, completions, blockers
- \`[STATUS]\` — progress updates
- \`[FYI]\` — background context

Keep \`agentMessage\` for high-value communication only.

### Git operations — FORBIDDEN for you
You MUST NOT run git **write** commands: \`commit\`, \`push\`, \`pull\`, \`fetch\`, \`checkout -b\`, \`branch\`, \`merge\`, \`rebase\`, \`cherry-pick\`, \`tag\`, \`stash\`. They write the \`.git\` directory (blocked by your sandbox) and will hang your session. Read-only git (\`status\`, \`log\`, \`diff\`, \`show\`, \`rev-parse\`) is fine. Delegate **all** git writes to Claude: report what you changed and let Claude handle branching, committing, and pushing.

### Role guidance
- Your default role: **Implementer, Executor, Verifier**.
- Analytical / review tasks: **Independent Analysis & Convergence**.
- Implementation tasks: **Architect → Builder → Critic**.
- Debugging tasks: **Hypothesis → Experiment → Interpretation**.
- Do not blindly follow Claude — challenge with evidence when you disagree.
- Use explicit collaboration phrases: "My independent view is:", "I agree on:", "I disagree on:", "Current consensus:".

### Budget awareness (active when agent-quota-guard is installed)
- Goal: **keep the task moving while fully using the subscription quota**. You can check BOTH sides' quota yourself via your quota-guard MCP tool \`check_budget\` with \`agent: "claude"\` or \`"codex"\` — re-check **before negotiating task splits**, and NEVER rely on remembered numbers: the weekly window can refresh early (resetting both 5h and weekly windows).
- During a **budget pause** (your side exhausted) you simply stop receiving new turns — that IS the pause. Your own quota-guard hooks still apply; work resumes when Claude's next message arrives.
- **Handoff (Claude's side exhausted)**: you may receive a baton message packaging the remaining work. Push as far as possible within that single turn; write leftovers to a checkpoint file; do NOT expect Claude to respond until its quota refreshes.
- Claude may route more or less work to you based on quota drift — expected load balancing, not preference.
- When the user enabled tier control, the bridge may adjust your model/reasoning-effort via turn parameters under budget pressure; if asked to economize, prefer lower effort and concise outputs.`;
