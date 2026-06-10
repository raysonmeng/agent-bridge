/**
 * CSWSH (cross-site WebSocket hijacking) Origin guard.
 *
 * Both Bun.serve WebSocket servers (daemon control port and the Codex proxy
 * port) bind 127.0.0.1 but otherwise accept ANY WS upgrade. WebSocket
 * handshakes are NOT subject to the browser same-origin policy, so a malicious
 * web page open in the user's browser can `new WebSocket('ws://127.0.0.1:4502/ws')`,
 * connect to the control port, inject turns AND read back Codex's
 * agentMessages. This module gates the upgrade to block that vector.
 *
 * ── Policy ──────────────────────────────────────────────────────────────────
 * A legitimate CLI client connects via the Bun/Node global `new WebSocket(url)`
 * (see src/daemon-client.ts:58), which by default sends NO `Origin` request
 * header. A browser page ALWAYS sends one. Therefore the default policy is:
 *
 *   - Origin header ABSENT (or empty string) → ALLOW.
 *   - Origin header PRESENT (non-empty)      → REJECT (HTTP 403, do NOT upgrade),
 *                                              unless it is in the allowlist.
 *
 * The allowlist exists for a future legitimate Origin-sending client (e.g. an
 * Electron renderer) that can be permitted via env without a code change:
 *   AGENTBRIDGE_WS_ALLOWED_ORIGINS  (comma-separated exact origins).
 * Absent/empty env = strict no-Origin-only (the secure default). Setting the
 * env permits the listed origins IN ADDITION to the no-Origin case; it never
 * loosens the no-Origin path.
 *
 * ── Empirical verification (the "never assume protocol behavior" rule) ───────
 * The whole policy rests on "Bun/Node `new WebSocket()` does NOT send an Origin
 * header." This was verified empirically against Bun 1.3.11 in this worktree:
 * a Bun.serve WS server logged `req.headers.get("origin")` while a client
 * connected with the SAME global `new WebSocket(url)` class that
 * daemon-client.ts uses — the received Origin was `null`
 * (`hasHeader === false`). The OTHER production consumer is the real Codex TUI
 * Rust binary connecting to the proxy port via `--remote`; PTY-launching the
 * actual codex-cli 0.139.0 against a raw-socket logger captured its WS upgrade
 * carrying NO Origin header either (confirmed in cross-review — the proxy
 * consumer most likely to drift on a codex upgrade). So the no-Origin allow
 * path keeps both legitimate clients — CLI reconnect AND Codex TUI proxy —
 * working. If a future Bun/codex version starts sending an Origin, this guard
 * would reject those legit clients and the fix is to add that exact Origin to
 * AGENTBRIDGE_WS_ALLOWED_ORIGINS (or switch to a capability token —
 * codex-rs already exposes `--remote-auth-token-env`) — re-run the probe
 * before trusting it.
 */

const ALLOWED_ORIGINS_ENV = "AGENTBRIDGE_WS_ALLOWED_ORIGINS";

/**
 * Parse the comma-separated allowlist from an env map into a Set of exact
 * origin strings. Entries are trimmed; empty entries are dropped. The result is
 * an exact-match allowlist (no wildcards, no scheme/host normalization) — an
 * attacker-controlled page cannot match unless its Origin string is byte-for-byte
 * present, which the operator must opt into explicitly.
 */
export function parseAllowedWsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const raw = env[ALLOWED_ORIGINS_ENV];
  if (raw == null || raw === "") return new Set();
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(origins);
}

/**
 * Decide whether a WS upgrade request is allowed by the Origin policy.
 *
 * @param req           The incoming upgrade Request.
 * @param allowedOrigins Exact-match allowlist of Origins that may send a
 *                       non-empty Origin header (defaults to the env allowlist).
 * @returns `true` if the upgrade may proceed, `false` if it must be rejected.
 */
export function isAllowedWsUpgrade(
  req: Request,
  allowedOrigins: ReadonlySet<string> = parseAllowedWsOrigins(),
): boolean {
  const origin = req.headers.get("origin");

  // No Origin header at all → a non-browser client (CLI / Bun WebSocket).
  // Empty-string Origin → treat the same as absent: some clients/proxies may
  // surface "" and it carries no cross-site identity. The secure default
  // allows both, matching the empirically-verified legitimate CLI path.
  if (origin == null || origin === "") return true;

  // A non-empty Origin means a browser (or browser-like) client. Reject unless
  // the operator explicitly allowlisted this exact Origin.
  return allowedOrigins.has(origin);
}

/**
 * Build the HTTP 403 Response returned when a WS upgrade is rejected by the
 * Origin policy. Returned in the fetch handler INSTEAD of calling
 * `server.upgrade`, so the socket is never upgraded.
 */
export function wsOriginRejectedResponse(): Response {
  return new Response("Forbidden: WebSocket Origin not allowed", { status: 403 });
}
