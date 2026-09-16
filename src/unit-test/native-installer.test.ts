import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const INSTALLER = join(ROOT, "install.sh");

function makeFixture({ active = false, badChecksum = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentbridge-installer-test-"));
  const release = join(root, "release");
  const packageRoot = join(release, "package");
  const bin = join(root, "bin");
  const data = join(root, "data");
  const stubs = join(root, "stubs");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(join(packageRoot, "plugins", "agentbridge", "server"), { recursive: true });
  mkdirSync(stubs);

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@raysonmeng/agentbridge", version: "1.2.3" }));
  writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env bun\n");
  writeFileSync(join(packageRoot, "dist", "daemon.js"), "daemon\n");
  writeFileSync(join(packageRoot, "plugins", "agentbridge", "server", "bridge-server.js"), "bridge\n");
  writeFileSync(join(packageRoot, "plugins", "agentbridge", "server", "daemon.js"), "daemon\n");
  chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);

  const archive = join(release, "agentbridge.tgz");
  execFileSync("tar", ["-czf", archive, "-C", release, "package"]);
  const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(release, "agentbridge.tgz.sha256"), `${badChecksum ? "0".repeat(64) : checksum}  agentbridge.tgz\n`);

  const writeStub = (name: string, body: string) => {
    const path = join(stubs, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  writeStub("bun", 'if [ "$1" = "--version" ]; then echo "1.4.0"; else exit 0; fi');
  writeStub("claude", `printf '%s\\n' "$*" >> "${join(root, "claude.log")}"`);
  writeStub("codex", "exit 0");
  writeStub("ps", active ? 'echo "123 agentbridge daemon bridge-server.js"' : "exit 0");

  return {
    root,
    release,
    bin,
    data,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      AGENTBRIDGE_RELEASE_BASE_URL: `file://${release}`,
      AGENTBRIDGE_INSTALL_ROOT: data,
      AGENTBRIDGE_BIN_DIR: bin,
    },
    claudeLog: join(root, "claude.log"),
  };
}

function runInstaller(fixture: ReturnType<typeof makeFixture>, args: string[] = ["--yes"]) {
  return spawnSync("bash", [INSTALLER, ...args], {
    cwd: ROOT,
    env: fixture.env,
    encoding: "utf-8",
  });
}

describe("native installer", () => {
  test("downloads, verifies, stages and activates a release package", () => {
    const fixture = makeFixture();
    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.data, "versions", "1.2.3", "dist", "cli.js"))).toBe(true);
    expect(readFileSync(join(fixture.bin, "agentbridge"), "utf-8")).toContain("#!/usr/bin/env bun");
    expect(readFileSync(fixture.claudeLog, "utf-8")).toContain("plugin marketplace add");
  });

  test("rejects a release package with a checksum mismatch", () => {
    const fixture = makeFixture({ badChecksum: true });
    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("checksum");
    expect(existsSync(join(fixture.data, "versions"))).toBe(false);
  });

  test("refuses to replace an active pair unless --force is explicit", () => {
    const fixture = makeFixture({ active: true });
    const result = runInstaller(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--force");
    expect(existsSync(join(fixture.data, "versions"))).toBe(false);
  });

  test("dry-run reports actions without touching the filesystem", () => {
    const fixture = makeFixture();
    const result = runInstaller(fixture, ["--yes", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Would download");
    expect(existsSync(fixture.data)).toBe(false);
    expect(existsSync(fixture.bin)).toBe(false);
  });
});
