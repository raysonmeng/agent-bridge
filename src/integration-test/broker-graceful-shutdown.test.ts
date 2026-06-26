import { describe, test, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

describe("abg broker start — graceful shutdown (§8.2)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("SIGTERM stops the server, closes the Store, and exits 0", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-broker-sig-"));
    const dbPath = join(dir, "collab.db");
    // --no-web: this test exercises broker shutdown only; keep it hermetic (no
    // dashboard port bind / browser spawn). The shutdown-handler ordering fix is
    // verified independently — the handler is registered before the web/probe step.
    const child = spawn(process.execPath, ["run", CLI_PATH, "broker", "start", "--port", "0", "--db", dbPath, "--no-web"], {
      env: { ...process.env, AGENTBRIDGE_COLLAB_DB: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the broker to finish binding before signalling (so the SIGTERM
    // handler is installed — it's registered right after start()).
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("broker did not start in time")), 8000);
      child.stdout.on("data", (d: Buffer) => {
        if (String(d).includes("已启动")) {
          clearTimeout(to);
          resolve();
        }
      });
      child.once("exit", (c) => {
        clearTimeout(to);
        reject(new Error(`broker exited before startup (code ${c})`));
      });
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });
    expect(exitCode).toBe(0); // graceful: exit 0, not killed by the signal
  }, 15000);
});
