# Releasing AgentBridge / 发布流程

AgentBridge auto-publishes to npm on every code merge to `master`, so the
update-notifier always has a fresh, gated source. Every published version is
gated by `bun run check` — we never publish a build that can't pass.

AgentBridge 在每次代码合并到 `master` 时自动发布到 npm,让 update-notifier 始终有一个
最新、经门禁把关的源。每个发布版本都被 `bun run check` 卡住——绝不发布无法通过检查的构建。

## Pipeline / 管线

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

## Required setup / 必需配置

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

## Skip / opt-out / 跳过

- Put `[skip release]` in a commit message to skip the auto-bump (use for
  docs-only / chore commits that should not produce a new npm version).
  提交信息含 `[skip release]` 即跳过自动 bump(用于纯文档/杂务提交)。
- `chore(release):` commits (the bot's own bumps) and `github-actions[bot]` pushes
  are skipped automatically (loop guard).
- If the triggering push already changed the version (a manual bump), the
  auto-bump is skipped and the existing release flow publishes instead — no
  double bump.

## Manual release / 手动发布

If you need to cut a release by hand (e.g. a coordinated minor/major bump):

```bash
bun run release:bump minor    # or patch | major — syncs all three manifests
git commit -am "chore(release): v$(node -p "require('./package.json').version")"
git push origin master        # triggers auto-release.yml -> publish.yml
```

## Artifact integrity / 产物可用性

`bun run check` (typecheck + full test suite + plugin-bundle sync + version
alignment) gates BOTH the bump and the publish, so a broken build can never be
released. A stronger **release-form smoke** — launching the built `dist/cli.js`
daemon and verifying `npm pack` completeness (`smoke:built` / `smoke:pack`) —
lands with PR #90; once merged, add those as extra gate steps in
`release-on-merge.yml` and `publish.yml`.

`bun run check` 同时卡住 bump 和 publish,坏构建永远发不出去。更强的**发布形态 smoke**
(真启打包 daemon + 查 npm 包完整性)随 PR #90 合入,届时把它们加进两处门禁。

## Concurrency & limitations / 并发与已知限制

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

## Installing a build globally (dogfooding) / 本地全局安装

To replace the globally-installed `agentbridge`/`abg` CLI for testing:

```bash
bun run install:global:local   # build THIS checkout, pack it, then fully replace the global install
bun run install:global:npm     # replace the global install with the npm `latest`
```

(`install:global` is an alias for `install:global:local`.) Both fully replace the
global package, so afterward `npm install -g @raysonmeng/agentbridge@latest`
cleanly overrides whatever you installed — there is no leftover `bun link` symlink
to conflict with.

The CLI and the Claude Code **plugin** are separate installs. `install:global:*`
updates the CLI; the npm `postinstall` best-effort registers/installs the plugin,
but an already-installed plugin cache and an active Claude session are NOT
force-refreshed. To make the plugin match your source and reload it:

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
