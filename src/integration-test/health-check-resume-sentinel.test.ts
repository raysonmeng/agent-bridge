import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resumeAckSentinelPath, writeResumeAckDegradedSentinel } from "../budget/resume-ack-sentinel";

/**
 * End-to-end bash↔TS parity for the PR4 §6 degrade→sentinel escape hatch: spawns
 * the REAL plugins/agentbridge/scripts/health-check.sh against a temp state dir
 * seeded by the REAL TS writer (writeResumeAckDegradedSentinel). This closes the
 * drift gap that a hand-copied regex test could not — if either the JSON shape or
 * the bash grep/sed/charset/TTL logic changes incompatibly, this fails. Also
 * exercises the staleness TTL gate (fast-follow) and the corrupted-id guard.
 */

const HOOK = resolve(import.meta.dir, "../../plugins/agentbridge/scripts/health-check.sh");
const RESUME_NOTICE = "续接通知未被确认";

// Spawning bash; skip on platforms without it (Windows CI only runs port-cleanup).
const bashAvailable =
  process.platform !== "win32" && spawnSync("bash", ["-c", ":"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = bashAvailable ? describe : describe.skip;

const tmpDirs: string[] = [];
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "abg-hc-sentinel-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function runHook(stateDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [HOOK], {
    input: "",
    encoding: "utf-8",
    env: {
      ...process.env,
      AGENTBRIDGE_STATE_DIR: stateDir,
      // Isolate the cooldown stamp so a fall-through case never reads a real one.
      AGENTBRIDGE_HOOK_STATE_DIR: join(stateDir, "hook-state"),
      // Point the health probe at a port nothing listens on so fall-through is
      // deterministic ("not reachable"), never a real local daemon.
      AGENTBRIDGE_CONTROL_PORT: "59",
      // Pin the default TTL so default-TTL tests stay hermetic even if the ambient
      // env happens to export AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC. Per-test
      // overrides (below) still win.
      AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC: "86400",
      // Per-test overrides win.
      ...extraEnv,
    },
  });
}

