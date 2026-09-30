/** Only explicit launch selections, never a guessed native default. */
export function launchAgentProfile(args: string[], name: string, model?: string) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    for (const flag of ["--agent", "--model"]) {
      const value = args[i] === flag ? args[i + 1] : args[i].startsWith(`${flag}=`) ? args[i].slice(flag.length + 1) : undefined;
      if (value && !value.startsWith("--")) {
        if (flag === "--agent") name = value;
        else model = value;
      }
    }
  }
  return { name, model, modelSource: model ? "configured" as const : "unknown" as const };
}
