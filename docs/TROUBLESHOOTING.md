# Troubleshooting / 排错

Common failure modes and how to recover. See also the [README](../README.md) / [中文 README](../README.zh-CN.md).

---

## English

### `abg` installed but the command won't run

Almost always: **Bun is not installed.** AgentBridge's daemon and plugin server run on Bun — Node.js alone is not enough. Install it and retry:

```bash
curl -fsSL https://bun.sh/install | bash
# restart your terminal, then:
abg init
```

Bun **v1.3.11 or newer** is required (matches `engines.bun` in `package.json`). Check with `bun --version`; if it is older, upgrade with `bun upgrade`.

### Plugin didn't register during `npm install`

The `postinstall` step (register marketplace + install the plugin) is best-effort and is skipped if Bun or Claude Code isn't on `PATH` yet. After installing the missing dependency, run `abg init` to retry, or do the [manual plugin install](../README.md#manual-plugin-install-fallback) from inside Claude Code.

### Disabled bridge states

The bridge can enter several dormant states when it cannot accept new MCP replies. Each surfaces to the agent as an error message (and, for the transient ones, an in-band push notification):

| State | Cause | Recovery |
|-------|-------|----------|
| `killed` | `agentbridge kill` was run, sentinel file present. | Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume`. |
| `rejected` | Daemon rejected the connection: another Claude session is already attached. | Close the other session, or run `agentbridge kill` to reset, then `agentbridge claude` again. |
| `evicted` | A newer session evicted this one after the incumbent failed a liveness probe (issue #68). | Close this session and start a fresh one with `agentbridge claude`. |
| `probe_in_progress` | A liveness probe is currently checking the incumbent — contention window. Transient (auto-recovers within `DISABLED_RECOVERY_INTERVAL_MS` × cap, ~30 s). | None needed; the recovery poller reconnects automatically when the slot clears. |
| `auto_recovery_exhausted` | The auto-recovery poller for `probe_in_progress` ran its full retry budget (6 attempts, ~30 s) without succeeding. Terminal. | Retry manually with `agentbridge claude`. |

### Codex hangs on any git command (`.git` restriction)

Codex runs in a sandboxed environment that **blocks all writes to the `.git` directory**. `git commit`, `git push`, `git pull`, `git checkout -b`, `git merge` — anything that modifies git metadata — will cause the Codex session to **hang indefinitely**.

**Fix / workflow:** let Claude Code handle all git operations (branching, committing, pushing, PRs). Codex should focus on code changes and report completed work via `agentMessage`, then Claude does the git workflow.

### More diagnostics

`abg doctor` (add `--json` for machine output) is a read-only check of env, daemon health/readiness, build drift, artifact alignment, TUI attachment, and logs — start there when something is off.

---

## 中文

### `abg` 装上了却跑不起来

几乎总是：**没装 Bun。** AgentBridge 的 daemon 和插件服务器跑在 Bun 上,仅有 Node.js 不够。装上再试：

```bash
curl -fsSL https://bun.sh/install | bash
# 重启终端,然后：
abg init
```

要求 Bun **v1.3.11 或更新**（与 `package.json` 的 `engines.bun` 一致）。用 `bun --version` 查看；偏旧就 `bun upgrade`。

### `npm install` 时插件没注册上

`postinstall`（注册市场 + 装插件）是 best-effort 的,当 Bun 或 Claude Code 还不在 `PATH` 上时会跳过。装好缺的依赖后运行 `abg init` 重试,或在 Claude Code 里[手动装插件](../README.zh-CN.md#手动安装插件兜底)。

### Bridge 禁用状态

Bridge 在无法接受新 MCP 回复时会进入若干休眠状态。每种都会以错误信息返回给 agent；瞬态状态还会推一条带内通知：

| 状态 | 原因 | 恢复方式 |
|------|------|---------|
| `killed` | 运行过 `agentbridge kill`，存在 sentinel 文件。 | 重启 Claude Code（`agentbridge claude`），切换到新会话，或运行 `/resume`。 |
| `rejected` | daemon 拒绝连接：已有另一个 Claude 会话连接中。 | 先关闭另一个会话，或运行 `agentbridge kill` 重置，然后重新 `agentbridge claude`。 |
| `evicted` | 在位会话未响应存活探测，被更新的会话驱逐（issue #68）。 | 关闭本会话，用 `agentbridge claude` 重新启动一个。 |
| `probe_in_progress` | 当前正在对在位会话执行存活探测——争用窗口期。瞬态（约 30 秒内自动恢复）。 | 无需操作；恢复轮询会在槽位释放后自动重连。 |
| `auto_recovery_exhausted` | `probe_in_progress` 的自动恢复轮询用尽重试预算（6 次，约 30 秒）仍未成功。终态。 | 手动用 `agentbridge claude` 重试。 |

### Codex 一碰 git 就挂死（`.git` 限制）

Codex 运行在沙箱里,**禁止对 `.git` 目录的任何写操作**。`git commit`、`git push`、`git pull`、`git checkout -b`、`git merge` 等任何修改 git 元数据的命令都会让 Codex 会话**无限期挂起**。

**修法 / 工作流：** 让 Claude Code 负责所有 git 操作（分支、提交、推送、PR）。Codex 专注代码修改,通过 `agentMessage` 汇报完成的工作,由 Claude 走 git 流程。

### 更多诊断

`abg doctor`（加 `--json` 输出机器可读）是对环境、daemon 健康/就绪、构建漂移、产物对齐、TUI 连接、日志的只读检查——出问题先看它。
