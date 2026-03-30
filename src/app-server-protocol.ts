const APP_SERVER_REQUEST_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/name/set",
  "thread/list",
  "review/start",
  "turn/start",
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
