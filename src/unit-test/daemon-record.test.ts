import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDaemonRecord,
  writeDaemonRecord,
  synthesizeLegacyRecord,
  readUnifiedDaemonRecord,
  portFromUrl,
  type DaemonRecord,
} from "../daemon-record";

describe("daemon-record", () => {
  let dir: string;
  let paths: { daemonRecordFile: string; pidFile: string; statusFile: string };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-record-"));
    paths = {
      daemonRecordFile: join(dir, "daemon.json"),
      pidFile: join(dir, "daemon.pid"),
      statusFile: join(dir, "status.json"),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("portFromUrl", () => {
    test("extracts port from ws/http urls, undefined otherwise", () => {
      expect(portFromUrl("ws://127.0.0.1:4501")).toBe(4501);
      expect(portFromUrl("ws://127.0.0.1:4501/ws")).toBe(4501);
      expect(portFromUrl("http://127.0.0.1:4502/healthz")).toBe(4502);
      expect(portFromUrl("no-port")).toBeUndefined();
      expect(portFromUrl(123)).toBeUndefined();
      expect(portFromUrl(undefined)).toBeUndefined();
    });
  });

  describe("write/read round-trip + atomicity", () => {
    test("writeDaemonRecord then readDaemonRecord returns the record", () => {
      const record: DaemonRecord = {
        pid: 4242,
        phase: "ready",
        startedAt: 1000,
        nonce: "abc",
        pairId: "p-1",
        proxyUrl: "ws://127.0.0.1:4501",
        ports: { appPort: 4500, proxyPort: 4501, controlPort: 4502 },
        turnPhase: "idle",
        turnInProgress: false,
      };
      writeDaemonRecord(paths.daemonRecordFile, record);
      expect(readDaemonRecord(paths.daemonRecordFile)).toEqual(record);
    });

    test("write is atomic (tmp+rename) — no stray .tmp left behind", () => {
      writeDaemonRecord(paths.daemonRecordFile, { pid: 1, phase: "booting" });
      // Only the final file should exist; no leftover .tmp.* siblings.
      const { readdirSync } = require("node:fs");
      const stray = readdirSync(dir).filter((n: string) => n.includes(".tmp."));
      expect(stray.length).toBe(0);
      expect(existsSync(paths.daemonRecordFile)).toBe(true);
    });

    test("readDaemonRecord rejects corrupt / non-object / pidless content", () => {
      writeFileSync(paths.daemonRecordFile, "not-json");
      expect(readDaemonRecord(paths.daemonRecordFile)).toBeNull();
      writeFileSync(paths.daemonRecordFile, JSON.stringify([1, 2]));
      expect(readDaemonRecord(paths.daemonRecordFile)).toBeNull();
      writeFileSync(paths.daemonRecordFile, JSON.stringify({ phase: "ready" }));
      expect(readDaemonRecord(paths.daemonRecordFile)).toBeNull();
      writeFileSync(paths.daemonRecordFile, JSON.stringify({ pid: "x" }));
      expect(readDaemonRecord(paths.daemonRecordFile)).toBeNull();
    });

    test("readDaemonRecord normalizes an unknown phase to booting", () => {
      writeFileSync(paths.daemonRecordFile, JSON.stringify({ pid: 5, phase: "weird" }));
      expect(readDaemonRecord(paths.daemonRecordFile)?.phase).toBe("booting");
    });

    test("readDaemonRecord returns null when file absent", () => {
      expect(readDaemonRecord(paths.daemonRecordFile)).toBeNull();
    });
  });

  describe("synthesizeLegacyRecord (old daemon: daemon.pid + status.json)", () => {
    test("pid from daemon.pid, status present → phase ready + fields recovered", () => {
      writeFileSync(paths.pidFile, "777\n");
      writeFileSync(
        paths.statusFile,
        JSON.stringify({
          pid: 777,
          proxyUrl: "ws://127.0.0.1:4511",
          appServerUrl: "ws://127.0.0.1:4510",
          controlPort: 4512,
          pairId: "legacy-1",
          cwd: "/tmp/x",
          turnInProgress: true,
          turnPhase: "running",
        }),
      );
      const rec = synthesizeLegacyRecord(paths.pidFile, paths.statusFile);
      expect(rec).not.toBeNull();
      expect(rec!.pid).toBe(777);
      expect(rec!.phase).toBe("ready");
      expect(rec!.proxyUrl).toBe("ws://127.0.0.1:4511");
      expect(rec!.ports).toEqual({ appPort: 4510, proxyPort: 4511, controlPort: 4512 });
      expect(rec!.pairId).toBe("legacy-1");
      expect(rec!.turnInProgress).toBe(true);
      expect(rec!.turnPhase).toBe("running");
    });

    test("only daemon.pid (started, not bootstrapped) → phase booting, pid recovered", () => {
      writeFileSync(paths.pidFile, "888\n");
      const rec = synthesizeLegacyRecord(paths.pidFile, paths.statusFile);
      expect(rec!.pid).toBe(888);
      expect(rec!.phase).toBe("booting");
      expect(rec!.proxyUrl).toBeUndefined();
    });

    test("only status.json (no pid file) → pid taken from status (legacy union)", () => {
      writeFileSync(paths.statusFile, JSON.stringify({ pid: 999, proxyUrl: "ws://127.0.0.1:4501" }));
      const rec = synthesizeLegacyRecord(paths.pidFile, paths.statusFile);
      expect(rec!.pid).toBe(999);
      expect(rec!.phase).toBe("ready");
      expect(rec!.proxyUrl).toBe("ws://127.0.0.1:4501");
    });

    test("daemon.pid wins as pid anchor over a stale status.json pid", () => {
      writeFileSync(paths.pidFile, "111\n");
      writeFileSync(paths.statusFile, JSON.stringify({ pid: 222 }));
      expect(synthesizeLegacyRecord(paths.pidFile, paths.statusFile)!.pid).toBe(111);
    });

    test("neither file yields a pid → null", () => {
      expect(synthesizeLegacyRecord(paths.pidFile, paths.statusFile)).toBeNull();
      writeFileSync(paths.statusFile, JSON.stringify({ noPid: true }));
      expect(synthesizeLegacyRecord(paths.pidFile, paths.statusFile)).toBeNull();
    });
  });

  describe("readUnifiedDaemonRecord — three compat states", () => {
    test("only LEGACY files present → synthesized record", () => {
      writeFileSync(paths.pidFile, "501\n");
      writeFileSync(paths.statusFile, JSON.stringify({ pid: 501, proxyUrl: "ws://127.0.0.1:4501" }));
      const rec = readUnifiedDaemonRecord(paths);
      expect(rec!.pid).toBe(501);
      expect(rec!.phase).toBe("ready");
      expect(rec!.proxyUrl).toBe("ws://127.0.0.1:4501");
    });

    test("only daemon.json present → that record", () => {
      writeDaemonRecord(paths.daemonRecordFile, {
        pid: 601,
        phase: "ready",
        proxyUrl: "ws://127.0.0.1:4601",
      });
      const rec = readUnifiedDaemonRecord(paths);
      expect(rec!.pid).toBe(601);
      expect(rec!.proxyUrl).toBe("ws://127.0.0.1:4601");
    });

    test("BOTH present → daemon.json wins (legacy ignored)", () => {
      writeFileSync(paths.pidFile, "700\n");
      writeFileSync(paths.statusFile, JSON.stringify({ pid: 700, proxyUrl: "ws://127.0.0.1:4501" }));
      writeDaemonRecord(paths.daemonRecordFile, {
        pid: 701,
        phase: "ready",
        proxyUrl: "ws://127.0.0.1:4701",
      });
      const rec = readUnifiedDaemonRecord(paths);
      expect(rec!.pid).toBe(701);
      expect(rec!.proxyUrl).toBe("ws://127.0.0.1:4701");
    });

    test("daemon.json corrupt but legacy valid → falls back to legacy", () => {
      writeFileSync(paths.daemonRecordFile, "corrupt{");
      writeFileSync(paths.pidFile, "800\n");
      writeFileSync(paths.statusFile, JSON.stringify({ pid: 800 }));
      expect(readUnifiedDaemonRecord(paths)!.pid).toBe(800);
    });

    test("nothing present → null", () => {
      expect(readUnifiedDaemonRecord(paths)).toBeNull();
    });
  });
});
