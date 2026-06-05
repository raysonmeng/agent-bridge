import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRotatingLog } from "../rotating-log";

describe("appendRotatingLog", () => {
  test("rotates when appending would exceed max bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    try {
      const path = join(root, "agentbridge.log");
      appendRotatingLog(path, "aaaa\n", { maxBytes: 8, keep: 2 });
      appendRotatingLog(path, "bbbb\n", { maxBytes: 8, keep: 2 });

      expect(readFileSync(path, "utf-8")).toBe("bbbb\n");
      expect(readFileSync(`${path}.1`, "utf-8")).toBe("aaaa\n");
      expect(existsSync(`${path}.2`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotates a pre-existing oversized current log before appending", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    try {
      const path = join(root, "agentbridge.log");
      writeFileSync(path, "oversized\n", "utf-8");

      appendRotatingLog(path, "next\n", { maxBytes: 8, keep: 2 });

      expect(readFileSync(path, "utf-8")).toBe("next\n");
      expect(readFileSync(`${path}.1`, "utf-8")).toBe("oversized\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid rotation env values fall back instead of disabling rotation", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    const savedMax = process.env.AGENTBRIDGE_LOG_MAX_BYTES;
    const savedKeep = process.env.AGENTBRIDGE_LOG_ROTATE_KEEP;
    try {
      process.env.AGENTBRIDGE_LOG_MAX_BYTES = "8";
      process.env.AGENTBRIDGE_LOG_ROTATE_KEEP = "0";
      const path = join(root, "agentbridge.log");

      appendRotatingLog(path, "aaaa\n");
      appendRotatingLog(path, "bbbb\n");

      expect(readFileSync(path, "utf-8")).toBe("bbbb\n");
      expect(readFileSync(`${path}.1`, "utf-8")).toBe("aaaa\n");
    } finally {
      if (savedMax === undefined) delete process.env.AGENTBRIDGE_LOG_MAX_BYTES;
      else process.env.AGENTBRIDGE_LOG_MAX_BYTES = savedMax;
      if (savedKeep === undefined) delete process.env.AGENTBRIDGE_LOG_ROTATE_KEEP;
      else process.env.AGENTBRIDGE_LOG_ROTATE_KEEP = savedKeep;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
