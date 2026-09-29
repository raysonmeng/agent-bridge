import { describe, expect, test } from "bun:test";
import { agyPairArgs, isExplicitAttachAck, parseChatArgs, resolveChatSender } from "../cli/agy";
import { parseTopLevel } from "../cli";

describe("Antigravity CLI entrypoints", () => {
  test("each attach requires version and exact session in the socket ACK", () => {
    const id = "ab9da612-66aa-4195-91ba-881369f93e8b";
    const legacy = { type: "local_chat_result", success: true, agentId: `agy:${id}` };
    expect(isExplicitAttachAck(legacy, id)).toBe(false);
    expect(isExplicitAttachAck({ ...legacy, routingVersion: 1 }, id)).toBe(false);
    expect(isExplicitAttachAck({ ...legacy, routingVersion: 2 }, "different")).toBe(false);
    expect(isExplicitAttachAck({ ...legacy, routingVersion: 2 }, id)).toBe(true);
  });
  test("manual launch preserves inherited ports instead of constructing an invalid named pair", () => {
    expect(agyPairArgs({ manual: true, name: "(manual)" })).toEqual([]);
    expect(agyPairArgs({ manual: false, name: "team" })).toEqual(["--pair", "team"]);
  });
  test("preserves pair selection and passes literal message arguments", () => {
    for (const command of ["agy", "chat"]) {
      expect(parseTopLevel(["--pair", "team", command, "--list"]).restArgs).toEqual(["--pair", "team", "--list"]);
    }
    expect(parseChatArgs(["--from", "agy", "--to", "claude", "--message", "--literal\n$(no shell)"])).toMatchObject({ from: "agy", to: "claude", text: "--literal\n$(no shell)", list: false });
    const exact = "agy:ab9da612-66aa-4195-91ba-881369f93e8b";
    expect(parseChatArgs(["--from", exact, "--to", "codex", "--message", "hi"]).from).toBe(exact);
  });
  test("rejects invalid and missing inputs", () => {
    expect(parseChatArgs(["--list"]).list).toBe(true);
    expect(parseChatArgs(["--inbox"]).inbox).toBe(true);
    expect(() => parseChatArgs(["--list", "--inbox"])).toThrow();
    for (const args of [[], ["--to"], ["--unknown"], ["--to", "claude", "--message", " "], ["--from", "spoof", "--to", "claude", "--message", "hi"]]) {
      expect(() => parseChatArgs(args)).toThrow();
    }
  });
  test("replies require both an explicit recipient and a valid original ID", () => {
    const id = "ab9da612-66aa-4195-91ba-881369f93e8b";
    expect(parseChatArgs(["--to", "codex", "--message", "answer", "--reply-to", id]).replyTo).toBe(id);
    expect(() => parseChatArgs(["--message", "private", "--reply-to", id])).toThrow();
    expect(() => parseChatArgs(["--to", "codex", "--message", "answer", "--reply-to", "guess"])).toThrow();
  });
  test("inside an agy session the sender is pinned to that session", () => {
    const id = "ab9da612-66aa-4195-91ba-881369f93e8b", env = { ANTIGRAVITY_CONVERSATION_ID: id };
    expect(resolveChatSender("agy", env)).toBe(`agy:${id}`);
    expect(resolveChatSender(`agy:${id}`, env)).toBe(`agy:${id}`);
    for (const spoof of ["user", "claude", "codex", "agy:c647e404-6a5c-4eca-aae9-ff62ca5e4b5b"]) expect(() => resolveChatSender(spoof, env)).toThrow();
    expect(() => resolveChatSender("agy", { ANTIGRAVITY_CONVERSATION_ID: "not-a-uuid" })).toThrow();
    expect(resolveChatSender("user", {})).toBe("user");
  });
});
