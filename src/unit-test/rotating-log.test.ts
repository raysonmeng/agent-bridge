import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FsOps, appendRotatingLog } from "../rotating-log";

/**
 * Real fs ops wired through the production injection seam. Tests clone this and
 * override a single op to inject the exact ENOENT a concurrent cross-process
 * writer produces mid-rotation. (A static ESM `import { renameSync }` binding
 * cannot be monkey-patched after load, so reassigning `fs.renameSync` would
 * never reach the production code — hence the seam.)
 */
const realFsOps: FsOps = { statSync, renameSync, unlinkSync, appendFileSync, existsSync };

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

  test("keeps exactly `keep` rotated generations and drops the oldest (no regression)", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    try {
      const path = join(root, "agentbridge.log");
      // keep=3 → at most path.1, path.2, path.3 survive; the 4th generation is dropped.
      appendRotatingLog(path, "g1\n", { maxBytes: 4, keep: 3 });
      appendRotatingLog(path, "g2\n", { maxBytes: 4, keep: 3 });
      appendRotatingLog(path, "g3\n", { maxBytes: 4, keep: 3 });
      appendRotatingLog(path, "g4\n", { maxBytes: 4, keep: 3 });
      appendRotatingLog(path, "g5\n", { maxBytes: 4, keep: 3 });

      expect(readFileSync(path, "utf-8")).toBe("g5\n");
      expect(readFileSync(`${path}.1`, "utf-8")).toBe("g4\n");
      expect(readFileSync(`${path}.2`, "utf-8")).toBe("g3\n");
      expect(readFileSync(`${path}.3`, "utf-8")).toBe("g2\n");
      expect(existsSync(`${path}.4`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ENOENT during the head rename does not throw and does not lose the line", () => {
    // Simulate the cross-process interleaving where a PEER writer rotates the
    // current log away in the gap between our oversize check and our head
    // rename. The append must still land (no lost line) and must not throw.
    //
    // The injected renameSync models the peer winning the `path -> path.1` race:
    // it performs the real move (the peer's effect) and then throws ENOENT — the
    // error OUR own rename would observe finding the source already gone. The
    // production code must swallow that ENOENT and let appendFileSync recreate
    // `path`. If the ENOENT-tolerance is reverted, the throw escapes and this
    // test FAILS — that is what makes it non-vacuous.
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    try {
      const path = join(root, "agentbridge.log");
      writeFileSync(path, "oversized-current\n", "utf-8");

      let armed = true;
      const fsOps: FsOps = {
        ...realFsOps,
        renameSync: ((from: string, to: string) => {
          if (armed && from === path) {
            armed = false;
            // Peer already moved `path` to `path.1`; our rename now races ENOENT.
            renameSync(from, to);
            const err: NodeJS.ErrnoException = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            throw err;
          }
          return renameSync(from, to);
        }) as typeof renameSync,
      };

      expect(() =>
        appendRotatingLog(path, "new-line\n", { maxBytes: 8, keep: 3 }, fsOps),
      ).not.toThrow();

      // The injected ENOENT must actually have fired — guards against a future
      // refactor silently bypassing the head rename and re-vacuating the test.
      expect(armed).toBe(false);

      // No line lost: the peer's rotated copy AND our fresh append both survive.
      expect(readFileSync(path, "utf-8")).toBe("new-line\n");
      expect(readFileSync(`${path}.1`, "utf-8")).toBe("oversized-current\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concurrent interleaved appends to the same file keep every line and skip no generation", () => {
    // Model two cross-process writers (A=daemon, B=foreground) appending to the
    // SAME log, each independently calling appendRotatingLog. Interleave them so
    // both repeatedly cross the rotation threshold. On a deterministic subset of
    // rotations we inject the peer-already-rotated ENOENT at BOTH the head rename
    // (`path -> path.1`) and an intermediate rename (`path.1 -> path.2`): the
    // mock performs the real move (the peer's effect) and then throws ENOENT —
    // exactly what our own racing op observes once the source is gone. The
    // production cascade must swallow those ENOENTs and never throw out of the
    // append path, never lose a line, and never skip a generation. Reverting the
    // ENOENT-tolerance lets the injected throw escape ⇒ the `not.toThrow()`
    // assertion below fails, proving the test is non-vacuous.
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    try {
      const path = join(root, "agentbridge.log");
      const keep = 3;
      const maxBytes = 16;
      const head = path;
      const firstRotated = `${path}.1`;

      let injectedHead = 0;
      let injectedIntermediate = 0;
      // Inject on a fixed cadence so the peer-race branch is hit repeatedly and
      // deterministically across the 30 writes.
      let rotationRound = 0;
      const fsOps: FsOps = {
        ...realFsOps,
        renameSync: ((from: string, to: string) => {
          // Tie the injection cadence to head renames (one per rotation round).
          if (from === head) {
            rotationRound++;
            if (rotationRound % 2 === 0) {
              renameSync(from, to);
              injectedHead++;
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
          } else if (from === firstRotated && rotationRound % 3 === 0) {
            // Intermediate generation also races a peer on some rounds.
            renameSync(from, to);
            injectedIntermediate++;
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return renameSync(from, to);
        }) as typeof renameSync,
      };

      const written: string[] = [];
      // 30 small writes, alternating "writers". Each line is unique so we can
      // verify presence/loss precisely.
      for (let i = 0; i < 30; i++) {
        const writer = i % 2 === 0 ? "A" : "B";
        const line = `${writer}-${i}\n`;
        written.push(line);
        expect(() => appendRotatingLog(path, line, { maxBytes, keep }, fsOps)).not.toThrow();
      }

      // The injected peer-race ENOENT must actually have fired (otherwise the
      // test would silently degrade to the ordinary rotation path and validate
      // nothing about the crash-safe cascade).
      expect(injectedHead).toBeGreaterThan(0);
      expect(injectedIntermediate).toBeGreaterThan(0);

      // Reconstruct everything still on disk (current + rotated generations).
      const files = readdirSync(root).filter((name) => name.startsWith("agentbridge.log"));
      const onDisk = files.map((name) => readFileSync(join(root, name), "utf-8")).join("");

      // The most recent line must always be present (just appended, never rotated out).
      expect(onDisk).toContain(written[written.length - 1]!);

      // Generation invariant: never more than keep rotated files (path.1..path.keep).
      const rotated = files.filter((name) => /\.\d+$/.test(name));
      expect(rotated.length).toBeLessThanOrEqual(keep);

      // The lines that survived must be a contiguous suffix of the write order
      // (rotation drops oldest-first; it must not punch holes / skip a
      // generation in the middle).
      const present = written.map((line) => onDisk.includes(line));
      const firstPresent = present.indexOf(true);
      expect(firstPresent).toBeGreaterThanOrEqual(0);
      for (let i = firstPresent; i < present.length; i++) {
        expect(present[i]).toBe(true);
      }
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
