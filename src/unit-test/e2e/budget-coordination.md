# Budget Coordination — E2E Test Plan

## feat: budget-aware coordination layer (AgentBridge × agent-quota-guard)

Related:
- Design doc: `budgetcoordinationplan.md` (v2.2, cross-reviewed Claude × Codex, 0 REAL issues)
- Branch: `feat/budget-aware-coordination` (stacked on PR #96)

The feature: the daemon polls both agents' subscription quota via the deployed
agent-quota-guard probe (`~/.budget-guard/bin/budget-probe`), computes a joint
decision (`normal/balance/parallel/paused`), surfaces it via `DaemonStatus.budget`
/ `get_budget` / `abg budget`, and at `paused` enforces a hard gate on
`claude_to_codex` injection until BOTH sides drop below `resumeBelow`.

### Fixture harness (used by all tests below)

All phase scenarios are driven through `AGENTBRIDGE_QUOTA_PROBE` pointing at a
fixture script so no real quota is consumed and thresholds are reproducible:

```bash
cat > /tmp/abg-budget-fixture.sh << 'EOF'
#!/bin/bash
# emits a fixed probe JSON per agent; tweak utils to drive phases
agent="${2:-claude}"   # invoked as: fixture.sh --agent <agent>
cat "/tmp/abg-fixture-${agent}.json"
EOF
chmod +x /tmp/abg-budget-fixture.sh
export AGENTBRIDGE_QUOTA_PROBE=/tmp/abg-budget-fixture.sh
```

Write per-agent JSON files in either probe shape (bash shape with `hard_util`,
node shape without) — both must normalize identically (covered by unit tests;
E2E uses the bash shape).

### Test 0 — fail-open: probe missing

**Goal:** budget sensing silently disables without affecting collaboration.

1. Unset `AGENTBRIDGE_QUOTA_PROBE`/`BUDGET_PROBE`; temporarily rename BOTH installed
   probes (`~/.budget-guard/bin/budget-probe` AND `~/.budget-guard/bin/probe.mjs`) —
   the v2.3 auto chain falls back budget-probe → probe.mjs, so removing only one
   is NOT a missing-probe scenario.
2. `abg claude` + `abg codex`; exchange a message round-trip.
3. `abg budget` → prints the "预算感知不可用" notice, exit 0 paths unaffected.
4. In Claude, call `get_budget` → same unavailable text.
5. `agentbridge.log` contains at most one budget-unavailable line; no errors.

**Pass:** collaboration identical to pre-feature behavior; no repeated noise.

### Test 1 — P0 sensing: snapshot visible on all three surfaces

**Goal:** normal-phase snapshot flows daemon → status → get_budget / abg budget.

1. Fixture: claude 42% (5h) / 19% (周), codex 10% / 14% — normal phase.
2. Start the pair; wait for bridge ready.
3. `abg budget` shows both agents' 5h/周 %, 门控/预警 utils, drift line, 暂停：否.
4. `abg budget --json` → `.budget.phase == "normal"`.
5. In Claude, `get_budget` → same content as `abg budget` (shared renderer).

**Pass:** all three surfaces agree; percentages match the fixture.

### Test 2 — v2.4 side-aware pause: Codex-side closes the gate, Claude can solo

**Goal:** Codex gateUtil ≥ pauseAt(90) → `system_budget_pause` + gate closed;
Claude side stays free for solo work.

1. Start pair in normal phase; confirm round-trip works.
2. Rewrite CODEX fixture to gateUtil 93% (5h window), reset_epoch ≈ now+10min.
3. Within one poll interval (≤60s) Claude receives `system_budget_pause_*`
   (checkpoint + may continue solo on independent work + mark the split point).
4. Claude calls `reply` → error containing 预算暂停 + 预计恢复（以实测为准）.
5. `abg budget` shows Codex 侧额度耗尽（闸门关闭）, pauseSide=codex.
6. Codex receives **no** injected turn (its session stays idle — that IS the park).

**Pass:** gate enforced; Claude-side tooling unrestricted; wording is side-aware.

### Test 2b — v2.4 handoff: Claude-side exhaustion keeps the gate OPEN

**Goal:** Claude gateUtil ≥ pauseAt(90), Codex healthy → `system_budget_handoff`;
the baton reply still goes through.

1. From normal phase, rewrite CLAUDE fixture to gateUtil 91% (Codex stays low).
2. Claude receives `system_budget_handoff_*` (package remaining work into ONE
   reply: task list, context, artifact locations, acceptance criteria).
3. Claude sends the handoff `reply` → **succeeds** (gate open); Codex starts its
   turn and pushes the work forward within that single agentic turn.
4. `abg budget` shows 接力中（闸门开放）, pauseSide=claude.
5. Escalation: ALSO raise codex fixture ≥90 → state upgrades to 双侧联合暂停,
   gate closes, further replies rejected.

**Pass:** handoff reply not blocked; Codex relays the baton; escalation closes the gate.

### Test 3 — v2.4 resume paths (side-aware)

**Goal:** each activeSides downgrade path emits its own notice.

1. From joint pause (Test 2b step 5), drop CLAUDE fixture to 5% → state
   downgrades to Codex-only pause (`system_budget_pause` again, gate STILL closed,
   Claude-solo wording).
2. Drop CODEX fixture to 5% → `system_budget_resume_*`, gate opens; Claude
   `reply` succeeds; Codex wakes with the relayed context.
3. Separately: from a Claude-only handoff, drop CLAUDE to 5% →
   `system_budget_claude_recovered_*` notice (gate was never closed).
4. Early-refresh realism: release follows live probes — a weekly refresh that
   resets windows ahead of the displayed estimate must release on the next poll.

**Pass:** all downgrade paths emit distinct notices; resume follows live probes.

### Test 4 — P1 daemon restart during pause: re-derivation

**Goal:** pause state is re-derived from the first immediate poll after restart.

1. Enter paused state (Test 2).
2. `abg kill` then `abg claude` again (fixtures still ≥90).
3. After bridge ready, `abg budget` shows paused again within the first poll;
   a duplicate STOP directive is acceptable (idempotent wording).
4. `reply` is still gated.

**Pass:** no un-gated window after restart beyond the first immediate poll.

### Test 5 — P2 balance directive (advisory, deduped)

**Goal:** warnUtil drift > syncDriftPct(10) → one tilt directive, no spam.

1. Fixtures: claude 40%, codex 20% → Claude receives balance directive naming
   both percentages and the lighter side (Codex).
2. Keep fixtures unchanged for 3+ poll intervals → no repeated directive.
3. Swap fixtures (20/40) → one new directive tilting toward Claude.

**Pass:** correct direction both ways; fingerprint dedup holds across ticks.

### Test 6 — P3 parallel recommendation (boundary)

**Goal:** both remaining > 60% AND nearest 5h reset < 3600s → parallel directive.

1. Fixtures: both gateUtil 35% (remaining 65%), claude 5h reset_epoch = now+30min → directive fires.
2. reset_epoch = now+90min → no directive.
3. Drift 40/20 AND reset now+30min → ONE merged directive (lighter side takes
   more parallel subtasks), not two.

**Pass:** boundary behavior matches config; merged wording when both conditions hold.

### Test 7 — P4 codex tier control (default off / opt-in)

**Goal:** model/effort overrides only injected when codexTierControl=true.

1. Default config: trigger any phase; inspect daemon log / proxy traffic —
   `turn/start` params contain NO `model`/`effort` keys.
2. Set `AGENTBRIDGE_BUDGET_CODEX_TIER_CONTROL=true`; drive phase to a non-full
   tier; Claude sends a reply → injected `turn/start` carries `model`/`effort`.
3. No JSON-RPC error from app-server (codex-cli ≥ 0.137.0) → log records
   transport-accepted; manually confirm via Codex TUI `/status` that the model
   changed (applied ≠ accepted — this step is the only applied-level check).
4. Drive tier back to `full` → an explicit restore override is sent once.

**Pass:** opt-in only; sticky semantics managed (restore observed); zero impact when off.

### Test 8 — real-probe smoke (no fixtures)

**Goal:** the deployed probe chain works against live endpoints, including the
v2.3 per-agent fallback.

1. Unset `AGENTBRIDGE_QUOTA_PROBE`/`BUDGET_PROBE` (auto chain: budget-probe → probe.mjs).
2. Start pair; `abg budget` shows real percentages for BOTH agents, consistent with
   `~/.budget-guard/bin/probe.mjs claude probe` / `codex probe` (±cache TTL).
   Note: on this machine the bash budget-probe is schema-stale for claude
   (`ok:false "no Claude usage buckets found"`), so claude data arriving at all
   PROVES the per-agent probe.mjs fallback works — check the daemon log for the
   "no usable data" fallback line for claude.
3. No pause unless real usage is actually ≥ pauseAt.

**Pass:** both agents show live data (claude via fallback); no spurious pause.

---

Notes:
- Tests 2–4 cover plan risk #6. The former pull-mode limitation (risk #5) was
  eradicated by removing the configurable pull mode entirely — push delivery is
  unconditional; a failed push still degrades to the get_messages fallback queue
  (transport failure, not a mode).
- Unit-level coverage (dual probe shapes, gateUtil vs warnUtil gating,
  rate-limit-only pause, config boundary protection, stop() timer cleanup) lives in
  `budget-state.test.ts` / `quota-source.test.ts` / `budget-coordinator.test.ts` /
  `config-service.test.ts` / `budget-render.test.ts`.
