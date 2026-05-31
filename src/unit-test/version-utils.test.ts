import { describe, expect, test } from "bun:test";
import { compareVersions, isStableVersion, isStableUpgrade } from "../version-utils";

describe("compareVersions", () => {
  test("orders by major, minor, patch", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("0.1.7", "0.1.6")).toBe(1);
    expect(compareVersions("0.1.6", "0.1.7")).toBe(-1);
  });

  test("treats missing trailing segments as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });
});

describe("isStableVersion", () => {
  test("accepts exactly three numeric segments", () => {
    expect(isStableVersion("0.1.6")).toBe(true);
    expect(isStableVersion("10.20.30")).toBe(true);
    expect(isStableVersion(" 1.2.3 ")).toBe(true); // trimmed
  });

  test("rejects prerelease / build / prefixed / partial versions", () => {
    expect(isStableVersion("0.2.0-beta.1")).toBe(false);
    expect(isStableVersion("1.2.3+build")).toBe(false);
    expect(isStableVersion("v1.2.3")).toBe(false);
    expect(isStableVersion("1.2")).toBe(false);
    expect(isStableVersion("1.2.3.4")).toBe(false);
    expect(isStableVersion("latest")).toBe(false);
    expect(isStableVersion("")).toBe(false);
  });
});

describe("isStableUpgrade", () => {
  test("true only when latest is a stable version strictly greater than current", () => {
    expect(isStableUpgrade("0.1.6", "0.1.7")).toBe(true);
    expect(isStableUpgrade("0.1.6", "0.2.0")).toBe(true);
    expect(isStableUpgrade("0.1.6", "1.0.0")).toBe(true);
  });

  test("false for equal or older latest (no downgrade nag)", () => {
    expect(isStableUpgrade("0.1.6", "0.1.6")).toBe(false);
    expect(isStableUpgrade("0.1.7", "0.1.6")).toBe(false);
  });

  test("false when either side is prerelease or malformed (no beta nag)", () => {
    expect(isStableUpgrade("0.1.6", "0.2.0-beta.1")).toBe(false);
    expect(isStableUpgrade("0.1.6-rc.1", "0.1.7")).toBe(false);
    expect(isStableUpgrade("0.1.6", "garbage")).toBe(false);
    expect(isStableUpgrade("", "0.1.7")).toBe(false);
  });
});
