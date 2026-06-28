# 03. 发布上线 + Codex 协议适配（2026-03-29 ~ 03-31）

## 一句话定位

这是 AgentBridge **走出实验室**的三天——从一个跑在本机、只有作者自己会用的双向桥，变成能 `npm install` 装下来、有短命令、跟着 GitHub Release 自动发版的工具；与此同时，它第一次跟**真实的、闭源的 Codex app-server 协议**正面较真，把一个"审批提示不弹、Codex 卡死"的硬骨头啃了下来。

## 起点与背景

走到这个阶段，桥的核心机制已经成型：MCP stdio 接 Claude、daemon 守 Codex app-server 代理、`agentMessage` 拦截转发、`source` 字段防回环。但它还停在"作者本机能跑"的状态，缺两样东西：

1. **没法被别人装。** 包名、入口、发布流程都还是雏形，谈不上分发。
2. **跟 Codex 协议只是"凑合能通"。** `codex-adapter.ts` 里的 WebSocket 代理对 app-server 发来的消息做了一套朴素分类——有 `id` 当响应、没 `id` 当通知。这套分类在正常对话里看不出问题，可一旦 Codex 触碰沙箱权限（写文件、跑命令、访问网络），就会暴露致命缺陷。

而麻烦在于：**Codex app-server 是闭源协议**。没有公开的 spec，没有消息类型清单，连审批响应该长什么样都不知道。要把桥做成能公开发布、能被信任的工具，就必须先把这层"黑盒协议"摸清到足以可靠对接的程度。

## 这个阶段做了什么

这三天的工作分两条线并行推进。

**发布链这条线**，把"能被装、能被发"补齐：

- **`abg` 短别名 + npm 发布准备**（#31）：给冗长的 `agentbridge` 加了 `abg` 短命令，并把项目按 npm 包的标准重新组织——这是"能被装"的前置。
- **包体清理 + scoped 包名**（#35/#36）：清掉不该进包的文件，并改用 scoped 包名 `@raysonmeng/agentbridge`，把发布身份固定下来。
- **GitHub Release 触发自动发布**（#42）：打一个 Release，CI 自动 `npm publish`，发版从手工动作变成流水线。
- **带自动 changelog + 社媒文案的发布脚本**（#43）：发版顺手生成变更日志和对外公告草稿，把"发布"做成一个完整动作而不只是推包。
- **v0.1.1 ~ v0.1.4** 四个补丁版本，是这条线一路打磨出来的产物。

**协议适配这条线**，则是本阶段真正的硬仗：

- **server-request 透传**（#37/#38）：修复 Codex 审批 UI 不弹、整个 turn 无限卡死的根因——这是下面要重点讲的部分。
- **采用 Codex app-server 协议类型定义**（#47/#53）：把逆向摸清的协议消息形状，沉淀成正式的 TypeScript 类型定义，让此后所有跟 app-server 的交互都有类型可依，不再靠 `any` 和经验拼。

## 关键设计决策与为什么——对闭源协议的逆向考古

issue #37 是这个阶段、乃至整个早期最值得记的一次工程实践。它不只是修一个 bug，而是示范了**面对一个没有文档的闭源协议，怎么把它摸清到可以可靠对接**。

### 根因：一个被"朴素分类"丢掉的消息类型

`codex-adapter.ts` 的代理把 app-server → TUI 的 JSON-RPC 消息分成两类：

| 类型 | 结构 | 当时的处理 |
|------|------|-----------|
| Notification | `{ method, params }`（无 `id`） | 转发给 TUI ✅ |
| Response | `{ id, result/error }`（无 `method`） | ID 重映射后转发 ✅ |

漏掉的是第三类——**server-to-client request**：`{ id, method, params }`，**既有 `id` 又有 `method`**。它是服务端主动向客户端发起的请求（典型就是审批提示），不是对 TUI 某个请求的回应。代理一看它有 `id`，就当成响应丢进 `handleAppServerResponse`，可它又找不到对应的 upstream mapping，最终落到 fallback 分支——`"Dropping unmatched app-server response"`，**直接丢弃**。

