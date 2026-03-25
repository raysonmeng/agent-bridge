import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";

/** Flags that AgentBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

export async function runClaude(args: string[]) {
  // Check for owned flag conflicts
  checkOwnedFlagConflicts(args, "agentbridge claude", OWNED_FLAGS);

  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  const fullArgs = [
    "--channels", channelEntry,
    "--dangerously-load-development-channels", channelEntry,
    ...args,
  ];

  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: claude not found in PATH.");
      console.error("Install Claude Code: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
    console.error(`Error starting Claude Code: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Check if user passed any AgentBridge-owned flags.
 * Hard error if they did — mixed flag state is unpredictable.
 */
export function checkOwnedFlagConflicts(
  args: string[],
  commandName: string,
  ownedFlags: string[],
) {
  for (const flag of ownedFlags) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by ${commandName}.`);
      console.error("");
      console.error("AgentBridge automatically injects these flags:");
      for (const f of ownedFlags) {
        console.error(`  ${f}`);
      }
      console.error("");
      const nativeCmd = commandName.includes("codex") ? "codex" : "claude";
      console.error("If you need full control over these flags, use the native command directly:");
      console.error(`  ${nativeCmd} [your flags here]`);
      process.exit(1);
    }
  }
}
