import { describe, expect, test } from "bun:test";
import { compareVersions } from "../cli/init";
import { checkOwnedFlagConflicts, warnIfPluginCacheMissing, mapChildExitCode } from "../cli/claude";
import {
  buildCodexArgs,
  parseAgentBridgeCodexArgs,
  resolveCodexResumeArgs,
} from "../cli/codex";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDirResolver } from "../state-dir";
import {
  promoteCurrentThreadIfRolloutExists,
  writePendingCurrentThread,
} from "../thread-state";

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

  test("detects --remote after 'resume' subcommand", () => {
    const args = ["resume", "--remote", "ws://evil"];
    const ownedFlags = ["--remote"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge codex", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(true);
  });

  test("detects --remote=value after 'fork' subcommand", () => {
    const args = ["fork", "session-id", "--remote=ws://evil"];
    const ownedFlags = ["--remote"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge codex", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(true);
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

describe("CLI: claude plugin-cache preflight (fail-open)", () => {
  test("missing cache dir → emits a warning pointing at `abg init`", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "agentbridge-preflight-")), "no-such-cache");
    let warned = "";
    const didWarn = warnIfPluginCacheMissing(missing, (msg) => {
      warned += msg + "\n";
    });
    expect(didWarn).toBe(true);
    expect(warned).toContain("abg init");
    expect(warned).toContain("/plugin marketplace add raysonmeng/agent-bridge");
    // Fail-open: this is only a warning; runClaude continues to spawn after it.
    expect(warned).toContain("Launching anyway");
  });

  test("present cache dir → no warning", () => {
    const present = mkdtempSync(join(tmpdir(), "agentbridge-preflight-present-"));
    let warned = "";
    const didWarn = warnIfPluginCacheMissing(present, (msg) => {
      warned += msg + "\n";
    });
    expect(didWarn).toBe(false);
    expect(warned).toBe("");
    rmSync(present, { recursive: true, force: true });
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

  test("plugin subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["plugin", "install", "foo"], PROXY);
    expect(r.fullArgs).toEqual(["plugin", "install", "foo"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("remote-control subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["remote-control"], PROXY);
    expect(r.fullArgs).toEqual(["remote-control"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("update subcommand: pass-through, no bridge flags", () => {
    const r = buildCodexArgs(["update"], PROXY);
    expect(r.fullArgs).toEqual(["update"]);
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

describe("CLI: AgentBridge Codex resume args", () => {
  function makePair(root: string) {
    return {
      pairId: "main-12345678",
      slot: 0,
      ports: { appPort: 4500, proxyPort: 4501, controlPort: 4502 },
      stateDir: new StateDirResolver(join(root, "pair-state")),
      name: "main",
      manual: false,
    };
  }

  test("--new is consumed by AgentBridge and disables auto-resume", () => {
    const parsed = parseAgentBridgeCodexArgs(["--new", "--model", "o3"]);
    expect(parsed).toEqual({ rest: ["--model", "o3"], forceNew: true, resumeCurrent: false });

    const root = mkdtempSync(join(tmpdir(), "agentbridge-cli-resume-"));
    try {
      const result = resolveCodexResumeArgs(parsed, makePair(root));
      expect(result).toEqual({ rest: ["--model", "o3"], mode: "new" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare codex auto-resumes only a rollout-backed current thread", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-cli-resume-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agentbridge-codex-home-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const pair = makePair(root);
      const cwd = process.cwd();
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "rollout-thread-abc.jsonl"), "{}\n", "utf-8");
      promoteCurrentThreadIfRolloutExists(
        { stateDir: pair.stateDir, pairId: pair.pairId, pairName: pair.name, cwd },
        "thread-abc",
        "test",
        { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      );

      const result = resolveCodexResumeArgs(
        parseAgentBridgeCodexArgs([]),
        pair,
        { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      );
      expect(result.mode).toBe("auto-resume");
      expect(result.rest).toEqual(["resume", "thread-abc"]);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("resume-current errors when no verified current thread exists", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-cli-resume-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const result = resolveCodexResumeArgs(parseAgentBridgeCodexArgs(["resume-current"]), makePair(root));
      expect(result.mode).toBe("resume-current");
      expect(result.error).toContain("No verified current Codex thread");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resume-current error surfaces a pending thread id with an explicit resume hint", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-cli-resume-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agentbridge-codex-home-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const pair = makePair(root);
      const cwd = process.cwd();
      // Pending record for THIS pair + cwd, but no rollout file anywhere:
      // promotion cannot happen, yet the user deserves the threadId.
      writePendingCurrentThread(
        { stateDir: pair.stateDir, pairId: pair.pairId, pairName: pair.name, cwd },
        "thread-pending-1",
        "test",
      );

      const result = resolveCodexResumeArgs(
        parseAgentBridgeCodexArgs(["resume-current"]),
        pair,
        { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      );
      expect(result.mode).toBe("resume-current");
      expect(result.error).toContain("No verified current Codex thread");
      expect(result.error).toContain("thread-pending-1");
      expect(result.error).toContain("abg codex resume thread-pending-1");
      expect(result.error).toContain("abg codex --new");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("resume-current error omits the pending hint when the record belongs to another cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-cli-resume-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agentbridge-codex-home-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const pair = makePair(root);
      // Same pair, different cwd — hinting this threadId would cross-wire projects.
      writePendingCurrentThread(
        { stateDir: pair.stateDir, pairId: pair.pairId, pairName: pair.name, cwd: join(root, "elsewhere") },
        "thread-foreign",
        "test",
      );

      const result = resolveCodexResumeArgs(
        parseAgentBridgeCodexArgs(["resume-current"]),
        pair,
        { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      );
      expect(result.mode).toBe("resume-current");
      expect(result.error).toContain("No verified current Codex thread");
      expect(result.error).not.toContain("thread-foreign");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("resume-current promotes a pending thread whose rollout now exists", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-cli-resume-"));
    const codexHome = mkdtempSync(join(tmpdir(), "agentbridge-codex-home-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const pair = makePair(root);
      const cwd = process.cwd();
      writePendingCurrentThread(
        { stateDir: pair.stateDir, pairId: pair.pairId, pairName: pair.name, cwd },
        "thread-late-cli",
        "test",
      );
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "rollout-thread-late-cli.jsonl"), "{}\n", "utf-8");

      const result = resolveCodexResumeArgs(
        parseAgentBridgeCodexArgs(["resume-current"]),
        pair,
        { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      );
      expect(result.mode).toBe("resume-current");
      expect(result.error).toBeUndefined();
      expect(result.rest).toEqual(["resume", "thread-late-cli"]);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("CLI: buildCodexArgs --yolo positioning (max-permission default)", () => {
  const PROXY = "ws://127.0.0.1:4501";
  const BRIDGE_YOLO = ["--enable", "tui_app_server", "--remote", PROXY, "--yolo"];

  test("bare codex: --yolo rides with the bridge flags at front", () => {
    const r = buildCodexArgs([], PROXY, { yolo: true });
    expect(r.fullArgs).toEqual(BRIDGE_YOLO);
  });

  test("resume subcommand: --yolo lands after 'resume' with the bridge flags", () => {
    const r = buildCodexArgs(["resume", "thread-1"], PROXY, { yolo: true });
    expect(r.fullArgs).toEqual(["resume", ...BRIDGE_YOLO, "thread-1"]);
  });

  test("non-TUI subcommand never gets --yolo (exec sandboxing untouched)", () => {
    const r = buildCodexArgs(["exec", "ls"], PROXY, { yolo: true });
    expect(r.fullArgs).toEqual(["exec", "ls"]);
    expect(r.injectedBridgeFlags).toBe(false);
  });

  test("yolo:false matches the legacy two-arg shape exactly", () => {
    const withOpt = buildCodexArgs(["resume", "t"], PROXY, { yolo: false });
    const legacy = buildCodexArgs(["resume", "t"], PROXY);
    expect(withOpt).toEqual(legacy);
  });
});

describe("CLI: resolveResumeTargets (abg resume)", () => {
  test("returns both sides' ids from the claude transcript dir and the pair thread state", async () => {
    const { resolveResumeTargets } = await import("../cli/resume");
    const { encodeClaudeProjectDir } = await import("../claude-session");
    const { derivePairId } = await import("../pair-registry");

    const root = mkdtempSync(join(tmpdir(), "abg-resume-targets-"));
    const previousBase = process.env.AGENTBRIDGE_BASE_DIR;
    process.env.AGENTBRIDGE_BASE_DIR = join(root, "base");
    try {
      const cwd = process.cwd();

      // Claude side: one uuid transcript for this cwd.
      const claudeHome = join(root, "claude-home");
      const projectDir = join(claudeHome, "projects", encodeClaudeProjectDir(cwd));
      mkdirSync(projectDir, { recursive: true });
      const sessionId = "12345678-1234-1234-1234-123456789abc";
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}\n");

      // Codex side: a verified current-thread file for the derived "main" pair.
      const pairId = derivePairId(cwd, "main");
      const pairDir = join(root, "base", "pairs", pairId);
      mkdirSync(pairDir, { recursive: true });
      const rolloutPath = join(root, "rollout.jsonl");
      writeFileSync(rolloutPath, "{}\n");
      writeFileSync(
        join(pairDir, "current-thread.json"),
        JSON.stringify({
          version: 1,
          status: "current",
          pairId,
          pairName: "main",
          cwd,
          threadId: "thread-resume-test",
          updatedAt: new Date().toISOString(),
          rolloutPath,
        }),
      );

      const targets = resolveResumeTargets({ claudeHome });
      expect(targets.claudeSessionId).toBe(sessionId);
      expect(targets.codexThreadId).toBe("thread-resume-test");
      expect(targets.pairName).toBe("main");
    } finally {
      if (previousBase === undefined) delete process.env.AGENTBRIDGE_BASE_DIR;
      else process.env.AGENTBRIDGE_BASE_DIR = previousBase;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns nulls when nothing exists to resume", async () => {
    const { resolveResumeTargets } = await import("../cli/resume");
    const root = mkdtempSync(join(tmpdir(), "abg-resume-empty-"));
    const previousBase = process.env.AGENTBRIDGE_BASE_DIR;
    process.env.AGENTBRIDGE_BASE_DIR = join(root, "base");
    try {
      const targets = resolveResumeTargets({ claudeHome: join(root, "claude-home") });
      expect(targets.claudeSessionId).toBeNull();
      expect(targets.codexThreadId).toBeNull();
    } finally {
      if (previousBase === undefined) delete process.env.AGENTBRIDGE_BASE_DIR;
      else process.env.AGENTBRIDGE_BASE_DIR = previousBase;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CLI claude: child exit-code mapping (signal-aware, mirrors codex wrapper)", () => {
  test("normal exit code passes through", () => {
    expect(mapChildExitCode(0, null)).toBe(0);
    expect(mapChildExitCode(1, null)).toBe(1);
    expect(mapChildExitCode(42, null)).toBe(42);
  });

  test("null code with no signal maps to 0", () => {
    expect(mapChildExitCode(null, null)).toBe(0);
  });

  test("a signal-killed child reports 128+N, NOT 0 (the bug)", () => {
    // A signal-killed child is reaped with code=null + signal set; the old
    // `code ?? 0` wrongly reported 0. The wrapper must surface a non-zero,
    // conventional 128+signal exit so scripts see the failure.
    expect(mapChildExitCode(null, "SIGINT")).toBe(130); // 128 + 2
    expect(mapChildExitCode(null, "SIGTERM")).toBe(143); // 128 + 15
    expect(mapChildExitCode(null, "SIGKILL")).toBe(137); // 128 + 9
  });

  test("signal takes precedence over a present code (signal-killed is a failure)", () => {
    expect(mapChildExitCode(0, "SIGTERM")).toBe(143);
  });

  test("unknown signal name still yields a non-zero exit (128 + 0 fallback)", () => {
    // os.constants.signals[unknown] is undefined → 128 + 0 = 128, still non-zero.
    expect(mapChildExitCode(null, "SIGNOPE" as NodeJS.Signals)).toBe(128);
  });
});
