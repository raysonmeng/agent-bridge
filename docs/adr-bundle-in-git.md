# ADR: Plugin server bundles are committed to git

Status: Accepted · 2026-07-03

## 中文

**背景。** `plugins/agentbridge/server/{bridge-server,daemon}.js` 是由 `bun run build:plugin`
从 `src/` 打包出来的产物。通常产物不进 git,但这里两条安装链路都**直接从 git 仓库里读这两个
文件**:

- Claude Code 插件市场用 `git` 从仓库安装插件(`/plugin marketplace add raysonmeng/agent-bridge`),
  没有构建步骤;
- `.mcp.json` 直接 `bun plugins/agentbridge/server/bridge-server.js` 启动 server。

所以这两个 bundle **必须**留在 git 里,否则从市场装出来的插件是空的。

**决定。** 把打包产物提交进仓库,并用 `.gitattributes` 把它们标成 `linguist-generated -diff`
(GitHub 折叠 diff、不计入语言统计、不做逐行合并)。构建的规范工具链是 **pinned bun
(见 `package.json` 的 `packageManager`,当前 `bun@1.3.11`)**——换一个 bun 版本会改变
`codeHash`,让 `verify:plugin-sync` 误报 out-of-sync。

**后果 / 冲突处理。** 这两个文件在 PR 里发生冲突时,**不要手工 merge** minified 输出。正确做法:

```bash
git checkout --theirs plugins/agentbridge/server/*.js   # 或 --ours,随便先取一份
bun run build:plugin                                     # 用 pinned bun 从 src/ 重新生成
bun run verify:plugin-sync                               # 确认与 src 同步
git add plugins/agentbridge/server/*.js
```

`bun run check` 会跑 `verify:plugin-sync`,漏提交或提交了陈旧 bundle 都会红灯。

## English

**Context.** `plugins/agentbridge/server/{bridge-server,daemon}.js` are artifacts that
`bun run build:plugin` produces from `src/`. Build artifacts usually don't belong in git, but
both install paths here **read these files straight out of the git repo**:

- the Claude Code plugin marketplace installs the plugin via `git` with no build step
  (`/plugin marketplace add raysonmeng/agent-bridge`);
- `.mcp.json` launches the server with `bun plugins/agentbridge/server/bridge-server.js` directly.

So these bundles **must** stay committed — otherwise a marketplace install ships an empty plugin.

**Decision.** Commit the bundles, and mark them `linguist-generated -diff` in `.gitattributes`
(GitHub collapses the diff, excludes them from language stats, and skips line-level merge). The
canonical build toolchain is the **pinned bun** (`packageManager` in `package.json`, currently
`bun@1.3.11`) — a different bun version changes the embedded `codeHash` and makes
`verify:plugin-sync` report a false out-of-sync.

**Consequences / conflict resolution.** When these files conflict in a PR, **do not hand-merge**
the minified output. Instead:

```bash
git checkout --theirs plugins/agentbridge/server/*.js   # or --ours; either side, just pick one
bun run build:plugin                                     # regenerate from src/ with the pinned bun
bun run verify:plugin-sync                               # confirm it matches src
git add plugins/agentbridge/server/*.js
```

`bun run check` runs `verify:plugin-sync`, so a missing or stale bundle fails the gate.
