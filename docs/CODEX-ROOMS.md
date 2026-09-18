# Codex remote rooms

Recommended CLI versions for this release: **Claude Code 2.1.269** and **Codex 0.154.0** (latest stable npm releases checked on 2026-09-12). Two Linux machines also passed native Codex message/ACK exchange, busy-turn queuing and daemon/session recovery with **Codex 0.153.4**. Keep the toolchain version used for builds separate from these CLI recommendations: AgentBridge's release bundles use Bun 1.3.11.

From the project directory, log in with a broker-issued token and associate the directory with a room:

```powershell
abg auth login --token <broker-issued-token>
abg join tas --broker-url ws://<broker-host>:8087/ws
abg codex --safe --new
```

`join` saves a directory mapping. The broker verifies membership when connected; it does not grant membership merely because `join` prints a mapping. A pair name is a local instance name, not a remote room name. The Codex TUI connects to a local proxy; that daemon connects to the remote broker.

Upgrade the broker and participating daemons together to 0.1.31. Offline messages are replayed only after an authorized subscription to their room; logging in or subscribing to another room does not consume them. Directed completion notices are excluded from the room's public whiteboard.

Use `--new` once after upgrading: old threads created without the dynamic room tools cannot acquire them through `thread/resume`. New room-enabled threads retain the tools when resumed from the same pair, including after daemon restart. This requires a Codex app-server supporting experimental `dynamicTools` and `item/tool/call`. The original PR validated 0.154.0-alpha.6.2; release validation passed cross-machine tests on 0.153.4 and the live room-tool smoke test on stable 0.154.0.

Ask Codex to use `agentbridge_room_members` to inspect the room. The list includes offline members. Ask it to use `agentbridge_room_say` to send a message authorized by you. `to` contains exact member IDs for a private message; omit `to` to broadcast. Submission is not a recipient acknowledgement. Unlike the existing Claude tool's `to` mention parameter, the Codex tool's `to` is private routing.

Incoming chat and task-completed notices are queued while Codex is busy or a local turn is starting, then injected into an idle connected TUI session. The bounded inbox holds 100 notices and submits up to 10 consecutive entries with the same trust status per turn, preserving arrival order. An explicitly rejected injection is retried once after a delay, retaining each entry's trust status. The inbox is in memory and does not promise durable end-to-end delivery. Ordinary Codex output is not automatically published to the room or forwarded to the local Claude from a room-message turn, including trusted turns. If local Claude explicitly steers that turn, or the user adds input from the TUI, subsequent replies follow normal local routing after Codex accepts the request. Claude's `require_reply` rules still apply; a rejected request does not enable forwarding.

By default, all room members' `chat` messages are treated as local-user instructions. This mode is intended for collaboration among trusted colleagues in the same team. Chat messages start with `✅[房间成员指令]`, and Codex uses `agentbridge_room_say` when a reply is needed. Any member's chat can cause your agent to perform operations: share rooms only with colleagues you trust, and keep broker tokens secret. Task-completed events, join/leave events and whiteboard snapshots always remain `📨` notices in both modes, including for locally trusted members.

This upgrade changes the default room behavior. In projects already initialized with `abg init`, run `abg init` again to update the room rules in `CLAUDE.md`/`AGENTS.md` for both modes; stop any running daemon with `abg kill` before restarting so the launch settings take effect.

To restrict room instructions, start with `abg codex --room-untrusted` or `abg claude --room-untrusted`, or set `AGENTBRIDGE_ROOM_UNTRUSTED=1` in the launch environment. The setting applies to a newly started daemon. If a daemon is already running, first run `abg kill`, then start it with the desired setting. In restricted mode, only chat messages from members on the local trust list are treated as instructions; other members' chat retains the external-untrusted security preamble and prohibition on automatic replies.

In restricted mode, the local operator manages trusted senders for each room with:

```powershell
abg room trust <roomId> <agentId>
abg room trusted [roomId]
abg room untrust <roomId> <agentId>
```

Use the exact member ID from `agentbridge_room_members`. The list is matched against the broker-authenticated `from.agentId`, never a display name or a claim in message text. Its instruction authority applies only to `chat`. In default mode, removing an entry from the trust list leaves that member's chat eligible as instructions; enable restricted mode to enforce the list.

The trust list is stored only on this machine in `<collab directory>/room-trust.json` with file mode `0600`; it is not sent to the broker and does not grant room membership. In restricted mode, list changes take effect for subsequent arrivals without restarting the daemon. Entries already in the Codex inbox, including retries, retain the trust status assigned when received. Manage the list separately on each machine using restricted mode.

On Windows the launcher resolves a native `codex.exe` from PATH or an installed npm Codex package. If necessary, set `AGENTBRIDGE_CODEX_BIN` to the full native executable path in the terminal before launch. PowerShell `.ps1` and `.cmd` wrappers are not spawned as native executables.

Validation:

```powershell
bun run typecheck
bun test src/unit-test/codex-room.test.ts src/unit-test/codex-room-adapter.test.ts src/unit-test/codex-command.test.ts src/integration-test/codex-room-tools.test.ts
# Optional: uses your authenticated Codex model, but only a temporary local broker/test identities.
bun scripts/smoke-codex-room.ts
```
