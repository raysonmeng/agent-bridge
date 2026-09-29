import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalChatHub } from "../local-chat";
import { requestLocalChat } from "../local-chat-client";
import { StateDirResolver } from "../state-dir";
import { resolveControlTokenPath, writeControlToken } from "../control-token";
import { validateClaudeClientIdentity } from "../daemon-identity";
import { BUILD_INFO } from "../build-info";

test("real WebSocket: native agy ACK and targeted outbound coexist without Claude attach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "abg-local-chat-"));
  const delivered: unknown[] = [];
  let claudeConnects = 0;
  const hub = new LocalChatHub({
    authorize: identity => validateClaudeClientIdentity({ expectedPairId: "test-pair", daemonCwd: process.cwd(), expectedControlToken: "secret", expectedContractVersion: BUILD_INFO.contractVersion, identity }).ok,
    deliver: async (to, from, text) => { delivered.push({ to, from, text }); return { accepted: true }; },
  });
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, s) { if (s.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: {
      message(ws, data) { const m = JSON.parse(String(data)); if (m.type === "claude_connect") claudeConnects++; hub.handle(ws, m); },
      close(ws) { hub.disconnect(ws); },
    },
  });
  const stateDir = new StateDirResolver(dir);
  writeControlToken(resolveControlTokenPath(dir), "secret");
  const pair = { pairId: "test-pair", name: "test", slot: 0, manual: false, stateDir, ports: { controlPort: server.port!, appPort: 1, proxyPort: 2 } };
  const agy = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      agy.onerror = reject;
      agy.onopen = () => agy.send(JSON.stringify({ type: "agy_attach", routingVersion: 2, conversationId: "ab9da612-66aa-4195-91ba-881369f93e8b", identity: {
        pairId: pair.pairId, cwd: process.cwd(), controlToken: "secret", contractVersion: BUILD_INFO.contractVersion,
      } }));
      agy.onmessage = event => {
        const m = JSON.parse(String(event.data));
        if (m.type === "local_chat_result") { if (m.success) resolve(); else reject(new Error(m.info)); }
        if (m.type === "agy_message") { received.push(m.text); agy.send(JSON.stringify({ type: "agy_ack", deliveryId: m.deliveryId, accepted: true })); }
      };
    });
    const roster = await requestLocalChat(pair, { type: "local_chat_members" });
    expect(roster.members).toContain("agy:ab9da612-66aa-4195-91ba-881369f93e8b");
    expect((await requestLocalChat(pair, { type: "local_chat_send", from: "codex", to: "agy", text: "request" })).success).toBe(true);
    expect(received).toEqual(["request"]);
    expect((await requestLocalChat(pair, { type: "local_chat_send", from: "agy", to: "claude", text: "response" })).success).toBe(true);
    expect(delivered).toEqual([{ to: "claude", from: "agy:ab9da612-66aa-4195-91ba-881369f93e8b", text: "response" }]);
    expect(claudeConnects).toBe(0);
  } finally {
    agy.close(); hub.stop(); server.stop(true); rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
