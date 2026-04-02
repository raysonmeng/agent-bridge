# PR #57 — E2E Test Plan

## fix: stop infinite reconnect storm + approval lifecycle reliability

### Test 1: Close Code 4001 — 多会话 dormant

**目的：** 验证第二个 Claude Code 会话连接后，第一个会话优雅进入永久 dormant，不会无限重连。

1. 终端 A：`agentbridge claude` 启动第一个 Claude Code 会话
2. 终端 B：`agentbridge codex` 启动 Codex TUI
3. 确认终端 A 收到 `✅ AgentBridge bridge is ready` 和 Codex 连接通知
4. **终端 C：`agentbridge claude` 启动第二个 Claude Code 会话**
5. 验证：
   - 终端 A 应收到 `⚠️ Another Claude Code session connected to AgentBridge and replaced this one. This session is now permanently idle.`
   - 终端 A **不应**出现持续的重连日志（无 reconnect 循环）
   - 终端 C 正常工作，能和 Codex 通信
6. 关闭终端 C 的 Claude Code
7. 验证终端 A **仍然保持 dormant**（不自动恢复），这是预期行为

**通过标准：** 旧会话收到 replaced 通知后完全静默，无重连尝试，新会话正常工作。

### Test 2: TUI 断连后审批请求重放

**目的：** 验证 TUI 断连重连后，pending 的审批请求被正确重放。

1. `agentbridge claude` + `agentbridge codex`
2. 在 Claude 中给 Codex 发一个需要审批的任务（比如修改文件）
3. 当 Codex 弹出审批请求（permission prompt）时，**不要点审批**
4. `Ctrl+C` 杀掉 Codex TUI
5. 重新运行 `agentbridge codex`
6. 验证：审批请求应该被**重新弹出**，点击审批后 Codex 继续执行

**通过标准：** 审批请求在 TUI 重连后正确重放，用户审批后 Codex 正常继续。

### Test 3: app-server 断连后审批状态清理

**目的：** 验证 app-server 断连后，旧的审批状态被正确清理，不会 flush 到新连接。

此场景较难手动复现（需要精确时序），主要靠单元测试覆盖。可观察：
1. 正常使用过程中，`/tmp/agentbridge.log` 中**不应出现** `Flushed buffered approval response after app-server reconnect` 的日志
2. 如果出现 `App-server connection closed` 日志，紧跟其后应有 approval 状态清理记录

**通过标准：** 单元测试 `"app-server close discards approval state across reconnects"` 通过。

### Test 4: `agentbridge kill` → 恢复

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
