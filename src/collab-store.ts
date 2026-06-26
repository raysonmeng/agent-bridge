/**
 * Shared collab-store resolution helpers (§11.1) — the local path/secret/URL
 * lookups every collab entrypoint needs. Extracted so `abg publish`, the daemon
 * room bridge, and future consumers resolve the collab DB, auth token, and broker
 * URL identically (and lock the dir down identically), instead of each re-deriving
 * them. The collab DB holds PSK tokens (hashed at rest §11.3) + identity PII, so its dir is forced to 0700.
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteStore } from "./backbone/store/sqlite-store";
import { StateDirResolver } from "./state-dir";

export const DEFAULT_BROKER_URL = "ws://127.0.0.1:4700/ws";

/** Resolve the collab DB path: explicit > AGENTBRIDGE_COLLAB_DB > `<state>/collab.db`. */
export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTBRIDGE_COLLAB_DB;
  if (env && env.length > 0) return env;
  return join(new StateDirResolver().dir, "collab.db");
}

/** Resolve the broker URL: explicit > AGENTBRIDGE_BROKER_URL > local default. */
export function resolveBrokerUrl(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTBRIDGE_BROKER_URL;
  if (env && env.length > 0) return env;
  return DEFAULT_BROKER_URL;
}

/** Read the logged-in PSK token from `<collabDir>/auth-token`. No Store needed — cheap login gate. */
export function readAuthToken(dbPath: string): string | null {
  try {
    const token = readFileSync(join(dirname(dbPath), "auth-token"), "utf-8").trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

/** Open the collab Store, locking the containing dir to 0700 (hashed PSK tokens §11.3 + identity PII live there). */
export function openStore(dbPath: string): SqliteStore {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return new SqliteStore(dbPath);
}
