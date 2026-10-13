import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePairId } from "../pair-registry";
import {
  guardAgentBridgeEnv,
  inspectAgentBridgeEnv,
  type EnvGuardMode,
} from "../env-guard";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempCwd(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `agentbridge-env-guard-${name}-`));
  tempDirs.push(dir);
  return dir;
}

describe("AgentBridge env guard", () => {
  test("reports clean when pair env matches the current cwd and pair name", () => {
    const cwd = tempCwd("clean");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_PAIR_NAME: "main",
      AGENTBRIDGE_BASE_DIR: "/tmp/agentbridge-base",
      AGENTBRIDGE_STATE_DIR: `/tmp/agentbridge-base/pairs/${pairId}`,
      AGENTBRIDGE_CONTROL_PORT: "4502",
      CODEX_WS_PORT: "4500",
      CODEX_PROXY_PORT: "4501",
    } as NodeJS.ProcessEnv;

    expect(inspectAgentBridgeEnv({ cwd, env }).ok).toBe(true);
  });

  test("fix mode clears stale generated env before pair resolution can enter manual mode", () => {
    const cwd = tempCwd("fix");
    const oldCwd = tempCwd("old");
    const stalePairId = derivePairId(oldCwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: stalePairId,
      AGENTBRIDGE_PAIR_NAME: "main",
      AGENTBRIDGE_BASE_DIR: "/tmp/stale-base",
      AGENTBRIDGE_STATE_DIR: `/tmp/stale-base/pairs/${stalePairId}`,
      AGENTBRIDGE_CONTROL_PORT: "4999",
      CODEX_WS_PORT: "4997",
      CODEX_PROXY_PORT: "4998",
      AGENTBRIDGE_MODE: "pull",
    } as NodeJS.ProcessEnv;

    const result = guardAgentBridgeEnv({ cwd, env, mode: "fix" });

    expect(result.action).toBe("fixed");
    expect(env.AGENTBRIDGE_PAIR_ID).toBeUndefined();
    expect(env.AGENTBRIDGE_PAIR_NAME).toBeUndefined();
    expect(env.AGENTBRIDGE_BASE_DIR).toBeUndefined();
    expect(env.AGENTBRIDGE_STATE_DIR).toBeUndefined();
    expect(env.AGENTBRIDGE_CONTROL_PORT).toBeUndefined();
    expect(env.CODEX_WS_PORT).toBeUndefined();
    expect(env.CODEX_PROXY_PORT).toBeUndefined();
    expect(env.AGENTBRIDGE_MODE).toBeUndefined();
  });

  test("fix mode clears manual-looking runtime env unless AGENTBRIDGE_MANUAL is explicit", () => {
    const cwd = tempCwd("manual-env");
    const env = {
      AGENTBRIDGE_STATE_DIR: "/tmp/stale-manual",
      AGENTBRIDGE_CONTROL_PORT: "4502",
      CODEX_WS_PORT: "4500",
      CODEX_PROXY_PORT: "4501",
    } as NodeJS.ProcessEnv;

    const result = guardAgentBridgeEnv({ cwd, env, mode: "fix" });

    expect(result.action).toBe("fixed");
    expect(env.AGENTBRIDGE_STATE_DIR).toBeUndefined();
    expect(env.AGENTBRIDGE_CONTROL_PORT).toBeUndefined();
    expect(env.CODEX_WS_PORT).toBeUndefined();
    expect(env.CODEX_PROXY_PORT).toBeUndefined();
  });

  test("explicit AGENTBRIDGE_MANUAL opt-in allows manual runtime env", () => {
    const cwd = tempCwd("manual-opt-in");
    const env = {
      AGENTBRIDGE_MANUAL: "1",
      AGENTBRIDGE_STATE_DIR: "/tmp/manual",
      AGENTBRIDGE_CONTROL_PORT: "4502",
      CODEX_WS_PORT: "4500",
      CODEX_PROXY_PORT: "4501",
    } as NodeJS.ProcessEnv;

    const result = guardAgentBridgeEnv({ cwd, env, mode: "fix" });

    expect(result.action).toBe("none");
    expect(env.AGENTBRIDGE_STATE_DIR).toBe("/tmp/manual");
  });

  test.each(["warn", "strict"] as EnvGuardMode[])("%s mode leaves stale env intact", (mode) => {
    const cwd = tempCwd(mode);
    const oldCwd = tempCwd(`${mode}-old`);
    const stalePairId = derivePairId(oldCwd, "work");
    const env = {
      AGENTBRIDGE_PAIR_ID: stalePairId,
      AGENTBRIDGE_PAIR_NAME: "work",
      AGENTBRIDGE_STATE_DIR: `/tmp/stale-base/pairs/${stalePairId}`,
    } as NodeJS.ProcessEnv;

    if (mode === "strict") {
      expect(() => guardAgentBridgeEnv({ cwd, env, mode })).toThrow(/stale AgentBridge environment/i);
    } else {
      expect(guardAgentBridgeEnv({ cwd, env, mode }).action).toBe("warned");
    }

    expect(env.AGENTBRIDGE_PAIR_ID).toBe(stalePairId);
  });
});

describe("AgentBridge env guard — win32 paths", () => {
  const BS = String.fromCharCode(92);
  const win = (p: string) => p.replace(/\//g, BS);

  test("backslash state dir written by applyPairEnv on Windows is NOT flagged stale", () => {
    const cwd = tempCwd("win-clean");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_PAIR_NAME: "main",
      AGENTBRIDGE_BASE_DIR: win("C:/Users/u/.local/state/agentbridge"),
      AGENTBRIDGE_STATE_DIR: win(`C:/Users/u/.local/state/agentbridge/pairs/${pairId}`),
      AGENTBRIDGE_CONTROL_PORT: "4532",
      CODEX_WS_PORT: "4530",
      CODEX_PROXY_PORT: "4531",
    } as NodeJS.ProcessEnv;

    const result = guardAgentBridgeEnv({ cwd, env, mode: "fix", platform: "win32" });

    expect(result.reasons).toEqual([]);
    expect(result.action).toBe("none");
    expect(env.AGENTBRIDGE_CONTROL_PORT).toBe("4532");
  });

  test("drive-letter / case differences between base and state dir are tolerated on win32", () => {
    const cwd = tempCwd("win-case");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_BASE_DIR: "c:/users/u/state",
      AGENTBRIDGE_STATE_DIR: win(`C:/Users/U/State/pairs/${pairId}`) + BS,
    } as NodeJS.ProcessEnv;

    expect(inspectAgentBridgeEnv({ cwd, env, platform: "win32" }).ok).toBe(true);
  });

  test("a state dir for a DIFFERENT pair is still flagged on win32", () => {
    const cwd = tempCwd("win-stale");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_BASE_DIR: win("C:/state"),
      AGENTBRIDGE_STATE_DIR: win("C:/state/pairs/main-deadbeef"),
    } as NodeJS.ProcessEnv;

    const inspection = inspectAgentBridgeEnv({ cwd, env, platform: "win32" });
    expect(inspection.ok).toBe(false);
    expect(inspection.reasons.join(" ")).toContain(`/pairs/${pairId}`);
  });

  test("POSIX keeps case-sensitive comparison", () => {
    const cwd = tempCwd("posix-case");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_BASE_DIR: "/tmp/Base",
      AGENTBRIDGE_STATE_DIR: `/tmp/base/pairs/${pairId}`,
    } as NodeJS.ProcessEnv;

    expect(inspectAgentBridgeEnv({ cwd, env, platform: "linux" }).ok).toBe(false);
  });
});
