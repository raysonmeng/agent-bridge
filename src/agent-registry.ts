import type { ServerWebSocket } from "bun";
import type { ConnectionSession, ControlSocketData } from "./connection-session";

/**
 * §2.1 logical-agent layer.
 *
 * 1:1 today: one Claude slot plus Codex liveness flags. Consolidates the former
 * daemon module singletons (`attachedClaude` / `codexBootstrapped` /
 * `challengeInProgress`) into a single addressable owner, so room membership can
 * later hold N members instead of one global slot. The Claude member is keyed
 * implicitly today; real agentIds (§2.2, email/GitHub) plug in here later
 * WITHOUT touching the call sites that go through these methods.
 *
 * Deliberately a pure state holder (no deps): `codex` and `tuiConnectionState`
 * stay as daemon module consts — they are already well-encapsulated objects, and
 * moving them in would add churn without making the slot more addressable.
 */
export class AgentRegistry {
  private claude: ConnectionSession | null = null;
  private _codexBootstrapped = false;
  private _challengeInProgress = false;

  /** The session currently holding the Claude slot, or null when detached. */
  getClaude(): ConnectionSession | null {
    return this.claude;
  }
  setClaude(session: ConnectionSession): void {
    this.claude = session;
  }
  clearClaude(): void {
    this.claude = null;
  }
  /** True iff `ws` is the socket currently holding the Claude slot. */
  isClaude(ws: ServerWebSocket<ControlSocketData>): boolean {
    return this.claude?.ws === ws;
  }

  get codexBootstrapped(): boolean {
    return this._codexBootstrapped;
  }
  set codexBootstrapped(value: boolean) {
    this._codexBootstrapped = value;
  }

  /**
   * Single-flight admission gate for the one Claude slot (challenge-on-contest).
   * Returns false if a liveness probe is already in flight, so a concurrent
   * claude_connect is bounced instead of racing a second probe. Pair with
   * {@link endChallenge} in a finally.
   */
  beginChallenge(): boolean {
    if (this._challengeInProgress) return false;
    this._challengeInProgress = true;
    return true;
  }
  endChallenge(): void {
    this._challengeInProgress = false;
  }
  get challengeInProgress(): boolean {
    return this._challengeInProgress;
  }
}
