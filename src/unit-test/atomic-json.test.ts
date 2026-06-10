import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, atomicWriteText } from "../atomic-json";

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "abg-atomic-json-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("atomic-json", () => {
  test("writes formatted JSON that is immediately readable", () => {
    const dir = tempDir();
    const path = join(dir, "state", "status.json");

    atomicWriteJson(path, { pid: 123, ok: true });

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ pid: 123, ok: true });
    expect(readFileSync(path, "utf-8")).toEndWith("\n");
    expect(readdirSync(join(dir, "state")).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  test("writes plain text atomically for pid-style files", () => {
    const dir = tempDir();
    const path = join(dir, "daemon.pid");

    atomicWriteText(path, "456\n");

    expect(readFileSync(path, "utf-8")).toBe("456\n");
  });

  test("concurrent writers use unique temp files and leave a valid final JSON file", async () => {
    const dir = tempDir();
    const target = join(dir, "shared.json");
    const atomicModuleUrl = pathToFileURL(join(process.cwd(), "src", "atomic-json.ts")).href;
    const script = join(dir, "writer.mjs");
    writeFileSync(
      script,
      [
        `import { atomicWriteJson } from ${JSON.stringify(atomicModuleUrl)};`,
        "const [target, id] = process.argv.slice(2);",
        "atomicWriteJson(target, { id: Number(id), payload: 'x'.repeat(1024) });",
      ].join("\n"),
      "utf-8",
    );

    const children = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn([process.execPath, script, target, String(index)], {
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })));

    expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as { id: number; payload: string };
    expect(parsed.id).toBeGreaterThanOrEqual(0);
    expect(parsed.id).toBeLessThan(8);
    expect(parsed.payload).toHaveLength(1024);
    expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  test("fsync option fsyncs the temp file before rename", () => {
    const dir = tempDir();
    const fsyncSpy = spyOn(fs, "fsyncSync");
    try {
      atomicWriteJson(join(dir, "registry.json"), { version: 1 }, { fsync: true });
      expect(fsyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  test("mode option creates the file owner-only with no world/group window (CWE-732)", () => {
    const dir = tempDir();
    const path = join(dir, "secret-token");

    atomicWriteText(path, "s3cr3t", { mode: 0o600 });

    const mode = fs.statSync(path).mode & 0o777;
    // The security-relevant property: no group/other permission bits are ever set,
    // so the secret is never world/group readable — not even for the temp-file
    // instant before a post-rename chmod would run.
    expect(mode & 0o077).toBe(0);
    expect(mode & 0o400).toBe(0o400); // owner can still read it
    expect(readFileSync(path, "utf-8")).toBe("s3cr3t");
  });

  test("a failed rename leaves the previous target intact", () => {
    const dir = tempDir();
    const path = join(dir, "status.json");
    atomicWriteJson(path, { pid: 111 });
    const renameSpy = spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("rename failed");
    });
    try {
      expect(() => atomicWriteJson(path, { pid: 222 })).toThrow("rename failed");
    } finally {
      renameSpy.mockRestore();
    }

    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ pid: 111 });
    expect(readdirSync(dir).filter((name) => name.includes(".tmp."))).toEqual([]);
  });
});
