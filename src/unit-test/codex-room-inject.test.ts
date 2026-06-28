import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../codex-adapter";

// §5.2: room events injected into Codex. Unlike Claude (pushed to a socket), Codex injection is
// rejected mid-turn, so injectRoomNotice queues during a turn and flushes one-per-turn afterwards.
const TEST_LOG_FILE = join(mkdtempSync(join(tmpdir(), "abg-codex-room-inject-")), "test.log");

function createAdapter() {
  return new CodexAdapter(4530, 4531, TEST_LOG_FILE) as any;
}
function wire(adapter: any, sent: string[]) {
  adapter.threadId = "t1";
  adapter.appServerWs = { readyState: WebSocket.OPEN, send: (s: string) => sent.push(s) };
}

describe("CodexAdapter.injectRoomNotice (§5.2 room→Codex)", () => {
  test("injects immediately when the gate is open", () => {
    const a = createAdapter();
    const sent: string[] = [];
    wire(a, sent);
    a.turnInProgress = false;
    a.injectRoomNotice("hello room");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("hello room");
    expect(a.roomInjectQueue.length).toBe(0);
  });

  test("queues mid-turn, then flushes one per turn completion (FIFO)", () => {
    const a = createAdapter();
    const sent: string[] = [];
    wire(a, sent);
    a.turnInProgress = true;
    a.injectRoomNotice("notice 1");
    a.injectRoomNotice("notice 2");
    expect(sent.length).toBe(0); // nothing sent while a turn runs
    expect(a.roomInjectQueue.length).toBe(2);

    a.turnInProgress = false; // turn ends
    a.flushRoomInjectQueue();
    expect(sent.length).toBe(1); // one-per-turn pacing
    expect(sent[0]).toContain("notice 1"); // FIFO order
    expect(a.roomInjectQueue.length).toBe(1);
  });

  test("bounded queue drops oldest past the cap", () => {
    const a = createAdapter();
    const sent: string[] = [];
    wire(a, sent);
    a.turnInProgress = true; // force everything to queue
    for (let i = 0; i < 60; i++) a.injectRoomNotice(`n${i}`);
    expect(a.roomInjectQueue.length).toBe(50); // ROOM_INJECT_QUEUE_CAP
    expect(a.roomInjectQueue[0]).toBe("n10"); // oldest 10 dropped
    expect(a.roomInjectQueue[49]).toBe("n59");
  });

  test("no active thread → queues (does not crash, nothing sent)", () => {
    const a = createAdapter();
    const sent: string[] = [];
    a.threadId = undefined; // gate closed: no thread
    a.injectRoomNotice("x");
    expect(sent.length).toBe(0);
    expect(a.roomInjectQueue.length).toBe(1);
  });

  test("flush is a no-op while the gate stays closed", () => {
    const a = createAdapter();
    const sent: string[] = [];
    wire(a, sent);
    a.turnInProgress = true;
    a.injectRoomNotice("queued");
    a.flushRoomInjectQueue(); // gate still closed → must not drain
    expect(sent.length).toBe(0);
    expect(a.roomInjectQueue.length).toBe(1);
  });
});
