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

  test("accepts native Windows state paths and preserves valid generated env in fix mode", () => {
    const cwd = tempCwd("windows-path");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_PAIR_NAME: "main",
      AGENTBRIDGE_BASE_DIR: "C:\\Users\\Trevor\\.agentbridge",
      AGENTBRIDGE_STATE_DIR: `C:\\Users\\Trevor\\.agentbridge\\pairs\\${pairId}`,
      AGENTBRIDGE_CONTROL_PORT: "4502",
    } as NodeJS.ProcessEnv;

    const result = guardAgentBridgeEnv({ cwd, env, mode: "fix" });

    expect(result.action).toBe("none");
    expect(result.ok).toBe(true);
    expect(env.AGENTBRIDGE_PAIR_ID).toBe(pairId);
    expect(env.AGENTBRIDGE_STATE_DIR).toBe(`C:\\Users\\Trevor\\.agentbridge\\pairs\\${pairId}`);
  });

  test("accepts mixed separators and case differences in Windows path comparisons", () => {
    const cwd = tempCwd("windows-path-case");
    const pairId = derivePairId(cwd, "main");
    const env = {
      AGENTBRIDGE_PAIR_ID: pairId,
      AGENTBRIDGE_PAIR_NAME: "main",
      AGENTBRIDGE_BASE_DIR: "c:/users/trevor/.AgentBridge/",
      AGENTBRIDGE_STATE_DIR: `C:\\Users\\Trevor\\.agentbridge/pairs/${pairId.toUpperCase()}`,
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
