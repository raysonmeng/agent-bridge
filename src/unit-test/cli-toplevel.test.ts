import { describe, expect, test } from "bun:test";
import { parseTopLevel } from "../cli";

describe("parseTopLevel — leading --pair before the subcommand", () => {
  test("no args → undefined command", () => {
    expect(parseTopLevel([])).toEqual({ command: undefined, restArgs: [] });
  });

  test("bare subcommand passes through unchanged", () => {
    expect(parseTopLevel(["claude", "--resume"])).toEqual({
      command: "claude",
      restArgs: ["--resume"],
    });
  });

  test("leading --pair <name> is re-attached in front of a pair-aware command", () => {
    expect(parseTopLevel(["--pair", "work", "claude", "--resume"])).toEqual({
      command: "claude",
      restArgs: ["--pair", "work", "--resume"],
    });
  });

  test("leading --pair=<name> is re-attached too", () => {
    expect(parseTopLevel(["--pair=work", "codex", "--model", "o3"])).toEqual({
      command: "codex",
      restArgs: ["--pair=work", "--model", "o3"],
    });
  });

  test("leading --pair works for kill", () => {
    expect(parseTopLevel(["--pair", "work", "kill"])).toEqual({
      command: "kill",
      restArgs: ["--pair", "work"],
    });
  });

  test("classic trailing --pair is left in place (command's own parser handles it)", () => {
    expect(parseTopLevel(["claude", "--pair", "work"])).toEqual({
      command: "claude",
      restArgs: ["--pair", "work"],
    });
  });

  test("--pair with a missing value (next is a flag) does not swallow the flag", () => {
    // "--pair" then "claude" — "claude" is a value (not a flag), so it is taken
    // as the pair name and there is no command. This mirrors parsePairFlag's
    // value-consumption rule and surfaces a clear downstream error.
    expect(parseTopLevel(["--pair", "claude"])).toEqual({
      command: undefined,
      restArgs: [],
    });
    // But a following FLAG is never consumed as the name.
    expect(parseTopLevel(["--pair", "--help"])).toEqual({
      command: "--help",
      restArgs: [],
    });
  });

  test("leading --pair before a non-pair-aware command is dropped", () => {
    // `pairs` does not take --pair; the leading token is ignored rather than
    // breaking the pairs argument parser.
    expect(parseTopLevel(["--pair", "work", "pairs"])).toEqual({
      command: "pairs",
      restArgs: [],
    });
  });

  test("--help / --version pass through as the command", () => {
    expect(parseTopLevel(["--help"]).command).toBe("--help");
    expect(parseTopLevel(["--version"]).command).toBe("--version");
  });
});
