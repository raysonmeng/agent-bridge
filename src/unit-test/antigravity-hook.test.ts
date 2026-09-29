import { expect, test } from "bun:test";
import { requestLocalChat } from "../local-chat-client";

test("cached native Stop entrypoint is inert even with a plausible final-answer payload", async () => {
  const p = Bun.spawn([process.execPath, "src/cli.ts", "agy-hook"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(JSON.stringify({ conversationId: "ab9da612-66aa-4195-91ba-881369f93e8b", terminationReason: "NO_TOOL_CALL", transcriptPath: "/must-not-read", text: "PRIVATE_DO_NOT_UPLOAD" })); p.stdin.end();
  const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0); expect(JSON.parse(out)).toEqual({ decision: "stop" }); expect(err).toBe(""); expect(out).not.toContain("PRIVATE");
});

test("sender rejects incomplete business envelopes before token lookup or opening any socket", async () => {
  const invalidPair = { stateDir: { dir: "/must-not-read" }, ports: { controlPort: 0 } } as any;
  for (const payload of [
    { type: "local_chat_send", from: "agy", text: "private" },
    { type: "local_chat_reply", from: "agy", to: "codex", text: "private" },
    { type: "local_chat_reply", from: "agy", to: "codex", inReplyTo: "unknown", text: "private" },
  ]) await expect(requestLocalChat(invalidPair, payload as any)).rejects.toThrow("nothing submitted to daemon");
});
