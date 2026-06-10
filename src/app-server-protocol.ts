const APP_SERVER_REQUEST_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "thread/list",
  "review/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export type AppServerMethod = typeof APP_SERVER_REQUEST_METHODS[number];

export const APP_SERVER_TRACKED_REQUEST_METHODS = [
  "thread/start",
  "thread/resume",
  "turn/start",
] as const;

export type AppServerTrackedRequestMethod = typeof APP_SERVER_TRACKED_REQUEST_METHODS[number];

export const APP_SERVER_SERVER_REQUEST_METHODS = [
  "item/permissions/requestApproval",
  "item/fileChange/requestApproval",
  "item/commandExecution/requestApproval",
] as const;

export type AppServerServerRequestMethod = typeof APP_SERVER_SERVER_REQUEST_METHODS[number];

export const APP_SERVER_NOTIFICATION_METHODS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/agentMessage/delta",
  "item/completed",
] as const;

export type AppServerNotificationMethod = typeof APP_SERVER_NOTIFICATION_METHODS[number];

const TRACKED_REQUEST_METHOD_SET = new Set<string>(APP_SERVER_TRACKED_REQUEST_METHODS);
const SERVER_REQUEST_METHOD_SET = new Set<string>(APP_SERVER_SERVER_REQUEST_METHODS);
const NOTIFICATION_METHOD_SET = new Set<string>(APP_SERVER_NOTIFICATION_METHODS);

export type AppServerJsonRpcId = number | string;

export interface AppServerThread {
  id: string;
  [key: string]: unknown;
}

export interface AppServerTurn {
  id: string;
  [key: string]: unknown;
}

export interface AppServerItemContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AppServerItem {
  id: string;
  type: string;
  content?: AppServerItemContentPart[];
  [key: string]: unknown;
}

export type AppServerUserInput =
  | { type: "text"; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface TurnStartParams {
  threadId: string;
  input: AppServerUserInput[];
  [key: string]: unknown;
}

/**
 * turn/steer — feed additional input into the CURRENTLY RUNNING turn without
 * interrupting it (introduced in codex rust-v0.99; the TUI uses it when the
 * user types mid-turn). Fails with NoActiveTurn / ExpectedTurnMismatch /
 * ActiveTurnNotSteerable (Review/Compact turns) / EmptyInput.
 *
 * expectedTurnId is a REQUIRED active-turn precondition since the API was
 * introduced (every codex release that has turn/steer requires it). B0
 * shipped without it, so every real steer bounced with "missing field
 * `expectedTurnId`" — found by live E2E against codex 0.139.
 */
export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: AppServerUserInput[];
  [key: string]: unknown;
}

/**
 * turn/interrupt — terminate the CURRENTLY RUNNING turn (protocol v2 PR B).
 * Verified against codex-rs (app-server-protocol/src/protocol/v2/turn.rs:
 * TurnInterruptParams { thread_id, turn_id }, camelCase on the wire).
 *
 * Semantics verified in app-server/src/request_processors/turn_processor.rs
 * (turn_interrupt_inner) + bespoke_event_handling.rs:
 *   - turnId must match the active turn, else an immediate JSON-RPC error
 *     ("expected active turn id X but found Y" / "no active turn to interrupt").
 *   - The SUCCESS response ({}) is DEFERRED until the core emits TurnAborted —
 *     it arrives at roughly the same time as the terminal notification.
 *   - The interrupted turn's terminal notification is a normal `turn/completed`
 *     with `turn.status = "interrupted"` (handle_turn_interrupted →
 *     emit_turn_completed_with_status) — the adapter's existing turn/completed
 *     handling IS the terminal boundary; no extra notification type exists.
 */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread?: AppServerThread;
  [key: string]: unknown;
}

export interface ThreadResumeResponse {
  thread?: AppServerThread;
  [key: string]: unknown;
}

export interface TurnStartResponse {
  turn?: AppServerTurn;
  [key: string]: unknown;
}

/**
 * `initialize` response (codex-rs app-server-protocol v1 InitializeResponse).
 *
 * Verified against codex-rs at
 * codex-rs/app-server-protocol/src/protocol/v1.rs:61-71 (camelCase on the wire
 * via `#[serde(rename_all = "camelCase")]`) and its construction site
 * codex-rs/app-server/src/request_processors/initialize_processor.rs:141-146.
 *
 * The app-server does NOT expose a dedicated top-level `version` field or a
 * server-side `capabilities` object; the version is embedded in `userAgent`
 * (built by get_codex_user_agent — codex-rs/login/src/auth/default_client.rs:133,
 * format `"{originator}/{version} ({OsType} {os_version}; {arch}) {ua}"`).
 *
 * All fields are typed optional here so a future protocol that drops one
 * surfaces as a captured-null (a drift signal) rather than a crash.
 */
export interface AppServerInitializeResponse {
  /** e.g. "codex_cli_rs/0.139.0 (Mac OS 15.1; arm64) ...". Carries the version. */
  userAgent?: string;
  /** Absolute path to the server's $CODEX_HOME directory. */
  codexHome?: string;
  /** Platform family, e.g. "unix" / "windows". */
  platformFamily?: string;
  /** Operating system, e.g. "macos" / "linux" / "windows". */
  platformOs?: string;
  [key: string]: unknown;
}

