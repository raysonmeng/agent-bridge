/**
 * Collaboration section content for CLAUDE.md and AGENTS.md.
 *
 * These are injected by `abg init` into project-level instruction files
 * so that agents auto-discover the multi-agent collaboration setup.
 *
 * Content must be generic (not project-specific). The collaboration intro is
 * kept short; the shared BUDGET_PACING governance block below is longer by
 * design (it encodes the quota-pacing policy both agents follow). Tool usage
 * details are otherwise covered by MCP server instructions — these sections
 * focus on *when* and *why* to collaborate.
 */

export const MARKER_ID = "AgentBridge";

/**
 * Shared budget-pacing governance block, injected verbatim into BOTH CLAUDE.md
 * and AGENTS.md so Claude and Codex follow ONE identical policy. Code enforces
 * only the hard floor (the near-limit pause/handoff gate) and edge cases; this
 * block delegates the live "raise / hold / reduce intensity" decision to the
 * model, driven by the probe data.
 */
export const BUDGET_PACING = `\
### Budget pacing — drive the WEEKLY quota to ~100% over the week, evenly, without reaching a 5h cap (active when agent-quota-guard is installed)
- **Core principle: token is the means, value is the end.** Raising intensity means producing more real parallel value (deeper reviews, more independent exploration / verification / genuine subtasks) — never manufacturing low-value work to consume quota. The budget to MAXIMIZE is the **weekly** quota (refreshed once a week): drive each side's weekly toward ~100% by its weekly reset, and consume it **evenly** across the week — front-loading then starving, or under-consuming throughout, both leave weekly quota unredeemed (forfeited). The **5h window is NOT a quota bucket to fill — it is a RATE CAP**: stay under it within any 5h period; reaching it = a forced pause until the 5h resets = wasted time, not progress.
- **Re-query your budget before EVERY allocation decision** — Claude: \`get_budget\` → **rendered text** covering both sides; Codex: \`check_budget\` with \`agent:"claude"|"codex"\` → **normalized JSON**, per side. (Two different shapes — read the right one below.) Never reuse remembered numbers: a weekly window can refresh EARLY (resetting both 5h and weekly), fully restoring a side you believed was exhausted.
- **Even-pacing test (per side — Claude runs it)** — compare two quantities: *budget-windows* = how many 5h windows the weekly quota still covers at the current burn rate; *clock-windows* = how many 5h windows physically fit before the weekly reset = (weekly reset − now) ÷ 5h. **Claude** (\`get_budget\` text) carries BOTH, pre-computed for BOTH sides: the lines "按当前节奏，周额度还够 … 个 5h 窗口" (budget-windows) and "距周刷新还能容纳 … 个 5h 窗口（时钟）" (clock-windows). **Codex** (\`check_budget\` JSON) today carries only per-bucket \`util\` / \`reset_epoch\` / \`reset_after_seconds\` — no burn rate, no \`five_hour_windows_left\` — so Codex CANNOT compute budget-windows itself; it reads its weekly \`util\` and clock-windows only. To locate Codex's weekly bucket: of the \`buckets[]\` entries whose \`id\` contains \`seven_day\` or \`secondary_window\` (there can be several — e.g. a model-specific \`additional_rate_limits[…]\` one at 0%), take the HIGHEST-util one (the binding account-level window, matching how the bridge parses it); its clock-windows = \`reset_after_seconds\` ÷ 5h (never the top-level \`reset_epoch\`, which tracks the current limiter, not necessarily the weekly window). For the budget-windows half and the raise/hold/reduce verdict, Codex relies on Claude's \`get_budget\` (the burn projection lives there, for both sides) and reports its own weekly \`util\` + reset timing so Claude can run the test. (If a future \`check_budget\` exposes \`five_hour_windows_left\` on the weekly bucket, Codex reads it directly.) **The verdict (Claude computes it, per side):** budget > clock → **under-consuming** (weekly will be left unused) → **raise intensity**; budget < clock → **over-consuming** (won't last to the weekly reset) → **reduce intensity**; within ~1 window, or no confident rate → **hold**. **Codex, absent a fresh Claude verdict, holds at its current intensity (it never escalates unilaterally) and stays clear of the 5h cap — surfacing its weekly \`util\` + reset timing so Claude can issue the verdict.**
- **Raise intensity — use the levers your role has.** Orchestrator (Claude): pick larger, more-decomposable tasks; run more parallel subagents at once (3–5+ vs 1); raise delegation density; open more concurrent streams (review + explore + verify in parallel). Executor (Codex): go deeper in-turn, take larger chunks, run more verification/repro. Both: deepen quality (multi-angle review, broader test/repro) — never manufacture make-work. **Reduce intensity:** fewer/serial subagents (Claude), short bounded chunks, defer optional deep work. Stay below the **动态暂停线** (shown in \`get_budget\`; its \`余量\` = headroom from your current util to that soft line, measured on the resettable hard-winner window — the 5h OR the weekly window, whichever currently limits you) — that soft ceiling, not the raw 5h cap, is the "do not cross, avoid a forced pause" line. **If that line is absent, or you only have JSON (Codex),** fall back to the 5h bucket's raw util vs 100% (Codex: of the \`buckets[]\` entries whose \`id\` contains \`five_hour\` or \`primary_window\`, take the HIGHEST-util one) and keep clear of the 5h cap.
- **Distinguish 5h from weekly:** a 5h window resetting does NOT consume or waste weekly budget — it only refreshes your rate headroom, so you can keep going when weekly is under-consumed. A near 5h reset is therefore not urgency but the release of a rate limit. The real "unused = forfeited" is the **weekly budget as its WEEKLY reset nears**: if weekly is still under-consumed then, raise intensity (within the 5h cap) to use it. If even pacing needs a rate beyond one 5h window's capacity, you are rate-limited → keep each 5h window as full as possible (under the cap).
- **Two-subscription imbalance — the quotas are INDEPENDENT and differ in BOTH amount AND reset timing** (each side's weekly and 5h windows reset on different clocks). **The cross-side split is the orchestrator's (Claude) decision:** route more work to the side that is MORE under-consuming on the even-pacing test (the larger budget-windows − clock-windows gap); when EITHER side lacks a confident rate (so the gap can't be compared), fall back to the more budget-rich side (larger absolute weekly headroom). On any tie (equal gap, or equal headroom), prefer the side whose **weekly resets SOONER** (its leftover is forfeited earlier). **As the executor (Codex) you do NOT decide the global split** — execute what you're assigned, and when your own budget is rich report it (with evidence) so Claude routes more to you. The tighter / over-consuming side carries less.
- **Side-aware pause (the hard floor the code enforces — obey, do not reinvent), with each side's own action:** **Codex exhausted** (\`system_budget_pause\`) → Codex's turns stop (gate closed); **Claude** must not retry replies and continues solo on independent work, checkpointing the split point — but the SAME \`system_budget_pause\` is ALSO emitted when both sides are exhausted, so do not infer "solo" from the directive name alone: read its content (it names the paused side[s]) or re-check \`get_budget\`, and continue solo ONLY while Claude's own side is healthy; if Claude is also at its line, handle it as **Both** below. **Claude exhausted** (\`system_budget_handoff\`) → **Claude** sends ONE handoff (remaining tasks / context / artifact locations / acceptance criteria) then stops; **Codex** receives the baton and carries the work forward as far as its remaining quota allows that turn. **Both** → joint pause; checkpoint and wait for \`resume\` (Claude's own quota-guard also hard-stops Claude independently). A transient probe **429 is NOT exhaustion** → fall back to cached util and keep working.`;

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

${BUDGET_PACING}`;

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

${BUDGET_PACING}`;
