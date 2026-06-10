import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairScopedCommand } from "../pair-command";
import { writeRegistry } from "../pair-registry";

describe("pairScopedCommand", () => {
  let savedId: string | undefined;
  let savedName: string | undefined;
  let savedBase: string | undefined;
  let savedState: string | undefined;
  let base: string;

  beforeEach(() => {
    savedId = process.env.AGENTBRIDGE_PAIR_ID;
    savedName = process.env.AGENTBRIDGE_PAIR_NAME;
    savedBase = process.env.AGENTBRIDGE_BASE_DIR;
    savedState = process.env.AGENTBRIDGE_STATE_DIR;
    delete process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_NAME;
    // Isolate the registry the conservative-C name recovery reads from, so a real
    // dev-machine registry never leaks into these assertions.
    base = mkdtempSync(join(tmpdir(), "abg-paircmd-test-"));
    process.env.AGENTBRIDGE_BASE_DIR = base;
    delete process.env.AGENTBRIDGE_STATE_DIR;
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore("AGENTBRIDGE_PAIR_ID", savedId);
    restore("AGENTBRIDGE_PAIR_NAME", savedName);
    restore("AGENTBRIDGE_BASE_DIR", savedBase);
    restore("AGENTBRIDGE_STATE_DIR", savedState);
    rmSync(base, { recursive: true, force: true });
  });

  // The leading binary name now comes from cliInvocationName(); in the test
  // runner argv[1] is a test path, so the live default resolves to "abg". The
  // explicit-name overload is exercised separately below to prove either name
  // flows through.
  test("legacy/manual mode (no AGENTBRIDGE_PAIR_ID) → bare command (default name)", () => {
    expect(pairScopedCommand("codex")).toBe("abg codex");
    expect(pairScopedCommand("claude")).toBe("abg claude");
    expect(pairScopedCommand("kill")).toBe("abg kill");
  });

  test("pair mode → puts --pair <selector> BEFORE the subcommand", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "work-1a2b3c4d";
    process.env.AGENTBRIDGE_PAIR_NAME = "work";
    expect(pairScopedCommand("codex")).toBe("abg --pair work codex");
    expect(pairScopedCommand("claude")).toBe("abg --pair work claude");
    expect(pairScopedCommand("kill")).toBe("abg --pair work kill");
  });

  test("echoes the explicit invocation name (abg vs agentbridge)", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "work-1a2b3c4d";
    process.env.AGENTBRIDGE_PAIR_NAME = "work";
    expect(pairScopedCommand("codex", "agentbridge")).toBe("agentbridge --pair work codex");
    expect(pairScopedCommand("codex", "abg")).toBe("abg --pair work codex");
    // Bare (legacy) form also threads the name through.
    delete process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_NAME;
    expect(pairScopedCommand("claude", "agentbridge")).toBe("agentbridge claude");
    expect(pairScopedCommand("claude", "abg")).toBe("abg claude");
  });

  test("prefers the friendly name over the composite pairId", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "main-deadbeef";
    process.env.AGENTBRIDGE_PAIR_NAME = "main";
    expect(pairScopedCommand("codex", "agentbridge")).toBe("agentbridge --pair main codex");
  });

  test("--pair precedes the subcommand's own extra args", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "review-1a2b3c4d";
    process.env.AGENTBRIDGE_PAIR_NAME = "review";
    expect(pairScopedCommand("claude --resume", "agentbridge")).toBe("agentbridge --pair review claude --resume");
  });

  test("an empty-string AGENTBRIDGE_PAIR_ID is treated as unset (no --pair)", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "";
    expect(pairScopedCommand("codex", "agentbridge")).toBe("agentbridge codex");
  });

  // Conservative C: when AGENTBRIDGE_PAIR_NAME is missing (e.g. an OLD bridge
  // process started before the NAME env shipped), recover the friendly name from
  // the registry by pairId instead of exposing the raw composite id in the hint.
  test("recovers the friendly name from the registry when PAIR_NAME is unset", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "myproj-1a2b3c4d";
    writeRegistry(base, {
      version: 1,
      pairs: [
        { pairId: "myproj-1a2b3c4d", slot: 3, cwd: "/some/dir", name: "myproj", source: "cwd", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(pairScopedCommand("codex", "agentbridge")).toBe("agentbridge --pair myproj codex");
  });

  test("falls back to the composite pairId when PAIR_NAME unset AND no registry match", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "myproj-1a2b3c4d";
    writeRegistry(base, { version: 1, pairs: [] });
    expect(pairScopedCommand("codex", "agentbridge")).toBe("agentbridge --pair myproj-1a2b3c4d codex");
  });

  // best-effort: a corrupt/unreadable registry must NOT throw while rendering a
  // hint — it falls back to the pairId. (readRegistry throws PAIR_REGISTRY_CORRUPT
  // on unparseable JSON; pairScopedCommand swallows it.)
  test("a corrupt registry does not throw, falls back to the pairId", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "ghost-deadbeef";
    mkdirSync(join(base, "pairs"), { recursive: true });
    writeFileSync(join(base, "pairs", "registry.json"), "{ this is not valid json", "utf-8");
    expect(() => pairScopedCommand("codex", "agentbridge")).not.toThrow();
    expect(pairScopedCommand("codex", "agentbridge")).toBe("agentbridge --pair ghost-deadbeef codex");
  });
});
