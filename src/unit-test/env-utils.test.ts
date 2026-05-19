import { afterEach, describe, expect, test } from "bun:test";
import { parsePositiveIntEnv } from "../env-utils";

describe("parsePositiveIntEnv", () => {
  const envName = "AGENTBRIDGE_TEST_POSITIVE_INT";

  afterEach(() => {
    delete process.env[envName];
  });

  test("returns a safe positive integer when the env var is valid", () => {
    process.env[envName] = "3000";
    expect(parsePositiveIntEnv(envName, 123)).toBe(3000);
  });

  test("falls back when the value exceeds Number.MAX_SAFE_INTEGER", () => {
    process.env[envName] = "9007199254740993";
    expect(parsePositiveIntEnv(envName, 123)).toBe(123);
  });

  test("falls back for the negative overflow analog", () => {
    process.env[envName] = "-9007199254740993";
    expect(parsePositiveIntEnv(envName, 123)).toBe(123);
  });
});
