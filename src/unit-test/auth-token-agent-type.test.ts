import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authTokenFile, readAuthToken } from "../collab-store";

// §5.2 multi agent-type: Claude and Codex authenticate to the broker as DISTINCT identities from the
// same collab dir, keyed by `auth-token` vs `auth-token-<agentType>`. These guard the filename logic
// (incl. path-traversal sanitisation) + the per-agent token read so Codex can never piggyback Claude's.

describe("authTokenFile", () => {
  test("claude / undefined → bare auth-token (back-compat)", () => {
    expect(authTokenFile()).toBe("auth-token");
    expect(authTokenFile("claude")).toBe("auth-token");
    expect(authTokenFile("Claude")).toBe("auth-token"); // case-folded
  });

  test("non-claude → auth-token-<type>", () => {
    expect(authTokenFile("codex")).toBe("auth-token-codex");
    expect(authTokenFile("gemini")).toBe("auth-token-gemini");
  });

  test("sanitises to [a-z0-9-] so agentType can never escape the collab dir", () => {
    expect(authTokenFile("../../etc/passwd")).toBe("auth-token-etcpasswd");
    expect(authTokenFile("a/b")).toBe("auth-token-ab");
    expect(authTokenFile("..")).toBe("auth-token"); // sanitises to "" → bare token, never a traversal
  });
});

describe("readAuthToken with agentType", () => {
  test("reads the per-agent token file, isolating Claude from Codex", () => {
    const dir = mkdtempSync(join(tmpdir(), "abg-authtoken-"));
    const dbPath = join(dir, "collab.db");
    writeFileSync(join(dir, "auth-token"), "claude-tok\n");
    writeFileSync(join(dir, "auth-token-codex"), "codex-tok\n");

    expect(readAuthToken(dbPath)).toBe("claude-tok"); // trimmed
    expect(readAuthToken(dbPath, "claude")).toBe("claude-tok");
    expect(readAuthToken(dbPath, "codex")).toBe("codex-tok");
  });

  test("codex token absent → null even when the claude token exists (no piggybacking)", () => {
    const dir = mkdtempSync(join(tmpdir(), "abg-authtoken-"));
    const dbPath = join(dir, "collab.db");
    writeFileSync(join(dir, "auth-token"), "claude-tok");
    expect(readAuthToken(dbPath, "codex")).toBeNull();
  });

  test("empty token file → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "abg-authtoken-"));
    const dbPath = join(dir, "collab.db");
    writeFileSync(join(dir, "auth-token-codex"), "   \n");
    expect(readAuthToken(dbPath, "codex")).toBeNull();
  });
});