于是卡死链条就成立了：Codex 调用需要审批的工具 → app-server 发 `item/permissions/requestApproval` → 代理误判为响应并丢弃 → TUI 永远收不到审批提示、不渲染 UI → app-server 永远等不到审批回复 → 用户看着 Codex 停在 "Working" 一动不动。

### 怎么摸清一个闭源协议——读二进制

问题来了：要正确处理 server request，得先知道**到底有哪些 server request**。但 Codex app-server 没有公开协议文档。

做法是**对 `@openai/codex` 二进制做字符串分析**，从里面把协议消息类型一个个挖出来：

- **server-to-client request（审批，需回复）**：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`
- **server-to-client notification（不需回复）**：`TerminalInteractionNotification`、`serverRequest/resolved`
- **TUI 对审批的响应**：`CommandExecutionRequestApprovalResponse`、`FileChangeRequestApprovalResponse`、`PermissionsRequestApprovalResponse`

这一步把"黑盒"变成了"半透明盒"——足够知道消息边界，但**还不够知道每个 payload 的内部结构**。

### 设计哲学："信息不全，就防御性透传，绝不做假设"

这是 issue #37 最该被记住的一条原则，也是它从普通 bugfix 升格成方法论的地方。

逆向能告诉你"审批响应叫 `PermissionsRequestApprovalResponse`"，但**告诉不了你它的 payload 长什么样**——它显然不是简单的 `{ approved: true/false }`，但具体字段未知。面对这种"知道有、不知道细节"的局面，桥选择了一条克制的路线：**代理对审批响应原样透传，不解析、不重构、不假设任何字段**。代理只做一件自己有把握的事——把 server 端的 `id` 重映射成自己命名空间里的 `proxyId`、记一条 mapping、等 TUI 回复时再映射回去。payload 内容它一个字节都不碰。

这条"不做假设"的哲学，在设计里处处体现：

- **修复是通用的**：判据是"任何 `{ id, method }` 消息都当 server request 转发"，而不是去硬编码那三个已知的 `requestApproval` 方法名。这样**即便存在尚未逆向发现的 server request 类型，也能被正确处理**——明确把"我们可能没挖全"当成前提来设计。
- **不假设上游重连行为**：app-server 在 TUI 重连后会不会重发 pending 审批？不知道。所以采取防御性策略——只重放断连期间缓冲的 server request，**不主动重发**已发给旧 TUI 的请求；万一 app-server 真重发了，它会带新 `id` 走正常流程，不会撞车。
- **session-scoped 状态显式清理**：app-server 重连意味着新 session、新 ID 空间，旧的审批 mapping 全部失效——于是在 app-server close 时主动清空 `serverRequestToProxy` 和缓冲队列，而不是赌它们还有效。

一句话：**逆向给出边界，防御性透传填补未知**。凡是逆向没给出确定答案的地方，桥都选择"原样传递 + 不假设"，而不是猜一个结构去解析——猜错的代价是悄悄丢消息、再次卡死，而透传最坏也只是多转一条无害的字节流。

### 五轮 review 磨出的健壮性

issue #37 的设计稿从 v1 迭代到 v5，跨了 Claude 和 Codex 两个引擎的多轮交叉 review，每一轮都在补"防御性"的缝：

- **v1→v2**：补上重连期间审批请求会丢的洞（新增 `pendingServerRequests` 缓冲）；明确区分 request 与 notification；给 mapping 加 `connId` 作用域，拒绝旧连接的过期响应。
- **v2→v3**：修 delete-before-validate——`delete()` 必须挪到 `connId` 验证通过之后，否则旧连接的过期响应会误删 mapping，让正确响应再也匹配不上。
- **v3→v4**：缓冲重放改成逐条 try-catch，单条 send 失败不再整批清空。
- **v4→v5**（Claude + Codex 最终并行 review）：**ID 类型归一化**——TUI 可能回 string `"100050"` 而非 number `100050`，查找前必须 string→number 归一，否则重现卡死；`handleServerRequest` 改为内部直接 `tuiWs.send()`，**send 成功后才建立 mapping**（避免失败时留下幽灵条目），不再把 payload 丢回外层那条 "log and drop" 路径。

这一串改动里反复出现同一个母题：**先确认能成功，再记录状态；状态只在确定有效时保留**。这正是"不做假设"哲学在并发与失败路径上的延伸。

## 踩的坑——审批 UI 不弹 / Codex 卡死的根因

本阶段最典型的坑，就是 issue #37 的症状本身，值得单独点明它的"隐蔽性"：

**这个 bug 在普通对话里完全看不出来。** 只要 Codex 不触碰需要审批的操作，那套"有 `id` 当响应、没 `id` 当通知"的朴素分类就一直正常工作。坑只在特定条件下才触发——Codex 在受限沙箱里要写文件、跑命令或联网，app-server 这才发出 server-to-client request。于是表现成一个极具迷惑性的现象：**桥平时好好的，一到关键操作就让 Codex 永久卡在 "Working"，且没有任何报错**——既不抛异常，也不打醒目日志，只是静悄悄把那条审批请求丢进了 fallback 分支。

教训有两条。其一，**朴素的二分类（有 id / 无 id）对 JSON-RPC 是不够的**——server-to-client request 这第三类同时具备两个特征，任何只看单一字段的分类都会把它归错。其二，**"log and drop" 是危险的兜底默认**：把无法识别的消息记一行日志然后丢掉，看起来安全，实际是在悄悄吞掉可能至关重要的协议消息。修复之后的默认姿态反过来了——**不认识但结构像 server request 的，一律透传**，宁可多传也不静默丢。

## 产出

三天结束时，AgentBridge 拿到了两样它之前没有的东西：

1. **完整的发布能力**：scoped npm 包 `@raysonmeng/agentbridge`、`abg` 短命令、GitHub Release 触发的自动发版、带 changelog 与社媒文案的发布脚本，外加 v0.1.1~v0.1.4 一串实打实跑通的版本。它**正式可被安装、可被分发**了。
2. **与 Codex 协议的稳固对接**：审批流程（命令执行 / 文件改动 / 权限）能可靠地透传到 TUI，Codex 不再因审批卡死；逆向摸清的协议消息形状沉淀成了正式的 app-server 类型定义（#47/#53），此后所有跟 app-server 的交互都有类型护栏。更重要的是，它确立了一条贯穿后续所有协议工作的方法论——**面对闭源协议，逆向定边界、防御性透传填未知、绝不对未知结构做假设**。

## 关键 PR / commit

| PR / commit | 内容 |
|-------------|------|
| #31 | `abg` 短别名 + npm 发布准备 |
| #35 / #36 | 包体清理 + 改用 scoped 包名 `@raysonmeng/agentbridge` |
| **#37 / #38** | **server-request 透传——修 Codex 审批 UI 不弹 / 卡死（本阶段核心，v5 定稿）** |
| #42 | GitHub Release 触发自动 npm publish |
| #43 | 带自动 changelog + 社媒文案的发布脚本 |
| #47 / #53 | 采用 Codex app-server 协议类型定义 |
| v0.1.1 ~ v0.1.4 | 阶段产出的补丁版本 |

> 核心改动文件：`src/codex-adapter.ts`（server request 检测、`handleServerRequest()`、TUI 响应回传含 connId 验证、缓冲与重放、TTL 清理）。完整设计稿与 v1→v5 review 演进的原始记录见 git 历史。

---

## 附录：当前发布流程 SOP

> 发布链是本阶段建立的，这里附上其演进至今的完整操作手册（内容来自 `docs/08-发布流程.md`）。

AgentBridge auto-publishes to npm on every code merge to `master`, so the
update-notifier always has a fresh, gated source. Every published version is
gated by `bun run check` — we never publish a build that can't pass.

AgentBridge 在每次代码合并到 `master` 时自动发布到 npm,让 update-notifier 始终有一个
最新、经门禁把关的源。每个发布版本都被 `bun run check` 卡住——绝不发布无法通过检查的构建。

### Pipeline / 管线

```
merge code PR to master
        │
        ▼
