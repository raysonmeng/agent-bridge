import { expect, test } from "bun:test";
import { DaemonClient } from "../daemon-client";

for (const version of [undefined, 1, 2]) test(`explicit routing never falls through an older daemon (version ${version})`, async () => {
  const received: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, s) { if (s.upgrade(req)) return; return new Response(null); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.type === "status") ws.send(JSON.stringify({ type: "status", status: { localChatVersion: version } }));
      if (msg.type === "claude_to_codex") {
        received.push(msg);
        ws.send(JSON.stringify({ type: "claude_to_codex_result", requestId: msg.requestId, success: true }));
      }
    } },
  });
  const client = new DaemonClient(`ws://127.0.0.1:${server.port}/ws`);
  try {
    await client.connect();
    const ready = new Promise<void>(resolve => client.once("status", () => resolve()));
    (client as any).ws.send(JSON.stringify({ type: "status" })); await ready;
    const result = await client.sendReply({ id: "routed", source: "claude", content: "for agy, not Codex", timestamp: 0, to: "agy" });
    expect(result.success).toBe(version === 2);
    expect(received).toHaveLength(version === 2 ? 1 : 0);
    expect((await client.sendReply({ id: "legacy", source: "claude", content: "legacy request", timestamp: 0 })).success).toBe(false);
    expect(received).toHaveLength(version === 2 ? 1 : 0);
    if (version === 2) {
      const result = await client.sendReply({ id: "reply", source: "claude", content: "response", timestamp: 0, to: "agy", inReplyTo: "12345678-1234-1234-1234-123456789abc" });
      expect(result.success).toBe(true);
      expect(received[1].message).toMatchObject({ to: "agy", inReplyTo: "12345678-1234-1234-1234-123456789abc" });
      expect((await client.sendReply({ id: "bad", source: "claude", content: "x", timestamp: 0, to: "agy" }, true)).success).toBe(false);
      for (const inReplyTo of ["request", "", " " , "12345678-1234-1234-1234-123456789abz"]) {
        expect((await client.sendReply({ id: "bad-id", source: "claude", content: "x", timestamp: 0, to: "agy", inReplyTo })).success).toBe(false);
      }
      expect(received).toHaveLength(2);
    }
  } finally { await client.disconnect(); server.stop(true); }
});
