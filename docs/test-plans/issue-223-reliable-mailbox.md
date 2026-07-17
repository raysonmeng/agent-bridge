# Issue 223 reliable mailbox test plan

This plan validates Codex-to-Claude delivery without weakening normal Claude or Codex permission controls. It covers the in-memory P0/P1 mailbox implemented for issue 223. It does not claim crash durability or guaranteed idle wake-up.

## Safety setup

Use a disposable Git repository with no production files. Build source and committed plugin artifacts with the pinned Bun version, then verify synchronization:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build:cli
bun run build:plugin
bun run verify:plugin-sync
```

Launch both native subscription-authenticated CLIs with safe controls:

```bash
AGENTBRIDGE_SAFE=1 bun dist/cli.js --pair issue223 claude \
  --safe --permission-mode manual

AGENTBRIDGE_SAFE=1 bun dist/cli.js --pair issue223 codex \
  --safe --new --sandbox read-only --ask-for-approval untrusted --no-alt-screen
```

Approve only the specific AgentBridge MCP calls under test. No API key is required.

## Deterministic suite

Run:

```bash
bun test src/unit-test/reliable-mailbox.test.ts
```

The suite must cover:

- A resolved Channel write with no consumer, followed by two identical `get_messages` snapshots.
- Successful Channel processing followed by `ack_messages`, with no later pull or retry duplicate.
- A throwing Channel write that leaves exactly one mailbox entry.
- Partial and repeated polling with deletion limited to requested immutable delivery IDs.
- Both lost-ACK directions: no committed ACK remains recoverable; a committed ACK with a lost response is idempotent when repeated.
- Adapter restart loss and same-adapter daemon, Claude Channel, and Codex reconnect survival.
- Rapid arrivals, ACK concurrent with arrival, source-ID conflicts, TTL/capacity reuse, collision aliases, multiple adapters, and FIFO retry order.
- Count and UTF-8 byte limits, oversized messages, overflow, ordinary system notices, budget-resume aliases, retry exhaustion, and invalid ACK input.

## Live idle recovery

Leave Claude idle at its prompt. Ask Codex to return a unique one-line sentinel. If Claude does not visibly wake, activate Claude manually and ask it to call `get_messages` twice without acknowledging.

Pass criteria:

1. Both polls contain the sentinel under the same delivery-generation ID.
2. `ack_messages` for that exact ID succeeds after processing.
3. A later poll no longer contains the sentinel.

If Claude wakes and processes the initial Channel push, that round tests successful push delivery rather than the idle-drop recovery path. Repeat with a new sentinel. If every push wakes Claude, record the live idle-drop result as inconclusive and retain the deterministic silent-consumer simulation as the proof for P0.

## Live Channel acknowledgement

While Claude is active, send a unique Codex sentinel. The Channel body and metadata expose the immutable delivery ID and direct Claude to call `ack_messages`. Claude must acknowledge without first discovering the ID through `get_messages`. A later poll must not return that sentinel.

## Restart boundaries

Leave a message unacknowledged and test each boundary separately:

- Restart only the daemon, retaining the same Claude adapter process: the adapter mailbox remains.
- Reconnect Codex, retaining the same Claude adapter: completed replies already in the mailbox remain.
- Reconnect the Claude Channel through the same adapter process: the mailbox remains.
- Exit and relaunch the Claude plugin/adapter process: the mailbox is lost. This demonstrates that P2 is not implemented.

Do not infer crash durability from a daemon-only restart because the authoritative mailbox lives in the Claude adapter process.

## Cleanup

Exit Codex and Claude, then stop and remove only the disposable pair:

```bash
AGENTBRIDGE_SAFE=1 bun dist/cli.js --pair issue223 kill
bun dist/cli.js pairs rm issue223
```

Remove any local development marketplace/plugin registration only if this test created it and no previous AgentBridge installation needs to be restored.
