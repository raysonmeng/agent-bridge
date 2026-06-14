import { describe, expect, test } from "bun:test";
import {
  ResumeInjectionQueue,
  tryClaimPendingResume,
  type ResumeClaim,
} from "../budget/resume-injection-queue";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingEntry } from "../budget/pending-reader";

class FakeScheduler {
  private nextId = 1;
  timers = new Map<number, { callback: () => void; active: boolean; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { callback, active: true, delayMs });
    return id;
  }

  clearTimeout(id: number): void {
    const timer = this.timers.get(id);
    if (timer) timer.active = false;
  }

  runNext(): void {
    const next = [...this.timers.entries()].find(([, timer]) => timer.active);
    if (!next) throw new Error("no active timer");
    const [id, timer] = next;
    timer.active = false;
    this.timers.delete(id);
    timer.callback();
  }

  activeCount(): number {
    return [...this.timers.values()].filter((timer) => timer.active).length;
  }
}

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    status: "paused",
    agent: "codex",
    sessionId: "sess-1",
    cwd: "/repo/project",
    resetEpoch: 1_700_010_000,
    util: 92,
    warnUtil: 92,
    at: 1_700_000_000,
    sourcePath: "/tmp/pending/codex_one.json",
    contentHash: "hash-one",
    ...overrides,
  };
}

