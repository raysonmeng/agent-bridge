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

**Last updated / 最后更新：2026-09-13**

本节描述仓库的发布工作流与所需配置。配置文件、tag 或 GitHub Release 的存在，都不能证明 npm OIDC 已实际发布成功；以工作流中的 registry 回读和已发布包安装验证为准。

发布入口统一为 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml)：代码合并到 `master` 后自动发布 patch，也可手动恢复当前版本。旧的 `release-on-merge.yml` / `auto-release.yml` 接力流程已移除，不再依赖 `RELEASE_PAT` 或 `NPM_TOKEN`。

### Pipeline / 管线

```
master push / workflow_dispatch
        │
        ▼
publish.yml  ── single concurrency group / environment: release
        │
        ▼
select version → bump manifests if needed → resolve tag / source
        │
        ▼
install → build:plugin if bump → check → local commit if bump
        │
        ▼
prepublishOnly → pack smoke → built CLI smoke → candidate .tgz
        │
        ▼
if bump: push release branch → PR → squash merge
        │               GITHUB_TOKEN, contents / pull-requests: write
        ▼
verify merge commit / master / version → checkout master → rerun all gates
        │  fail → stop before tag / GitHub Release / npm publish
        ▼
pack canonical .tgz → tag + GitHub Release
        │
        ▼
npm publish checked .tgz     OIDC, id-token: write
        │
        ▼
registry version / latest / hash → isolated install → version / help
```

| 入口 | 版本行为 |
|------|----------|
| `master` push | 自动 patch；比较事件的 `before` 与事件 SHA 中的版本，若此次 push 已人工改版本，则发布该版本，不重复 bump |
| `workflow_dispatch`，`bump=false`（默认） | 恢复当前版本的发布，不增加版本号；已有 tag 时从该 tag 的固定源码重新构建 |
| `workflow_dispatch`，`bump=true` | 明确请求新的 patch 版本 |

版本同步复用 [`scripts/bump-version.mjs`](../scripts/bump-version.mjs)，更新 `package.json`、plugin manifest 和 marketplace manifest。plugin bundles 按 [`scripts/bundle-commit.cjs`](../scripts/bundle-commit.cjs) 读取的 tracked commit stamp 重建，避免只有 manifest 涨版本、包内版本仍旧的问题。

自动 bump 使用内置 `GITHUB_TOKEN` 推送专用 release 分支、创建版本 PR，并以 `gh pr merge --squash --match-head-commit` 合并已检查的 PR head；不直推 `master`，不使用 `--admin`、`--auto` 或自动 approve。合并后核对 merge commit、`master` 和版本，再重新检出正式源码、跑完整门禁；tag、GitHub Release 和 npm 包均基于这次重新验证的正式提交。

