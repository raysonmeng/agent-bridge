# Codex 原生 skill 集成设计

> Status: draft
> Author: Claude (起稿) / 待 Codex review
> Date: 2026-04-24
> Motivation: 解决 Codex 侧不理解"AgentBridge 透明代理机制"导致反复钻牛角尖找不存在的 reply API 的问题。

## 1. 背景与问题

今天协作时发现一个具体失败模式:Codex 为了给 Claude 发消息,花 1+ 分钟在 `daemon.js` 里搜索 `reply` / `sendStatus` / `claudeOnline` 等函数,试图找到"Codex 侧发消息给 Claude 的对称 API"。

该 API **不存在**,这是 AgentBridge 的设计(codex-adapter 透明代理 agentMessage,Codex 只需正常输出即可)。但目前文档存在两个锅:

1. `src/collaboration-content.ts` 里注入到 `AGENTS.md` 的内容只写 Claude 视角("Claude has reply and get_messages tools"),没写 Codex 视角的"你不用找工具"。
2. 注入机制是**项目级**的 —— 每个项目都要跑 `abg init`,否则 Codex 完全没看到协作协议。即使项目级协议有,也会被淹没在几千字的项目 AGENTS.md 里。

## 2. 参考:superpowers 的做法

`~/repo/superpowers` 针对 Codex 的集成非常干净,值得抄:

```
~/.codex/superpowers/                        # git clone 的仓库
~/.agents/skills/superpowers                 # 符号链接 → ~/.codex/superpowers/skills/
```

Codex TUI 启动时会**自动扫描 `~/.agents/skills/`**,读每个子目录的 `SKILL.md` frontmatter(`name` + `description`),按需触发。关键特征:

- **入口 skill**:`using-superpowers/SKILL.md` 的 description 写成 "Use when starting ANY conversation" —— Codex 会话一开始就一定触发。
- **跨 harness 复用**:skill 正文使用 Claude 的工具名(`Task` / `Skill` / `TodoWrite`),另配 `references/codex-tools.md` 做映射表(`Task → spawn_agent`,`TodoWrite → update_plan` 等)。
- **安装极简**:`.codex/INSTALL.md` 只有 `git clone` + `ln -s` 两步,完全不改用户的 `AGENTS.md`。
- **更新免重装**:`git pull` 即生效(symlink 永远活的)。

## 3. 套到 AgentBridge 的设计

### 3.1 目录结构(新增)

```
plugins/agentbridge/
├── server/                         # 已有,不动
├── .claude-plugin/                 # 已有,不动
└── codex-skills/                   # 新增
    └── agentbridge-collab/
        ├── SKILL.md                # Codex 入口 skill
        └── references/
            ├── mechanism.md        # 透明代理机制详解
            └── troubleshooting.md  # 常见误解 + 排查
```

### 3.2 安装位置

```
~/.agentbridge/codex-skills/agentbridge-collab/   # abg dev / abg init 写入
~/.agents/skills/agentbridge-collab               # symlink → 上面
```

选 `~/.agentbridge/` 而不是 `~/.codex/agentbridge/`,因为:
- AgentBridge 本身跨 harness(Claude + Codex),放在 `~/.codex/` 下语义不对。
- `~/.agents/skills/` 是 Codex 认的,放哪里由 AgentBridge 自己定。

### 3.3 `SKILL.md` 内容纲要

```markdown
---
name: agentbridge-collab
description: Use when AgentBridge daemon is detected (check ~/Library/Application Support/AgentBridge/daemon.pid or http://127.0.0.1:4502/healthz) — governs how to collaborate with the Claude agent running in parallel. MUST be consulted before searching code for any "send-message-to-Claude" API.
---

# AgentBridge Collaboration Protocol (Codex 视角)

## 核心事实:Codex 侧无对称工具

AgentBridge 是**透明代理**。你不需要调用任何工具来给 Claude 发消息。

- 你正常输出回答 → codex-adapter 拦截你的 `agentMessage` 事件 → 自动转发到 Claude。
- Claude 回复你 → AgentBridge 用 `turn/start` 把内容注入你当前 thread,像用户发了新一轮 turn。

**不要**在 `daemon.js` / `bridge-server.js` / `codex-adapter.ts` 里搜索 "reply" / "sendStatus" / "send_to_claude" 之类的函数 —— 不存在。**唯一的工具调用发生在 Claude 侧**(`mcp__plugin_agentbridge_agentbridge__reply` 和 `get_messages`)。

## 怎么用

- 想给 Claude 发消息?**正常写回答就行**。
- 想知道 Claude 是否在线?看 `http://127.0.0.1:4502/healthz` 的 `tuiConnected` 字段。
- 看到 `⏳ Codex is working` 标志?别理,那是给 Claude 看的状态行。

## 红旗 / 钻牛角尖信号

如果你产生以下想法,**停**,你已经在钻牛角尖:
- "让我查一下 daemon.js 里 Codex 是怎么给 Claude 发消息的"
- "应该有个 sendMessageToClaude 函数我没找到"
- "bridge 好像坏了,我得去 fix 代码"

正确反应:直接写一段中文/英文文字作为你的回答,结束 turn。

## 更多

