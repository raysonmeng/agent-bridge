# PR #57 — E2E Test Plan

## fix: single-session admission + approval lifecycle reliability

### Test 1: 单会话保护 — 新连接被拒绝

**目的：** 验证第二个 Claude Code 会话连接时被拒绝，第一个会话不受影响。

1. 终端 A：`agentbridge claude` 启动第一个 Claude Code 会话
2. 终端 B：`agentbridge codex` 启动 Codex TUI
3. 确认终端 A 收到 `✅ AgentBridge bridge is ready` 和 Codex 连接通知
4. **终端 C：`agentbridge claude` 启动第二个 Claude Code 会话**
5. 验证：
   - 终端 C（新会话）应收到 `⚠️ AgentBridge daemon rejected this session — another Claude Code session is already connected.`
   - 终端 A（旧会话）**不受任何影响**，继续正常工作
   - 终端 A 能正常和 Codex 通信
6. 关闭终端 C
7. 终端 A 仍然正常工作

**通过标准：** 旧会话完全不受影响，新会话被拒绝并收到明确错误消息。

### Test 2: 旧会话断开后新会话可连入

**目的：** 验证第一个 Claude 正常关闭后，新的 Claude 可以成功连入。

1. 终端 A：`agentbridge claude` 启动第一个 Claude Code 会话
2. 确认连接正常
3. 关闭终端 A 的 Claude Code（Ctrl+C 或 /exit）
4. 终端 B：`agentbridge claude` 启动新的 Claude Code 会话
5. 验证：终端 B 成功连入，收到 `✅ AgentBridge bridge is ready`

**通过标准：** 旧会话释放 slot 后，新会话正常连入。

### Test 3: TUI 断连后审批请求重放

**目的：** 验证 TUI 断连重连后，pending 的审批请求被正确重放。

1. `agentbridge claude` + `agentbridge codex`
2. 在 Claude 中给 Codex 发一个需要审批的任务（比如修改文件）
3. 当 Codex 弹出审批请求（permission prompt）时，**不要点审批**
4. `Ctrl+C` 杀掉 Codex TUI
5. 重新运行 `agentbridge codex`
6. 验证：审批请求应该被**重新弹出**，点击审批后 Codex 继续执行

**通过标准：** 审批请求在 TUI 重连后正确重放，用户审批后 Codex 正常继续。

### Test 4: app-server 断连后审批状态清理

**目的：** 验证 app-server 断连后，旧的审批状态被正确清理，不会 flush 到新连接。

此场景较难手动复现（需要精确时序），主要靠单元测试覆盖。可观察：
1. 正常使用过程中，`/tmp/agentbridge.log` 中**不应出现** `Flushed buffered approval response after app-server reconnect` 的日志
2. 如果出现 `App-server connection closed` 日志，紧跟其后应有 approval 状态清理记录

**通过标准：** 单元测试 `"app-server close discards approval state across reconnects"` 通过。

### Test 5: `agentbridge kill` → 恢复

**目的：** 验证 killed 状态下的错误消息和恢复机制。

1. `agentbridge claude` + `agentbridge codex`
2. `agentbridge kill`
3. 尝试在 Claude 中给 Codex 发消息
4. 验证：应收到 `AgentBridge is disabled by agentbridge kill` 错误
5. 重新运行 `agentbridge claude`，验证可以正常恢复

**通过标准：** kill 后错误消息正确，重启后恢复正常。

### Related

- PR: https://github.com/raysonmeng/agent-bridge/pull/57
- Issues: #55 (Phase 1), #39, #58
- Unit tests: `src/unit-test/daemon-client.test.ts`, `src/unit-test/codex-adapter.test.ts`, `src/unit-test/bridge-disabled-state.test.ts`