describe("ResumeInjectionQueue", () => {
  test("soft inject null defers without counting attempts; turn drain retries once", () => {
    const scheduler = new FakeScheduler();
    const injected: string[] = [];
    const accepted: Array<{ resumeId: string; requestId: number }> = [];
    const queue = new ResumeInjectionQueue({
      inject: (prompt) => {
        injected.push(prompt);
        return injected.length === 1 ? null : -10;
      },
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onInjectionAccepted: (event) => accepted.push(event),
    });

    queue.enqueue({ resumeId: "system_budget_resume_1", prompt: "resume now" });
    expect(injected).toEqual(["resume now"]);
    expect(queue.get("system_budget_resume_1")?.attempts).toBe(0);
    expect(accepted).toEqual([]);

    queue.onTurnDrained();

    expect(injected).toEqual(["resume now", "resume now"]);
    expect(accepted).toEqual([{ resumeId: "system_budget_resume_1", requestId: -10 }]);
    expect(queue.get("system_budget_resume_1")?.state).toBe("awaiting_confirm");
  });

  test("dedups by resumeId while preserving the first prompt", () => {
    const prompts: string[] = [];
    const released: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: (prompt) => {
        prompts.push(prompt);
        return null;
      },
      scheduler: new FakeScheduler(),
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
    });

    queue.enqueue({ resumeId: "rid-1", prompt: "first" });
    queue.enqueue({
      resumeId: "rid-1",
      prompt: "second",
      claim: {
        identity: "claim-dedup",
        claimPath: "/tmp/claim-dedup.json",
        consumedPath: "/tmp/consumed-dedup.json",
        consume: () => {},
        release: () => released.push("claim-dedup"),
      },
    });
    queue.onTurnDrained();

    expect(prompts).toEqual(["first", "first"]);
    expect(queue.size).toBe(1);
    expect(released).toEqual(["claim-dedup"]);
  });

  test("dedup still drops the duplicate (and does not throw) when its claim.release throws", () => {
    const logs: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: () => null,
      scheduler: new FakeScheduler(),
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      log: (m) => logs.push(m),
    });

    queue.enqueue({ resumeId: "rid-dup", prompt: "first" });
    expect(() =>
      queue.enqueue({
        resumeId: "rid-dup",
        prompt: "second",
        claim: {
          identity: "boom",
          claimPath: "/tmp/boom.json",
          consumedPath: "/tmp/boom-consumed.json",
          consume: () => {},
          release: () => {
            throw new Error("release boom");
          },
        },
      }),
    ).not.toThrow();

    expect(queue.size).toBe(1); // duplicate never added
    expect(logs.some((m) => m.includes("release failed") && m.includes("dedup"))).toBe(true);
  });

  test("bridgeTurnStarted confirms the matching injection once and consumes the claim", () => {
    const scheduler = new FakeScheduler();
    const consumed: string[] = [];
    const confirmed: string[] = [];
    const claim: ResumeClaim = {
      identity: "claim-1",
      claimPath: "/tmp/claim.json",
      consumedPath: "/tmp/consumed.json",
      consume: () => consumed.push("claim-1"),
      release: () => {},
    };
    const queue = new ResumeInjectionQueue({
      inject: () => -11,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onConfirmed: (event) => confirmed.push(`${event.resumeId}:${event.turnId}`),
    });

    queue.enqueue({ resumeId: "rid-2", prompt: "resume", claim });
    queue.onBridgeTurnStarted({ resumeId: "rid-2", requestId: -11, turnId: "turn-1" });
    queue.onBridgeTurnStarted({ resumeId: "rid-2", requestId: -11, turnId: "turn-1" });

    expect(confirmed).toEqual(["rid-2:turn-1"]);
    expect(consumed).toEqual(["claim-1"]);
    expect(queue.get("rid-2")).toBeUndefined();
  });

  test("bridgeTurnRejected counts as a real attempt and retries with a fresh request id", () => {
    const scheduler = new FakeScheduler();
    const accepted: Array<{ resumeId: string; requestId: number }> = [];
    const ids = [-21, -22];
    const queue = new ResumeInjectionQueue({
      inject: () => ids.shift() ?? -99,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onInjectionAccepted: (event) => accepted.push(event),
    });

    queue.enqueue({ resumeId: "rid-3", prompt: "resume" });
    queue.onBridgeTurnRejected({ resumeId: "rid-3", requestId: -21, error: "turn/start rejected" });
    scheduler.runNext();

    expect(accepted).toEqual([
      { resumeId: "rid-3", requestId: -21 },
      { resumeId: "rid-3", requestId: -22 },
    ]);
    expect(queue.get("rid-3")?.attempts).toBe(1);
    expect(queue.get("rid-3")?.state).toBe("awaiting_confirm");
  });

  test("stale bridge events and turn tracking reset do not cross-confirm a newer injection", () => {
    const scheduler = new FakeScheduler();
    const confirmed: string[] = [];
    const superseded: Array<{ resumeId: string; requestId: number; reason: string }> = [];
    const queue = new ResumeInjectionQueue({
      inject: () => -31,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onConfirmed: (event) => confirmed.push(event.resumeId),
      onInjectionSuperseded: (event) => superseded.push(event),
    });

    queue.enqueue({ resumeId: "rid-4", prompt: "resume" });
    queue.onBridgeTurnStarted({ resumeId: "rid-4", requestId: -99, turnId: "stale" });
    expect(confirmed).toEqual([]);

    queue.onTurnTrackingReset();
    expect(queue.get("rid-4")?.state).toBe("pending");
    expect(queue.get("rid-4")?.attempts).toBe(1);
    expect(superseded).toEqual([{ resumeId: "rid-4", requestId: -31, reason: "turn_tracking_reset" }]);

    queue.onBridgeTurnStarted({ resumeId: "rid-4", requestId: -31, turnId: "stale-after-reset" });
    expect(confirmed).toEqual([]);
  });

  test("confirm timeout counts attempts, supersedes stale request ids, and abandons at maxAttempts", () => {
    const scheduler = new FakeScheduler();
    const injected: number[] = [];
    const superseded: Array<{ resumeId: string; requestId: number; reason: string }> = [];
    const abandoned: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: () => {
        const requestId = -50 - injected.length;
        injected.push(requestId);
        return requestId;
      },
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onInjectionSuperseded: (event) => superseded.push(event),
      onAbandoned: (event) => abandoned.push(event.resumeId),
    });

    queue.enqueue({ resumeId: "rid-timeout", prompt: "resume" });
    scheduler.runNext(); // confirm timeout for -50
    scheduler.runNext(); // retry → inject -51
    scheduler.runNext(); // confirm timeout for -51 → maxAttempts abandon

    expect(injected).toEqual([-50, -51]);
    expect(superseded).toEqual([
      { resumeId: "rid-timeout", requestId: -50, reason: "confirm_timeout" },
      { resumeId: "rid-timeout", requestId: -51, reason: "confirm_timeout" },
    ]);
    expect(abandoned).toEqual(["rid-timeout"]);
    expect(queue.get("rid-timeout")).toBeUndefined();

    expect(() => scheduler.runNext()).toThrow("no active timer");
  });

  test("turn tracking reset is bounded by maxAttempts", () => {
    const scheduler = new FakeScheduler();
    const abandoned: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: () => -61,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 1,
      onAbandoned: (event) => abandoned.push(event.resumeId),
    });

    queue.enqueue({ resumeId: "rid-reset", prompt: "resume" });
    queue.onTurnTrackingReset();

    expect(abandoned).toEqual(["rid-reset"]);
    expect(queue.get("rid-reset")).toBeUndefined();
  });

  test("turn tracking reset bounds pending retry entries and releases their claim", () => {
    const scheduler = new FakeScheduler();
    const released: string[] = [];
    const abandoned: string[] = [];
    let injectCalls = 0;
    const queue = new ResumeInjectionQueue({
      inject: () => {
        injectCalls += 1;
        return null;
      },
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 1,
      onAbandoned: (event) => abandoned.push(event.resumeId),
    });

    queue.enqueue({
      resumeId: "rid-pending-reset",
      prompt: "resume",
      claim: {
        identity: "claim-pending-reset",
        claimPath: "/tmp/claim-pending-reset.json",
        consumedPath: "/tmp/consumed-pending-reset.json",
        consume: () => {},
        release: () => released.push("claim-pending-reset"),
      },
    });
    expect(queue.get("rid-pending-reset")?.state).toBe("pending");
    expect(scheduler.activeCount()).toBe(1);

    queue.onTurnTrackingReset();

    expect(abandoned).toEqual(["rid-pending-reset"]);
    expect(released).toEqual(["claim-pending-reset"]);
    expect(queue.get("rid-pending-reset")).toBeUndefined();
    expect(scheduler.activeCount()).toBe(0);
    expect(injectCalls).toBe(1);
  });

  test("serializes different resumeIds; second waits until first DRAINS, not when it confirms (Option B)", () => {
    const scheduler = new FakeScheduler();
    const injected: string[] = [];
    const accepted: Array<{ resumeId: string; requestId: number }> = [];
    const queue = new ResumeInjectionQueue({
      inject: (prompt) => {
        injected.push(prompt);
        return -90 - injected.length;
      },
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onInjectionAccepted: (event) => accepted.push(event),
    });

    queue.enqueue({ resumeId: "rid-serial-1", prompt: "first" });
    queue.enqueue({ resumeId: "rid-serial-2", prompt: "second" });

    expect(injected).toEqual(["first"]);
    expect(accepted).toEqual([{ resumeId: "rid-serial-1", requestId: -91 }]);
    expect(queue.get("rid-serial-1")?.state).toBe("awaiting_confirm");
    expect(queue.get("rid-serial-2")?.state).toBe("pending");

    // Option B: CONFIRMING the first must NOT advance the queue — a turn just started
    // in Codex, so injecting the second now could race it. The second stays pending.
    queue.onBridgeTurnStarted({ resumeId: "rid-serial-1", requestId: -91, turnId: "turn-1" });
    expect(injected).toEqual(["first"]); // second NOT injected on confirm
    expect(queue.get("rid-serial-1")).toBeUndefined();
    expect(queue.get("rid-serial-2")?.state).toBe("pending");

    // The first turn DRAINING (turnCompleted → onTurnDrained) is the boundary that
    // advances the second.
    queue.onTurnDrained();
    expect(injected).toEqual(["first", "second"]);
    expect(accepted).toEqual([
      { resumeId: "rid-serial-1", requestId: -91 },
      { resumeId: "rid-serial-2", requestId: -92 },
    ]);
    expect(queue.get("rid-serial-2")?.state).toBe("awaiting_confirm");
  });

  test("Option B: onTurnTrackingReset never injects the next pending mid-sweep (resetSweepDepth guard)", () => {
    const scheduler = new FakeScheduler();
    const injected: string[] = [];
    const abandoned: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: (prompt) => {
        injected.push(prompt);
        return -200 - injected.length;
      },
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 1, // so the reset abandons the swept entries
      onAbandoned: (event) => abandoned.push(event.resumeId),
    });

    queue.enqueue({ resumeId: "rid-sweep-a", prompt: "a" }); // injected → awaiting
    queue.enqueue({ resumeId: "rid-sweep-b", prompt: "b" }); // pending (single-flight)
    expect(injected).toEqual(["a"]);

    // During the sweep, abandoning rid-sweep-a calls tryInjectNext via abandon();
    // the guard must make that a no-op so rid-sweep-b is NOT injected mid-sweep
    // (which would fire a spurious turn/start the rest of the sweep then tears down).
    queue.onTurnTrackingReset();

    expect(injected).toEqual(["a"]); // rid-sweep-b never injected during the sweep
    expect(abandoned.sort()).toEqual(["rid-sweep-a", "rid-sweep-b"]);
    expect(queue.size).toBe(0);
  });

  test("Option B: after an abort/reset the surviving pending advances via its retry timer (no stall)", () => {
    const scheduler = new FakeScheduler();
    const injected: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: (prompt) => {
        injected.push(prompt);
        return -300 - injected.length;
      },
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 3,
    });

    queue.enqueue({ resumeId: "rid-abort-1", prompt: "first" }); // injected → awaiting
    queue.enqueue({ resumeId: "rid-abort-2", prompt: "second" }); // pending, no timer
    expect(injected).toEqual(["first"]);

    // First turn confirms (deleted); second still pending (Option B), no timer yet.
    queue.onBridgeTurnStarted({ resumeId: "rid-abort-1", requestId: -301, turnId: "t1" });
    expect(queue.get("rid-abort-1")).toBeUndefined();
    expect(queue.get("rid-abort-2")?.state).toBe("pending");
    expect(injected).toEqual(["first"]);

    // The first turn ABORTS (resetTurnState → turnTrackingReset). The sweep gives the
    // surviving pending a retry timer (count-or-abandon → scheduleRetry); it must NOT
    // be injected during the sweep.
    queue.onTurnTrackingReset();
    expect(injected).toEqual(["first"]); // not injected mid-sweep
    expect(queue.get("rid-abort-2")?.state).toBe("pending");
    expect(scheduler.activeCount()).toBe(1); // a retry timer is armed

    // The retry timer firing advances the second — no stall, no turnAborted drain.
    scheduler.runNext();
    expect(injected).toEqual(["first", "second"]);
    expect(queue.get("rid-abort-2")?.state).toBe("awaiting_confirm");
  });

  test("maxAttempts abandons after real transport rejections", () => {
    const scheduler = new FakeScheduler();
    const abandoned: string[] = [];
    const queue = new ResumeInjectionQueue({
      inject: () => -41,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 1,
      onAbandoned: (event) => abandoned.push(event.resumeId),
    });

    queue.enqueue({ resumeId: "rid-5", prompt: "resume" });
    queue.onBridgeTurnRejected({ resumeId: "rid-5", requestId: -41, error: "turn/start rejected" });

    expect(abandoned).toEqual(["rid-5"]);
    expect(queue.get("rid-5")).toBeUndefined();
  });

  test("abandon releases the claim so the same pending identity can be retried later", () => {
    const scheduler = new FakeScheduler();
    const released: string[] = [];
    const claim: ResumeClaim = {
      identity: "claim-release",
      claimPath: "/tmp/claim-release.json",
      consumedPath: "/tmp/consumed-release.json",
      consume: () => {},
      release: () => released.push("claim-release"),
    };
    const queue = new ResumeInjectionQueue({
      inject: () => -71,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 1,
    });

    queue.enqueue({ resumeId: "rid-release", prompt: "resume", claim });
    queue.onBridgeTurnRejected({ resumeId: "rid-release", requestId: -71, error: "turn/start rejected" });

    expect(released).toEqual(["claim-release"]);
  });

  test("get does not expose the live claim object", () => {
    const scheduler = new FakeScheduler();
    const released: string[] = [];
    const claim: ResumeClaim = {
      identity: "claim-private",
      claimPath: "/tmp/claim-private.json",
      consumedPath: "/tmp/consumed-private.json",
      consume: () => {},
      release: () => released.push("claim-private"),
    };
    const queue = new ResumeInjectionQueue({
      inject: () => null,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
    });

    queue.enqueue({ resumeId: "rid-private", prompt: "resume", claim });

    expect(queue.get("rid-private")?.claim).toBeUndefined();
    expect(released).toEqual([]);
  });

  test("stop clears retry and confirm timers and releases in-flight claims", () => {
    const scheduler = new FakeScheduler();
    const released: string[] = [];
    const superseded: Array<{ resumeId: string; requestId: number; reason: string }> = [];
    const retryQueue = new ResumeInjectionQueue({
      inject: () => null,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
    });
    retryQueue.enqueue({
      resumeId: "rid-retry-stop",
      prompt: "resume",
      claim: {
        identity: "claim-retry-stop",
        claimPath: "/tmp/claim-retry-stop.json",
        consumedPath: "/tmp/consumed-retry-stop.json",
        consume: () => {},
        release: () => released.push("claim-retry-stop"),
      },
    });
    expect(scheduler.activeCount()).toBe(1);

    retryQueue.stop();

    expect(scheduler.activeCount()).toBe(0);
    expect(retryQueue.size).toBe(0);
    expect(released).toEqual(["claim-retry-stop"]);

    const confirmQueue = new ResumeInjectionQueue({
      inject: () => -81,
      scheduler,
      retryMs: 5_000,
      confirmTimeoutMs: 60_000,
      maxAttempts: 2,
      onInjectionSuperseded: (event) => superseded.push(event),
    });
    confirmQueue.enqueue({
      resumeId: "rid-confirm-stop",
      prompt: "resume",
      claim: {
        identity: "claim-confirm-stop",
        claimPath: "/tmp/claim-confirm-stop.json",
        consumedPath: "/tmp/consumed-confirm-stop.json",
        consume: () => {},
        release: () => released.push("claim-confirm-stop"),
      },
    });
    expect(scheduler.activeCount()).toBe(1);

    confirmQueue.stop();

    expect(scheduler.activeCount()).toBe(0);
    expect(confirmQueue.size).toBe(0);
    expect(superseded).toContainEqual({ resumeId: "rid-confirm-stop", requestId: -81, reason: "stop" });
    expect(released).toEqual(["claim-retry-stop", "claim-confirm-stop"]);
  });
});

