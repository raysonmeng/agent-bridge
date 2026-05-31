import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateDirResolver } from "../state-dir";
import {
  PACKAGE_NAME,
  buildUpdateNotice,
  isUpdateCheckSuppressed,
  maybeNotifyUpdate,
  parseLatestFromRegistry,
  refreshUpdateCache,
  type UpdateCache,
} from "../update-notifier";

const tmpDirs: string[] = [];
function freshStateDir(): StateDirResolver {
  const d = mkdtempSync(join(tmpdir(), "abg-upd-"));
  tmpDirs.push(d);
  return new StateDirResolver(d);
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function writeCacheFile(sd: StateDirResolver, cache: UpdateCache): void {
  sd.ensure();
  writeFileSync(sd.updateCheckFile, JSON.stringify(cache), "utf-8");
}
function readCacheFile(sd: StateDirResolver): UpdateCache {
  return JSON.parse(readFileSync(sd.updateCheckFile, "utf-8"));
}
/** A fetch that returns a 200 npm body and records call count. */
function recordingFetch(body: unknown, status = 200): { fn: typeof fetch; calls: () => number } {
  let n = 0;
  const fn = (async () => {
    n++;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls: () => n };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const CLEAN_ENV = {} as NodeJS.ProcessEnv; // not suppressed by env

describe("parseLatestFromRegistry", () => {
  test("extracts a stable dist-tags.latest", () => {
    expect(parseLatestFromRegistry({ "dist-tags": { latest: "0.2.0" } })).toBe("0.2.0");
  });
  test("rejects prerelease / missing / wrong-shape / non-string", () => {
    expect(parseLatestFromRegistry({ "dist-tags": { latest: "0.2.0-beta.1" } })).toBeNull();
    expect(parseLatestFromRegistry({ "dist-tags": {} })).toBeNull();
    expect(parseLatestFromRegistry({ "dist-tags": { latest: 5 } })).toBeNull();
    expect(parseLatestFromRegistry({})).toBeNull();
    expect(parseLatestFromRegistry(null)).toBeNull();
    expect(parseLatestFromRegistry("nope")).toBeNull();
  });
});

describe("buildUpdateNotice", () => {
  test("shows current → latest and both upgrade commands", () => {
    const msg = buildUpdateNotice("0.1.6", "0.2.0", false);
    expect(msg).toContain("0.1.6");
    expect(msg).toContain("0.2.0");
    expect(msg).toContain(`npm install -g ${PACKAGE_NAME}@latest`);
    expect(msg).toContain("/plugin marketplace update agentbridge");
  });
  test("omits ANSI color when not a TTY, includes it on a TTY", () => {
    expect(buildUpdateNotice("0.1.6", "0.2.0", false)).not.toContain("\x1b[");
    expect(buildUpdateNotice("0.1.6", "0.2.0", true)).toContain("\x1b[");
  });
});

describe("isUpdateCheckSuppressed", () => {
  test("suppresses on opt-out env, CI, test, and non-TTY", () => {
    expect(isUpdateCheckSuppressed({ NO_UPDATE_NOTIFIER: "1" } as any, true)).toBe(true);
    expect(isUpdateCheckSuppressed({ AGENTBRIDGE_NO_UPDATE_NOTIFIER: "1" } as any, true)).toBe(true);
    expect(isUpdateCheckSuppressed({ CI: "true" } as any, true)).toBe(true);
    expect(isUpdateCheckSuppressed({ NODE_ENV: "test" } as any, true)).toBe(true);
    expect(isUpdateCheckSuppressed({} as any, false)).toBe(true); // non-TTY
  });
  test("not suppressed on a clean TTY environment", () => {
    expect(isUpdateCheckSuppressed({} as any, true)).toBe(false);
  });
});

describe("maybeNotifyUpdate — printing", () => {
  test("prints when cache has a newer stable version", () => {
    const sd = freshStateDir();
    writeCacheFile(sd, { lastCheckMs: 1000, latest: "0.2.0" });
    const out: string[] = [];
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: (m) => out.push(m), now: () => 1000 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("0.1.6");
    expect(out[0]).toContain("0.2.0");
  });

  test("does NOT print when latest is equal/older/prerelease or cache absent", () => {
    const out: string[] = [];
    const run = (cache: UpdateCache | null, current = "0.1.6") => {
      const sd = freshStateDir();
      if (cache) writeCacheFile(sd, cache);
      maybeNotifyUpdate({ current, stateDir: sd, isTTY: true, env: CLEAN_ENV, print: (m) => out.push(m), now: () => 1000 });
    };
    run({ lastCheckMs: 1, latest: "0.1.6" }); // equal
    run({ lastCheckMs: 1, latest: "0.1.5" }); // older
    run({ lastCheckMs: 1, latest: "0.2.0-beta.1" }); // prerelease
    run({ lastCheckMs: 1, latest: null }); // unknown
    run(null); // no cache file
    expect(out).toHaveLength(0);
  });

  test("does NOT print when suppressed even if a newer version is cached", () => {
    const sd = freshStateDir();
    writeCacheFile(sd, { lastCheckMs: 1, latest: "9.9.9" });
    const out: string[] = [];
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: { CI: "1" } as any, print: (m) => out.push(m) });
    expect(out).toHaveLength(0);
  });

  test("never throws on a corrupt cache file", () => {
    const sd = freshStateDir();
    sd.ensure();
    writeFileSync(sd.updateCheckFile, "{not json", "utf-8");
    const out: string[] = [];
    expect(() =>
      maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: (m) => out.push(m) }),
    ).not.toThrow();
    expect(out).toHaveLength(0);
  });
});

