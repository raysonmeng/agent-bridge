/**
 * Shared collab-store resolution helpers (§11.1) — the local path/secret/URL
 * lookups every collab entrypoint needs. Extracted so `abg publish`, the daemon
 * room bridge, and future consumers resolve the collab DB, auth token, and broker
 * URL identically (and lock the dir down identically), instead of each re-deriving
 * them. The collab DB holds PSK tokens (hashed at rest §11.3) + identity PII, so its dir is forced to 0700.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteStore } from "./backbone/store/sqlite-store";
import { StateDirResolver } from "./state-dir";

export const DEFAULT_BROKER_URL = "ws://127.0.0.1:4700/ws";

/**
 * Resolve the collab DB path: explicit > AGENTBRIDGE_COLLAB_DB > `<base>/collab.db`.
 *
 * The collab store (identities / rooms / membership / auth-token) is USER-GLOBAL, NOT per-pair. The
 * daemon runs with AGENTBRIDGE_STATE_DIR pointing at its PER-PAIR dir (`<base>/pairs/<id>/`), so a plain
 * StateDirResolver would put collab.db under the pair — but `abg auth login` / `abg join` (run in a plain
 * shell, with no per-pair override) write it under the BASE dir. The daemon's room-bridge would then read
 * `pairs/<id>/auth-token`, never find the token, and go inert ("not logged in"). Anchor the collab store
 * to the BASE dir: the daemon's pair wrapper exports AGENTBRIDGE_BASE_DIR to it; the plain CLI has no
 * per-pair override, so its StateDirResolver already IS the base.
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTBRIDGE_COLLAB_DB;
  if (env && env.length > 0) return env;
  const base = process.env.AGENTBRIDGE_BASE_DIR;
  const dir = base && base.length > 0 ? base : new StateDirResolver().dir;
  return join(dir, "collab.db");
}

/**
 * Resolve the broker URL: explicit > AGENTBRIDGE_BROKER_URL > persisted `<collabDir>/broker-url` > local default.
 *
 * Why the persisted file: the edge daemon (room-bridge) used to learn the broker address ONLY from the
 * AGENTBRIDGE_BROKER_URL env var, which had to be exported in the shell rc BEFORE `agentbridge claude`
 * started — forget it and the daemon silently fell back to localhost and received zero room events. `abg
 * join --broker-url <ws://…>` now writes the address here, so the daemon picks it up automatically with no
 * env var and no kill/restart dance. Env still wins as a deliberate one-off override; pass `dbPath` to opt
 * into the persisted lookup (the plain non-collab CLI paths omit it and keep the old env-or-default shape).
 */
export function resolveBrokerUrl(explicit?: string, dbPath?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTBRIDGE_BROKER_URL;
  if (env && env.length > 0) return env;
  if (dbPath) {
    const persisted = readPersistedBrokerUrl(dbPath);
    if (persisted) return persisted;
  }
  return DEFAULT_BROKER_URL;
}

/** Read the persisted broker URL from `<collabDir>/broker-url` (written by `abg join --broker-url`). */
export function readPersistedBrokerUrl(dbPath: string): string | null {
  try {
    const url = readFileSync(join(dirname(dbPath), "broker-url"), "utf-8").trim();
    return url === "" ? null : url;
  } catch {
    return null;
  }
}

/** Persist the broker URL next to the collab DB so the daemon auto-connects without AGENTBRIDGE_BROKER_URL. */
export function writeBrokerUrl(dbPath: string, url: string): void {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "broker-url"), url, { mode: 0o600 });
}

/**
 * Resolve the auth-token filename for an agent kind (§5.2 multi agent-type). Claude (or no
 * agentType) uses the bare `auth-token` (back-compat); a non-claude agent uses `auth-token-<type>`
 * so Claude and Codex authenticate to the broker as DISTINCT identities from the same collab dir.
 * agentType is sanitised to `[a-z0-9-]` before it becomes a filename (defence-in-depth: it must
 * never escape the collab dir even though it is daemon-set, not user input).
 */
export function authTokenFile(agentType?: string): string {
  if (!agentType) return "auth-token";
  const safe = agentType.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return safe === "" || safe === "claude" ? "auth-token" : `auth-token-${safe}`;
}

/** Read the logged-in PSK token from `<collabDir>/auth-token[-<agentType>]`. No Store needed — cheap login gate. */
export function readAuthToken(dbPath: string, agentType?: string): string | null {
  try {
    const token = readFileSync(join(dirname(dbPath), authTokenFile(agentType)), "utf-8").trim();
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
