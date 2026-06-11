# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语言 / Language

- **🔴 铁律：面向用户的叙述只可以用中文，禁止用英文。**（用户多次强调，2026-06-11 再次明确"禁止说英文！！只可以说中文！"）。聊天回复、状态汇报、表格标题、列表、解释、报告里的叙述文字——一律中文。**唯一例外**：代码、命令、文件路径、标识符、API 名、配置键、PR/commit 里既有的英文约定段落可保留原文（因为它们就是字面量）。除此之外任何句子都不许用英文。每次回复前自检：有没有冒出英文叙述句？有就改成中文。
- **强制使用中文回复**（用户明确要求 / 强制项目级规则）。所有面向用户的输出（解释、报告、问答、plan、commit message 中的中文部分、issue / report）使用中文。
- 代码内的注释、变量名、提交信息中的英文部分、日志保持英文（与项目既有约定一致）。
- 涉及给用户读的内容（README、用户文档、终端说明）必须中文优先。
- 若用户用英文提问，仍**用中文回复**（除非他明确要求英文）。

## Commands

Runtime is **Bun** — do not change the local Bun version.

| Task | Command |
|------|---------|
| Install deps | `bun install` |
| Type check | `bun run typecheck` (= `tsc --noEmit`) |
| Run all tests | `bun test src` |
| Run a single test file | `bun test src/unit-test/<name>.test.ts` |
| Run a single test by name | `bun test src -t "<test name pattern>"` |
| Full pre-commit check | `bun run check` (typecheck + tests + plugin sync + plugin versions) |
| Build CLI binary | `bun run build:cli` → `dist/cli.js` |
| Build plugin bundle | `bun run build:plugin` → `plugins/agentbridge/server/{bridge-server,daemon}.js` |
| Verify plugin sync | `bun run verify:plugin-sync` |
| Validate plugin manifest | `bun run validate:plugin` (requires `claude` CLI) |
| Local dev link | `bun link` then `agentbridge dev` (registers local marketplace + installs plugin; repo checkout only) |
| Update global CLI + plugin | `bun run install:global` (one command: rebuild, replace global install, sync plugin; `--skip-plugin` to opt out) |
| Start session | `agentbridge claude` (one terminal) + `agentbridge codex` (another) |
| Show quota snapshot | `agentbridge budget [--json]` (both agents' 5h/weekly usage, drift, pause state) |
| Stop everything | `agentbridge kill` |

**Before committing**: run `bun run typecheck && bun test src`.

**After modifying `src/`**: run `bun run build:plugin` before end-to-end testing. The installed plugin loads the bundled JS under `plugins/agentbridge/server/`, not the raw TS — forgetting to rebuild means you are testing the old code.

## Architecture

AgentBridge is a **two-process** local bridge between Claude Code and Codex.

```
Claude Code ── MCP stdio ──▶ bridge.ts (foreground)
                                 │ control WS :4502
                                 ▼
                             daemon.ts (persistent background)
                                 │ ws proxy :4501
                                 ▼
                             Codex app-server :4500
```

- **`src/bridge.ts`** — foreground MCP server registered as a Claude Code plugin channel. Exits when Claude Code closes.
- **`src/daemon.ts`** — long-lived background process; owns the Codex app-server proxy and the single source of truth for bridge state. Survives Claude Code restarts; `bridge.ts` reconnects with exponential backoff.
- **`src/control-protocol.ts`** — message schema for the control WebSocket between foreground and daemon.
- **`src/claude-adapter.ts`** — MCP tool surface exposed to Claude (`reply`, `get_messages`). Emits `notifications/claude/channel` on inbound messages (push mode).
- **`src/codex-adapter.ts`** — WebSocket proxy in front of Codex app-server; intercepts `agentMessage` items and injects turns via `turn/start`.
- **`src/message-filter.ts`** — collapses noisy intermediate events so only meaningful `agentMessage` payloads reach Claude.
- **`src/daemon-lifecycle.ts`** — shared `ensureRunning` / `kill` / startup-lock logic; both the CLI and `bridge.ts` call into this.
- **`src/daemon-client.ts`** — typed WS client used by `bridge.ts` to talk to the daemon control port.
- **`src/config-service.ts`** + **`src/state-dir.ts`** — read/write `.agentbridge/config.json` and resolve the platform state dir (`daemon.pid`, `status.json`, `agentbridge.log`, `killed` sentinel, `startup.lock`).
- **`src/cli.ts` + `src/cli/*.ts`** — `abg` / `agentbridge` command router (`init`, `claude`, `codex`, `pairs`, `doctor`, `budget`, `kill`, `dev`).
- **`src/marker-section.ts` + `src/collaboration-content.ts`** — idempotent marker-based injection of the `<!-- AgentBridge:start/end -->` block into `CLAUDE.md` and `AGENTS.md` during `abg init`. (Other agent config files — GEMINI.md / .cursorrules / .kiro etc. — are NOT injected today; backlog, not shipped behavior.)
- **`src/bridge-disabled-state.ts` + `src/tui-connection-state.ts`** — disabled-reason and TUI-connect state machines used by the kickoff + reconnect UX.

### Data flow invariants

- Every `BridgeMessage` carries a `source: "claude" | "codex"` — the bridge **never forwards a message back to its origin** (loop prevention).
- Message delivery is always push (channel notifications). A failed push falls back to an in-memory queue drained by `get_messages`. (The legacy `AGENTBRIDGE_MODE=pull` mode was removed; the env var is ignored with a one-time warning.)
- Ports are allocated per pair from a registry (slot-based, +10 strides from the base 4500/4501/4502); the legacy fixed defaults remain the slot-0 values. Multiple pairs run side-by-side, one per project directory.
- All state lives in the platform state dir (`AGENTBRIDGE_STATE_DIR`, default `~/Library/Application Support/AgentBridge/` on macOS, `$XDG_STATE_HOME/agentbridge/` on Linux). The daemon uses `startup.lock` + `killed` sentinel to coordinate startup and explicit-kill-don't-restart semantics.

### Tests

- Tests are split by process boundary: pure-logic **unit tests** in `src/unit-test/*.test.ts` (fast, `bun run test:unit`), and spawn-real-process **integration tests** in `src/integration-test/*.test.ts` (slow, `bun run test:integration`). `bun test src` (and the `check` gate / CI) runs the full suite recursively.
- Unit tests: one file per module, e.g. `daemon-lifecycle.test.ts`, `codex-adapter.test.ts`, `marker-section.test.ts`.
- CLI integration: `src/integration-test/e2e-cli.test.ts` + `src/unit-test/cli.test.ts`.
- Reconnect E2E: `src/integration-test/e2e-reconnect.test.ts`. Manual E2E test plans live in `docs/test-plans/`.
- `message-delivery.test.ts` covers push delivery and the fallback queue.
- Every PR must ship both unit tests and an E2E test plan before merge.

## Git Workflow

- **永远不要直接推送到 master 分支！** 所有改动必须通过 feature/fix 分支 + PR 合并。
- 分支命名：`feat/xxx`（功能）、`fix/xxx`（修复）、`docs/xxx`（文档）。
- PR 必须交叉 review：Claude 写的由 Codex review，Codex 写的由 Claude review。
- 合并使用 squash merge。
- 提交信息与 release note **双语**（中文 + English）。

## Codex 协作

- Codex sandbox 禁止写 `.git` —— 所有 git 操作（commit/push/PR）由 Claude 代劳。
- Codex 在主目录 `/Users/raysonmeng/agent_bridge` 工作，Claude 使用 worktree（`/Users/raysonmeng/agent_bridge_wt_<PR号>`）。
- 不要在 Codex active turn 期间发 `reply` —— busy guard 会拒绝。看到 `⏳ Codex is working` 时等 `✅ Codex finished` 再回复。
- Codex TUI 的 resume 有已知 bug（GitHub #14470、#12382），建议开新会话。
- 连接 Codex TUI 用 `agentbridge codex`（通过 `bun link` 安装）。
- **测试 PR 时必须切到该 PR 对应的分支/worktree** — 不要在别的分支上测。

## 进度跟踪

- `V1_PROGRESS.md`（本地文件，不提交到 git）记录 v1 任务进度；每完成一个功能更新 Status 和 Progress Timeline。

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
