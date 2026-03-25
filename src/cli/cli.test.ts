import { describe, expect, test } from "bun:test";
import { compareVersions } from "./init";
import { checkOwnedFlagConflicts } from "./claude";

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
    const ownedFlags = ["--remote", "--enable"];
    let exited = false;
    const origExit = process.exit;
    process.exit = (() => { exited = true; }) as any;
    checkOwnedFlagConflicts(args, "agentbridge codex", ownedFlags);
    process.exit = origExit;
    expect(exited).toBe(false);
  });
});
