import { describe, expect, test } from "bun:test";
import {
  ADAPTER_DISCONNECT_REASON,
  APP_SERVER_RECONNECT_NEW_TUI_REASON,
  buildTurnAbortedNotice,
} from "../turn-notices";

describe("buildTurnAbortedNotice", () => {
  test("returns null for intentional adapter teardown (no noise on daemon stop)", () => {
    expect(buildTurnAbortedNotice(ADAPTER_DISCONNECT_REASON, false)).toBeNull();
    expect(buildTurnAbortedNotice(ADAPTER_DISCONNECT_REASON, true)).toBeNull();
  });

  test("returns null for an intentional reconnect-to-resume (avoids contradicting the reconnect notice)", () => {
    // This reconnect is deliberate and recoverable — the user is concurrently
    // told "✅ Codex TUI reconnected", so a "turn died, retry" notice would
    // directly contradict it. Regression guard for cross-review H1.
    expect(buildTurnAbortedNotice(APP_SERVER_RECONNECT_NEW_TUI_REASON, false)).toBeNull();
    expect(buildTurnAbortedNotice(APP_SERVER_RECONNECT_NEW_TUI_REASON, true)).toBeNull();
  });

  test("surfaces a notice for an app-server connection close (the unexpected-drop / 429 case)", () => {
    const notice = buildTurnAbortedNotice("app-server connection closed", false);
    expect(notice).not.toBeNull();
    expect(notice).toContain("app-server connection closed");
    expect(notice).toContain("429");
    expect(notice).toContain("ended without completing");
  });

  test("surfaces a notice for an injected turn rejection (busy/error)", () => {
    const notice = buildTurnAbortedNotice("injected turn/start rejected: Codex is busy", false);
    expect(notice).toContain("injected turn/start rejected: Codex is busy");
  });

  test("uses stronger wording when a reply was required", () => {
    const required = buildTurnAbortedNotice("app-server connection closed", true);
    const notRequired = buildTurnAbortedNotice("app-server connection closed", false);
    expect(required).toContain("will NOT arrive");
    expect(required).toContain("retry your last message");
    expect(notRequired).toContain("will not arrive");
    expect(notRequired).not.toContain("will NOT arrive");
  });

  test("embeds the verbatim reason so the cause is traceable", () => {
    const notice = buildTurnAbortedNotice("some novel reason 123", false);
    expect(notice).toContain("(some novel reason 123)");
  });
});
