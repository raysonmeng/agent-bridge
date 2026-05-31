#!/usr/bin/env bun
/**
 * In-session plugin-update reminder.
 *
 * The CLI notifier (src/update-notifier.ts) writes the latest npm version to the
 * update-check cache. This script — invoked by the SessionStart hook
 * (scripts/health-check.sh) — compares that `latest` against the INSTALLED
 * plugin version (plugin.json, passed as argv[2]) and prints a one-line reminder
 * to stdout if the plugin is behind. Prints NOTHING otherwise.
 *
 * Why a separate plugin-side reminder: the CLI prints its notice to the terminal
 * before Claude Code's TUI takes over, so a user who updates npm but not the
 * plugin would otherwise never see the mismatch from inside the session.
 *
 * Self-contained on purpose: the shipped plugin does not include src/, so the
 * tiny state-dir resolution + stable-semver compare are inlined here. Keep them
 * in sync with src/state-dir.ts (StateDirResolver) and src/version-utils.ts.
 * Silent on ANY error — it must never break the SessionStart hook.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/** Mirror of StateDirResolver (src/state-dir.ts). */
function stateDir() {
  const override = process.env.AGENTBRIDGE_STATE_DIR;
  if (override) return override;
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "AgentBridge");
  }
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "agentbridge");
}

const STABLE = /^\d+\.\d+\.\d+$/;

/** Mirror of isStableUpgrade (src/version-utils.ts): stable latest strictly > stable current. */
function isStableUpgrade(current, latest) {
  if (!STABLE.test(current) || !STABLE.test(latest)) return false;
  const a = current.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

try {
  // Honor the same opt-out as the CLI notifier (src/update-notifier.ts): a user
  // who silenced update notices must not still get the in-session reminder.
  if (process.env.NO_UPDATE_NOTIFIER || process.env.AGENTBRIDGE_NO_UPDATE_NOTIFIER) {
    process.exit(0);
  }

  const pluginJsonPath = process.argv[2];
  if (!pluginJsonPath) process.exit(0);

  const current = JSON.parse(readFileSync(pluginJsonPath, "utf-8")).version;
  const cache = JSON.parse(readFileSync(join(stateDir(), "update-check.json"), "utf-8"));
  const latest = cache?.latest;

  if (typeof current === "string" && typeof latest === "string" && isStableUpgrade(current, latest)) {
    process.stdout.write(
      `AgentBridge plugin update available: ${current} -> ${latest}. ` +
        `Update the plugin with /plugin marketplace update agentbridge then /reload-plugins ` +
        `(and the CLI with npm install -g @raysonmeng/agentbridge@latest) so the CLI and plugin versions match.`,
    );
  }
} catch {
  // No cache yet / no plugin.json / malformed — stay silent.
}
process.exit(0);
