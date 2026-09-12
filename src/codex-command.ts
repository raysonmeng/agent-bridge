import { statSync } from "node:fs";
import { win32 } from "node:path";

export const CODEX_BIN_ENV = "AGENTBRIDGE_CODEX_BIN";

/** Resolve a native Windows executable without invoking cmd/PowerShell shims. */
export function resolveCodexCommand(options: {
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? ((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  const override = env[CODEX_BIN_ENV]?.trim();
  if (override) {
    if (platform === "win32" && !/\.exe$/i.test(override)) {
      throw new Error(`${CODEX_BIN_ENV} must point to a native codex.exe on Windows.`);
    }
    if (!isFile(override)) throw new Error(`${CODEX_BIN_ENV} executable not found: ${override}`);
    return override;
  }
  if (platform !== "win32") return "codex";

  // Windows environment keys are case-insensitive; inherited objects may use Path.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const dirs = (pathKey ? env[pathKey] ?? "" : "").split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const dir of dirs) {
    const native = win32.join(dir, "codex.exe");
    if (isFile(native)) return native;
  }

  const target = arch === "x64" ? "x86_64-pc-windows-msvc"
    : arch === "arm64" ? "aarch64-pc-windows-msvc" : null;
  if (target) {
    for (const dir of dirs) {
      // npm global shims sit beside node_modules; local shims live in .bin.
      const modules = win32.basename(dir) === ".bin" ? win32.dirname(dir)
        : win32.join(dir, "node_modules");
      const codexRoot = win32.join(modules, "@openai", "codex");
      const roots = [
        win32.join(codexRoot, "node_modules", "@openai", `codex-win32-${arch}`, "vendor"),
        win32.join(modules, "@openai", `codex-win32-${arch}`, "vendor"),
        win32.join(codexRoot, "vendor"),
      ];
      for (const root of roots) {
        for (const subdir of ["bin", "codex"]) {
          const native = win32.join(root, target, subdir, "codex.exe");
          if (isFile(native)) return native;
        }
      }
    }
  }
  throw new Error(`Cannot find native codex.exe. Add it to PATH or set ${CODEX_BIN_ENV} to its full path.`);
}
