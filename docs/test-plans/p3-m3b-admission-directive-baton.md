# v3 P3 M3b — Admission Directive + Checkpoint Baton E2E Test Plan

> **For agentic workers:** This plan verifies the LIVE behavior of the v3 P3 M3b
> milestone against a real daemon + a controllable budget probe. The deterministic
> paths are already covered by the automated suite (`src/integration-test/daemon-wiring.test.ts`,
> `src/unit-test/budget-coordinator.test.ts`); this plan is the manual/live backstop
> the project requires per PR. Do NOT run against the active collaboration pair —
> use a disposable pair + cwd.

**Goal:** Confirm that the three-state admission gate's M3b layer behaves correctly
end-to-end: the admission directive reaches Claude (turnPhase-aware), the closed-state
checkpoint baton fires once per quota window, routing advice is suppressed while
admission-closed, the Codex pause-recovery is held while admission-closed, and the
interrupt path re-checks the gate after its await.

**Architecture:** A controllable quota probe (a shell script that cats a per-agent
JSON fixture) drives `BudgetCoordinator` through the real daemon. The daemon's
`gateState()` (open / admission-closed / closed) gates `handleClaudeToCodex`, emits
`system_budget_admission` to Claude, and injects the checkpoint baton via
`codex.injectMessage`.

**Tech Stack:** Bun, AgentBridge control protocol + `/healthz`, the real daemon
budget coordinator, a fixture quota probe (`AGENTBRIDGE_QUOTA_PROBE`).

---

## Code anchors (prefer symbols if line numbers drift)

- `src/budget/budget-coordinator.ts` — `gateState()`, `applyAdmissionDirective()`
  (idempotent emit via `lastEmittedAdmissionFingerprint`, defer/flush via
  `isCodexTurnActive`/`onCodexTurnIdle`), `admissionResetEpoch()` (codex fresh window),
  the recoveredSides codex-hold, the advise-case `gateState()!=="open"` re-arm.
- `src/budget/budget-state.ts` — `renderBudgetAdmissionDirective()`, the
  `adviceEligible` `!agentShouldAdmitClose(...)` guard.
- `src/daemon.ts` — `evaluateInjectionBudgetGate()` (top-of-handler + post-interrupt-await
  re-check), `maybeFireCheckpointBaton()` (onSnapshot + turnPhaseChanged triggers,
  `codex.canInject()` precheck), `CHECKPOINT_BATON_PROMPT`.
- `src/codex-adapter.ts` — `canInject()`, `injectMessage()`.
- `src/budget/admission-quota.ts` — `consumeWrapUp`, `consumeCheckpointBaton` (fail-closed).

## Safety

Do NOT target the active pair. Use a disposable pair + cwd and a fixture probe:

```bash
export M3B_CWD="/tmp/agentbridge-m3b"
export M3B_PAIR="m3b-probe"
mkdir -p "$M3B_CWD/.agent"
```

The fixture probe reads per-agent JSON so the gate can be driven deterministically:

```bash
# probe.sh
#!/bin/sh
cat "$FIXTURE_ROOT/usage-$2.json"
```

Set `AGENTBRIDGE_BUDGET_ENABLED=1`, `AGENTBRIDGE_QUOTA_PROBE=<probe.sh>`,
`AGENTBRIDGE_BUDGET_POLL_SECONDS=5` on the disposable pair's daemon.

`util` levels (5h window, `reset_epoch` in the future): `< 85` = gate open;
`85 ≤ util < 90` = admission-closed (not paused); `≥ 90` = closed (paused).

---

## T1 — Admission directive reaches Claude, turnPhase-aware

1. Start the pair with codex `util: 20` (gate open). Confirm `/healthz`
   `budget.gateState === "open"`; Claude receives no admission directive.
2. With Codex idle, raise codex `util: 86`. Within one poll, `/healthz`
   `gateState === "admission-closed"` and Claude receives ONE
   `system_budget_admission` channel message ("收尾保护 … budget_admission … wrap_up").
3. Reset codex `util: 20` (gate open), then start a Codex turn (any reply), and
   WHILE it runs raise codex `util: 86`. **Expected:** the admission directive is
   DEFERRED — Claude does NOT receive it mid-turn. When the Codex turn ends (idle),
   the directive is flushed (Claude receives exactly one).
4. Keep codex `util: 86` across several polls. **Expected:** no duplicate admission
   directive (idempotent dedup).

**Automated mirror:** budget-coordinator.test.ts "admission directive emission" block.

