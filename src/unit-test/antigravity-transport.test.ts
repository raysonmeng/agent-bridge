import { describe, expect, test } from "bun:test";
import { antigravityContext, isolateAntigravityContext, sendAntigravityMessage } from "../antigravity-transport";

const conversationId = "ab9da612-66aa-4195-91ba-881369f93e8b";
const env = {
  ANTIGRAVITY_CONVERSATION_ID: conversationId,
  ANTIGRAVITY_LS_ADDRESS: "localhost:57072",
  ANTIGRAVITY_CSRF_TOKEN: "test-secret-not-for-logs",
};

describe("Antigravity native-session transport", () => {
  test("isolates native runtime secrets before any shared daemon child inherits env", () => {
    const inherited: NodeJS.ProcessEnv = { ...env, ANTIGRAVITY_AGENTAPI_EXE: "/native/agentapi", PATH: "/bin", AGENTBRIDGE_PAIR_ID: "pair" };
    const context = isolateAntigravityContext(inherited);
    expect(context.env.ANTIGRAVITY_CSRF_TOKEN).toBe(env.ANTIGRAVITY_CSRF_TOKEN);
    expect(context.env.ANTIGRAVITY_LS_ADDRESS).toBe(env.ANTIGRAVITY_LS_ADDRESS);
    expect(Object.keys(inherited).some(k => k.startsWith("ANTIGRAVITY_"))).toBe(false);
    expect({ ...inherited }).toEqual({ PATH: "/bin", AGENTBRIDGE_PAIR_ID: "pair" });
  });
  test("requires the native tool environment; never guesses a session or endpoint", () => {
    expect(() => antigravityContext({})).toThrow("inside the agy session");
    expect(() => antigravityContext({ ...env, ANTIGRAVITY_CONVERSATION_ID: "--other" })).toThrow();
    expect(() => antigravityContext({ ...env, ANTIGRAVITY_LS_ADDRESS: "remote.example:57072" })).toThrow();
    expect(() => antigravityContext({ ...env, ANTIGRAVITY_LS_ADDRESS: "localhost:0" })).toThrow();
    expect(() => antigravityContext({ ...env, ANTIGRAVITY_CSRF_TOKEN: "" })).toThrow();
    expect(antigravityContext(env).conversationId).toBe(conversationId);
  });

  test("passes literal text to official agentapi and checks the recipient receipt", async () => {
    const context = antigravityContext(env);
    let called = false;
    const text = 'hello; $(touch SHOULD_NOT_EXIST)\n--help';
    const result = await sendAntigravityMessage(context, text, async (file, args, options) => {
      called = true;
      expect(file).toBe("agy");
      expect(args).toEqual(["agentapi", "send-message", "--title=AgentBridge", conversationId, text]);
      expect(options.env.ANTIGRAVITY_CSRF_TOKEN).toBe(env.ANTIGRAVITY_CSRF_TOKEN);
      expect(options.timeout).toBe(15000);
      return { stdout: JSON.stringify({ response: { sendMessage: { recipientId: conversationId, content: text } } }) };
    });
    expect(called).toBe(true);
    expect(result).toEqual({ accepted: true, conversationId });
  });

  test("fails closed on empty, oversized, malformed or mismatched receipts", async () => {
    const context = antigravityContext(env);
    const unused = async () => { throw new Error("must not execute"); };
    await expect(sendAntigravityMessage(context, "  ", unused)).rejects.toThrow("1–6000");
    await expect(sendAntigravityMessage(context, "x".repeat(6001), unused)).rejects.toThrow("1–6000");
    for (const stdout of ["", "not-json", "{}", "null", JSON.stringify({ response: { sendMessage: { recipientId: "other" } } })]) {
      await expect(sendAntigravityMessage(context, "hi", async () => ({ stdout }))).rejects.toThrow("receipt");
    }
  });

  test("never leaks subprocess stderr or credentials through errors", async () => {
    const context = antigravityContext(env);
    await expect(sendAntigravityMessage(context, "hi", async () => {
      throw new Error(`timeout: ${env.ANTIGRAVITY_CSRF_TOKEN}`);
    })).rejects.toThrow("agentapi failed or timed out; delivery is unconfirmed");
  });
});
