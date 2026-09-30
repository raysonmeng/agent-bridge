import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Obtain this from an agy run_command child, not an MCP/hook process or a
 * guessed PID/port. Keep the native runtime credentials in memory only. */
export function antigravityContext(env: NodeJS.ProcessEnv = process.env) {
  const conversationId = env.ANTIGRAVITY_CONVERSATION_ID;
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  if (!conversationId || !UUID.test(conversationId) || !address || !token) {
    throw new Error("Run abg agy attach inside the agy session's terminal tool (native session context missing)");
  }
  // The documented API is a local language-server endpoint, not a remote URL.
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/.exec(address);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error("Antigravity language server must use a loopback host and valid port");
  }
  return { conversationId, env: { ...env } };
}

/** Transfer native runtime context to the adapter before it may spawn a shared
 * daemon. Its Codex child must never inherit another product's API credentials. */
export function isolateAntigravityContext(env: NodeJS.ProcessEnv = process.env) {
  const context = antigravityContext(env);
  for (const key of Object.keys(env)) if (key.startsWith("ANTIGRAVITY_")) delete env[key];
  return context;
}

type Context = ReturnType<typeof antigravityContext>;
type Runner = (file: string, args: string[], options: {
  env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: "utf8";
}) => Promise<{ stdout: string }>;

/** A native API receipt proves submission, NOT that the model read or replied.
 * Never retry automatically: a timeout may occur after the message was accepted. */
export async function sendAntigravityMessage(context: Context, text: string, run: Runner = execute) {
  if (typeof text !== "string" || !text.trim() || text.length > 6000) {
    throw new Error("text must contain 1–6000 characters (including routing context)");
  }
  let stdout: string;
  try {
    ({ stdout } = await run("agy", [
      "agentapi", "send-message", "--title=AgentBridge", context.conversationId, text,
    ], { env: context.env, timeout: 15000, maxBuffer: 65536, encoding: "utf8" }));
  } catch {
    // execFile's error includes argv and stderr. Do not surface those verbatim.
    throw new Error("agentapi failed or timed out; delivery is unconfirmed");
  }
  let receipt;
  try { receipt = JSON.parse(stdout)?.response?.sendMessage; } catch { /* invalid receipt */ }
  if (receipt?.recipientId !== context.conversationId || receipt?.content !== text) {
    throw new Error("agentapi did not return a matching delivery receipt");
  }
  return { accepted: true as const, conversationId: context.conversationId };
}
