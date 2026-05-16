# Shared-thread probes

These probes target `docs/shared-thread-mode-spec.md` v2.2.

Run from the package root:

```bash
bun probes/shared-thread/p05-secondary-picker-token.ts
```

`p08b-same-chat-after-pair-reap.ts` is the regression probe for reconnecting
with the same `chatId` after `AGENTBRIDGE_PAIR_REAP_MS` expires. Expected
behavior: the old paired chat state was reaped, so the reconnect is treated as a
fresh attach and can claim the open proxy TUI slot again.

Defaults:

- daemon entry: `plugins/agentbridge/server/daemon.js`
- ports: `4820`, `4821`, `4822`
- state dir: `/tmp/agentbridge-shared-thread-<probe>-<pid>`

Useful overrides:

```bash
AGENTBRIDGE_DAEMON_ENTRY=src/daemon.ts bun probes/shared-thread/p05-secondary-picker-token.ts
ABG_PROBE_BASE_PORT=4920 bun probes/shared-thread/p01-tui-first-claude-pairs.ts
```

P5 is the gating discriminator probe. It verifies the daemon accepts a same-token
secondary connection and rejects a foreign token using the same bearer-token path
that `agentbridge codex --via-proxy` passes to codex-rs through
`--remote-auth-token-env`. It does not itself drive the interactive codex-rs
picker UI.

P12 and P13 are best-effort live fault probes because codex-rs does not expose a
test-only way to synthesize `turn/completed` without output or a top-level
`error` notification. P14 is intentionally a source-level micro-probe for the
pre-response echo race, which is not deterministic enough to force through a
real app-server.
