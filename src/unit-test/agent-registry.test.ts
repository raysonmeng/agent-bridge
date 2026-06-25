import { describe, test, expect, beforeEach } from "bun:test";
import { AgentRegistry } from "../agent-registry";
import type { ConnectionSession } from "../connection-session";

/** Minimal ConnectionSession stub — AgentRegistry only reads `.ws` (for isClaude). */
function fakeSession(ws: object): ConnectionSession {
  return { ws } as unknown as ConnectionSession;
}

describe("AgentRegistry — Claude slot single source of truth", () => {
  let reg: AgentRegistry;
  beforeEach(() => {
    reg = new AgentRegistry();
  });

  test("starts empty", () => {
    expect(reg.getClaude()).toBeNull();
  });

  test("setClaude / getClaude / clearClaude", () => {
    const wsA = {};
    const s = fakeSession(wsA);
    reg.setClaude(s);
    expect(reg.getClaude()).toBe(s);
    reg.clearClaude();
    expect(reg.getClaude()).toBeNull();
  });

  test("isClaude matches only the slot's underlying ws", () => {
    const wsA = {};
    const wsB = {};
    expect(reg.isClaude(wsA as any)).toBe(false); // empty slot
    reg.setClaude(fakeSession(wsA));
    expect(reg.isClaude(wsA as any)).toBe(true);
    expect(reg.isClaude(wsB as any)).toBe(false);
    reg.clearClaude();
    expect(reg.isClaude(wsA as any)).toBe(false);
  });
});

describe("AgentRegistry — codexBootstrapped flag", () => {
  test("defaults false, round-trips", () => {
    const reg = new AgentRegistry();
    expect(reg.codexBootstrapped).toBe(false);
    reg.codexBootstrapped = true;
    expect(reg.codexBootstrapped).toBe(true);
    reg.codexBootstrapped = false;
    expect(reg.codexBootstrapped).toBe(false);
  });
});

describe("AgentRegistry — challenge single-flight gate", () => {
  let reg: AgentRegistry;
  beforeEach(() => {
    reg = new AgentRegistry();
  });

  test("first beginChallenge wins, concurrent is rejected until endChallenge", () => {
    expect(reg.challengeInProgress).toBe(false);
    expect(reg.beginChallenge()).toBe(true);
    expect(reg.challengeInProgress).toBe(true);
    // A second contender while a probe is in flight is bounced.
    expect(reg.beginChallenge()).toBe(false);
    reg.endChallenge();
    expect(reg.challengeInProgress).toBe(false);
    // Gate is reusable after release.
    expect(reg.beginChallenge()).toBe(true);
    reg.endChallenge();
  });
});