- 机制细节:`references/mechanism.md`
- 常见误解排查:`references/troubleshooting.md`
```

### 3.4 `references/mechanism.md` 内容纲要

- 画图说明 Claude ↔ AgentBridge ↔ Codex app-server 的数据流
- 两端分别承担的职责
- `agentMessage` 事件如何被拦截、`turn/start` 如何被注入
- `tuiConnected` / `bridgeReady` / `queuedMessageCount` 字段含义

### 3.5 `references/troubleshooting.md` 内容纲要

- Claude 好像没回我:
  - 检查 healthz `tuiConnected` 是 false → Claude 没上线,等待即可
  - `queuedMessageCount > 0` → 消息已排队,Claude 会话未 attach
- 我发的消息 Claude 收不到:
  - 确认 daemon 在跑(4502 端口)
  - 确认 bridge-server 在跑(Claude 侧)
  - **不要**试图改 bridge 代码
- "AgentBridge rejected this session":另一个 Claude 占着 bridge,跑 `agentbridge kill` 再重连

### 3.6 CLI 改造

`src/cli/init.ts` 和 `src/cli/dev.ts` 都要新增一步:

```typescript
async function installCodexSkill() {
  const srcDir = resolveFromPluginRoot("codex-skills/agentbridge-collab");
  const homeDir = process.env.HOME!;
  const stagingDir = path.join(homeDir, ".agentbridge/codex-skills/agentbridge-collab");
  const linkDir = path.join(homeDir, ".agents/skills/agentbridge-collab");

  // 1. 把 skill 内容复制到用户目录(避免 plugin 根目录被改动时污染)
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.cp(srcDir, stagingDir, { recursive: true });

  // 2. 创建符号链接(幂等)
  await fs.mkdir(path.dirname(linkDir), { recursive: true });
  try {
    await fs.symlink(stagingDir, linkDir, "dir");
  } catch (err) {
    if (err.code === "EEXIST") {
      const current = await fs.readlink(linkDir).catch(() => null);
      if (current !== stagingDir) {
        await fs.rm(linkDir, { recursive: true, force: true });
        await fs.symlink(stagingDir, linkDir, "dir");
      }
    } else throw err;
  }
}
```

`abg init` 运行结束后应该打印:
```
✓ Claude plugin installed
✓ Codex skill linked → ~/.agents/skills/agentbridge-collab
  (restart any running Codex TUI for it to take effect)
```

### 3.7 `abg kill` / `abg uninstall` 对应

`agentbridge kill` 不动 skill(只停 daemon)。新增一个 `agentbridge uninstall`(或给 `kill` 加 `--purge` flag):

```bash
agentbridge uninstall
# → 删除 ~/.agents/skills/agentbridge-collab symlink
# → 删除 ~/.agentbridge/codex-skills/
# → 停止 daemon,清 killed sentinel
```

## 4. 与现有 AGENTS.md 注入的关系

**保留注入,叠加 skill 方案。**

| 机制 | 角色 |
|---|---|
| `~/.agents/skills/agentbridge-collab` (新) | 主渠道。Codex 启动期自动触发,优先级最高,不被项目内容淹没。 |
| `AGENTS.md` 注入 (现有) | 兜底。给不支持 skill 发现的老版 Codex / 其他 agent / IDE 用。 |
| `CLAUDE.md` 注入 (现有) | 仍然保留。Claude 侧的协作约束继续通过项目文档表达。 |

`collaboration-content.ts` 里的 `AGENTS_MD_SECTION` 也要同步修正(补 "Codex 侧透明代理" 一段),这是本次必做的文档修复。

## 5. 非目标 / 后续项

- 本设计**不涉及** Codex MCP server 注册 —— 那是另一个方向(让 Codex 能调用 AgentBridge 暴露的 MCP 工具),可以作为 phase 2。
- 本设计**不解决**"同时多个 Claude 会话竞抢 bridge"的问题(今天遇到的 "rejected this session" 错误)。那个是锁管理问题,独立 issue。
- 跨平台(Windows)的 junction 支持按 superpowers 的模板补。

## 6. 验收标准

1. `abg init` 在一个干净机器上跑完后:
   - `ls -la ~/.agents/skills/agentbridge-collab` 是一条指向 `~/.agentbridge/codex-skills/agentbridge-collab` 的 symlink。
   - `cat ~/.agents/skills/agentbridge-collab/SKILL.md` 能看到完整内容。
2. 启动 Codex TUI,在没有任何项目级 AGENTS.md 的目录下问 "怎么给 Claude 发消息?" → Codex 应该直接回答"正常输出即可,透明代理",不再去翻源码。
3. 故意问 "daemon.js 里 Codex 侧的 sendMessage 函数在哪?" → Codex 应该识别这是红旗模式,拒绝搜索,解释为啥不存在。

## 7. 开工拆解

- [ ] **P1** 修 `collaboration-content.ts` 的 `AGENTS_MD_SECTION`,立即补"透明代理"段(当场解决今天的问题)
- [ ] **P1** 新建 `plugins/agentbridge/codex-skills/agentbridge-collab/SKILL.md`(+ references/)
- [ ] **P2** 改造 `src/cli/init.ts` 和 `src/cli/dev.ts`,增加 `installCodexSkill()`
- [ ] **P2** 对应单测(`src/unit-test/codex-skill-install.test.ts`)
- [ ] **P3** 新增 `agentbridge uninstall` 命令
- [ ] **P3** 更新 README + CLAUDE.md 描述新机制

---

**open questions**(请 review 时回复):
1. 放 `~/.agentbridge/` 还是 `~/.codex/agentbridge/`?我倾向前者,理由见 3.2。
2. `abg init` 在项目目录跑,还是 `abg dev` / 独立的 `abg setup` 做机器级安装?skill 是机器级的,和 per-project init 应该是不同 scope。
3. SKILL.md description 里要不要强硬到 "MUST be consulted before..." 这种程度?superpowers 用了类似措辞,效果不错,但也可能让 Codex 过度触发。
