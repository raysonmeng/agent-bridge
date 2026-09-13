import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const NODE = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
const GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const MANIFESTS = ["package.json", "plugins/agentbridge/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];
const BUNDLES = ["plugins/agentbridge/server/bridge-server.js", "plugins/agentbridge/server/daemon.js"];
const STAMP = "1234567";
const temporary: string[] = [];

interface Command {
  command: string;
  args: string[];
  version: string;
  head: string;
  githubSha?: string;
  dependencyFingerprint?: string;
  stamp?: string;
  oidc: boolean;
  npmToken: boolean;
}

// Only process boundaries are faked: version bumping and the entire Git graph
// use the real helpers/Git. Unknown external commands fail instead of reaching
// the network or silently passing a newly added release step.
const FAKE_COMMAND = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
const state = read(env.FAKE_STATE);
const save = () => fs.writeFileSync(env.FAKE_STATE, JSON.stringify(state));
const git = (a, cwd = process.cwd()) => cp.execFileSync(env.FAKE_REAL_GIT, a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let pkg = { version: "" }, head = "";
try { pkg = read(path.join(process.cwd(), "package.json")); head = git(["rev-parse", "HEAD"]); } catch {}
const dependencyFingerprint = crypto.createHash("sha256").update(JSON.stringify([
  pkg.dependencies ?? {}, pkg.devDependencies ?? {}, pkg.optionalDependencies ?? {}, pkg.peerDependencies ?? {},
  fs.existsSync("bun.lock") ? fs.readFileSync("bun.lock", "utf8") : null,
])).digest("hex");
const log = (name = command, argv = args) => fs.appendFileSync(env.FAKE_LOG, JSON.stringify({ command: name, args: argv, version: pkg.version, head,
  githubSha: env.GITHUB_SHA,
  dependencyFingerprint,
  stamp: env.AGENTBRIDGE_BUILD_COMMIT_OVERRIDE, oidc: !!env.ACTIONS_ID_TOKEN_REQUEST_URL && !!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  npmToken: !!env.NPM_TOKEN || !!env.NODE_AUTH_TOKEN }) + "\n");
log();
const fail = message => { console.error(message); process.exit(1); };
const output = value => console.log(JSON.stringify(value));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
if (command === "git") {
  if (args[0] === "push" && args.some(a => /(^|:)(refs\/heads\/)?master$/.test(a))) {
    fail("protected master requires a pull request");
  }
  const result = cp.spawnSync(env.FAKE_REAL_GIT, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (command === "bun") {
  if (args[0] === "--version") { console.log("1.3.11"); process.exit(0); }
  const step = args[0] === "run" ? args[1] : args[0];
  if (step === "install") {
    if (!args.includes("--frozen-lockfile") || !args.includes("--ignore-scripts")) fail("release install must preserve the lockfile and skip scripts");
    state.installedDependencyFingerprint = dependencyFingerprint; save();
  } else if (state.installedDependencyFingerprint !== dependencyFingerprint) {
    fail("dependencies not installed for current lockfile or manifests: " + step);
  }
  if (env.FAKE_FAIL === step) fail("injected failure: " + step);
  if (step === "build:plugin") {
    if (!env.AGENTBRIDGE_BUILD_COMMIT_OVERRIDE) fail("plugin build was not pinned");
    for (const file of ["bridge-server.js", "daemon.js"]) write("plugins/agentbridge/server/" + file,
      'version: "' + pkg.version + '", commit: defineString("' + env.AGENTBRIDGE_BUILD_COMMIT_OVERRIDE + '", "source")\n');
  } else if (step === "build:cli" || step === "prepublishOnly") {
    write("dist/cli.js", "built " + pkg.version); write("dist/daemon.js", "built " + pkg.version);
  } else if (!["check", "smoke:pack", "smoke:built", "scripts/smoke-built-cli.mjs", "verify:plugin-sync", "validate:plugin-versions", "install", "scripts/check-plugin-versions.js"].includes(step)) {
    fail("unexpected bun command: " + args.join(" "));
  }
  process.exit(0);
}
if (command === "gh") {
  if (args[0] === "pr") {
    const value = flag => args[args.indexOf(flag) + 1];
    if (args[1] === "create") {
      if (value("--base") !== "master") fail("release PR must target master");
      const branch = value("--head");
      const oid = git(["ls-remote", "origin", "refs/heads/" + branch]).split(/\s/)[0];
      if (!oid) fail("release PR branch was not pushed");
      const url = "https://github.com/raysonmeng/agent-bridge/pull/" + (Object.keys(state.prs).length + 1);
      state.prs[url] = { branch, head: oid, title: value("--title"), state: "OPEN", mergeCommit: null };
      save(); console.log(url); process.exit(0);
    }
    const pr = state.prs[args[2]];
    if (!pr) fail("pull request not found");
    if (args[1] === "view") { output({ state: pr.state, mergeCommit: pr.mergeCommit }); process.exit(0); }
    if (args[1] === "merge") {
      if (!args.includes("--squash") || value("--match-head-commit") !== pr.head) fail("release PR merge must match the checked head");
      if (env.FAKE_FAIL === "merge") fail("injected PR merge rejection");
      if (env.FAKE_RACE && (!state.raced || env.FAKE_RACE_ALWAYS)) {
        if (state.raced) git(["commit", "--allow-empty", "-qm", "another concurrent merge"], env.FAKE_RACE);
        state.raced = true; save(); git(["push", "origin", "master"], env.FAKE_RACE); log("race", []);
        fail("pull request is out of date after concurrent merge");
      }
      const merger = fs.mkdtempSync(path.join(env.RUNNER_TEMP, "pr-merge-"));
      try {
        git(["clone", "-q", "--branch", "master", git(["remote", "get-url", "origin"]), merger]);
        git(["fetch", "origin", "refs/heads/" + pr.branch], merger);
        git(["merge", "--squash", "FETCH_HEAD"], merger);
        git(["commit", "-qm", pr.title + " (#" + args[2].split("/").at(-1) + ")"], merger);
        const oid = git(["rev-parse", "HEAD"], merger);
        git(["push", "origin", "HEAD:master"], merger);
        if (args.includes("--delete-branch")) git(["push", "origin", "--delete", pr.branch], merger);
        pr.state = "MERGED"; pr.mergeCommit = { oid }; save();
      } finally { fs.rmSync(merger, { recursive: true, force: true }); }
      process.exit(0);
    }
    fail("unexpected gh pr command: " + args.join(" "));
  }
  const tag = args[2];
  if (args[0] === "release" && args[1] === "view") {
    if (!state.releases.includes(tag)) fail("release not found");
    output({ tagName: tag, url: "https://github.invalid/releases/" + tag, isDraft: false }); process.exit(0);
  }
  if (args[0] === "release" && args[1] === "create") {
    if (env.FAKE_FAIL === "release") fail("injected release failure");
    state.releases.push(tag); save(); process.exit(0);
  }
  if (args[0] === "release" && args[1] === "upload") { process.exit(0); }
  fail("unexpected gh command: " + args.join(" "));
}
if (command === "npm") {
  if (args[0] === "--version") { console.log("11.15.0"); process.exit(0); }
  if (["view", "publish", "install"].includes(args[0]) && args[args.indexOf("--registry") + 1] !== "https://registry.npmjs.org") fail("registry must be explicitly public");
  if (args[0] === "pack") {
    const filename = "raysonmeng-agentbridge-" + pkg.version + ".tgz";
    const bytes = Buffer.from(JSON.stringify({ version: pkg.version, head }));
    const shasum = crypto.createHash("sha1").update(bytes).digest("hex");
    const destination = args.includes("--pack-destination") ? args[args.indexOf("--pack-destination") + 1] : ".";
    write(path.join(destination, filename), bytes);
    state.packs[pkg.version] = { version: pkg.version, head, shasum }; save();
    output([{ filename, shasum, version: pkg.version }]); process.exit(0);
  }
  if (args[0] === "view") {
    const spec = args[1];
    const marker = spec.lastIndexOf("@");
    const requested = marker > 0 ? spec.slice(marker + 1) : null;
    const version = requested === "latest" ? state.latest : requested;
    if (version) {
      const published = state.versions[version];
      if (!published) { output({ error: { code: "E404", summary: "not found" } }); process.exit(1); }
      const metadata = { version, dist: { shasum: published.shasum }, gitHead: published.head };
      const fields = args.slice(2).filter(a => !a.startsWith("--") && !a.startsWith("https:"));
      const value = field => field.split(".").reduce((v, key) => v?.[key], metadata);
      output(fields.length === 1 ? value(fields[0]) : Object.fromEntries(fields.map(field => [field, value(field)])));
    } else output({ versions: Object.keys(state.versions), "dist-tags": { latest: state.latest } });
    process.exit(0);
  }
  if (args[0] === "publish") {
    if (env.FAKE_FAIL === "publish") fail("injected publish failure");
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) fail("missing OIDC");
    const tarball = args.find(a => a.endsWith(".tgz"));
    if (!tarball) fail("publish must use the packed tarball");
    const bytes = fs.readFileSync(tarball);
    const packed = JSON.parse(bytes);
    const shasum = crypto.createHash("sha1").update(bytes).digest("hex");
    state.versions[packed.version] = { shasum, head: packed.head }; state.latest = packed.version; save(); process.exit(0);
  }
  if (args[0] === "install") {
    const prefix = args[args.indexOf("--prefix") + 1];
    if (!args.includes("--ignore-scripts") || !args.includes("--prefix") || !prefix) fail("unsafe install");
    const installed = args.find(a => a.startsWith("@raysonmeng/agentbridge@"))?.split("@").at(-1);
    if (!state.versions[installed]) fail("install requested unpublished version");
    const cli = '#!' + env.FAKE_NODE + '\n' +
      'const fs = require("node:fs"); fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({command:"installed-cli",args:process.argv.slice(2),version:' + JSON.stringify(installed) + '}) + "\\n"); console.log(' + JSON.stringify(installed) + ');\n';
    for (const file of ["bin/agentbridge", "node_modules/.bin/agentbridge", "node_modules/@raysonmeng/agentbridge/dist/cli.js", "lib/node_modules/@raysonmeng/agentbridge/dist/cli.js"]) {
      write(path.join(prefix, file), cli); fs.chmodSync(path.join(prefix, file), 0o755);
    }
    for (const file of ["node_modules/@raysonmeng/agentbridge/package.json", "lib/node_modules/@raysonmeng/agentbridge/package.json"]) write(path.join(prefix, file), JSON.stringify({ version: installed }));
    process.exit(0);
  }
  fail("unexpected npm command: " + args.join(" "));
}
fail("unexpected command: " + command);
`;

function fixture(ambient: NodeJS.ProcessEnv = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "agentbridge-release-"));
  temporary.push(dir);
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    ...ambient,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Release Test", GIT_AUTHOR_EMAIL: "release@example.invalid",
    GIT_COMMITTER_NAME: "Release Test", GIT_COMMITTER_EMAIL: "release@example.invalid",
    GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "raysonmeng/agent-bridge", GITHUB_REF: "refs/heads/master",
    GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: join(dir, "event.json"), RUNNER_TEMP: dir,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GITHUB_TOKEN: "test-actions-token", GH_TOKEN: "test-actions-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc",
    FAKE_STATE: join(dir, "state.json"), FAKE_LOG: join(dir, "commands.jsonl"), FAKE_REAL_GIT: GIT, FAKE_NODE: NODE,
  };
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  const git = (args: string[], cwd = repo) => execFileSync(GIT, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const setVersion = (version: string) => {
    write("package.json", JSON.stringify({ name: "@raysonmeng/agentbridge", version, type: "module", bin: { agentbridge: "dist/cli.js" } }, null, 2) + "\n");
    write(MANIFESTS[1], JSON.stringify({ name: "agentbridge", version }, null, 2) + "\n");
    write(MANIFESTS[2], JSON.stringify({ plugins: [{ name: "agentbridge", version }] }, null, 2) + "\n");
    for (const file of BUNDLES) write(file, `version: "${version}", commit: defineString("${STAMP}", "source")\n`);
  };
  const commit = (message: string) => {
    git(["add", "."]);
    git(["commit", "-qm", message]);
    return git(["rev-parse", "HEAD"]);
  };
  const state = () => JSON.parse(readFileSync(env.FAKE_STATE!, "utf8"));
  const updateState = (changes: Record<string, unknown>) => writeFileSync(env.FAKE_STATE!, JSON.stringify({ ...state(), ...changes }));
  const commands = (): Command[] => readFileSync(env.FAKE_LOG!, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  writeFileSync(env.FAKE_STATE!, JSON.stringify({ versions: {}, latest: null, releases: [], packs: {}, prs: {} }));
  writeFileSync(env.FAKE_LOG!, "");
  for (const command of ["git", "bun", "npm", "gh"]) writeFileSync(join(bin, command), `#!${NODE}\n${FAKE_COMMAND}`, { mode: 0o755 });
  git(["init", "--bare", "-q", origin]);
  git(["init", "-qb", "master"]);
  git(["config", "core.hooksPath", "/dev/null"]);
  git(["remote", "add", "origin", origin]);
  write(".gitignore", "dist/\n*.tgz\nnode_modules/\n");
  write("bun.lock", '{"lockfileVersion":1,"packages":{}}\n');
  setVersion("0.1.31");
  for (const file of ["bump-version.mjs", "bundle-commit.cjs", "publish-release.mjs"]) {
    const source = join(ROOT, "scripts", file);
    if (existsSync(source)) {
      mkdirSync(join(repo, "scripts"), { recursive: true });
      copyFileSync(source, join(repo, "scripts", file));
    }
  }
  const setEvent = (sha: string, message: string) => {
    env.GITHUB_SHA = sha;
    writeFileSync(env.GITHUB_EVENT_PATH!, JSON.stringify({ before, after: sha, head_commit: { message }, commits: [{ message }] }));
  };
  const before = commit("initial release fixture");
  write("feature.txt", "feature\n");
  const sha = commit("feat: release fixture");
  git(["push", "-qu", "origin", "master"]);
  setEvent(sha, "feat: release fixture");
  const run = (overrides: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(NODE, [join(repo, "scripts/publish-release.mjs")], { cwd: repo, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000 });
    return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  };
  const remoteHead = () => git(["--git-dir", origin, "rev-parse", "master"]);
  const remoteVersion = () => JSON.parse(git(["--git-dir", origin, "show", "master:package.json"])).version;
  return { dir, repo, origin, env, git, write, setVersion, setEvent, commit, state, updateState, commands, before, sha, run, remoteHead, remoteVersion };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function succeeds(result: { status: number | null; output: string }) {
  expect(result.output).not.toContain("unexpected ");
  expect(result.status, result.output).toBe(0);
}

function fails(result: { status: number | null; output: string }, reason?: string) {
  expect(result.output).not.toContain("unexpected ");
  expect(result.output).not.toContain("Cannot find module");
  expect(result.status, result.output).not.toBeNull();
  expect(result.status, result.output).not.toBe(0);
  if (reason) expect(result.output).toContain(reason);
}

describe("Actions OIDC release transaction", () => {
  test("fixture summaries never append simulated release receipts to the ambient Actions summary", () => {
    const external = mkdtempSync(join(tmpdir(), "agentbridge-release-summary-"));
    temporary.push(external);
    const sentinel = join(external, "real-actions-summary.md");
    const original = "Existing real Actions summary\n";
    writeFileSync(sentinel, original);
    const f = fixture({ ...process.env, GITHUB_STEP_SUMMARY: sentinel });
    succeeds(f.run());
    expect(readFileSync(sentinel, "utf8")).toBe(original);
    expect(readFileSync(join(f.dir, "summary.md"), "utf8")).toContain("Published @raysonmeng/agentbridge@0.1.32");
  }, 60_000);

  test("auto-patches once, validates before pushing, and publishes the exact packed artifact", () => {
    const f = fixture();
    f.git(["tag", "v0.1.31", f.before]);
    f.git(["push", "origin", "v0.1.31"]);
    succeeds(f.run());
    expect(f.remoteVersion()).toBe("0.1.32");
    const released = f.git(["--git-dir", f.origin, "rev-parse", "v0.1.32^{commit}"]);
    expect(released).toBe(f.remoteHead());
    for (const file of MANIFESTS) expect(f.git(["show", `${released}:${file}`])).toContain("0.1.32");
    for (const file of BUNDLES) {
      expect(f.git(["show", `${released}:${file}`])).toContain("0.1.32");
      expect(f.git(["show", `${released}:${file}`])).toContain(STAMP);
    }
    const commands = f.commands();
    const firstBun = commands.find(c => c.command === "bun")!;
    expect(firstBun.args[0]).toBe("install");
    const prepublish = commands.find(c => c.command === "bun" && c.args.includes("prepublishOnly"))!;
    expect(prepublish.head).not.toBe(firstBun.head); // The release commit changes metadata, not dependencies.
    expect(prepublish.dependencyFingerprint).toBe(firstBun.dependencyFingerprint);
    expect(released).not.toBe(prepublish.head); // GitHub squash creates a new canonical commit.
    const canonicalChecks = commands.filter(c => c.command === "bun" && c.head === released);
    for (const step of ["install", "check", "prepublishOnly", "smoke:pack", "scripts/smoke-built-cli.mjs"]) {
      expect(canonicalChecks.some(c => c.args.includes(step))).toBe(true);
    }
    const index = (command: string, arg: string) => commands.findIndex(c => c.command === command && c.args.includes(arg));
    const firstPush = index("git", "push");
    expect(index("bun", "check")).toBeGreaterThanOrEqual(0);
    expect(index("bun", "check")).toBeLessThan(firstPush);
    expect(index("bun", "scripts/smoke-built-cli.mjs")).toBeLessThan(firstPush);
    expect(index("bun", "scripts/smoke-built-cli.mjs")).toBeGreaterThanOrEqual(0);
    expect(index("bun", "smoke:pack")).toBeGreaterThanOrEqual(0);
    expect(index("bun", "smoke:pack")).toBeLessThan(firstPush);
    const releaseCreate = commands.findIndex(c => c.command === "gh" && c.args[0] === "release" && c.args[1] === "create");
    const tagPush = commands.findIndex(c => c.command === "git" && c.args[0] === "push" && c.args.includes("refs/tags/v0.1.32"));
    const canonicalCheck = commands.findIndex(c => c.command === "bun" && c.args.includes("check") && c.head === released);
    expect(canonicalCheck).toBeLessThan(tagPush);
    expect(releaseCreate).toBeGreaterThan(tagPush);
    expect(index("npm", "publish")).toBeGreaterThan(releaseCreate);
    expect(index("npm", "publish")).toBeGreaterThan(index("npm", "pack"));
    const published = commands.find(c => c.command === "npm" && c.args[0] === "publish")!;
    expect(published.head).toBe(released);
    expect(published.githubSha).toBe(released);
    expect(published.args.some(a => a.endsWith(".tgz"))).toBe(true);
    expect(published.oidc).toBe(true);
    expect(published.npmToken).toBe(false);
    expect(published.args[published.args.indexOf("--registry") + 1]).toBe("https://registry.npmjs.org");
    expect(commands.find(c => c.command === "gh" && c.args[1] === "upload")!.args).toContain(published.args[1]);
    expect(f.state().versions["0.1.32"].shasum).toBe(f.state().packs["0.1.32"].shasum);
    expect(f.state().versions["0.1.32"].head).toBe(released);
    expect(f.state().latest).toBe("0.1.32");
    expect(commands.filter(c => c.command === "installed-cli").map(c => c.args[0]).sort()).toEqual(["--help", "--version"]);
    const head = f.remoteHead();
    succeeds(f.run());
    expect(f.remoteHead()).toBe(head);
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(1);
  }, 60_000);

  test("a manually bumped event publishes that version without adding another bump", () => {
    const f = fixture();
    f.setVersion("0.1.40");
    f.setEvent(f.commit("chore: manually bump version"), "chore: manually bump version");
    f.git(["push", "origin", "master"]);
    succeeds(f.run());
    expect(f.remoteVersion()).toBe("0.1.40");
    expect(f.remoteHead()).toBe(f.env.GITHUB_SHA!);
  });

  test("skip-release commits perform no release writes", () => {
    const f = fixture();
    f.write("docs.txt", "examples\n");
    f.setEvent(f.commit("docs: examples [skip release]"), "docs: examples [skip release]");
    f.git(["push", "origin", "master"]);
    succeeds(f.run());
    expect(f.remoteHead()).toBe(f.env.GITHUB_SHA!);
    expect(f.commands().filter(c => c.args[0] === "push" || c.command === "gh" || (c.command === "npm" && c.args[0] === "publish"))).toHaveLength(0);
  });

  test("dispatch defaults to recovering the existing version; bump=true opts into a patch", () => {
    for (const bump of [false, true]) {
      const f = fixture();
      writeFileSync(f.env.GITHUB_EVENT_PATH!, JSON.stringify({ inputs: bump ? { bump: "true" } : {} }));
      succeeds(f.run({ GITHUB_EVENT_NAME: "workflow_dispatch" }));
      expect(f.remoteVersion()).toBe(bump ? "0.1.32" : "0.1.31");
    }
  }, 60_000);

  test("an existing ancestor tag is resumed from its exact commit", () => {
    const f = fixture();
    f.git(["tag", "v0.1.31", f.before]);
    f.git(["push", "origin", "v0.1.31"]);
    f.write("bun.lock", '{"lockfileVersion":1,"packages":{"later-dependency":[]}}\n');
    const latestMaster = f.commit("deps: change dependencies after the tagged release");
    f.git(["push", "origin", "master"]);
    writeFileSync(f.env.GITHUB_EVENT_PATH!, JSON.stringify({ inputs: {} }));
    succeeds(f.run({ GITHUB_EVENT_NAME: "workflow_dispatch" }));
    expect(f.remoteHead()).toBe(latestMaster);
    expect(f.state().versions["0.1.31"].head).toBe(f.before);
    const published = f.commands().find(c => c.command === "npm" && c.args[0] === "publish")!;
    expect(published.githubSha).toBe(f.before);
    expect(f.remoteVersion()).toBe("0.1.31");
  });

  test("a tag with a mismatched manifest is refused before publishing", () => {
    const f = fixture();
    f.setVersion("0.1.32");
    f.setEvent(f.commit("chore: manual bump"), "chore: manual bump");
    f.git(["tag", "v0.1.32", f.before]);
    f.git(["push", "origin", "master", "v0.1.32"]);
    fails(f.run());
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(0);
    expect(f.remoteHead()).toBe(f.env.GITHUB_SHA!);
  });

  test("a tag outside master ancestry is refused before publishing", () => {
    const f = fixture();
    f.git(["checkout", "-qb", "side", f.before]);
    f.write("side.txt", "unmerged\n");
    const side = f.commit("unmerged release");
    f.git(["tag", "v0.1.31", side]);
    f.git(["push", "origin", "v0.1.31"]);
    f.git(["checkout", "master"]);
    writeFileSync(f.env.GITHUB_EVENT_PATH!, JSON.stringify({ inputs: {} }));
    fails(f.run({ GITHUB_EVENT_NAME: "workflow_dispatch" }));
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(0);
  });

  test("check or smoke failure leaves the remote branch and tags untouched", () => {
    for (const step of ["check", "scripts/smoke-built-cli.mjs", "smoke:pack"]) {
      const f = fixture();
      fails(f.run({ FAKE_FAIL: step }), "injected failure: " + step);
      expect(f.remoteHead()).toBe(f.sha);
      expect(f.git(["--git-dir", f.origin, "tag", "--list"])).toBe("");
      expect(f.commands().filter(c => c.command === "git" && c.args[0] === "push")).toHaveLength(0);
      expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(0);
    }
  }, 60_000);

  test("a rejected release PR never creates a release tag or publishes npm", () => {
    const f = fixture();
    fails(f.run({ FAKE_FAIL: "merge" }), "injected PR merge rejection");
    expect(f.remoteHead()).toBe(f.sha);
    expect(f.git(["--git-dir", f.origin, "tag", "--list"])).toBe("");
    expect(f.commands().filter(c => c.command === "gh" && c.args[0] === "release")).toHaveLength(0);
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(0);
  });

  test("a non-fast-forward race revalidates the new master and publishes only the replacement candidate", () => {
    const f = fixture();
    const racer = join(f.dir, "racer");
    f.git(["clone", "-q", "--branch", "master", f.origin, racer]);
    writeFileSync(join(racer, "concurrent.txt"), "another merge\n");
    writeFileSync(join(racer, "bun.lock"), '{"lockfileVersion":1,"packages":{"concurrent-dependency":[]}}\n');
    f.git(["add", "."], racer);
    f.git(["commit", "-qm", "feat: concurrent merge"], racer);
    const raceHead = f.git(["rev-parse", "HEAD"], racer);
    succeeds(f.run({ FAKE_RACE: racer }));
    expect(f.remoteVersion()).toBe("0.1.32");
    expect(f.git(["show", `${f.remoteHead()}:concurrent.txt`])).toBe("another merge");
    const checks = f.commands().filter(c => c.command === "bun" && c.args.includes("check"));
    expect(checks).toHaveLength(3);
    expect(checks[1].head).not.toBe(checks[0].head);
    expect(checks[2].head).toBe(f.remoteHead());
    const installs = f.commands().filter(c => c.command === "bun" && c.args[0] === "install");
    const builds = f.commands().filter(c => c.command === "bun" && c.args.includes("build:plugin"));
    expect(installs).toHaveLength(3);
    expect(installs[0].dependencyFingerprint).not.toBe(installs[1].dependencyFingerprint);
    expect(installs[2].dependencyFingerprint).toBe(installs[1].dependencyFingerprint);
    expect(builds.map(c => c.dependencyFingerprint)).toEqual(installs.slice(0, 2).map(c => c.dependencyFingerprint));
    expect(checks.map(c => c.dependencyFingerprint)).toEqual(installs.map(c => c.dependencyFingerprint));
    expect(f.git(["merge-base", "--is-ancestor", raceHead, f.remoteHead()])).toBe("");
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(1);
    expect(f.state().versions["0.1.32"].head).toBe(f.remoteHead());
  }, 60_000);

  test("a newer master version resumes that release instead of applying another patch", () => {
    const f = fixture();
    f.setVersion("0.1.32");
    const bumped = f.commit("chore: bump version to 0.1.32");
    f.git(["tag", "v0.1.32", bumped]);
    f.git(["push", "origin", "master", "v0.1.32"]);
    f.git(["switch", "--detach", f.sha]);
    succeeds(f.run());
    expect(f.remoteHead()).toBe(bumped);
    expect(f.remoteVersion()).toBe("0.1.32");
    expect(f.state().versions["0.1.32"].head).toBe(bumped);
    expect(f.commands().filter(c => c.command === "git" && c.args[0] === "commit")).toHaveLength(0);
  });

  test("repeated master races stop after three validations without publishing a stale candidate", () => {
    const f = fixture();
    const racer = join(f.dir, "racer");
    f.git(["clone", "-q", "--branch", "master", f.origin, racer]);
    f.git(["commit", "--allow-empty", "-qm", "concurrent merge"], racer);
    fails(f.run({ FAKE_RACE: racer, FAKE_RACE_ALWAYS: "1" }), "Release version PR could not be merged");
    expect(f.remoteVersion()).toBe("0.1.31");
    expect(f.commands().filter(c => c.command === "bun" && c.args.includes("check"))).toHaveLength(3);
    expect(f.commands().filter(c => c.command === "git" && c.args[0] === "push")).toHaveLength(3);
    expect(f.git(["--git-dir", f.origin, "tag", "--list"])).toBe("");
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(0);
  }, 60_000);

  test("a failure after pushing the bump and tag can be rerun without a second bump", () => {
    const f = fixture();
    fails(f.run({ FAKE_FAIL: "release" }), "injected release failure");
    const bumped = f.remoteHead();
    expect(f.remoteVersion()).toBe("0.1.32");
    expect(f.git(["--git-dir", f.origin, "rev-parse", "v0.1.32^{commit}"])).toBe(bumped);
    expect(f.state().versions).toEqual({});
    succeeds(f.run());
    expect(f.remoteHead()).toBe(bumped);
    expect(f.state().versions["0.1.32"].head).toBe(bumped);
    expect(f.commands().filter(c => c.command === "git" && c.args[0] === "commit")).toHaveLength(1);
  }, 60_000);

  test("resuming an already published older version never moves latest backwards", () => {
    const f = fixture();
    succeeds(f.run());
    const published = f.state().versions;
    f.updateState({ versions: { ...published, "0.2.0": { shasum: "newer", head: "newer" } }, latest: "0.2.0" });
    succeeds(f.run());
    expect(f.state().latest).toBe("0.2.0");
    expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(1);
  }, 60_000);

  test("registry checksum conflicts and newer latest versions cannot be overwritten", () => {
    for (const scenario of ["checksum", "newer-unpublished", "newer-checksum"]) {
      const f = fixture();
      const version = scenario === "checksum" ? "0.1.31" : "0.2.0";
      const versions: Record<string, { shasum: string; head: string }> = { [version]: { shasum: "different", head: "other" } };
      if (scenario === "newer-checksum") versions["0.1.31"] = { shasum: "different", head: "other" };
      f.updateState({ versions, latest: version });
      writeFileSync(f.env.GITHUB_EVENT_PATH!, JSON.stringify({ inputs: {} }));
      fails(f.run({ GITHUB_EVENT_NAME: "workflow_dispatch" }));
      expect(f.commands().filter(c => c.command === "npm" && c.args[0] === "publish")).toHaveLength(0);
      expect(f.state().latest).toBe(version);
    }
  }, 60_000);

  test("missing OIDC and contexts outside the repository master workflow are rejected", () => {
    const f = fixture();
    for (const overrides of [
      { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, { ACTIONS_ID_TOKEN_REQUEST_URL: "" },
      { GITHUB_ACTIONS: "false" }, { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_REPOSITORY: "somebody/fork" }, { GITHUB_EVENT_NAME: "pull_request" },
      { GH_TOKEN: "" }, { NPM_TOKEN: "test-legacy-token" }, { NODE_AUTH_TOKEN: "test-legacy-token" },
    ]) {
      fails(f.run(overrides));
    }
    expect(f.remoteHead()).toBe(f.sha);
    expect(f.commands()).toHaveLength(0);
  });
});
