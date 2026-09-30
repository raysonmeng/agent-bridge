import { expect, test } from "bun:test";
import { launchAgentProfile } from "../cli/agent-profile";

test("launch profile reports only explicit selections, not native defaults", () => {
  expect(launchAgentProfile([], "Claude")).toEqual({ name: "Claude", model: undefined, modelSource: "unknown" });
  expect(launchAgentProfile(["--model", "model-a", "--agent=reviewer"], "Claude", "env-model")).toEqual({ name: "reviewer", model: "model-a", modelSource: "configured" });
  expect(launchAgentProfile(["--model=model-b"], "Antigravity").model).toBe("model-b");
  expect(launchAgentProfile(["--", "--model=not-an-option"], "Claude", "env-model").model).toBe("env-model");
});