describeOrSkip("health-check.sh resume-ack sentinel (bash↔TS parity)", () => {
  test("a fresh sentinel surfaces the resumeId in the SessionStart notice and is consumed", () => {
    const stateDir = tempStateDir();
    const resumeId = "system_budget_claude_recovered_7";
    writeResumeAckDegradedSentinel({ stateDir, resumeId, now: () => Date.now() });

    const res = runHook(stateDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"hookEventName":"SessionStart"');
    expect(res.stdout).toContain(`resume_id=${resumeId}`);
    expect(res.stdout).toContain(RESUME_NOTICE);
    // Consumed exactly once.
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("a corrupted resumeId collapses to 'unknown' (charset guard)", () => {
    const stateDir = tempStateDir();
    // Space is outside ^[A-Za-z0-9._-]+$ → the hook must collapse it to "unknown".
    writeResumeAckDegradedSentinel({ stateDir, resumeId: "bad id with spaces", now: () => Date.now() });

    const res = runHook(stateDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("resume_id=unknown");
    expect(res.stdout).not.toContain("bad id with spaces");
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("a stale sentinel (older than TTL) is dropped without surfacing, but still consumed", () => {
    const stateDir = tempStateDir();
    writeResumeAckDegradedSentinel({
      stateDir,
      resumeId: "system_budget_claude_recovered_8",
      now: () => Date.now() - 2 * 3600 * 1000, // 2h ago
    });

    // TTL = 1h → the 2h-old sentinel is stale.
    const res = runHook(stateDir, { AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC: "3600" });
    expect(res.stdout).not.toContain(RESUME_NOTICE);
    expect(res.stdout).not.toContain("system_budget_claude_recovered_8");
    expect(res.status).toBe(0);
    // Consumed (deleted) so it cannot resurface on a later session — the strong
    // invariant. (We intentionally do NOT assert the fall-through SessionStart
    // notice here: that path is gated by `command -v curl`, and the large-TTL
    // sibling test already proves the surface path works, so the gate is the only
    // difference — keeping this assertion curl-independent.)
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("a huge TTL surfaces a fresh sentinel — forward guard against a naive ms-multiply reintroduction", () => {
    const stateDir = tempStateDir();
    const resumeId = "system_budget_claude_recovered_11";
    writeResumeAckDegradedSentinel({ stateDir, resumeId, now: () => Date.now() - 1000 }); // 1s old → fresh

    // FORWARD-LOOKING guard (the committed gate already uses the seconds compare, so
    // this does NOT red/green the current diff): if anyone reintroduces a naive
    // `ttl_sec * 1000` ms-multiply, 9223372036854776 * 1000 overflows signed int64
    // → wraps negative → this fresh sentinel would be spuriously SUPPRESSED. The
    // seconds-based gate must keep SURFACING it.
    const res = runHook(stateDir, { AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC: "9223372036854776" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`resume_id=${resumeId}`);
    expect(res.stdout).toContain(RESUME_NOTICE);
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("a leading-zero (octal-invalid) degradedAt does not crash and the sentinel is still consumed", () => {
    const stateDir = tempStateDir();
    // JSON.parse rejects leading zeros, so write the raw bytes. `0888888888888`
    // passes the bash ^[0-9]{1,16}$ guard but is octal-invalid. FORWARD-LOOKING
    // guard: if the `10#` base-10 prefix is ever dropped, the arithmetic fails and
    // bash terminates the enclosing if-block, skipping the rm (sentinel leaks /
    // resurfaces forever); consume-once must hold.
    writeFileSync(
      resumeAckSentinelPath(stateDir),
      '{\n  "resumeId": "system_budget_claude_recovered_12",\n  "degradedAt": 0888888888888\n}\n',
    );

    const res = runHook(stateDir);
    expect(res.status).toBe(0);
    // The strong invariant the fix protects: consume-once holds even for a
    // corrupted numeric degradedAt (no leak, no infinite resurface).
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("a FRESH leading-zero degradedAt still surfaces (10# decimal parse, surface branch)", () => {
    const stateDir = tempStateDir();
    // A fresh sentinel whose degradedAt is zero-padded: 10# must parse it as a
    // recent decimal epoch-ms (not octal) so it ages as fresh and SURFACES, while
    // still being consumed. Pairs with the octal-invalid STALE case above to cover
    // both branches of the base-10 fix.
    const ms = Date.now() - 1000;
    writeFileSync(
      resumeAckSentinelPath(stateDir),
      `{\n  "resumeId": "system_budget_claude_recovered_14",\n  "degradedAt": 0${ms}\n}\n`,
    );

    const res = runHook(stateDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("resume_id=system_budget_claude_recovered_14");
    expect(res.stdout).toContain(RESUME_NOTICE);
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("TTL=0 suppresses an aged sentinel (and still consumes it)", () => {
    const stateDir = tempStateDir();
    writeResumeAckDegradedSentinel({
      stateDir,
      resumeId: "system_budget_claude_recovered_13",
      now: () => Date.now() - 5000, // 5s old → age_sec ≥ 1 > 0
    });
    const res = runHook(stateDir, { AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC: "0" });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain(RESUME_NOTICE);
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });

  test("the same old sentinel surfaces under a large TTL (gate is the only difference)", () => {
    const stateDir = tempStateDir();
    writeResumeAckDegradedSentinel({
      stateDir,
      resumeId: "system_budget_claude_recovered_9",
      now: () => Date.now() - 2 * 3600 * 1000, // 2h ago
    });

    // TTL = 24h (default) → a 2h-old sentinel is still fresh and surfaces.
    const res = runHook(stateDir, { AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC: "86400" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("resume_id=system_budget_claude_recovered_9");
    expect(res.stdout).toContain(RESUME_NOTICE);
  });

  test("an unparseable degradedAt fails open (treated as fresh, surfaced)", () => {
    const stateDir = tempStateDir();
    // Write a sentinel whose degradedAt is non-numeric — fail-open must surface it.
    const path = resumeAckSentinelPath(stateDir);
    writeFileSync(path, JSON.stringify({ resumeId: "system_budget_claude_recovered_10", degradedAt: "oops" }, null, 2));

    const res = runHook(stateDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("resume_id=system_budget_claude_recovered_10");
    expect(res.stdout).toContain(RESUME_NOTICE);
    expect(existsSync(path)).toBe(false);
  });
});
