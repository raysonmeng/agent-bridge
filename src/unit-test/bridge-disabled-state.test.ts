import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { disabledReplyError } from "../bridge-disabled-state";

describe("bridge disabled-state messaging", () => {
  // These assert the bare `agentbridge claude` / `agentbridge kill` hint
  // substrings, i.e. manual/no-pair mode. Clear any pair env that may have
  // leaked from another test so pairScopedCommand renders the bare command.
  let savedId: string | undefined;
  let savedName: string | undefined;
  beforeEach(() => {
    savedId = process.env.AGENTBRIDGE_PAIR_ID;
    savedName = process.env.AGENTBRIDGE_PAIR_NAME;
    delete process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_NAME;
  });
  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTBRIDGE_PAIR_ID;
    else process.env.AGENTBRIDGE_PAIR_ID = savedId;
    if (savedName === undefined) delete process.env.AGENTBRIDGE_PAIR_NAME;
    else process.env.AGENTBRIDGE_PAIR_NAME = savedName;
  });

  test("kill-disabled sessions explain how to reconnect", () => {
    expect(disabledReplyError("killed")).toContain("disabled by `agentbridge kill`");
    expect(disabledReplyError("killed")).toContain("/resume");
  });

  test("rejected sessions explain another session is active", () => {
    const message = disabledReplyError("rejected");
    expect(message).toContain("rejected this session");
    expect(message).toContain("another Claude Code session is already connected");
    expect(message).toContain("agentbridge kill");
    expect(message).not.toContain("/resume");
  });

  test("evicted sessions explain liveness probe failure and how to retry", () => {
    const message = disabledReplyError("evicted");
    expect(message).toContain("evicted this session");
    expect(message).toContain("liveness probes");
    expect(message).toContain("agentbridge claude");
    // Evicted is not the same as "another session connected" — must not reuse that wording
    expect(message).not.toContain("another Claude Code session is already connected");
  });

  test("probe-in-progress sessions tell the user to retry shortly", () => {
    const message = disabledReplyError("probe_in_progress");
    expect(message).toContain("liveness probe");
    expect(message).toContain("Retry");
    expect(message).toContain("agentbridge claude");
    // Probe-in-progress is transient — must not tell the user to run `agentbridge kill`
    expect(message).not.toContain("agentbridge kill");
  });

  test("auto_recovery_exhausted explains the retry budget gave up, not 'another session'", () => {
    const message = disabledReplyError("auto_recovery_exhausted");
    expect(message).toContain("auto-recovery gave up");
    expect(message).toContain("retry budget");
    expect(message).toContain("agentbridge claude");
    // Must NOT borrow the misleading "another session connected" wording from
    // the bare "rejected" reason — the cause here is exhausted retries, not
    // an active competing session.
    expect(message).not.toContain("another Claude Code session is already connected");
  });
});
