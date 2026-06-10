import { describe, expect, test } from "bun:test";
import {
  APP_SERVER_RATE_LIMIT_ERROR_CODES,
  APP_SERVER_SERVER_REQUEST_METHODS,
  APP_SERVER_TRACKED_REQUEST_METHODS,
  isAppServerNotification,
  isAppServerRequestMessage,
  isAppServerResponseMessage,
  isAppServerServerRequest,
  isTrackedAppServerRequestMethod,
  parseAppServerVersion,
} from "../app-server-protocol";

describe("app-server protocol subset", () => {
  test("exports the tracked app-server request methods used by CodexAdapter", () => {
    expect(APP_SERVER_TRACKED_REQUEST_METHODS).toEqual([
      "thread/start",
      "thread/resume",
      "turn/start",
    ]);
  });

  test("exports the known server request methods that must be proxied to TUI", () => {
    expect(APP_SERVER_SERVER_REQUEST_METHODS).toEqual([
      "item/permissions/requestApproval",
      "item/fileChange/requestApproval",
      "item/commandExecution/requestApproval",
    ]);
  });

  test("identifies tracked request methods", () => {
    expect(isTrackedAppServerRequestMethod("thread/start")).toBe(true);
    expect(isTrackedAppServerRequestMethod("thread/list")).toBe(false);
    expect(isTrackedAppServerRequestMethod("turn/completed")).toBe(false);
  });

  test("identifies app-server notifications used by AgentBridge", () => {
    expect(isAppServerNotification({
      method: "turn/completed",
      params: { turn: { id: "turn-1" } },
    })).toBe(true);

    expect(isAppServerNotification({
      id: 42,
      method: "item/permissions/requestApproval",
      params: { permission: "network" },
    })).toBe(false);

    expect(isAppServerNotification({
      id: 100,
      result: { ok: true },
    })).toBe(false);
  });

  test("identifies app-server server requests that require passthrough", () => {
    expect(isAppServerServerRequest({
      id: 42,
      method: "item/permissions/requestApproval",
      params: { permission: "network" },
    })).toBe(true);

    expect(isAppServerServerRequest({
      method: "item/permissions/requestApproval",
      params: { permission: "network" },
    })).toBe(false);

    expect(isAppServerServerRequest({
      id: 7,
      method: "turn/started",
      params: { turn: { id: "turn-1" } },
    })).toBe(false);
  });

  test("classifies request-shaped payloads at the request/response boundary", () => {
    expect(isAppServerRequestMessage({
      id: 1,
      method: "x",
      result: { ok: true },
    })).toBe(true);

    expect(isAppServerRequestMessage({
      id: 0,
      method: "turn/start",
    })).toBe(true);

    expect(isAppServerRequestMessage(null)).toBe(false);
    expect(isAppServerRequestMessage(undefined)).toBe(false);
    expect(isAppServerRequestMessage("turn/start")).toBe(false);
    expect(isAppServerRequestMessage(123)).toBe(false);
    expect(isAppServerRequestMessage(["turn/start"])).toBe(false);
  });

  test("classifies malformed and valid response payloads correctly", () => {
    expect(isAppServerResponseMessage({
      id: null,
      result: { ok: true },
    })).toBe(false);

    expect(isAppServerResponseMessage({
      id: 1,
    })).toBe(false);

    expect(isAppServerResponseMessage({
      id: 1,
      result: { ok: true },
    })).toBe(true);

    expect(isAppServerResponseMessage(null)).toBe(false);
    expect(isAppServerResponseMessage(undefined)).toBe(false);
    expect(isAppServerResponseMessage("response")).toBe(false);
    expect(isAppServerResponseMessage(123)).toBe(false);
    expect(isAppServerResponseMessage([{ id: 1, result: {} }])).toBe(false);
  });
});

describe("parseAppServerVersion (P1 #5)", () => {
  test("extracts the version token after the first slash", () => {
    // Real codex-rs userAgent shape: "{originator}/{version} ({os}; {arch}) {ua}"
    // (codex-rs/login/src/auth/default_client.rs:133).
    expect(parseAppServerVersion("codex_cli_rs/0.139.0 (Mac OS 15.1; arm64) reqwest/0.12")).toBe(
      "0.139.0",
    );
    expect(parseAppServerVersion("codex/1.0")).toBe("1.0");
    expect(parseAppServerVersion("codex/0.140.0-beta.2 (linux)")).toBe("0.140.0-beta.2");
  });

  test("returns null for unparseable / missing userAgent (a drift signal)", () => {
    expect(parseAppServerVersion(null)).toBeNull();
    expect(parseAppServerVersion(undefined)).toBeNull();
    expect(parseAppServerVersion("")).toBeNull();
    expect(parseAppServerVersion("garbage-no-slash")).toBeNull();
    expect(parseAppServerVersion(123 as unknown as string)).toBeNull();
  });
});

describe("APP_SERVER_RATE_LIMIT_ERROR_CODES (P1 #5)", () => {
  test("models the generic JSON-RPC codes the rate-limits read path emits", () => {
    // codex-rs/app-server/src/error_code.rs + account_processor.rs:967-990.
    expect(APP_SERVER_RATE_LIMIT_ERROR_CODES.has(-32603)).toBe(true); // INTERNAL_ERROR_CODE
    expect(APP_SERVER_RATE_LIMIT_ERROR_CODES.has(-32600)).toBe(true); // INVALID_REQUEST_ERROR_CODE
    expect(APP_SERVER_RATE_LIMIT_ERROR_CODES.has(-32099)).toBe(false);
    expect(APP_SERVER_RATE_LIMIT_ERROR_CODES.has(0)).toBe(false);
  });
});
