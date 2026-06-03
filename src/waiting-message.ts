export interface WaitingForCodexTuiMessageOptions {
  attachCmd: string;
  cwd: string;
  pairId: string | null;
  pairName?: string | null;
  slot?: number | null;
  proxyUrl: string;
}

export function formatWaitingForCodexTuiMessage(options: WaitingForCodexTuiMessageOptions): string {
  const pairName = options.pairName ?? "unknown";
  const pairId = options.pairId ?? "manual";
  const slot = options.slot === null || options.slot === undefined ? "manual" : String(options.slot);
  return [
    "⏳ Waiting for Codex TUI to connect.",
    `Current pair: cwd=${options.cwd} pair=${pairName} pairId=${pairId} slot=${slot} proxy=${options.proxyUrl}`,
    "If Codex was started from a different cwd, it belongs to another pair and will not attach here.",
    "Run in another terminal:",
    options.attachCmd,
    "For diagnostics: abg doctor",
  ].join("\n");
}