/**
 * Captured app-server identity, derived from the `initialize` response. Exposed
 * on DaemonStatus so `abg doctor` / /healthz can show which app-server build the
 * proxy is actually coupled to, and the adapter can WARN when it drifts from the
 * assumptions baked into the intercept points (see codex-adapter.ts).
 */
export interface AppServerInfo {
  /** Version token parsed out of `userAgent` (e.g. "0.139.0"); null if unparseable. */
  version: string | null;
  /** Raw `userAgent` string as received. */
  userAgent: string | null;
  /** Platform family ("unix" / "windows" / …) if present. */
  platformFamily: string | null;
  /** Operating system ("macos" / "linux" / "windows" / …) if present. */
  platformOs: string | null;
}

/**
 * Parse the version token out of an app-server `userAgent`. The wire format is
 * `"{originator}/{version} (…)"` — the version is the run of characters after
 * the FIRST "/" up to the first whitespace. Returns null when the string does
 * not match that shape (a drift signal worth a WARNING at the call site).
 */
export function parseAppServerVersion(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/\/([^\s]+)/);
  return match ? match[1] : null;
}

/**
 * JSON-RPC error codes the app-server's rate-limits read path is known to use
 * (codex-rs/app-server/src/error_code.rs + account_processor.rs:967-990). These
 * are GENERIC codes (not rate-limit-specific), so they alone do not identify a
 * rate-limit error — patchResponse pairs them with the message text. Modeling
 * them as a named set documents the structured signal we DO have and gives the
 * fragile-text fallback a clear "structured-recognized vs not" boundary.
 */
export const APP_SERVER_RATE_LIMIT_ERROR_CODES: ReadonlySet<number> = new Set([
  -32603, // INTERNAL_ERROR_CODE — "failed to fetch codex rate limits: …"
  -32600, // INVALID_REQUEST_ERROR_CODE — "chatgpt authentication required to read rate limits"
]);

export interface AppServerRequest<M extends string = string, P = unknown> {
  jsonrpc?: "2.0";
  id: AppServerJsonRpcId;
  method: M;
  params?: P;
}

export interface AppServerResponse<R = unknown> {
  jsonrpc?: "2.0";
  id: AppServerJsonRpcId;
  result?: R;
  error?: { code?: number; message?: string; data?: unknown };
}

export type AppServerTrackedRequest =
  | AppServerRequest<"thread/start", Record<string, unknown>>
  | AppServerRequest<"thread/resume", Record<string, unknown>>
  | AppServerRequest<"turn/start", TurnStartParams>;

export type AppServerTrackedResponse =
  | AppServerResponse<ThreadStartResponse>
  | AppServerResponse<ThreadResumeResponse>
  | AppServerResponse<TurnStartResponse>;

export type AppServerServerRequest =
  | AppServerRequest<"item/permissions/requestApproval", Record<string, unknown>>
  | AppServerRequest<"item/fileChange/requestApproval", Record<string, unknown>>
  | AppServerRequest<"item/commandExecution/requestApproval", Record<string, unknown>>;

export type AppServerNotification =
  | { jsonrpc?: "2.0"; id?: undefined; method: "turn/started"; params?: { turn?: AppServerTurn; [key: string]: unknown } }
  | { jsonrpc?: "2.0"; id?: undefined; method: "turn/completed"; params?: { turn?: AppServerTurn; [key: string]: unknown } }
  | { jsonrpc?: "2.0"; id?: undefined; method: "item/started"; params?: { item?: AppServerItem; [key: string]: unknown } }
  | { jsonrpc?: "2.0"; id?: undefined; method: "item/completed"; params?: { item?: AppServerItem; [key: string]: unknown } }
  | { jsonrpc?: "2.0"; id?: undefined; method: "item/agentMessage/delta"; params?: { itemId?: string; delta?: string; [key: string]: unknown } };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTrackedAppServerRequestMethod(method: unknown): method is AppServerTrackedRequestMethod {
  return typeof method === "string" && TRACKED_REQUEST_METHOD_SET.has(method);
}

export function isAppServerServerRequestMethod(method: unknown): method is AppServerServerRequestMethod {
  return typeof method === "string" && SERVER_REQUEST_METHOD_SET.has(method);
}

export function isAppServerRequestMessage(value: unknown): value is AppServerRequest {
  if (!isObjectRecord(value)) return false;
  return (typeof value.id === "number" || typeof value.id === "string")
    && typeof value.method === "string";
}

export function isAppServerServerRequest(value: unknown): value is AppServerServerRequest {
  return isAppServerRequestMessage(value) && isAppServerServerRequestMethod(value.method);
}

export function isAppServerNotification(value: unknown): value is AppServerNotification {
  if (!isObjectRecord(value)) return false;
  return value.id === undefined
    && typeof value.method === "string"
    && NOTIFICATION_METHOD_SET.has(value.method);
}

export function isAppServerResponseMessage(value: unknown): value is AppServerResponse {
  if (!isObjectRecord(value)) return false;
  return (typeof value.id === "number" || typeof value.id === "string")
    && value.method === undefined
    && ("result" in value || "error" in value);
}
