/**
 * Control-port capability token (arch-review P1 #283).
 *
 * The daemon's control WebSocket binds 127.0.0.1 and gates browser pages with
 * the WS Origin guard (ws-origin-guard.ts), but a non-browser local process can
 * still open `ws://127.0.0.1:<port>/ws` and — before this token existed — send
 * `claude_connect`/`claude_to_codex` to inject a turn into Codex. In multi-pair
 * mode the pairId is `sha256(realpath(cwd)).slice(0,8)`, derivable from a known
 * project path, so it is a ROUTING identifier, not a secret.
 *
 * This module adds a capability token as a second, independent layer of defense
 * (alongside attach-convergence and the Origin guard):
 *
 *   - The daemon generates a random token at startup and writes it to
 *     `<stateDir>/control-token` with owner-only (0600) permissions.
 *   - A legitimate same-machine frontend (bridge.ts) reads that file and echoes
 *     the token in its `claude_connect` identity; the daemon compares it.
 *   - A browser page cannot read the local filesystem, so it cannot present the
 *     token — token + Origin guard form defense in depth.
 *
 * TRUST BOUNDARY (intentional, documented): any local process running as the
 * same OS user CAN read the 0600 token file. That is an accepted boundary — the
 * threat model here is a remote/browser origin and accidental cross-pair
 * cross-talk, not a same-user local attacker (who could read the token, attach
 * to the codex socket directly, or sign your commits regardless).
 */

import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteText } from "./atomic-json";

/** File name (under the pair's state dir) holding the control-port token. */
export const CONTROL_TOKEN_FILENAME = "control-token";

/** Resolve the absolute path to the control-token file for a given state dir. */
export function resolveControlTokenPath(stateDir: string): string {
  return join(stateDir, CONTROL_TOKEN_FILENAME);
}

/** Generate a fresh random capability token (128-bit UUID, hex+dashes). */
export function generateControlToken(): string {
  return randomUUID();
}

/**
 * Write the token to `path` with owner-only (0600) permissions.
 *
 * atomicWriteText now creates the temp file at mode 0600 FROM THE START (via the
 * `mode` option), so the renamed token is owner-only with no world-readable
 * window between rename and any post-hoc chmod (CWE-732). We STILL chmod 0600
 * explicitly afterwards as belt-and-suspenders: it re-tightens even if a prior
 * (looser) file was somehow left at the target path, and makes the 0600
 * guarantee independent of the helper's internals.
 */
export function writeControlToken(path: string, token: string): void {
  // No trailing newline: the file content IS the token. readControlToken trims
  // defensively, but keeping the on-disk bytes exact avoids any ambiguity.
  // mode 0600: the temp file is owner-only before the rename — no exposure window.
  atomicWriteText(path, token, { mode: 0o600 });
  // Best-effort would be wrong here: if we cannot enforce 0600 the token is
  // exposed, so fail loud (the daemon's startup will surface it) rather than
  // silently ship a world-readable secret.
  chmodSync(path, 0o600);
}

/**
 * Read the token from `path`, returning null when the file is absent or
 * unreadable. Trims trailing whitespace/newline so a token written by any
 * version (with or without a trailing newline) compares equal.
 */
export function readControlToken(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export type ControlTokenValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Compare a client-provided token against the daemon's expected token.
 *
 * Compatibility / enforcement policy:
 *   - `expectedToken == null` (daemon has no token loaded, e.g. an older daemon
 *     or a token-file write/read failure) → token check is DISABLED; pass. The
 *     attach-convergence guard and Origin guard still apply, so this degrades to
 *     pre-token behavior rather than locking out every client.
 *   - `expectedToken` present, `providedToken` missing → reject (a token-aware
 *     daemon expects token-aware clients; same-version bridge always sends it).
 *   - both present → constant-time-ish exact compare.
 */
export function validateControlToken(input: {
  expectedToken: string | null;
  providedToken?: string | null;
}): ControlTokenValidationResult {
  const { expectedToken } = input;
  if (expectedToken == null || expectedToken.length === 0) {
    // No token to enforce — token layer disabled (compat / degraded).
    return { ok: true };
  }
  const provided = input.providedToken;
  if (provided == null || provided.length === 0) {
    return { ok: false, reason: "missing control token" };
  }
  if (!constantTimeEquals(provided, expectedToken)) {
    return { ok: false, reason: "control token mismatch" };
  }
  return { ok: true };
}

/**
 * Length-independent constant-time string comparison. Avoids leaking the token
 * via early-exit timing. Both inputs are local strings, so this is belt-and-
 * suspenders, but cheap and correct.
 */
function constantTimeEquals(a: string, b: string): boolean {
  // Comparing lengths first would leak length via timing; instead fold length
  // mismatch into the accumulator and always scan the longer string.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
