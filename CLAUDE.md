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
