import { describe, test, expect, beforeEach } from "bun:test";
import { SessionLedger } from "../session-ledger";
import { InMemoryStore } from "../backbone/store/memory-store";

describe("SessionLedger — new vs resumed (§2.5)", () => {
  let store: InMemoryStore;
  let ledger: SessionLedger;
  beforeEach(() => {
    store = new InMemoryStore();
    ledger = new SessionLedger(store);
  });

  test("first start in a workspace is 'new' with no previous", async () => {
    expect(await ledger.recordSessionStart("/repo", "claude", "sess-1")).toEqual({
      continuity: "new",
      previousSessionId: null,
    });
  });

  test("second start is 'resumed' and reports the prior session id to resume from", async () => {
    await ledger.recordSessionStart("/repo", "claude", "sess-1");
    expect(await ledger.recordSessionStart("/repo", "claude", "sess-2")).toEqual({
      continuity: "resumed",
      previousSessionId: "sess-1",
    });
    expect(await ledger.lastSession("/repo", "claude")).toBe("sess-2");
  });

  test("distinct (workspace, agentType) keys are independent", async () => {
    await ledger.recordSessionStart("/repo", "claude", "s1");
    expect((await ledger.recordSessionStart("/repo", "codex", "s2")).continuity).toBe("new");
    expect((await ledger.recordSessionStart("/other", "claude", "s3")).continuity).toBe("new");
  });
});
