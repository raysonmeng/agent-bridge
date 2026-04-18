import { describe, expect, test } from "bun:test";
import { compareVersions } from "../cli/init";
import { checkOwnedFlagConflicts } from "../cli/claude";
import { buildCodexArgs } from "../cli/codex";

describe("CLI: version comparison", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("2.1.80", "2.1.80")).toBe(0);
  });

  test("higher major returns 1", () => {
    expect(compareVersions("3.0.0", "2.1.80")).toBe(1);
  });

  test("lower major returns -1", () => {
    expect(compareVersions("1.9.99", "2.0.0")).toBe(-1);
  });

  test("higher minor returns 1", () => {
    expect(compareVersions("2.2.0", "2.1.80")).toBe(1);
  });

  test("higher patch returns 1", () => {
    expect(compareVersions("2.1.81", "2.1.80")).toBe(1);
  });

  test("lower patch returns -1", () => {
    expect(compareVersions("2.1.79", "2.1.80")).toBe(-1);
  });
});

describe("CLI: owned flag conflict detection", () => {
  test("passes when no owned flags present", () => {
    expect(() => {
      // checkOwnedFlagConflicts calls process.exit on conflict
      // Here we test the non-conflict case
      const args = ["--resume", "--model", "opus"];
      const ownedFlags = ["--channels", "--dangerously-load-development-channels"];
      // Should not throw or exit
      let exited = false;
      const origExit = process.exit;
      process.exit = (() => { exited = true; }) as any;
      checkOwnedFlagConflicts(args, "agentbridge claude", ownedFlags);
      process.exit = origExit;
      expect(exited).toBe(false);
    }).not.toThrow();
  });

  test("detects exact flag match", () => {
    const args = ["--channels", "something"];
    const ownedFlags = ["--channels"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge claude", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(true);
  });

  test("detects flag=value format", () => {
    const args = ["--channels=plugin:foo"];
    const ownedFlags = ["--channels"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge claude", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(true);
  });

  test("ignores unrelated flags", () => {
    const args = ["--model", "opus", "--resume"];
    const ownedFlags = ["--remote"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge codex", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(false);
  });

  test("allows --enable with non-owned values for codex", () => {
    const args = ["--enable", "some_other_feature"];
    const ownedFlags = ["--remote"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge codex", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(false);
  });

  test("fallback message uses correct native command name", () => {
    const args = ["--remote", "ws://foo"];
    const ownedFlags = ["--remote"];
    let output = "";
    const origExit = process.exit;
    const origError = console.error;
    process.exit = (() => {}) as any;
    console.error = (msg: string) => { output += msg + "\n"; };
    checkOwnedFlagConflicts(args, "agentbridge codex", ownedFlags);
    process.exit = origExit;
    console.error = origError;
    expect(output).toContain("codex [your flags here]");
    expect(output).not.toContain("claude [your flags here]");
  });
});

describe("CLI: buildCodexArgs", () => {
  const PROXY = "ws://127.0.0.1:4501";
  const BRIDGE = ["--enable", "tui_app_server", "--remote", PROXY];

  test("bare codex (no args) injects bridge flags at front", () => {
    const r = buildCodexArgs([], PROXY);
    expect(r.fullArgs).toEqual(BRIDGE);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("bare codex with prompt injects bridge flags at front", () => {
    const r = buildCodexArgs(["hello world"], PROXY);
    expect(r.fullArgs).toEqual([...BRIDGE, "hello world"]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("bare codex with leading flag treated as TUI (injected at front)", () => {
    const r = buildCodexArgs(["--model", "opus"], PROXY);
    expect(r.fullArgs).toEqual([...BRIDGE, "--model", "opus"]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("resume subcommand: bridge flags injected after 'resume'", () => {
    const r = buildCodexArgs(["resume", "019d9a2e-15a7-7841-a7d2-ca0e14a61f40"], PROXY);
    expect(r.fullArgs).toEqual([
      "resume",
      ...BRIDGE,
      "019d9a2e-15a7-7841-a7d2-ca0e14a61f40",
    ]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("resume --last: bridge flags injected after 'resume', --last preserved", () => {
    const r = buildCodexArgs(["resume", "--last"], PROXY);
    expect(r.fullArgs).toEqual(["resume", ...BRIDGE, "--last"]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("resume with session-id + prompt", () => {
    const r = buildCodexArgs(["resume", "abc-123", "continue please"], PROXY);
    expect(r.fullArgs).toEqual(["resume", ...BRIDGE, "abc-123", "continue please"]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("fork subcommand: bridge flags injected after 'fork'", () => {
    const r = buildCodexArgs(["fork", "session-xyz"], PROXY);
    expect(r.fullArgs).toEqual(["fork", ...BRIDGE, "session-xyz"]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("exec subcommand: no bridge flags injected (non-TUI)", () => {
    const r = buildCodexArgs(["exec", "do something"], PROXY);
    expect(r.fullArgs).toEqual(["exec", "do something"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("login subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["login"], PROXY);
    expect(r.fullArgs).toEqual(["login"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("mcp subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["mcp", "list"], PROXY);
    expect(r.fullArgs).toEqual(["mcp", "list"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("review subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["review", "--diff"], PROXY);
    expect(r.fullArgs).toEqual(["review", "--diff"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("help subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["help", "resume"], PROXY);
    expect(r.fullArgs).toEqual(["help", "resume"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("unknown first token treated as bare prompt (TUI)", () => {
    const r = buildCodexArgs(["some-unknown-subcmd", "arg"], PROXY);
    expect(r.fullArgs).toEqual([...BRIDGE, "some-unknown-subcmd", "arg"]);
    expect(r.injectedBridgeFlags).toBe(true);
  });

  test("exec alias 'e' treated as non-TUI", () => {
    const r = buildCodexArgs(["e", "run this"], PROXY);
    expect(r.fullArgs).toEqual(["e", "run this"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("apply alias 'a' treated as non-TUI", () => {
    const r = buildCodexArgs(["a"], PROXY);
    expect(r.fullArgs).toEqual(["a"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });
});
