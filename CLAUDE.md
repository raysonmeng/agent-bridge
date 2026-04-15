# AgentBridge — Project Rules

## Git Workflow

- **永远不要直接推送到 master 分支！** 所有改动必须通过 feature/fix 分支 + PR 合并。
- 分支命名：`feat/xxx`（功能）、`fix/xxx`（修复）、`docs/xxx`（文档）
- PR 必须交叉 review：Claude 写的 Codex review，Codex 写的 Claude review
- 合并使用 squash merge

## Codex 协作

- Codex 的 sandbox 禁止写 `.git` 目录 —— 所有 git 操作（commit/push/PR）由 Claude 代劳
- Codex 在主目录 `/Users/raysonmeng/agent_bridge` 工作，Claude 用 worktree
- 不要在 Codex active turn 期间发 reply —— busy guard 会拒绝
- Codex TUI 的 resume 功能有已知 bug（GitHub #14470、#12382），建议开新会话
- 连接 Codex TUI 使用 `agentbridge codex` 命令（通过 `bun link` 安装）
- **测试某个 PR 时，必须切换到该 PR 对应的分支/worktree 下工作和测试**，不要在其他分支上测试。worktree 路径通常为 `/Users/raysonmeng/agent_bridge_wt_<PR号>`

## 开发规范

- 运行时：Bun（不要修改本地 Bun 版本）
- 测试：`bun test src/` — 所有改动必须测试通过
- 类型检查：`bun run typecheck` — 必须通过
- 提交前必须跑 `bun run typecheck && bun test src/`
- 环境变量有默认值，不需要 .env 文件

## 进度跟踪

- `V1_PROGRESS.md`（本地文件，不提交到 git）记录 v1 任务进度
- 每完成一个功能更新 Status 和 Progress Timeline

<!-- AgentBridge:start -->
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

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
<!-- AgentBridge:end -->

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
