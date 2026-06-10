import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { disabledReplyError } from "../bridge-disabled-state";

describe("bridge disabled-state messaging", () => {
  // These assert the bare hint substrings, i.e. manual/no-pair mode. The leading
  // binary name now comes from cliInvocationName() (see cli-invocation.ts); in
  // the test runner argv[1] is a test path, so it resolves to the "abg" fallback
  // — hence the hints read `abg claude` / `abg kill` here. Clear any pair env
  // that may have leaked so pairScopedCommand renders the bare command.
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
    expect(disabledReplyError("killed")).toContain("disabled by `abg kill`");
    expect(disabledReplyError("killed")).toContain("/resume");
  });

  test("rejected sessions explain another session is active", () => {
    const message = disabledReplyError("rejected");
    expect(message).toContain("rejected this session");
    expect(message).toContain("another Claude Code session is already connected");
    expect(message).toContain("abg kill");
    expect(message).not.toContain("/resume");
  });

  test("evicted sessions explain liveness probe failure and how to retry", () => {
    const message = disabledReplyError("evicted");
    expect(message).toContain("evicted this session");
    expect(message).toContain("liveness probes");
    expect(message).toContain("abg claude");
    // Evicted is not the same as "another session connected" — must not reuse that wording
    expect(message).not.toContain("another Claude Code session is already connected");
  });

  test("probe-in-progress sessions tell the user to retry shortly", () => {
    const message = disabledReplyError("probe_in_progress");
    expect(message).toContain("liveness probe");
    expect(message).toContain("Retry");
    expect(message).toContain("abg claude");
    // Probe-in-progress is transient — must not tell the user to run a kill
    expect(message).not.toContain("abg kill");
  });

  test("auto_recovery_exhausted explains the retry budget gave up, not 'another session'", () => {
    const message = disabledReplyError("auto_recovery_exhausted");
    expect(message).toContain("auto-recovery gave up");
    expect(message).toContain("retry budget");
    expect(message).toContain("abg claude");
    // Must NOT borrow the misleading "another session connected" wording from
    // the bare "rejected" reason — the cause here is exhausted retries, not
    // an active competing session.
    expect(message).not.toContain("another Claude Code session is already connected");
  });
});
