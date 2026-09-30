import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Migration only. Never install or enable a model-output capture hook again. */
export async function disableAntigravityCapture() {
  const manifest = join(homedir(), ".gemini", "config", "plugins", "agentbridge-native", "plugin.json");
  if (!existsSync(manifest)) return;
  const plugin = JSON.parse(readFileSync(manifest, "utf8"));
  if (plugin.name !== "agentbridge-native" || plugin.description !== "AgentBridge managed native reply capture") {
    throw new Error("Refusing to change an unmanaged native plugin");
  }
  await execute("agy", ["plugin", "disable", "agentbridge-native"], { timeout: 15000, maxBuffer: 65536 });
}

/** Old agy instances may cache the previous Stop command until restart. Keep
 * its entrypoint inert: do not parse/read transcripts, tokens, registries or WS. */
export async function runAntigravityHook() {
  for await (const _chunk of process.stdin) { /* drain metadata without retaining it */ }
  console.log(JSON.stringify({ decision: "stop" }));
}