同一次运行继续创建 tag、GitHub Release 并直接执行 npm 发布。GitHub 对 `GITHUB_TOKEN` 产生的 push / release 事件不会再启动下游工作流，本流程无需用 PAT 绕过该限制。见 [GitHub：从工作流触发工作流](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。

### Required setup / 必需配置

以下是首次启用前置条件，须在 npm 和 GitHub 分别完成；仓库内的 workflow 文件不会自动建立这些配置。

1. **npm Trusted Publisher**：维护者在 `@raysonmeng/agentbridge` 的 npm 包设置中添加 GitHub Actions publisher，并完成这次配置所需的个人 2FA 验证。字段须与工作流一致：

   | 字段 | 值 |
   |------|----|
   | Organization or user | `raysonmeng` |
   | Repository | `agent-bridge` |
   | Workflow filename | `publish.yml`（仅文件名） |
   | Environment name | `release` |
   | Allowed actions | 允许直接 `npm publish` |

   后续 CI 通过 OIDC 获取短期发布凭据，不需保存 npm 发布 token，也不需每次交互输入 OTP。个人 2FA 保持开启。若只允许 `npm stage publish`，包仍需逐次人工批准，不符合此处的自动发布流程。字段和权限含义见 [npm Trusted publishing](https://docs.npmjs.com/trusted-publishers/)。
2. **GitHub environment `release`**：部署分支只允许 `master`；工作流使用同名 environment，npm Trusted Publisher 绑定该名称。`contents: write` 用于 release 分支、tag 和 GitHub Release，`id-token: write` 用于 npm OIDC。
3. **GitHub Actions 的 PR 权限**：在仓库 Actions 设置中开启 **Allow GitHub Actions to create and approve pull requests**（API 字段 `can_approve_pull_request_reviews=true`），并为发布 job 授予 `pull-requests: write`。该设置允许工作流创建版本 PR；工作流不执行 approve。`master` 的 ruleset `14316672` 要求 PR 和线性历史且没有 bypass，自动版本 PR 按既有规则 squash 合并，不修改 ruleset；创建或合并权限不足时运行失败。
4. **CI 运行时**：使用 GitHub 托管 runner、Bun **1.3.11**、Node **22** 和固定 npm **11.19.1**。npm 官方要求 Node 至少 22.14.0、npm 至少 11.5.1；这些工具由 Actions 在临时 runner 上准备，不修改维护者本机或服务器的语言环境。见 [npm Trusted publishing 的版本要求](https://docs.npmjs.com/trusted-publishers/)。

### Skip / opt-out / 跳过

- 在触发 push 的最终提交信息中加 `[skip release]`，跳过该次自动发布；例如无需发新版的文档或杂务提交。squash merge 时将标记保留在合并提交信息里。
- workflow 自己用 `GITHUB_TOKEN` 合并版本 PR 产生的 push 不会触发递归发布；当前运行继续完成合并后的检查和发布。
- 人工版本变更不等于跳过发布：只有自动 bump 被省略，检查、tag、Release、npm 发布与回读仍在同一次运行内完成。

### Manual release / 手动发布

minor / major 通过正常版本 PR 发布。从最新 `master` 创建工作分支，准备版本与 tracked plugin bundles：

```bash
git switch -c chore/release-minor
bun run release:bump minor    # 或 major；同步三个 manifest
BUNDLE_COMMIT="$(node scripts/bundle-commit.cjs)"
AGENTBRIDGE_BUILD_COMMIT_OVERRIDE="$BUNDLE_COMMIT" bun run build:plugin
bun run check
```

按仓库规则完成双 reviewer 审查，再提交版本相关文件、推送该工作分支并创建 PR；经授权正常合并到 `master` 后，`publish.yml` 发布已选定的版本。不要直接推送版本变更到 `master`。

旧的 [`scripts/release.sh`](../scripts/release.sh) 会创建并合并版本 PR，使用时仍须满足项目的 review 与合并授权纪律；本工作流不调用该脚本。脚本末尾只提供 `publish.yml` 状态链接，不再手工创建 GitHub Release，也不把排队状态报告为已发布。

恢复发布用默认的 `bump=false`；只有明确需要另发 patch 时才选 `bump=true`：

```bash
gh workflow run publish.yml --repo raysonmeng/agent-bridge --ref master -f bump=false
# 新 patch：将上面的 bump=false 改为 bump=true
gh run list --repo raysonmeng/agent-bridge --workflow publish.yml --branch master --limit 5
```

在 GitHub 页面单独创建 Release **不会触发 npm 发布**。如果 tag / Release 已有但 npm 尚未完成，使用上述恢复入口；恢复时仍校验 tag 指向和包体一致性。

### Artifact integrity / 产物可用性

- 需要 bump 时先更新 manifest，再确定 tag / 源码并安装依赖；随后为 bump 重建 plugin bundles，运行 `bun run check`（typecheck、完整测试、plugin bundle 同步、版本对齐），通过后为 bump 创建本地版本提交。接着运行 `prepublishOnly` 构建、npm pack 完整性 smoke、真实 built CLI daemon smoke 并打包候选 `.tgz`，通过后才推送 release 分支、创建并 squash 合并版本 PR。合并后的正式提交重新安装依赖并跑完整检查、构建、smoke 和打包，随后才创建 tag 和 GitHub Release；PR 分支产物不会直接作为最终 npm 发布包。
- npm 上传已检查的 `.tgz`。同一版本若已存在且包体 hash 一致，则跳过重复上传、继续验证；同版本不同包直接失败，不覆盖已有版本。已有 tag 必须指向正确候选提交，恢复时不会重写或移动 tag。
- 发布后最多检查官方 registry 30 次、每次间隔 20 秒（等待约 10 分钟，网络请求耗时另计），回读目标版本、`latest` 和包体 hash。恢复开始时若目标版本已存在且 `latest` 更新，会先构建和打包并比对 registry 的同版本包体 hash，一致才保留较新的 `latest` 并结束，不再走后续上传与安装；不同包体则失败。若目标版本尚未发布但已落后于 `latest`，或后续发布阶段出现更新的 `latest`，则失败，防止降级。
- 在临时隔离 prefix 中安装 registry 上的已发布包，核对 CLI `--version` 与 `--help`。这一步验证 npm 实际分发的内容，不复用仓库内的 `dist/`。
- **GitHub Release 创建成功与 npm 发布成功是两个状态。** 发布后的传播或安装验证失败会令工作流失败，但不会撤销已经上传的包；修复原因后以 `bump=false` 恢复，不因验证超时盲目再涨版本。

### Concurrency & limitations / 并发与已知限制

- 自动发布与手动恢复共用单个 concurrency group，同一时间只运行一个发布，不取消正在执行的发布。
- 并发 `master` 变更导致候选失效时，最多尝试 3 个候选；首次检出、版本 PR 合并后和每次重试切换到新源码后，都按该源码的 `bun.lock` 重新执行 `bun install --frozen-lockfile --ignore-scripts`，随后重跑完整检查、构建和 smoke。旧候选的依赖和检查结果不能替新源码背书。
- 连续合并可能合并进同一个 patch，不能据一次 push 或一个工作流条目推断“每个 PR 恰好一个 npm 版本”；通过最终 tag、registry 包体和运行日志确认该版实际内容。

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

1. Preflight active Claude frontends and managed Codex TUIs. If any are running,
   the installer asks on a TTY, refuses in non-TTY mode, or continues with
   `--force`.
2. Build/verify/install succeeds. Local mode rebuilds `dist/` and plugin
   bundles, verifies required artifacts on disk, packs a tarball, and verifies
   the tarball before installing it; npm mode verifies `latest` exists and
   installs it.
3. Only after the install succeeds, call `install-safety.cjs stop-running` using
   a scrubbed install environment.
4. Print the post-install reminder to restart affected AgentBridge/Claude
   windows.

Use `node scripts/install-global.mjs local --dry-run` to inspect the sequence
without stopping anything.

#### What stops running daemons (and what doesn't) / 谁会停掉运行中的 daemon

Stopping all running AgentBridge daemons/TUIs is destructive, so it is **not**
triggered by arbitrary installs. There are exactly two paths that stop them:

1. **The intentional installer** — `scripts/install-global.mjs` (`bun run
   install:global:*`) calls `install-safety.cjs stop-running` directly in both
   `local` and `npm` modes. It now preflights active sessions before doing so.
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
(1) **有意安装器** `scripts/install-global.mjs`(`bun run install:global:*`)在 `local` 与
`npm` 两种模式下直接调用 `install-safety.cjs stop-running`,且现在会先前置检测活跃会话;
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