describe("tryClaimPendingResume", () => {
  test("atomically claims one pending identity and writes consumed marker on confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-resume-claim-"));
    const project = join(root, "project");
    const pendingPath = join(root, "pending-codex.json");
    mkdirSync(project, { recursive: true });
    writeFileSync(pendingPath, JSON.stringify({ session_id: "sess-claim" }), "utf-8");
    try {
      const pending = entry({
        sessionId: "sess-claim",
        cwd: project,
        sourcePath: pendingPath,
        contentHash: "hash-claim",
      });

      const first = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath: join(project, ".agent", "checkpoint.md"),
        now: () => 1_700_000_000,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected claim");
      expect(readFileSync(first.claim.claimPath, "utf-8")).toContain("sess-claim");

      const second = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath: join(project, ".agent", "checkpoint.md"),
        now: () => 1_700_000_001,
      });
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected duplicate claim rejection");
      expect(second.reason).toBe("claimed");

      first.claim.consume();
      const consumed = JSON.parse(readFileSync(first.claim.consumedPath, "utf-8"));
      expect(consumed.identity).toBe(first.claim.identity);
      expect(consumed.agent).toBe("codex");
      expect(existsSync(first.claim.claimPath)).toBe(false);

      const third = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath: join(project, ".agent", "checkpoint.md"),
        now: () => 1_700_000_002,
      });
      expect(third.ok).toBe(false);
      if (third.ok) throw new Error("expected consumed rejection");
      expect(third.reason).toBe("consumed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("release removes an abandoned claim so the same pending can be claimed again", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-resume-claim-release-"));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    try {
      const pending = entry({ cwd: project, sessionId: "sess-release", contentHash: "hash-release" });
      const checkpointPath = join(project, ".agent", "checkpoint.md");
      const first = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        now: () => 1_700_000_000,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected claim");
      first.claim.release();
      expect(existsSync(first.claim.claimPath)).toBe(false);

      const second = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        now: () => 1_700_000_001,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected second claim");
      expect(second.claim.identity).toBe(first.claim.identity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stale claim TTL self-heals a crashed claimant", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-resume-claim-stale-"));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    try {
      const pending = entry({ cwd: project, sessionId: "sess-stale", contentHash: "hash-stale" });
      const checkpointPath = join(project, ".agent", "checkpoint.md");
      const first = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        claimTtlSec: 10,
        now: () => 1_700_000_000,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected claim");

      const second = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        claimTtlSec: 10,
        now: () => 1_700_000_011,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected stale claim recovery");
      expect(second.claim.identity).toBe(first.claim.identity);
      expect(readFileSync(second.claim.claimPath, "utf-8")).toContain("1700000011");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes a consumed tombstone older than consumedTtlSec so the same pending can resume again", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-resume-consumed-prune-"));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    try {
      const pending = entry({ cwd: project, sessionId: "sess-cprune", contentHash: "hash-cprune" });
      const checkpointPath = join(project, ".agent", "checkpoint.md");
      // Claim + consume at t0 → writes a consumed tombstone (consumed_at = 1_700_000_000).
      const first = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        now: () => 1_700_000_000,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected claim");
      first.claim.consume();
      expect(existsSync(first.claim.consumedPath)).toBe(true);

      // Within consumedTtlSec the tombstone still blocks re-claim.
      const blocked = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        consumedTtlSec: 3600,
        now: () => 1_700_000_100,
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error("expected consumed block");
      expect(blocked.reason).toBe("consumed");
      expect(existsSync(first.claim.consumedPath)).toBe(true);

      // Exactly AT the TTL boundary (age === consumedTtlSec) the strict `>` keeps it.
      const boundary = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        consumedTtlSec: 3600,
        now: () => 1_700_000_000 + 3600,
      });
      expect(boundary.ok).toBe(false);
      if (boundary.ok) throw new Error("expected consumed block at exact TTL boundary");
      expect(boundary.reason).toBe("consumed");
      expect(existsSync(first.claim.consumedPath)).toBe(true);

      // Past consumedTtlSec the tombstone is pruned → the same pending can resume.
      const reclaim = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath,
        consumedTtlSec: 3600,
        now: () => 1_700_000_000 + 3601,
      });
      expect(reclaim.ok).toBe(true);
      if (!reclaim.ok) throw new Error("expected reclaim after consumed prune");
      expect(reclaim.claim.identity).toBe(first.claim.identity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes orphaned claims from OTHER identities on the next claim attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-resume-orphan-prune-"));
    const project = join(root, "project");
    const claimsDir = join(root, "claims");
    mkdirSync(project, { recursive: true });
    mkdirSync(claimsDir, { recursive: true });
    // An orphaned claim from a crashed claimant of a DIFFERENT identity, stale.
    const orphan = join(claimsDir, "deadbeefdeadbeef.json");
    writeFileSync(orphan, JSON.stringify({ identity: "deadbeefdeadbeef", claimed_at: 1_700_000_000 }), "utf-8");
    try {
      const pending = entry({ cwd: project, sessionId: "sess-oprune", contentHash: "hash-oprune" });
      const res = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath: join(project, ".agent", "checkpoint.md"),
        claimTtlSec: 10,
        now: () => 1_700_000_100, // 100s later → orphan (>10s) pruned
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected claim");
      // The unrelated stale orphan was swept, not just our own identity.
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prune leaves corrupt / timestamp-less / non-json artifacts untouched (never aggressively delete)", () => {
    const root = mkdtempSync(join(tmpdir(), "abg-resume-corrupt-keep-"));
    const project = join(root, "project");
    const consumedDir = join(root, "consumed");
    mkdirSync(project, { recursive: true });
    mkdirSync(consumedDir, { recursive: true });
    const corruptJson = join(consumedDir, "corrupt.json");
    const noTs = join(consumedDir, "no-ts.json");
    const nonJson = join(consumedDir, "keep.txt");
    writeFileSync(corruptJson, "not json at all", "utf-8");
    writeFileSync(noTs, JSON.stringify({ identity: "no-ts" }), "utf-8"); // no consumed_at
    writeFileSync(nonJson, "whatever", "utf-8");
    try {
      const pending = entry({ cwd: project, sessionId: "sess-corrupt", contentHash: "hash-corrupt" });
      // Tiny TTL + far-future now: a parseable+timestamped tombstone WOULD be pruned
      // here, so survival proves each file is kept by its own guard (corrupt JSON →
      // catch; missing consumed_at → non-number; non-.json → skipped).
      const res = tryClaimPendingResume({
        stateDir: root,
        agent: "codex",
        pending,
        checkpointPath: join(project, ".agent", "checkpoint.md"),
        consumedTtlSec: 1,
        now: () => 9_999_999_999,
      });
      expect(res.ok).toBe(true);
      // §9 safety contract: never aggressively delete what we can't reason about.
      expect(existsSync(corruptJson)).toBe(true);
      expect(existsSync(noTs)).toBe(true);
      expect(existsSync(nonJson)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
