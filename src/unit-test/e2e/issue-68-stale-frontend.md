# Issue #68 — E2E Test Plan

## fix: evict stale Claude frontend via liveness probe (challenge-on-contest)

Related:
- Issue: https://github.com/raysonmeng/agent-bridge/issues/68
- Source of truth: `docs/issues-2026-04-18-codex-stuck-and-resume.md` (Issue A)

The bug: when Claude Code crashed/was killed hard, the OS never sent FIN, so the
daemon's WebSocket reported `readyState=OPEN` forever. New sessions were rejected
with close code `4001` for up to an hour (log: conn #2 through #19 all rejected).

The fix: when a second frontend arrives while the slot is "occupied", ping the
incumbent and wait up to 3 s for a pong. If no pong, evict the incumbent with
close code `4002` (`CLOSE_CODE_EVICTED_STALE`) and admit the newcomer.

### Test 1 — happy path unchanged

**Goal:** verify normal single-session admission still works.

1. Terminal A: `agentbridge claude` — verify `✅ AgentBridge bridge is ready`.
2. Terminal B: `agentbridge codex`.
3. Confirm Claude and Codex can exchange a message round-trip.

**Pass:** normal flow works; no new log lines about liveness probes because
the slot is never contested.

### Test 2 — rejection still blocks a live second session

**Goal:** verify two **live** Claude sessions can't coexist (regression guard
for PR #57 admission semantics).

1. Terminal A: `agentbridge claude` — wait for bridge ready.
2. Terminal C: `agentbridge claude` from the same machine.
3. Confirm Terminal C shows `⚠️ AgentBridge daemon rejected this session — another Claude Code session is already connected.`
4. In `agentbridge.log` confirm:
   - `Claude frontend contest: new=#N, incumbent=#M (readyState=1, msSincePong=...)`
   - `Rejecting Claude frontend #N — incumbent #M responded to liveness probe`
5. Terminal A is still healthy and can talk to Codex.

**Pass:** Terminal C rejected with code `4001`; Terminal A unaffected.

### Test 3 — stale frontend evicted when old process is killed hard

**Goal:** the core fix. Reproduce the half-open-dead incumbent scenario and
verify the contender is admitted within the probe window.

1. Terminal A: `agentbridge claude`.
2. Find the Claude Code PID (from process list or `agentbridge.log`).
3. `kill -9 <pid>` in Terminal A's process **without** letting it shut down the
   WebSocket. This simulates the crash that produced Issue #68.
4. Terminal B: `agentbridge claude` within 30 s.
5. Verify Terminal B becomes `✅ AgentBridge bridge is ready` within ~3-5 s.
6. In `agentbridge.log` confirm in order:
   - `Claude frontend contest: new=#N, incumbent=#M (readyState=1, msSincePong=...)`
   - `Evicting stale Claude frontend #M: liveness probe timed out after 3000ms`
   - `Claude frontend attached (#N)`

**Pass:** the newcomer attaches within ~`LIVENESS_PROBE_TIMEOUT_MS + 1s`;
no more endless reject loop on reconnect.

### Test 4 — concurrent contestants serialize safely

**Goal:** when two fresh sessions arrive simultaneously and the incumbent is
dead, exactly one wins, the other retries, and no double-attach occurs.

1. Simulate dead incumbent as in Test 3.
2. Start two `agentbridge claude` terminals within 200 ms of each other.
3. Confirm one becomes `✅ bridge is ready` and the other shows the rejection
   message (then it can retry — operator can restart it manually).
4. Log should contain `another liveness probe already in flight` for the loser.

**Pass:** only one session ends up attached; daemon state remains consistent.

### Test 5 — `kill` sentinel still wins

**Goal:** `agentbridge kill` disables the daemon globally; the probe must not
accidentally revive a session.

1. Terminals as in Test 1.
2. Run `agentbridge kill`.
3. Try `agentbridge claude` — should see `AgentBridge is disabled by agentbridge kill`.
4. No probe-related log lines appear (daemon has exited).

**Pass:** kill sentinel behavior is unaffected by the new admission path.

### Automated coverage

- Unit: `src/unit-test/liveness-probe.test.ts` — pure probe state machine (7 scenarios, fake clock)
- Integration: `src/unit-test/daemon-client.test.ts`, `src/unit-test/e2e-reconnect.test.ts` still green
