import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionContextAdditionalContext,
  buildSessionContextHookJson,
  isRuntimeInjectionEnabled,
  parseSessionContextArgs,
  runPrintSessionContext,
} from "../session-context-hook";
import { CLAUDE_SESSION_CONTEXT } from "../collaboration-contract";

describe("isRuntimeInjectionEnabled", () => {
  test("defaults to enabled: no config file", () => {
    expect(isRuntimeInjectionEnabled(null)).toBe(true);
  });

  test("defaults to enabled: config without an injection block", () => {
    expect(isRuntimeInjectionEnabled(JSON.stringify({ budget: { pauseAt: 90 } }))).toBe(true);
  });

  test("defaults to enabled: corrupt JSON must not silently disable delivery", () => {
    expect(isRuntimeInjectionEnabled("{not json")).toBe(true);
  });

  test("mirrors ConfigService.normalizeBoolean spellings exactly", () => {
    // Disable: boolean false + the env-var-ish string spellings.
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: false } }))).toBe(false);
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: "false" } }))).toBe(false);
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: "0" } }))).toBe(false);
    // Enable: boolean true + spellings.
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: true } }))).toBe(true);
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: "true" } }))).toBe(true);
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: "1" } }))).toBe(true);
    // Everything else keeps the default (same as normalizeBoolean's fallback) —
    // including a bare NUMBER 0, which normalizeBoolean does not accept.
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: "off" } }))).toBe(true);
    expect(isRuntimeInjectionEnabled(JSON.stringify({ injection: { runtime: 0 } }))).toBe(true);
  });
});

describe("buildSessionContextAdditionalContext", () => {
  test("status line first, then the full collaboration context", () => {
    const out = buildSessionContextAdditionalContext();
    expect(out.startsWith("AgentBridge is running.")).toBe(true);
    expect(out).toContain(CLAUDE_SESSION_CONTEXT);
  });

  test("optional notice rides the status line", () => {
    const out = buildSessionContextAdditionalContext("Update available: 0.2.0");
    const statusLine = out.split("\n")[0]!;
    expect(statusLine).toContain("Update available: 0.2.0");
  });
});

describe("buildSessionContextHookJson", () => {
  test("emits valid single-line hook JSON with the SessionStart shape", () => {
    const raw = buildSessionContextHookJson("note");
    expect(raw).not.toContain("\n"); // stdout protocol: one JSON document per line
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("AgentBridge is running.");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Multi-Agent Collaboration");
  });
});

describe("parseSessionContextArgs", () => {
  test("reads --workspace and --notice", () => {
    const args = parseSessionContextArgs(["--workspace", "/tmp/proj", "--notice", "hi there"]);
    expect(args.workspace).toBe("/tmp/proj");
    expect(args.notice).toBe("hi there");
  });

  test("blank --notice (health-check.sh always passes the flag) → undefined", () => {
    const args = parseSessionContextArgs(["--workspace", "/tmp/proj", "--notice", ""]);
    expect(args.notice).toBeUndefined();
  });

  test("defaults workspace to cwd when flag absent", () => {
    expect(parseSessionContextArgs([]).workspace).toBe(process.cwd());
  });

  test("reads --check", () => {
    expect(parseSessionContextArgs(["--check"]).checkOnly).toBe(true);
    expect(parseSessionContextArgs([]).checkOnly).toBe(false);
  });
});

describe("runPrintSessionContext", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function workspaceWithConfig(config: string | null): string {
    dir = mkdtempSync(join(tmpdir(), "abg-hook-"));
    if (config !== null) {
      mkdirSync(join(dir, ".agentbridge"), { recursive: true });
      writeFileSync(join(dir, ".agentbridge", "config.json"), config, "utf-8");
    }
    return dir;
  }

  test("--check prints disabled for an opt-out config (the health-check.sh gate)", () => {
    const workspace = workspaceWithConfig(JSON.stringify({ injection: { runtime: false } }));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(runPrintSessionContext(["--check", "--workspace", workspace])).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toBe("disabled");
    } finally {
      log.mockRestore();
    }
  });

  test("--check prints enabled without a config file and for corrupt JSON", () => {
    const workspace = workspaceWithConfig("{corrupt");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      runPrintSessionContext(["--check", "--workspace", workspace]);
      expect(log.mock.calls[0]![0]).toBe("enabled");
    } finally {
      log.mockRestore();
    }
  });

  test("payload mode prints nothing when disabled, full hook JSON when enabled", () => {
    const workspace = workspaceWithConfig(JSON.stringify({ injection: { runtime: "false" } }));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      runPrintSessionContext(["--workspace", workspace]);
      expect(log).not.toHaveBeenCalled();
      runPrintSessionContext(["--workspace", join(workspace, "nonexistent")]);
      expect(log).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(log.mock.calls[0]![0] as string);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    } finally {
      log.mockRestore();
    }
  });
});
