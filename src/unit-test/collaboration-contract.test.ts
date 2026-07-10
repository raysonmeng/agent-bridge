import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CONTEXT_SCOPE_CLAUSE,
  CLAUDE_SESSION_CONTEXT,
  CODEX_CONTRACT_SCOPE_CLAUSE,
  CODEX_DEVELOPER_CONTRACT,
  codexContractSupersedePayload,
  contractHash,
} from "../collaboration-contract";
import { AGENTS_MD_SECTION, CLAUDE_MD_SECTION } from "../collaboration-content";

describe("collaboration contract payloads", () => {
  test("codex contract OPENS with the self-scoping clause (the rollout-residue mitigation)", () => {
    // The clause must come first: a resumed-outside-the-bridge session reads
    // top-down and needs the "ignore everything below" rule before the rules.
    expect(CODEX_DEVELOPER_CONTRACT.startsWith(CODEX_CONTRACT_SCOPE_CLAUSE)).toBe(true);
  });

  test("codex contract carries the full collaboration section", () => {
    expect(CODEX_DEVELOPER_CONTRACT).toContain(AGENTS_MD_SECTION);
  });

  test("scope clause states the never-wait rule verbatim requirements", () => {
    // Wording requirements from the carrier investigation (2026-07-10): live
    // bridge messages are the only proof of attachment; never wait for Claude
    // because the contract exists.
    expect(CODEX_CONTRACT_SCOPE_CLAUSE).toMatch(/NEVER wait for/);
    expect(CODEX_CONTRACT_SCOPE_CLAUSE).toMatch(/CURRENT session/);
  });

  test("claude session context opens with its scope clause and carries the section", () => {
    expect(CLAUDE_SESSION_CONTEXT.startsWith(CLAUDE_CONTEXT_SCOPE_CLAUSE)).toBe(true);
    expect(CLAUDE_SESSION_CONTEXT).toContain(CLAUDE_MD_SECTION);
  });
});

describe("contractHash", () => {
  test("12 lowercase hex chars", () => {
    expect(contractHash()).toMatch(/^[0-9a-f]{12}$/);
  });

  test("deterministic for the same content", () => {
    expect(contractHash()).toBe(contractHash(CODEX_DEVELOPER_CONTRACT));
    expect(contractHash("abc")).toBe(contractHash("abc"));
  });

  test("changes when the content changes", () => {
    expect(contractHash("abc")).not.toBe(contractHash("abd"));
    expect(contractHash()).not.toBe(contractHash(CODEX_DEVELOPER_CONTRACT + " "));
  });
});

describe("codexContractSupersedePayload", () => {
  test("names the superseded hash and re-sends the FULL current contract", () => {
    const previous = "0123456789ab";
    const payload = codexContractSupersedePayload(previous);
    expect(payload).toContain(previous);
    // Full re-send is the point: a hash alone carries no meaning for the model.
    expect(payload).toContain(CODEX_DEVELOPER_CONTRACT);
    expect(payload.startsWith("[AgentBridge contract update]")).toBe(true);
  });

  test("supersede payload hash differs from the contract hash (adapter must record contractHash(), not the payload's)", () => {
    expect(contractHash(codexContractSupersedePayload("0123456789ab"))).not.toBe(contractHash());
  });
});