describe("maybeNotifyUpdate — refresh gating", () => {
  test("refresh:true with a stale cache fires the network check", () => {
    const sd = freshStateDir();
    writeCacheFile(sd, { lastCheckMs: 0, latest: "0.1.6" }); // very stale
    const f = recordingFetch({ "dist-tags": { latest: "0.2.0" } });
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: () => {}, now: () => 10 * 24 * 60 * 60 * 1000, refresh: true, fetchImpl: f.fn });
    expect(f.calls()).toBe(1);
  });

  test("refresh:true with a FRESH cache does NOT hit the network", () => {
    const sd = freshStateDir();
    const now = 1_000_000_000;
    writeCacheFile(sd, { lastCheckMs: now - 1000, latest: "0.1.6" }); // checked 1s ago
    const f = recordingFetch({ "dist-tags": { latest: "0.2.0" } });
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: () => {}, now: () => now, refresh: true, fetchImpl: f.fn });
    expect(f.calls()).toBe(0);
  });

  test("refresh:false never hits the network (one-shot commands)", () => {
    const sd = freshStateDir();
    writeCacheFile(sd, { lastCheckMs: 0, latest: "0.1.6" });
    const f = recordingFetch({ "dist-tags": { latest: "0.2.0" } });
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: () => {}, now: () => 10 ** 12, refresh: false, fetchImpl: f.fn });
    expect(f.calls()).toBe(0);
  });

  test("honors AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS from the injected env (deps.env DI contract)", () => {
    // With a 1000ms interval, a cache 2s old IS stale (fetch) but 500ms old is fresh (skip).
    const now = 1_000_000_000;
    const env = { AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS: "1000" } as unknown as NodeJS.ProcessEnv;

    const sdStale = freshStateDir();
    writeCacheFile(sdStale, { lastCheckMs: now - 2000, latest: "0.1.6" });
    const fStale = recordingFetch({ "dist-tags": { latest: "0.2.0" } });
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sdStale, isTTY: true, env, print: () => {}, now: () => now, refresh: true, fetchImpl: fStale.fn });
    expect(fStale.calls()).toBe(1); // 2s > 1s interval → fetch

    const sdFresh = freshStateDir();
    writeCacheFile(sdFresh, { lastCheckMs: now - 500, latest: "0.1.6" });
    const fFresh = recordingFetch({ "dist-tags": { latest: "0.2.0" } });
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sdFresh, isTTY: true, env, print: () => {}, now: () => now, refresh: true, fetchImpl: fFresh.fn });
    expect(fFresh.calls()).toBe(0); // 500ms < 1s interval → skip
  });
});

describe("refreshUpdateCache", () => {
  test("writes the fetched stable latest + a fresh timestamp", async () => {
    const sd = freshStateDir();
    const f = recordingFetch({ "dist-tags": { latest: "0.3.0" } });
    await refreshUpdateCache({ stateDir: sd, now: () => 12345, fetchImpl: f.fn });
    const cache = readCacheFile(sd);
    expect(cache.latest).toBe("0.3.0");
    expect(cache.lastCheckMs).toBe(12345);
  });

  test("preserves the previously-known latest on a transient fetch failure", async () => {
    const sd = freshStateDir();
    writeCacheFile(sd, { lastCheckMs: 1, latest: "0.2.0" });
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await refreshUpdateCache({ stateDir: sd, now: () => 99999, fetchImpl: failing });
    const cache = readCacheFile(sd);
    expect(cache.latest).toBe("0.2.0"); // preserved
    expect(cache.lastCheckMs).toBe(99999); // but throttle advanced
  });

  test("never throws and records the check even with no prior cache on failure", async () => {
    const sd = freshStateDir();
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await refreshUpdateCache({ stateDir: sd, now: () => 7, fetchImpl: failing });
    const cache = readCacheFile(sd);
    expect(cache.latest).toBeNull();
    expect(cache.lastCheckMs).toBe(7);
  });

  test("end-to-end: a stale refresh writes a cache a later run would notify from", async () => {
    const sd = freshStateDir();
    const f = recordingFetch({ "dist-tags": { latest: "0.2.0" } });
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: () => {}, now: () => 10 ** 12, refresh: true, fetchImpl: f.fn });
    await tick();
    const out: string[] = [];
    maybeNotifyUpdate({ current: "0.1.6", stateDir: sd, isTTY: true, env: CLEAN_ENV, print: (m) => out.push(m), now: () => 10 ** 12 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("0.2.0");
  });
});
