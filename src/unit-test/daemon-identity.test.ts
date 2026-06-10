import { describe, expect, test } from "bun:test";
import { CLOSE_CODE_PAIR_MISMATCH, CLOSE_CODE_TOKEN_MISMATCH } from "../control-protocol";
import {
  evaluateInjectionAttachGuard,
  validateClaudeClientIdentity,
} from "../daemon-identity";

describe("daemon Claude identity admission", () => {
  test("pair daemon rejects identity-less Claude clients by default", async () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: undefined,
      allowIdentityless: false,
    });

    expect(result).toEqual({
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: "missing client identity",
    });
  });

  test("pair daemon rejects pairId and cwd mismatches", () => {
    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "other-aaaaaaaa", cwd: "/tmp/project" },
      allowIdentityless: false,
    }).ok).toBe(false);

    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "main-12345678", cwd: "/tmp/other" },
      allowIdentityless: false,
    }).ok).toBe(false);
  });

  test("matching identity or explicit compat passes", () => {
    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "main-12345678", cwd: "/tmp/project" },
      allowIdentityless: false,
    }).ok).toBe(true);

    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: undefined,
      allowIdentityless: true,
    }).ok).toBe(true);
  });
});

describe("control-token admission gate (arch-review P1 #283)", () => {
  const goodIdentity = (controlToken?: string | null) => ({
    pairId: "main-12345678",
    cwd: "/tmp/project",
    ...(controlToken !== undefined ? { controlToken } : {}),
  });

  test("token correct + identity correct → admitted", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity("the-secret-token"),
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(true);
  });

  test("token missing while the daemon expects one → rejected with TOKEN_MISMATCH (4005)", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity(undefined), // pair/cwd correct, but NO token
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result).toEqual({
      ok: false,
      closeCode: CLOSE_CODE_TOKEN_MISMATCH,
      reason: "missing control token",
    });
  });

  test("token wrong → rejected with TOKEN_MISMATCH even when pair/cwd are correct", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity("attacker-guess"),
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result).toEqual({
      ok: false,
      closeCode: CLOSE_CODE_TOKEN_MISMATCH,
      reason: "control token mismatch",
    });
  });

  test("token gate runs BEFORE pair/cwd — a wrong token is rejected as TOKEN_MISMATCH", () => {
    // Even with a wrong pairId, the token gate (first) decides the close code, so
    // the failure is unambiguously attributable to the token.
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "other-aaaaaaaa", cwd: "/tmp/elsewhere", controlToken: "wrong" },
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);
  });

  test("token enforced even in legacy mode (no expectedPairId) — arbitrary socket without token is rejected", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      identity: { controlToken: undefined }, // no token presented
      allowIdentityless: false,
      expectedControlToken: "legacy-secret",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);

    // The legitimate legacy client that read the token is admitted.
    expect(validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      identity: { controlToken: "legacy-secret" },
      allowIdentityless: false,
      expectedControlToken: "legacy-secret",
    }).ok).toBe(true);
  });

  test("expectedControlToken null disables the gate (older daemon / write failure) — compat", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity(undefined),
      allowIdentityless: false,
      expectedControlToken: null,
    });
    expect(result.ok).toBe(true);
  });

  test("identityless compat escape hatch bypasses the token gate", () => {
    // AGENTBRIDGE_COMPAT_IDENTITYLESS: no identity object means no token can be
    // carried; the explicit operator opt-out must still admit.
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: undefined,
      allowIdentityless: true,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(true);
  });

  test("an identity-CARRYING client under the compat flag still must present the right token", () => {
    // The escape hatch only bypasses when identity is ABSENT. A client that sends
    // an identity (so it could carry a token) is held to the token gate.
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "main-12345678", cwd: "/tmp/project", controlToken: "wrong" },
      allowIdentityless: true,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);
  });
});

describe("injection attach-convergence guard (arch-review P1 #283)", () => {
  // Reference-identity sentinels stand in for the daemon's ServerWebSockets.
  const attached = { id: "attached" };
  const other = { id: "other" };

  test("the attached socket is allowed to inject", () => {
    expect(evaluateInjectionAttachGuard(attached, attached)).toEqual({ allowed: true });
  });

  test("a different (non-attached) socket is rejected with not_attached", () => {
    const result = evaluateInjectionAttachGuard(attached, other);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("not_attached");
      expect(result.reason).toContain("not the attached Claude session");
    }
  });

  test("no live frontend attached (null/undefined) rejects every injection", () => {
    expect(evaluateInjectionAttachGuard(null, other).allowed).toBe(false);
    expect(evaluateInjectionAttachGuard(undefined, other).allowed).toBe(false);
    // Even the socket itself cannot inject if it is not the recorded attached one.
    expect(evaluateInjectionAttachGuard(null, attached).allowed).toBe(false);
  });
});