## T2 — New Codex turn rejected; wrap-up + steer allowed

1. Gate `admission-closed` (codex `util: 86`). From Claude, `reply` a normal new
   task. **Expected:** rejected with `budget_admission`; no Codex turn starts.
2. `reply` with `wrap_up: true`. **Expected:** injected (one Codex turn); the
   wrap-up quota in `<stateDir>/admission-quota.json` shows `wrapUpUsed: 1`.
3. Exceed `maximize.wrapUpQuota` (default 2) wrap-ups. **Expected:** the
   (quota+1)-th `wrap_up` reply is rejected `budget_admission` (quota exhausted).
4. A `steer` into a running Codex turn is NOT gated (feeds the turn).

**Automated mirror:** daemon-wiring.test.ts "v3 P3 admission gate" tests.

## T3 — Advice suppressed while admission-closed

1. Drive a drift (e.g. Claude `util: 20`, codex `util: 86`) that would normally
   produce a `system_budget_balance`/`system_budget_underutilized`. **Expected:**
   NO routing-advice directive while codex admission-closes; `/healthz`
   `budget.phase` is NOT "balance"/"underutilized" (it is "normal").
2. Drop codex below the admission line (`util: 78`, gate open) with the drift still
   present. **Expected:** the routing advice now fires exactly once (re-armed).

**Automated mirror:** budget-state.test.ts "routing advice is suppressed" + the
"re-emits suppressed balance advice once the admission gate opens (R2-2)" test.

## T4 — Closed-state checkpoint baton (once per window)

1. Drive codex to `util: 95` (gate closed) with Codex idle and TUI connected.
   **Expected:** within one poll, ONE checkpoint baton turn is injected into Codex
   (a turn whose text contains "系统发起 … .agent/checkpoint.md");
   `admission-quota.json` shows `checkpointBatonUsed: true`.
2. Hold codex `util: 95` across several more polls. **Expected:** NO further baton
   (once per quota window). When the 5h window resets, a new baton may fire.
3. Disconnect the Codex TUI, then drive `util: 95` (gate closed). **Expected:** the
   baton is NOT consumed while Codex is not injectable (`canInject()` precheck) —
   `checkpointBatonUsed` stays false; reconnect the TUI → the baton fires.

**Automated mirror:** daemon-wiring.test.ts "closed gate fires the checkpoint baton
ONCE per window"; codex-adapter.test.ts "canInject" + admission-quota.test.ts.

## T5 — Codex pause-recovery held while admission-closed

1. Burn-regime fixture: codex `util: 96` with confident burn (gate closed/paused).
   Then drop to `util: 82` (pause clears, admission still holds — gate
   admission-closed). **Expected:** Claude does NOT receive a `system_budget_resume`
   for Codex while still admission-closed (no auto-resume turn injected); the
   admission directive is shown instead. Dropping below `util: 80` (gate open)
   allows recovery on the next genuine pause-recovery cycle.

**Automated mirror:** budget-coordinator.test.ts "holds the Codex pause-recovery
while still admission-closed (R2-1)".

## T6 — Interrupt re-checks the gate after the await

1. Gate open (codex `util: 20`), a Codex turn running. From Claude, send a new task
   with `on_busy: "interrupt"`. While the daemon is parked awaiting the interrupt
   terminal boundary, raise codex `util: 86` (gate → admission-closed). **Expected:**
   when the boundary fires, the injection is REJECTED with `budget_admission` (the
   post-await re-check), NOT injected — no gate bypass.

**Automated mirror:** daemon-wiring.test.ts "interrupt RE-CHECKS the gate after the
await" (uses `FAKE_APP_INTERRUPT_DELAY_MS` + a raised `AGENTBRIDGE_INTERRUPT_TIMEOUT_MS`).

---

## Pass criteria

All of T1–T6 behave as the **Expected** lines describe, AND `bun run check` is green
(typecheck + full suite + plugin sync + plugin versions). Any deviation is a
regression in the M3b admission layer.

## Known backlog (non-blocking, documented)

- `getResumeCandidate().codex` reports `true` for the single de-escalation poll on
  which the codex recovery is held; the value is unconsumed (the only reader,
  `enqueueCodexBudgetResume`, is reached via the skipped `onResume`). Consider
  clearing the codex candidate under the same hold condition.
- `renderBudgetSnapshot()` does not surface `gateState: "admission-closed"`; during
  the admission hold band `phase` can read "balance" while the gate is
  admission-closed. The `gateState` field is the authoritative signal; consider
  rendering admission-closed for observability.
