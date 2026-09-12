import { describe, expect, test } from "bun:test";
import { resolveCodexCommand } from "../codex-command";

describe("Codex executable resolution", () => {
  const resolve = (env: NodeJS.ProcessEnv, files: string[], arch = "x64") =>
    resolveCodexCommand({ platform: "win32", arch, env, isFile: (path) => files.includes(path) });

  test("keeps POSIX command lookup", () => {
    expect(resolveCodexCommand({ platform: "linux", env: {} })).toBe("codex");
  });
  test("explicit executable overrides PATH and preserves spaces", () => {
    const native = "C:\\My Apps\\codex.exe";
    expect(resolve({ AGENTBRIDGE_CODEX_BIN: native, PATH: "C:\\bin" }, [native, "C:\\bin\\codex.exe"])).toBe(native);
  });
  test("rejects invalid override rather than silently selecting another install", () => {
    expect(() => resolve({ AGENTBRIDGE_CODEX_BIN: "C:\\missing.exe" }, [])).toThrow("executable not found");
    expect(() => resolve({ AGENTBRIDGE_CODEX_BIN: "C:\\bin\\codex.cmd" }, ["C:\\bin\\codex.cmd"])).toThrow("native codex.exe");
  });
  test("finds native exe after npm shim in case-insensitive Path", () => {
    const native = "C:\\Codex App\\codex.exe";
    expect(resolve({ Path: 'C:\\npm;"C:\\Codex App"' }, ["C:\\npm\\codex.cmd", native])).toBe(native);
  });
  test("finds global npm nested platform dependency", () => {
    const native = "C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
    expect(resolve({ PATH: "C:\\npm" }, [native])).toBe(native);
  });
  test("finds local npm hoisted arm64 platform dependency", () => {
    const native = "C:\\repo\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe";
    expect(resolve({ PATH: "C:\\repo\\node_modules\\.bin" }, [native], "arm64")).toBe(native);
  });
  test("supports older bundled vendor layout", () => {
    const native = "C:\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe";
    expect(resolve({ PATH: "C:\\npm" }, [native])).toBe(native);
  });
  test("missing native binary gives actionable error without selecting shell shim", () => {
    expect(() => resolve({ PATH: "C:\\npm" }, ["C:\\npm\\codex.cmd", "C:\\npm\\codex.ps1"])).toThrow("AGENTBRIDGE_CODEX_BIN");
  });
});
