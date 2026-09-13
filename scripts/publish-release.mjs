#!/usr/bin/env node
// One Actions invocation owns validation, version preparation and both publishes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = "raysonmeng/agent-bridge";
const PACKAGE = "@raysonmeng/agentbridge";
const REGISTRY = "https://registry.npmjs.org";
const BUNDLES = ["plugins/agentbridge/server/bridge-server.js", "plugins/agentbridge/server/daemon.js"];
const RELEASE_FILES = ["package.json", "plugins/agentbridge/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ...BUNDLES];

function attempt(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function run(command, args, options) {
  const result = attempt(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr?.trim() ?? "see command output"}`);
  return result.stdout?.trim() ?? "";
}
const git = (...args) => run("git", args, { capture: true });
const json = path => JSON.parse(readFileSync(path, "utf8"));
function version(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
      !value.split(".").every(part => Number.isSafeInteger(Number(part)))) throw new Error(`Expected stable X.Y.Z version: ${value}`);
  return value;
}
function compare(a, b) {
  const left = version(a).split(".").map(Number), right = version(b).split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
function packageVersion(ref) {
  const pkg = ref ? JSON.parse(git("show", `${ref}:package.json`)) : json("package.json");
  if (pkg.name !== PACKAGE) throw new Error(`Unexpected package: ${pkg.name}`);
  return version(pkg.version);
}
function registry(...fields) {
  return JSON.parse(run("npm", ["view", ...fields, "--json", "--prefer-online", "--registry", REGISTRY,
    "--fetch-retries=0", "--fetch-timeout=15000"], { capture: true }));
}
function registryState() {
  const data = registry(PACKAGE, "versions", "dist-tags");
  const versions = typeof data.versions === "string" ? [data.versions] : data.versions;
  if (!Array.isArray(versions) || !versions.every(v => typeof v === "string")) throw new Error("Invalid registry versions response");
  const latest = data["dist-tags"]?.latest;
  if (latest != null) version(latest);
  return { versions, latest };
}
function tagCommit(tag) {
  const result = attempt("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { capture: true });
  if (result.status === 128) return null;
  if (result.status !== 0) throw new Error(`Cannot resolve ${tag}: ${result.stderr}`);
  return result.stdout.trim();
}
function ancestor(commit) {
  const result = attempt("git", ["merge-base", "--is-ancestor", commit, "origin/master"], { capture: true });
  if (result.status !== 0 && result.status !== 1) throw new Error(`Cannot check release ancestry: ${result.stderr}`);
  return result.status === 0;
}
function onlyReleaseChanges() {
  const paths = [git("diff", "HEAD", "--name-only", "-z"), git("ls-files", "--others", "--exclude-standard", "-z")]
    .join("\0").split("\0").filter(Boolean);
  for (const path of paths) if (!RELEASE_FILES.includes(path)) throw new Error(`Unexpected release working-tree change: ${path}`);
}
function fetchMaster() {
  git("fetch", "origin", "+refs/heads/master:refs/remotes/origin/master", "--tags");
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== REPO ||
      process.env.GITHUB_REF !== "refs/heads/master") throw new Error("Release is restricted to this repository's master Actions run");
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!["push", "workflow_dispatch"].includes(eventName)) throw new Error("Unsupported release event");
  const event = json(process.env.GITHUB_EVENT_PATH);
  if (eventName === "push" && event.head_commit?.message?.includes("[skip release]")) {
    console.log("[skip release]: no release requested"); return;
  }
  if (!process.env.GH_TOKEN || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("Release requires GITHUB_TOKEN and id-token: write for npm OIDC");
  }
  if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) throw new Error("Use npm OIDC, not a long-lived npm token");
  if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "")) throw new Error("Invalid triggering commit");
  if (git("status", "--porcelain")) throw new Error("Release checkout must start clean");
  const eventVersion = packageVersion(process.env.GITHUB_SHA);
  let beforeVersion = eventVersion;
  if (eventName === "push" && event.before && !/^0+$/.test(event.before)) {
    if (!/^[0-9a-f]{40}$/.test(event.before)) throw new Error("Invalid previous commit");
    beforeVersion = packageVersion(event.before);
  }
  const manualBump = event.inputs?.bump;
  if (manualBump !== undefined && ![true, false, "true", "false"].includes(manualBump)) throw new Error("Invalid bump input");
  const requestedBump = eventName === "push" ? beforeVersion === eventVersion : manualBump === true || manualBump === "true";
  const artifactDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "agentbridge-release-"));
  try {
    for (let retry = 0; retry < 3; retry++) {
      fetchMaster();
      git("switch", "--detach", "origin/master");
      const startingHead = git("rev-parse", "HEAD");
      const currentVersion = packageVersion();
      const bump = requestedBump && currentVersion === eventVersion;
      let wanted = currentVersion;
      if (bump) {
        wanted = version(run("node", ["scripts/bump-version.mjs", "patch"], { capture: true }));
      }
      const tag = `v${wanted}`;
      const existingTag = tagCommit(tag);
      if (existingTag) {
        if (bump || !ancestor(existingTag) || packageVersion(existingTag) !== wanted) {
          throw new Error(`Release tag ${tag} conflicts with the candidate or master history`);
        }
        git("switch", "--detach", existingTag); // recovery always uses immutable tagged source
      }
      let state = registryState();
      if (state.latest && compare(state.latest, wanted) > 0) {
        if (!state.versions.includes(wanted)) throw new Error(`Refusing to publish ${wanted} behind registry latest ${state.latest}`);
      }
      if (bump && state.versions.includes(wanted)) throw new Error(`Version ${wanted} is already published; reconcile the repository version first`);

      run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"]);
      if (bump) {
        const stamp = run("node", ["scripts/bundle-commit.cjs"], { capture: true });
        run("bun", ["run", "build:plugin"], { env: { ...process.env, AGENTBRIDGE_BUILD_COMMIT_OVERRIDE: stamp } });
      }
      run("bun", ["run", "check"]);
      onlyReleaseChanges();
      if (bump) {
        git("config", "user.name", "github-actions[bot]");
        git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
        git("add", ...RELEASE_FILES);
        git("commit", "-m", `chore(release): v${wanted}`);
      }
      const commit = git("rev-parse", "HEAD");
      run("bun", ["run", "prepublishOnly"]);
      run("bun", ["run", "smoke:pack"]);
      run("bun", ["scripts/smoke-built-cli.mjs", "--skip-build"]);
      onlyReleaseChanges();
      const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDir], { capture: true }))[0];
      if (packed?.filename !== `raysonmeng-agentbridge-${wanted}.tgz`) throw new Error("Unexpected packed artifact filename");
      const tarball = join(artifactDir, packed.filename);
      const bytes = readFileSync(tarball);
      const shasum = createHash("sha1").update(bytes).digest("hex");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (shasum !== packed.shasum) throw new Error("Packed artifact checksum mismatch");
      state = registryState();
      if (state.versions.includes(wanted) && registry(`${PACKAGE}@${wanted}`, "dist").shasum !== shasum) {
        throw new Error(`Published ${wanted} differs from the checked artifact`);
      }
      if (state.latest && compare(state.latest, wanted) > 0) {
        if (!state.versions.includes(wanted)) throw new Error(`Refusing to publish ${wanted} behind registry latest ${state.latest}`);
        console.log(`Verified ${wanted}; newer ${state.latest} remains latest`);
        return;
      }

      if (bump) {
        const branch = `release/auto-${tag}-${commit.slice(0, 12)}`;
        run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
        const body = join(artifactDir, "version-pr.md");
        writeFileSync(body, `Prepare ${tag} after validating source ${startingHead}.\n\nThe release job passed the full check and package/CLI smoke tests. After this version-only PR merges, it validates and packages the canonical master commit again before publishing.\n`);
        const pr = run("gh", ["pr", "create", "--repo", REPO, "--base", "master", "--head", branch,
          "--title", `chore(release): ${tag}`, "--body-file", body], { capture: true });
        if (!/^https:\/\/github\.com\/raysonmeng\/agent-bridge\/pull\/\d+$/.test(pr)) throw new Error("Unexpected version PR URL");
        const merged = attempt("gh", ["pr", "merge", pr, "--repo", REPO, "--squash", "--match-head-commit", commit, "--delete-branch"]);
        const result = JSON.parse(run("gh", ["pr", "view", pr, "--repo", REPO, "--json", "state,mergeCommit"], { capture: true }));
        fetchMaster();
        if (result.state !== "MERGED") {
          if (merged.status === 0 || git("rev-parse", "origin/master") === startingHead || retry === 2) {
            throw new Error(`Release version PR could not be merged: ${pr}`);
          }
          console.log("master advanced during validation; validating its new source before retrying");
        } else {
          const canonical = result.mergeCommit?.oid;
          if (!/^[0-9a-f]{40}$/.test(canonical ?? "") || !ancestor(canonical) || packageVersion(canonical) !== wanted) {
            throw new Error("Merged version PR does not match master history or version");
          }
          retry--; // Successful merge still needs final-source validation; it is not a failed attempt.
        }
        git("restore", "--", ...BUNDLES);
        continue;
      }
      if (!existingTag) {
        git("tag", tag);
        const pushed = attempt("git", ["push", "origin", `refs/tags/${tag}`]);
        if (pushed.status !== 0) {
          git("fetch", "origin", `refs/tags/${tag}`);
          if (git("rev-parse", "FETCH_HEAD^{commit}") !== commit) throw new Error(`Remote ${tag} points at another commit`);
        }
      }
      const release = attempt("gh", ["release", "view", tag, "--repo", REPO, "--json", "url,isDraft"], { capture: true });
      if (release.status !== 0) {
        if (!release.stderr?.toLowerCase().includes("release not found")) throw new Error(`Cannot inspect GitHub Release: ${release.stderr}`);
        const previous = git("tag", "--merged", "HEAD", "--sort=-version:refname").split("\n").find(t => t !== tag && /^v\d+\.\d+\.\d+$/.test(t));
        const notes = join(artifactDir, "release-notes.md");
        writeFileSync(notes, `${git("log", previous ? `${previous}..HEAD` : "HEAD", "--pretty=format:- %s", "--no-merges")}\n\nInstall: \`npm install -g ${PACKAGE}@${wanted}\`\n`);
        run("gh", ["release", "create", tag, "--repo", REPO, "--verify-tag", "--title", tag, "--notes-file", notes, "--latest"]);
      } else if (JSON.parse(release.stdout).isDraft) {
        run("gh", ["release", "edit", tag, "--repo", REPO, "--draft=false", "--latest"]);
      }
      run("gh", ["release", "upload", tag, tarball, "--repo", REPO, "--clobber"]);
      state = registryState();
      if (state.latest && compare(state.latest, wanted) > 0) throw new Error(`A newer ${state.latest} appeared; refusing to move latest backwards`);
      if (state.versions.includes(wanted)) {
        if (registry(`${PACKAGE}@${wanted}`, "dist").shasum !== shasum) throw new Error(`Published ${wanted} differs from the checked artifact`);
        console.log(`${PACKAGE}@${wanted} already contains this artifact; skipping duplicate upload`);
      } else {
        run("npm", ["publish", tarball, "--access=public", "--tag=latest", "--ignore-scripts", "--registry", REGISTRY],
          { env: { ...process.env, GITHUB_SHA: commit } });
      }
      let visible = false;
      for (let poll = 0; poll < 30; poll++) {
        try {
          const current = registryState();
          if (current.versions.includes(wanted) && current.latest === wanted) {
            if (registry(`${PACKAGE}@${wanted}`, "dist").shasum !== shasum) throw new Error("Registry artifact checksum mismatch");
            visible = true; break;
          }
        } catch (error) {
          if (error.message === "Registry artifact checksum mismatch") throw error;
          console.error(`Registry verification pending: ${error.message}`);
        }
        if (poll < 29) await sleep(20_000);
      }
      if (!visible) throw new Error(`Upload may already be accepted, but registry has not confirmed ${wanted}; rerun to recover this version`);
      const prefix = join(artifactDir, "installed");
      run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `${PACKAGE}@${wanted}`, "--registry", REGISTRY]);
      const cli = join(prefix, "node_modules/.bin/agentbridge");
      const installed = run(cli, ["--version"], { capture: true });
      if (!new RegExp(`^(?:agentbridge v)?${wanted.replaceAll(".", "\\.")}$`).test(installed)) throw new Error(`Installed version mismatch: ${installed}`);
      run(cli, ["--help"], { capture: true });
      const summary = `Published ${PACKAGE}@${wanted}\nTag commit: ${commit}\nSHA-256: ${sha256}\nRegistry latest, checksum and installed CLI verified.\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      return;
    }
  } finally { rmSync(artifactDir, { recursive: true, force: true }); }
}

main().catch(error => { console.error(`release: ${error.message}`); process.exitCode = 1; });
