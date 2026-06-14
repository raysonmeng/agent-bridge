# PR5 Codex Idle Injection Capability Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this plan step-by-step. This plan intentionally does not run from the current Codex collaboration turn.

**Goal:** Determine whether an idle Codex TUI can be fully automatically awakened by AgentBridge's existing `turn/start` injection path.

**Architecture:** The probe uses the public daemon control WebSocket as a temporary Claude-side client. It drives the real path `claude_to_codex -> codex.injectMessage() -> turn/start`, then waits for both the control `turn_started` ACK and the `system_turn_started` bridge message emitted from Codex's real `turn/started` notification.

**Tech Stack:** Bun/Node WebSocket, AgentBridge control protocol, existing daemon `/healthz`, existing Codex adapter injection path.

---

## Scope

This is a live capability test for current AgentBridge/Codex behavior. It does not depend on PR3 `ResumeInjectionQueue` and must not import daemon internals.

Code anchors being exercised:

- `src/codex-adapter.ts:503` `injectMessage()` sends app-server `turn/start`.
- `src/codex-adapter.ts:2013` handles app-server `turn/started`.
- `src/codex-adapter.ts:1874` emits `bridgeTurnStarted` from a bridge-originated `turn/start` response.
- `src/daemon.ts:616` (`codex.on("bridgeTurnStarted")`) converts `bridgeTurnStarted` into control `turn_started` (sent at `:638`).
- `src/daemon.ts:699` (`codex.on("turnStarted")`) emits `system_turn_started` (at `:703`) after the raw Codex turn lifecycle starts.
- `src/daemon.ts:1040` (`case "claude_to_codex"`) routes control `claude_to_codex` into `handleClaudeToCodex` (`:1134`), which calls `codex.injectMessage()` at `:1407`.

> Line numbers track `master` (PR4 / `21fd937`); prefer the named symbols if they drift on a later refactor.

## Files

- Script: `scripts/pr5-codex-idle-injection-probe.mjs`
- Plan: `docs/test-plans/pr5-codex-idle-injection.md`

## Safety Rules

Do not run this against the active collaboration pair. The current Codex session executing this work is not idle, and injecting into it would pollute this thread.

Use a disposable pair and cwd:

```bash
export PR5_CWD="/tmp/agentbridge-pr5-idle"
export PR5_PAIR="pr5-idle-probe"
mkdir -p "$PR5_CWD"
```

Run the probe script from this repo while targeting the disposable cwd, so the script's default `status.cwd === process.cwd()` refusal protects the current repo:

```bash
cd /Users/raysonmeng/repo/agent_bridge
```

The script also refuses to contest a live attached Claude frontend unless `--replace-incumbent` is supplied. Do not use `--replace-incumbent` for this test; the script itself should be the only temporary Claude-side control client for the disposable pair.

## Observable Signals

The success scenario must observe all of these:

1. Precondition status shows true idle target:
   - `bridgeReady: true`
   - `tuiConnected: true`
   - `threadId` is a non-empty string
   - `turnPhase: "idle"`

2. The probe sends one `claude_to_codex` message with `onBusy: "reject"`.

3. The daemon returns:
   - `claude_to_codex_result.success === true`

4. The daemon emits:
   - `turn_started` with the same `requestId`
   - a `turnId`
   - the same live `threadId`

5. The daemon forwards a `codex_to_claude` message whose id starts with `system_turn_started_`. This is the evidence that Codex's real `turn/started` notification fired, not only that the `turn/start` request was accepted.

If all five hold without manual input in Codex after the probe send, classify the capability as:

```text
fully_automatic_idle_wakeup
```

## Non-Success Classifications

Use these labels in the PR5 report:

- `not_ready_no_thread`: status lacks a live `threadId` or `bridgeReady`; daemon returns `no_thread`.
- `not_ready_ws_down`: status shows `tuiConnected:false` or `bridgeReady:false`; daemon returns `no_thread`.
- `busy_reject_only`: status shows `turnPhase:running|stalled`; daemon returns `busy_reject` and no `turn_started`.
- `transport_rejected`: `claude_to_codex_result.success:false` with an app-server rejection, or `turn_started` never arrives after result success.
- `not_fully_automatic`: `turn_started` arrives only after manual Codex input, or no `system_turn_started_` message arrives.

## Step 1: Start Disposable Codex Pair

In Terminal A:

```bash
cd "$PR5_CWD"
abg kill --pair "$PR5_PAIR" || true
abg codex --pair "$PR5_PAIR" --new
```

Create or verify a live thread in that Codex TUI, then wait until the turn is complete and Codex is idle. A simple manual warm-up prompt is acceptable inside the disposable TUI:

```text
Reply exactly READY and stop.
```

Leave the disposable Codex TUI open and idle.

Get the control port in Terminal B:

```bash
export CONTROL_PORT=$(abg pairs --json | jq -r --arg pair "$PR5_PAIR" '.[] | select(.name == $pair or .pairId == $pair) | .ports.controlPort')
echo "CONTROL_PORT=$CONTROL_PORT"
[ -n "$CONTROL_PORT" ] && [ "$CONTROL_PORT" != "null" ] || echo "WARN: control port not resolved — check 'abg pairs' (is the daemon up and the pair named '$PR5_PAIR'?)"
```

