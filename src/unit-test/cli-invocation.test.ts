import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliInvocationName, CLI_NAMES, DEFAULT_CLI_NAME } from "../cli-invocation";
import { pairScopedCommand } from "../pair-command";

describe("cliInvocationName", () => {
  test("returns 'abg' when argv[1] basename is 'abg'", () => {
    expect(cliInvocationName(["bun", "/usr/local/bin/abg", "kill"])).toBe("abg");
  });

  test("returns 'agentbridge' when argv[1] basename is 'agentbridge'", () => {
    expect(cliInvocationName(["bun", "/opt/homebrew/bin/agentbridge", "doctor"])).toBe("agentbridge");
  });

  test("falls back to 'abg' for any other basename (e.g. a test runner path)", () => {
    expect(cliInvocationName(["bun", "/private/tmp/some.test.ts"])).toBe("abg");
    expect(cliInvocationName(["node", "/repo/src/cli.ts", "init"])).toBe("abg");
    expect(cliInvocationName(["bun", "/repo/dist/cli.js"])).toBe("abg");
    expect(DEFAULT_CLI_NAME).toBe("abg");
  });

  test("strips a known script extension so a source/dev launcher still matches", () => {
    // `agentbridge.ts` / `abg.js` (source or wrapper) resolve to the published name.
    expect(cliInvocationName(["bun", "/repo/bin/agentbridge.ts"])).toBe("agentbridge");
    expect(cliInvocationName(["bun", "/repo/bin/abg.js"])).toBe("abg");
    // A generic bundle name still falls back — the safe default.
    expect(cliInvocationName(["bun", "/repo/dist/cli.mjs"])).toBe("abg");
  });

  test("handles a missing / empty argv[1] without throwing", () => {
    expect(cliInvocationName(["bun"])).toBe("abg");
    expect(cliInvocationName(["bun", ""])).toBe("abg");
    expect(cliInvocationName([])).toBe("abg");
  });

  test("only the two published names are accepted", () => {
    expect([...CLI_NAMES].sort()).toEqual(["abg", "agentbridge"]);
    // A near-miss (substring / superstring) is NOT a match.
    expect(cliInvocationName(["bun", "/bin/agentbridgex"])).toBe("abg");
    expect(cliInvocationName(["bun", "/bin/ab"])).toBe("abg");
  });
});

describe("cliInvocationName is the single source threaded into guidance", () => {
  // pairScopedCommand defaults its name to cliInvocationName(); swapping
  // process.argv[1] under it proves both echo the SAME name (no second source
  // of truth). This stands in for "kill restart hint / budget hint / doctor
  // daemon hint echo the invoked name consistently" — they all resolve the
  // name through this one helper.
  let savedArgv1: string | undefined;
  let savedPairId: string | undefined;
  let savedPairName: string | undefined;

  beforeEach(() => {
    savedArgv1 = process.argv[1];
    savedPairId = process.env.AGENTBRIDGE_PAIR_ID;
    savedPairName = process.env.AGENTBRIDGE_PAIR_NAME;
    delete process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_NAME;
  });

  afterEach(() => {
    if (savedArgv1 === undefined) process.argv.length = Math.min(process.argv.length, 1);
    else process.argv[1] = savedArgv1;
    if (savedPairId === undefined) delete process.env.AGENTBRIDGE_PAIR_ID;
    else process.env.AGENTBRIDGE_PAIR_ID = savedPairId;
    if (savedPairName === undefined) delete process.env.AGENTBRIDGE_PAIR_NAME;
    else process.env.AGENTBRIDGE_PAIR_NAME = savedPairName;
  });

  test("under argv[1]='agentbridge', the helper AND pairScopedCommand agree", () => {
    process.argv[1] = "/opt/homebrew/bin/agentbridge";
    expect(cliInvocationName()).toBe("agentbridge");
    // pairScopedCommand defaults to cliInvocationName() — so it echoes the same name.
    expect(pairScopedCommand("claude")).toBe("agentbridge claude");
  });

  test("under argv[1]='abg', the helper AND pairScopedCommand agree", () => {
    process.argv[1] = "/usr/local/bin/abg";
    expect(cliInvocationName()).toBe("abg");
    expect(pairScopedCommand("claude")).toBe("abg claude");
  });
});