release-on-merge.yml   ── gate: bun run check ──▶ (fail → no release)
        │  (pass)
        ▼
bump patch in package.json + plugin.json + marketplace.json  (synced)
        │
        ▼  commit "chore(release): vX.Y.Z", push to master  (needs RELEASE_PAT)
        ▼
auto-release.yml       ── tag vX.Y.Z + GitHub release ──▶
        │
        ▼
publish.yml            ── gate: bun run check → build → npm publish
```

- **`.github/workflows/release-on-merge.yml`** — on each push to `master`, runs
  the full check and, if green, patch-bumps the version (synced across all three
  manifests via `scripts/bump-version.mjs`) and pushes a `chore(release): vX.Y.Z`
  commit.
- **`.github/workflows/auto-release.yml`** — on a `package.json` version change,
  creates the `vX.Y.Z` tag and GitHub release.
- **`.github/workflows/publish.yml`** — on a published release, runs `bun run
  check` again (final gate), builds, and `npm publish`es.

### Required setup / 必需配置

1. **`RELEASE_PAT` repo secret** — a fine-grained Personal Access Token with
   `contents: write`. Used at **both** hops of the chain, because pushes/releases
   made with the default `GITHUB_TOKEN` do **not** trigger other workflows
   (GitHub's recursion guard):
   - `release-on-merge.yml` pushes the bump commit with `RELEASE_PAT` → triggers
     `auto-release.yml`. It **fails loudly** if `RELEASE_PAT` is missing (rather
     than push an un-publishable bump with `GITHUB_TOKEN`).
   - `auto-release.yml` creates the GitHub release with `RELEASE_PAT` → triggers
     `publish.yml`. With only `GITHUB_TOKEN` the release would be created but
     `npm publish` would never run.
   必须配置 `RELEASE_PAT`(细粒度 PAT,`contents: write`),发布链的**两跳都用它**:
   release-on-merge 推 bump commit、auto-release 建 release,都需要 PAT 才能触发下一跳
   (默认 `GITHUB_TOKEN` 推送/建 release 不触发其它 workflow)。缺 PAT 时 release-on-merge
   直接 fail,不会产生发不出去的版本 bump。
2. **`NPM_TOKEN` repo secret** — for `npm publish` (already used by publish.yml).
3. **Branch protection** — if `master` is protected, allow the PAT identity to push
   (the `chore(release):` bump commit). 若 `master` 受保护,需允许该 PAT 推送 bump commit。

### Skip / opt-out / 跳过

- Put `[skip release]` in a commit message to skip the auto-bump (use for
  docs-only / chore commits that should not produce a new npm version).
  提交信息含 `[skip release]` 即跳过自动 bump(用于纯文档/杂务提交)。
- `chore(release):` commits (the bot's own bumps) and `github-actions[bot]` pushes
  are skipped automatically (loop guard).
- If the triggering push already changed the version (a manual bump), the
  auto-bump is skipped and the existing release flow publishes instead — no
  double bump.

### Manual release / 手动发布

If you need to cut a release by hand (e.g. a coordinated minor/major bump):

```bash
bun run release:bump minor    # or patch | major — syncs all three manifests
git commit -am "chore(release): v$(node -p "require('./package.json').version")"
git push origin master        # triggers auto-release.yml -> publish.yml
```

### Artifact integrity / 产物可用性

`bun run check` (typecheck + full test suite + plugin-bundle sync + version
alignment) gates BOTH the bump and the publish, so a broken build can never be
released. A stronger **release-form smoke** — launching the built `dist/cli.js`
daemon and verifying `npm pack` completeness (`smoke:built` / `smoke:pack`) —
lands with PR #90; once merged, add those as extra gate steps in
`release-on-merge.yml` and `publish.yml`.

`bun run check` 同时卡住 bump 和 publish,坏构建永远发不出去。更强的**发布形态 smoke**
(真启打包 daemon + 查 npm 包完整性)随 PR #90 合入,届时把它们加进两处门禁。

### Concurrency & limitations / 并发与已知限制

- `release-on-merge.yml` uses a `concurrency` group so only one release runs at a
  time. Pushing the bump is wrapped in a **retry loop**: on any push failure
  (non-fast-forward, or a rebase conflict because a concurrent merge edited
  `package.json` near the version line) it hard-resets to the latest
  `origin/master` and recomputes the bump from that tip, up to 3 attempts. So a
  concurrent human merge does not silently drop a release.
- Edge case: with several merges in quick succession, a later merge's code may be
  published under the FIRST run's version (it's already on master), and its own
  run then skips bumping (version already changed). Nothing is lost — the code is
  on `master` and ships in that release or the next bump. This is acceptable for a
  patch-on-every-merge cadence; switch to a manual/batched release if you need one
  npm version per PR exactly.
  推送 bump 带 3 次重试:任何推送失败(非快进 / 并发改动 package.json 版本行附近导致 rebase
  冲突)都会硬重置到最新 origin/master 并重算 bump,所以并发合并不会悄悄丢掉发布。
  快速连续合并时,后一个 PR 的代码可能跟随前一次 run 的版本一起发布(不会丢失,代码已在 master),
  只是版本归属可能合并。需要"每个 PR 精确一个 npm 版本"时改用手动/批量发布。

### Installing a build globally (dogfooding) / 本地全局安装

To replace the globally-installed `agentbridge`/`abg` CLI for testing:

```bash
bun run install:global:local   # build THIS checkout, pack it, then fully replace the global install
bun run install:global:npm     # replace the global install with the npm `latest`
```

(`install:global` is an alias for `install:global:local`.) Both fully replace the
global package, so afterward `npm install -g @raysonmeng/agentbridge@latest`
cleanly overrides whatever you installed — there is no leftover `bun link` symlink
to conflict with.

Both install modes (via `scripts/install-global.mjs`) use the same four-step
sequence:

1. Preflight active Claude frontends and managed Codex TUIs. **Non-destructive by
   default (backlog ⑥):** the install no longer stops running daemons, so active
   sessions keep serving the OLD version until they restart on their own — nothing
   is disconnected and nothing is asked. Only `--restart-now` (the opt-in
   destructive path) prompts on a TTY, refuses in non-TTY, or continues with
   `--force`.
2. Build/verify/install succeeds. Local mode rebuilds `dist/` and plugin
   bundles, verifies required artifacts on disk, packs a tarball, and verifies
   the tarball before installing it; npm mode verifies `latest` exists and
   installs it.
3. **Only under `--restart-now`**, after the install succeeds, call
   `install-safety.cjs stop-running` using a scrubbed install environment. The
   default path skips this entirely.
4. Print the post-install reminder (only when sessions were running) — restart
   affected AgentBridge/Claude windows to pick up the new version.

Use `node scripts/install-global.mjs local --dry-run` to inspect the sequence
without stopping anything; add `--restart-now` to see the stop step.

#### What stops running daemons (and what doesn't) / 谁会停掉运行中的 daemon

Stopping all running AgentBridge daemons/TUIs is destructive, so it is **not**
triggered by arbitrary installs. There are exactly two paths that stop them:

1. **The intentional installer WITH `--restart-now`** — `scripts/install-global.mjs`
   (`bun run install:global:* -- --restart-now`) calls `install-safety.cjs
   stop-running` after install, in both `local` and `npm` modes. **Without
   `--restart-now` the installer is non-destructive (backlog ⑥): it never stops
   running daemons** — active sessions keep serving the old version until they
   restart on their own.
2. **An explicit global self-install via npm `postinstall`** — `scripts/postinstall.cjs`
   stops running daemons **only** when it detects an explicit global signal:
   - `npm_config_global=true` (i.e. `npm install -g …`), or
   - `npm_config_location=global`, or
   - `AGENTBRIDGE_POSTINSTALL_STOP=1` (force override).

   `AGENTBRIDGE_POSTINSTALL_STOP=0` forces the opposite (never stop), taking
   precedence over the global signals.

Crucially, **arbitrary `.tgz` / transitive-dependency installs do NOT stop
running daemons** — a non-global `npm install`, or AgentBridge being pulled in as
someone else's dependency, leaves every running pair untouched (postinstall logs
a note pointing at `abg kill --all` / install-global). Stop-the-world is reserved
for the two intentional paths above.

停掉所有运行中的 daemon/TUI 是破坏性操作,因此**不会**被任意安装触发。只有两条路径会停:
(1) **带 `--restart-now` 的有意安装器** `scripts/install-global.mjs`(`bun run install:global:* -- --restart-now`)
在 `local` 与 `npm` 两种模式下于安装后调用 `install-safety.cjs stop-running`。**不带 `--restart-now` 时安装器是非破坏的(backlog ⑥):
绝不停掉运行中的 daemon**——活跃会话继续用旧版服务,直到它们自行重启;
(2) **经 npm `postinstall` 的显式全局自安装**——`scripts/postinstall.cjs` 仅在检测到显式全局信号时才停
(`npm_config_global=true` / `npm_config_location=global` / `AGENTBRIDGE_POSTINSTALL_STOP=1`;
`AGENTBRIDGE_POSTINSTALL_STOP=0` 强制不停,优先级最高)。**任意 `.tgz` / 传递依赖安装
不会停掉运行中的 daemon**——非全局 `npm install`、或被当作他人依赖拉入时,所有运行中的
pair 都保持不动(postinstall 只打一条提示指向 `abg kill --all` / install-global)。

The CLI and the Claude Code **plugin** are separate installs. `install:global:*`
updates the CLI; the npm `postinstall` best-effort registers/installs the plugin,
but an active Claude Code session may still need a plugin reload or restart to
pick up the newly installed plugin bundle. To make the plugin match your source
and reload it:

```bash
bun run install:global:local
bun src/cli.ts dev        # build + sync the plugin from THIS checkout into Claude Code
# then in Claude Code:
/plugin marketplace update agentbridge   # (if installed via marketplace)
/reload-plugins
```

> Run `bun src/cli.ts dev` (from the source checkout) rather than the globally
> installed `agentbridge dev`, so the plugin is synced from your working tree, not
> the global npm package dir.

### Breaking changes / migration / 破坏性变更与迁移

#### `AGENTBRIDGE_MANUAL=1` now required for pinned-env classic single-pair mode

**BREAKING (power users):** Previously, exporting a pinned `AGENTBRIDGE_STATE_DIR`
and/or a pinned port (e.g. `AGENTBRIDGE_CONTROL_PORT`) **without** a `--pair` was
enough to opt into classic single-pair mode — AgentBridge honored that pinned
environment as-is.

That is no longer true. With cwd-scoped pair resolution as the default, a pinned
`AGENTBRIDGE_STATE_DIR` / port **without** `AGENTBRIDGE_MANUAL=1` is now treated as
**stale** and **overwritten** by the cwd-derived pair (state dir + ports resolved
from the current working directory). To keep the old behavior — i.e. force
AgentBridge to use exactly the state dir / ports you pinned — you must now set:

```bash
export AGENTBRIDGE_MANUAL=1
```

explicitly, alongside your pinned `AGENTBRIDGE_STATE_DIR` / port env. Without it,
your pins are ignored and cwd-scoped resolution wins.

**迁移说明(破坏性,面向高级用户):** 以前只要导出固定的 `AGENTBRIDGE_STATE_DIR` 和/或
固定端口(且**不带** `--pair`)就能进入经典单 pair 模式,AgentBridge 会原样沿用这些固定环境。
现在不再如此:由于默认走 cwd 作用域的 pair 解析,**不带** `AGENTBRIDGE_MANUAL=1` 的固定
`AGENTBRIDGE_STATE_DIR` / 端口会被视为**过期**并被 cwd 派生的 pair(按当前工作目录解析的
state dir + 端口)**覆盖**。若想保留旧行为(强制使用你固定的 state dir / 端口),必须显式设置
`export AGENTBRIDGE_MANUAL=1`,与固定环境变量一起使用;否则你的固定值会被忽略,cwd 作用域解析优先。
