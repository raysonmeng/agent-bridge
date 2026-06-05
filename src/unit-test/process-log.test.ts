import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessLogger } from "../process-log";

describe("createProcessLogger", () => {
  test("stderr EPIPE does not prevent file logging or escape to fatal handlers", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-process-log-"));
    try {
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      const stderr = { write: () => { throw error; } };
      const path = join(root, "agentbridge.log");
      const logger = createProcessLogger({ component: "TestLogger", logFile: path, stderr });

      expect(() => logger.log("hello")).not.toThrow();
      expect(() => logger.fatal("UNCAUGHT EXCEPTION", new Error("boom"))).not.toThrow();

      const contents = readFileSync(path, "utf-8");
      expect(contents).toContain("[TestLogger] hello");
      expect(contents).toContain("[TestLogger] UNCAUGHT EXCEPTION: Error: boom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("async stderr EPIPE disables subsequent stderr writes", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-process-log-"));
    try {
      const path = join(root, "agentbridge.log");
      const writes: string[] = [];
      const stderr = Object.assign(new EventEmitter(), {
        write(line: string) {
          writes.push(line);
          return true;
        },
      });
      const logger = createProcessLogger({ component: "TestLogger", logFile: path, stderr });

      logger.log("before");
      stderr.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      logger.log("after");

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("before");
      expect(readFileSync(path, "utf-8")).toContain("[TestLogger] after");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fatal never throws when the error stack getter throws", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-process-log-"));
    try {
      const path = join(root, "agentbridge.log");
      const logger = createProcessLogger({ component: "TestLogger", logFile: path, stderr: { write: () => true } });
      const hostileError = {};
      Object.defineProperty(hostileError, "stack", {
        get() {
          throw new Error("stack getter exploded");
        },
      });

      expect(() => logger.fatal("UNCAUGHT EXCEPTION", hostileError)).not.toThrow();

      const contents = readFileSync(path, "utf-8");
      expect(contents).toContain("[TestLogger] UNCAUGHT EXCEPTION:");
      expect(contents).toContain("<failed to format error>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
