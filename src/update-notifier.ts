/**
 * Update notifier (#auto-update).
 *
 * Tells the user when a newer stable AgentBridge is available on npm. Designed to
 * be correct-by-construction:
 *   - ZERO network on most runs: a notice is printed from a cached `latest`
 *     (populated by a prior run); the network is hit at most once per `interval`.
 *   - PROMPTS only for a cached upgrade on an interactive TTY. The prompt
 *     defaults to "no" after a short timeout so unattended launchers continue.
 *     Confirming runs the npm global update with inherited stdio; a successful
 *     update asks the user to rerun the command, while a failed update warns and
 *     continues the original launch.
 *   - NON-INTERACTIVE remains non-blocking: CI, non-TTY, test, and opt-out envs
 *     never prompt; `AGENTBRIDGE_UPDATE_PROMPT=0` keeps the old pure notice.
 *   - SILENT on any failure (offline, 404, proxy, malformed JSON, timeout).
 *   - SUPPRESSED for non-TTY/CI/test and via opt-out env vars.
 *   - STABLE-only: never nags about prereleases or downgrades (see version-utils).
 *   - DISMISSIBLE per version: saying no records `dismissedVersion`, so the same
 *     version only gets a short reminder; a newer version asks again.
 *
 * npm is queried as the single authoritative source: the user running `abg`
 * installed the CLI from npm, and `scripts/check-plugin-versions.js` keeps the
 * package/plugin/marketplace versions equal, so npm's `dist-tags.latest` is a
 * faithful proxy for the plugin version too. The notice still surfaces both the
 * CLI (`npm i -g`) and plugin (`/plugin marketplace update`) upgrade paths.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { atomicWriteJson } from "./atomic-json";
import { StateDirResolver } from "./state-dir";
import { isStableUpgrade, isStableVersion } from "./version-utils";
import { parsePositiveIntEnv } from "./env-utils";

export const PACKAGE_NAME = "@raysonmeng/agentbridge";
/** Scope must be URL-encoded (`@scope%2Fname`) in the registry path. */
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
/** Abbreviated metadata — smallest payload that still carries `dist-tags`. */
const ABBREVIATED_ACCEPT = "application/vnd.npm.install-v1+json";
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 2500;
export const DEFAULT_UPDATE_PROMPT_TIMEOUT_MS = 15_000;
const CHECK_INTERVAL_ENV = "AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS";

export interface UpdateCache {
  /** Epoch ms of the last completed network check. */
  lastCheckMs: number;
  /** Last-known stable `latest` from npm, or null if never/failed. */
  latest: string | null;
  /** Stable latest version the user declined; the same version will not prompt again. */
  dismissedVersion?: string | null;
}

export type UpdateNotifierDecision = "continue" | "updated";

export interface UpdateInstallResult {
  ok: boolean;
  status?: number | null;
  error?: Error;
}

export type UpdateInstaller = (cmd: string, args: string[]) => UpdateInstallResult;

export interface NotifierDeps {
  /** Installed version. Defaults to the build-time package version. */
  current?: string;
  /** Whether to fire the daily background refresh. Only true for long-lived launchers. */
  refresh?: boolean;
  stateDir?: StateDirResolver;
  now?: () => number;
  /** Whether output goes to a TTY (defaults to stderr.isTTY). */
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  print?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  /** Whether stdin can be used for an interactive prompt (defaults to stdin.isTTY). */
  inputIsTTY?: boolean;
  promptTimeoutMs?: number;
  promptUpdate?: (opts: { current: string; latest: string; timeoutMs: number }) => Promise<boolean>;
  installUpdate?: UpdateInstaller;
}

