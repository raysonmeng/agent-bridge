import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Integration test for the shipped plugin-side reminder script that the
// SessionStart hook invokes. It reads the update cache (written by the CLI
// notifier) and compares to the installed plugin version.
const SCRIPT = join(process.cwd(), "plugins/agentbridge/scripts/plugin-update-notice.mjs");

const dirs: string[] = [];
function setup(latest: string | null, pluginVersion: string): { stateDir: string; pluginJson: string } {
  const base = mkdtempSync(join(tmpdir(), "abg-pcn-"));
  dirs.push(base);
  const stateDir = join(base, "state");
  mkdirSync(stateDir, { recursive: true });
  if (latest !== null) {
    writeFileSync(join(stateDir, "update-check.json"), JSON.stringify({ lastCheckMs: 1, latest }));
  }
  const pluginJson = join(base, "plugin.json");
  writeFileSync(pluginJson, JSON.stringify({ name: "agentbridge", version: pluginVersion }));
  return { stateDir, pluginJson };
}
function run(stateDir: string, pluginJson: string, extraEnv: Record<string, string> = {}): string {
  const res = Bun.spawnSync(["bun", SCRIPT, pluginJson], {
    env: { ...process.env, AGENTBRIDGE_STATE_DIR: stateDir, ...extraEnv },
  });
  return res.stdout.toString();
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("plugin-update-notice.mjs", () => {
  test("prints a reminder when npm latest is newer than the installed plugin", () => {
    const { stateDir, pluginJson } = setup("0.1.9", "0.1.6");
    const out = run(stateDir, pluginJson);
    expect(out).toContain("plugin update available");
    expect(out).toContain("0.1.6 -> 0.1.9");
    expect(out).toContain("/plugin marketplace update agentbridge");
    expect(out).toContain("/reload-plugins");
  });

  test("prints nothing when the plugin is already at the latest version", () => {
    const { stateDir, pluginJson } = setup("0.1.6", "0.1.6");
    expect(run(stateDir, pluginJson).trim()).toBe("");
  });

  test("prints nothing for a prerelease latest (no beta nag)", () => {
    const { stateDir, pluginJson } = setup("0.2.0-beta.1", "0.1.6");
    expect(run(stateDir, pluginJson).trim()).toBe("");
  });

  test("prints nothing (silent) when no cache exists yet", () => {
    const { stateDir, pluginJson } = setup(null, "0.1.6");
    expect(run(stateDir, pluginJson).trim()).toBe("");
  });

  test("respects the NO_UPDATE_NOTIFIER opt-out even when an upgrade is available", () => {
    const { stateDir, pluginJson } = setup("0.1.9", "0.1.6");
    expect(run(stateDir, pluginJson, { NO_UPDATE_NOTIFIER: "1" }).trim()).toBe("");
    expect(run(stateDir, pluginJson, { AGENTBRIDGE_NO_UPDATE_NOTIFIER: "1" }).trim()).toBe("");
    // sanity: without the opt-out it DOES remind (proves the opt-out is what silenced it)
    expect(run(stateDir, pluginJson)).toContain("plugin update available");
  });
});
