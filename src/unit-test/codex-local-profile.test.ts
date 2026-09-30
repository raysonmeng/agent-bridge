import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../codex-adapter";

const logFile = join(mkdtempSync(join(tmpdir(), "abg-local-profile-")), "test.log");
function setup() {
  const adapter = new CodexAdapter(4510, 4511, logFile) as any;
  const profiles: unknown[] = [];
  adapter.on("localProfileChanged", (profile: unknown) => profiles.push(profile));
  const request = (id: number, method = "thread/start") => adapter.trackPendingRequest({ id, method }, 0);
  const respond = (id: number, threadId: string, model?: unknown) =>
    adapter.handleTrackedResponse({ id, result: { thread: { id: threadId }, model } }, 0);
  return { adapter, profiles, request, respond };
}

test("native model is set before threadChanged and same-thread resume refreshes profile", () => {
  const { adapter, profiles, request, respond } = setup();
  expect(adapter.activeModel).toBeNull();
  const models: unknown[] = [];
  adapter.on("threadChanged", () => models.push(adapter.activeModel));
  request(1); respond(1, "a", "native-model");
  request(2, "thread/resume"); respond(2, "a", "updated-model");
  expect(models).toEqual(["native-model"]);
  expect(profiles).toEqual([{ threadId: "a", model: "native-model" }, { threadId: "a", model: "updated-model" }]);
  expect(adapter.activeModel).toBe("updated-model");
});

test("stale, failed, malformed, and untracked responses cannot publish a local profile", () => {
  const { adapter, profiles, request, respond } = setup();
  request(1); request(2, "thread/resume");
  respond(2, "latest", "current"); respond(1, "old", "stale");
  request(3);
  adapter.handleTrackedResponse({ id: 3, error: { message: "failed" }, result: { thread: { id: "bad" }, model: "bad" } }, 0);
  request(4); respond(4, "", "bad");
  respond(5, "untracked", "bad");
  expect(adapter.activeThreadId).toBe("latest");
  expect(adapter.activeModel).toBe("current");
  expect(profiles).toEqual([{ threadId: "latest", model: "current" }]);
});

test("missing or invalid native model clears old metadata instead of guessing", () => {
  const { adapter, profiles, request, respond } = setup();
  request(1); respond(1, "a", "known");
  for (const [index, model] of [undefined, null, {}, "  ", 42].entries()) {
    request(index + 2); respond(index + 2, `thread-${index}`, model);
    expect(adapter.activeModel).toBeNull();
    expect(profiles.at(-1)).toEqual({ threadId: `thread-${index}`, model: null });
  }
});

test("new primary connection clears metadata without announcing its previous session", () => {
  const { adapter, profiles, request, respond } = setup();
  request(1); respond(1, "a", "old");
  adapter.onTuiConnect({ data: {} });
  expect(adapter.activeThreadId).toBeNull();
  expect(adapter.activeModel).toBeNull();
  expect(profiles).toHaveLength(1);
});
