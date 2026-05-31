/**
 * Update notifier (#auto-update).
 *
 * Tells the user when a newer stable AgentBridge is available on npm. Designed to
 * be correct-by-construction:
 *   - ZERO network on most runs: a notice is printed from a cached `latest`
 *     (populated by a prior run); the network is hit at most once per `interval`.
 *   - NEVER blocks / delays / fails the command: printing is sync from cache; the
 *     daily refresh is fired un-awaited and only on long-lived launchers (claude/
 *     codex) whose parent process outlives the fetch — one-shot commands never
 *     keep a pending fetch alive past their own exit.
 *   - SILENT on any failure (offline, 404, proxy, malformed JSON, timeout).
 *   - SUPPRESSED for non-TTY/CI/test and via opt-out env vars.
 *   - STABLE-only: never nags about prereleases or downgrades (see version-utils).
 *   - READ-ONLY: it only prints the upgrade command; it never installs anything.
 *
 * npm is queried as the single authoritative source: the user running `abg`
 * installed the CLI from npm, and `scripts/check-plugin-versions.js` keeps the
 * package/plugin/marketplace versions equal, so npm's `dist-tags.latest` is a
 * faithful proxy for the plugin version too. The notice still surfaces both the
 * CLI (`npm i -g`) and plugin (`/plugin marketplace update`) upgrade paths.
 */

import { readFileSync, writeFileSync } from "node:fs";
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
const CHECK_INTERVAL_ENV = "AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS";

export interface UpdateCache {
  /** Epoch ms of the last completed network check. */
  lastCheckMs: number;
  /** Last-known stable `latest` from npm, or null if never/failed. */
  latest: string | null;
}

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
    };
  } catch {
    return null; // missing / corrupt → treat as "no cache, recheck"
  }
}

function writeCache(stateDir: StateDirResolver, cache: UpdateCache): void {
  try {
    stateDir.ensure();
    writeFileSync(stateDir.updateCheckFile, JSON.stringify(cache, null, 2) + "\n", "utf-8");
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
    writeCache(stateDir, { lastCheckMs: now(), latest: latest ?? prev?.latest ?? null });
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

function checkIntervalMs(env: NodeJS.ProcessEnv): number {
  // Read from the injected env (not process.env) so the deps.env DI contract
  // holds end-to-end and the interval is overridable/testable.
  return parsePositiveIntEnv(CHECK_INTERVAL_ENV, DEFAULT_CHECK_INTERVAL_MS, undefined, env);
}

/**
 * Best-effort update notice. Synchronously prints a notice from the cached
 * `latest` (if a newer stable version exists), then — only when `refresh` is set
 * — fires an un-awaited daily refresh. NEVER throws, blocks, or changes exit code.
 */
export function maybeNotifyUpdate(deps: NotifierDeps = {}): void {
  try {
    const env = deps.env ?? process.env;
    const isTTY = deps.isTTY ?? Boolean(process.stderr.isTTY);
    if (isUpdateCheckSuppressed(env, isTTY)) return;

    const current = deps.current ?? getCurrentVersion();
    const stateDir = deps.stateDir ?? new StateDirResolver();
    const now = deps.now ?? Date.now;
    const print = deps.print ?? ((m: string) => process.stderr.write(m + "\n"));

    const cache = readCache(stateDir);
    if (cache?.latest && isStableUpgrade(current, cache.latest)) {
      print(buildUpdateNotice(current, cache.latest, isTTY));
    }

    // Daily refresh — only on long-lived launchers (deps.refresh), where the
    // parent process outlives the fetch. One-shot commands skip this so a
    // pending fetch can never delay their exit.
    if (deps.refresh && (!cache || now() - cache.lastCheckMs >= checkIntervalMs(env))) {
      void refreshUpdateCache({ stateDir, now, fetchImpl: deps.fetchImpl }).catch(() => {});
    }
  } catch {
    // The notifier must never affect the command it precedes.
  }
}