/** Installed version, inlined at build time by Bun's bundler (see printVersion). */
export function getCurrentVersion(): string {
  try {
    return (require("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/** Whether the notice should be fully suppressed for this environment. */
export function isUpdateCheckSuppressed(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  // Ecosystem-standard opt-out + namespaced opt-out (any non-empty value disables).
  if (env.NO_UPDATE_NOTIFIER) return true;
  if (env.AGENTBRIDGE_NO_UPDATE_NOTIFIER) return true;
  if (env.CI) return true; // don't nag in CI
  if (env.NODE_ENV === "test") return true;
  if (!isTTY) return true; // piped/redirected — keep output clean
  return false;
}

function readCache(stateDir: StateDirResolver): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(stateDir.updateCheckFile, "utf-8")) as Partial<UpdateCache>;
    if (typeof parsed.lastCheckMs !== "number" || !Number.isFinite(parsed.lastCheckMs)) return null;
    return {
      lastCheckMs: parsed.lastCheckMs,
      latest: typeof parsed.latest === "string" ? parsed.latest : null,
      dismissedVersion: typeof parsed.dismissedVersion === "string" ? parsed.dismissedVersion : undefined,
    };
  } catch {
    return null; // missing / corrupt → treat as "no cache, recheck"
  }
}

function writeCache(stateDir: StateDirResolver, cache: UpdateCache): void {
  try {
    atomicWriteJson(stateDir.updateCheckFile, cache);
  } catch {
    // best-effort; a failed cache write just means we recheck next time
  }
}

/** Extract + validate the stable `dist-tags.latest` from an npm registry body. */
export function parseLatestFromRegistry(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const distTags = (body as Record<string, unknown>)["dist-tags"];
  if (typeof distTags !== "object" || distTags === null) return null;
  const latest = (distTags as Record<string, unknown>).latest;
  if (typeof latest !== "string" || !isStableVersion(latest)) return null;
  return latest;
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      headers: { Accept: ABBREVIATED_ACCEPT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseLatestFromRegistry(await res.json());
  } catch {
    return null; // offline / timeout / DNS / 4xx / malformed JSON — all silent
  }
}

/**
 * Refresh the cache from npm. On a transient failure the previously-known
 * `latest` is preserved (only `lastCheckMs` advances) so we neither lose a good
 * value nor hammer the registry. Swallows all errors.
 */
export async function refreshUpdateCache(deps: NotifierDeps = {}): Promise<void> {
  const stateDir = deps.stateDir ?? new StateDirResolver();
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const latest = await fetchLatest(fetchImpl);
    const prev = readCache(stateDir);
    writeCache(stateDir, {
      lastCheckMs: now(),
      latest: latest ?? prev?.latest ?? null,
      dismissedVersion: prev?.dismissedVersion,
    });
  } catch {
    // never throw
  }
}

/** The user-facing notice. TTY-aware (color only on a terminal). */
export function buildUpdateNotice(current: string, latest: string, isTTY: boolean): string {
  const yellow = isTTY ? "\x1b[33m" : "";
  const bold = isTTY ? "\x1b[1m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  return [
    `${yellow}⚠ AgentBridge update available: ${bold}${current}${reset}${yellow} → ${bold}${latest}${reset}`,
    `  CLI:    npm install -g ${PACKAGE_NAME}@latest`,
    `  Plugin: /plugin marketplace update agentbridge   (then /reload-plugins)`,
    `  (silence with NO_UPDATE_NOTIFIER=1)`,
  ].join("\n");
}

export function buildDismissedUpdateNotice(current: string, latest: string, isTTY: boolean): string {
  const yellow = isTTY ? "\x1b[33m" : "";
  const bold = isTTY ? "\x1b[1m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  return `${yellow}⚠ AgentBridge update available: ${bold}${current}${reset}${yellow} → ${bold}${latest}${reset} (previously dismissed)`;
}

function checkIntervalMs(env: NodeJS.ProcessEnv): number {
  // Read from the injected env (not process.env) so the deps.env DI contract
  // holds end-to-end and the interval is overridable/testable.
  return parsePositiveIntEnv(CHECK_INTERVAL_ENV, DEFAULT_CHECK_INTERVAL_MS, undefined, env);
}

function updatePromptDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.AGENTBRIDGE_UPDATE_PROMPT === "0";
}

function defaultInstallUpdate(cmd: string, args: string[]): UpdateInstallResult {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) return { ok: false, status: res.status, error: res.error };
  return { ok: res.status === 0, status: res.status };
}

function defaultPromptUpdate(opts: { current: string; latest: string; timeoutMs: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(answer);
    };
    timer = setTimeout(() => {
      process.stderr.write("\n");
      finish(false);
    }, opts.timeoutMs);
    timer.unref?.();
    rl.question(`Update AgentBridge now? [y/N] `, (answer) => {
      finish(/^y(?:es)?$/i.test(answer.trim()));
    });
  });
}

function recordDismissal(stateDir: StateDirResolver, cache: UpdateCache, latest: string): void {
  writeCache(stateDir, {
    ...cache,
    latest,
    dismissedVersion: latest,
  });
}

/**
 * Best-effort update notice. Prints a notice from cached `latest` (if a newer
 * stable version exists). On an interactive TTY, it may prompt before the command
 * starts; otherwise it keeps the old non-blocking notice behavior. NEVER throws.
 */
export async function maybeNotifyUpdate(deps: NotifierDeps = {}): Promise<UpdateNotifierDecision> {
  try {
    const env = deps.env ?? process.env;
    const isTTY = deps.isTTY ?? Boolean(process.stderr.isTTY);
    if (isUpdateCheckSuppressed(env, isTTY)) return "continue";

    const current = deps.current ?? getCurrentVersion();
    const stateDir = deps.stateDir ?? new StateDirResolver();
    const now = deps.now ?? Date.now;
    const print = deps.print ?? ((m: string) => process.stderr.write(m + "\n"));
    const inputIsTTY = deps.inputIsTTY ?? Boolean(process.stdin.isTTY);
    const promptTimeoutMs = deps.promptTimeoutMs ?? DEFAULT_UPDATE_PROMPT_TIMEOUT_MS;

    const cache = readCache(stateDir);
    if (cache?.latest && isStableUpgrade(current, cache.latest)) {
      if (cache.dismissedVersion === cache.latest) {
        print(buildDismissedUpdateNotice(current, cache.latest, isTTY));
      } else {
        print(buildUpdateNotice(current, cache.latest, isTTY));
        if (!updatePromptDisabled(env) && inputIsTTY) {
          const promptUpdate = deps.promptUpdate ?? defaultPromptUpdate;
          let accepted = false;
          try {
            accepted = await promptUpdate({ current, latest: cache.latest, timeoutMs: promptTimeoutMs });
          } catch {
            accepted = false;
          }
          if (accepted) {
            const installUpdate = deps.installUpdate ?? defaultInstallUpdate;
            const cmd = "npm";
            const args = ["install", "-g", `${PACKAGE_NAME}@latest`];
            const result = installUpdate(cmd, args);
            if (result.ok) {
              print("AgentBridge CLI updated. 请重新运行命令。");
              print("Plugin: in Claude, run `/plugin marketplace update agentbridge` and then `/reload-plugins`.");
              return "updated";
            }
            const detail = result.error?.message
              ? ` (${result.error.message})`
              : typeof result.status === "number"
                ? ` (exit ${result.status})`
                : "";
            print(`⚠ AgentBridge update failed${detail}; continuing with the current command.`);
          } else {
            recordDismissal(stateDir, cache, cache.latest);
          }
        }
      }
    }

    // Daily refresh — only on long-lived launchers (deps.refresh), where the
    // parent process outlives the fetch. One-shot commands skip this so a
    // pending fetch can never delay their exit.
    if (deps.refresh && (!cache || now() - cache.lastCheckMs >= checkIntervalMs(env))) {
      void refreshUpdateCache({ stateDir, now, fetchImpl: deps.fetchImpl }).catch(() => {});
    }
    return "continue";
  } catch {
    // The notifier must never affect the command it precedes.
    return "continue";
  }
}