If the JSON shape differs, use the pair row's control port shown by `abg pairs`.

## Step 2: Observe Without Injecting

From `/Users/raysonmeng/repo/agent_bridge`:

```bash
bun scripts/pr5-codex-idle-injection-probe.mjs \
  --scenario observe \
  --control-port "$CONTROL_PORT" \
  --expected-cwd "$PR5_CWD"
```

Expected:

- If no Claude frontend is attached to the disposable pair, the script attaches and prints status.
- If a live Claude frontend is attached, the script reports observe-only and does not contest it.
- No `claude_to_codex` injection is sent.

Required status before Step 3:

```json
{
  "bridgeReady": true,
  "tuiConnected": true,
  "threadId": "non-empty",
  "turnPhase": "idle"
}
```

## Step 3: Success Scenario

From `/Users/raysonmeng/repo/agent_bridge`:

```bash
bun scripts/pr5-codex-idle-injection-probe.mjs \
  --scenario success \
  --control-port "$CONTROL_PORT" \
  --expected-cwd "$PR5_CWD" \
  --confirm-inject
```

Expected pass line:

```text
[PASS] fully_automatic_idle_wakeup
```

The JSON form is useful for PR artifacts:

```bash
bun scripts/pr5-codex-idle-injection-probe.mjs \
  --scenario success \
  --control-port "$CONTROL_PORT" \
  --expected-cwd "$PR5_CWD" \
  --confirm-inject \
  --json | tee /tmp/pr5-codex-idle-success.json
```

The resulting JSON must include:

- `classification: "fully_automatic_idle_wakeup"`
- `result.success: true`
- `turnStartedAck.turnId`
- `rawTurnStartedMessageId` starting with `system_turn_started_`
- `before.turnPhase: "idle"`

## Step 4: Busy Failure Mode

In the disposable Codex TUI, start a long-running turn. For example:

```text
Run a shell command that sleeps for 60 seconds, then reply DONE.
```

While it is running, execute:

```bash
bun scripts/pr5-codex-idle-injection-probe.mjs \
  --scenario busy \
  --control-port "$CONTROL_PORT" \
  --expected-cwd "$PR5_CWD" \
  --confirm-inject
```

Expected:

```text
[PASS] busy produced busy_reject without turn_started
```

This proves the probe is not silently steering or queueing while Codex is busy; the PR3 queue must defer until a later idle boundary.

## Step 5: No-Thread Failure Mode

Use a disposable daemon state where no Codex thread has been established yet, or start the pair and probe before the Codex TUI creates a thread.

Run:

```bash
bun scripts/pr5-codex-idle-injection-probe.mjs \
  --scenario no-thread \
  --control-port "$CONTROL_PORT" \
  --expected-cwd "$PR5_CWD" \
  --confirm-inject
```

Expected:

```text
[PASS] no-thread produced no_thread without turn_started
```

This confirms PR3 cannot rely on bridge injection unless PR2/PR3 has a live candidate thread/checkpoint.

## Step 6: WS-Down Failure Mode

Close the disposable Codex TUI while keeping the daemon alive. If needed, launch the pair with a long idle shutdown setting so the daemon remains reachable long enough to test:

```bash
AGENTBRIDGE_IDLE_SHUTDOWN_MS=300000 abg codex --pair "$PR5_PAIR"
```

After the TUI disconnects and status shows `tuiConnected:false` or `bridgeReady:false`, run:

```bash
bun scripts/pr5-codex-idle-injection-probe.mjs \
  --scenario ws-down \
  --control-port "$CONTROL_PORT" \
  --expected-cwd "$PR5_CWD" \
  --confirm-inject
```

Expected:

```text
[PASS] ws-down produced no_thread without turn_started
```

Current daemon behavior collapses no live thread and no app-server/TUI readiness into `code:"no_thread"`. The report should include the pre-status fields to distinguish the two cases.

## PR5 Report Template

Use this shape in the PR5 result:

```markdown
## Codex Idle Injection Capability

Result: fully_automatic_idle_wakeup | not_fully_automatic | transport_rejected | not_ready_no_thread | not_ready_ws_down | busy_reject_only

Environment:
- AgentBridge commit/build:
- Codex version:
- Pair:
- Cwd:
- Control port:

Success evidence:
- before.bridgeReady:
- before.tuiConnected:
- before.threadId:
- before.turnPhase:
- claude_to_codex_result:
- turn_started ACK:
- system_turn_started message id:
- after.turnPhase:

Failure-mode checks:
- busy:
- no-thread:
- ws-down:

Conclusion for PR3:
- ResumeInjectionQueue may inject immediately when candidate side is idle and status has live thread+WS.
- ResumeInjectionQueue must soft-defer on busy/no-thread/ws-down and retry from turnCompleted/status/watchdog triggers.
```
