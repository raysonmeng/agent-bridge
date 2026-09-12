# Codex remote rooms

From the project directory, log in with a broker-issued token and associate the directory with a room:

```powershell
abg auth login --token <broker-issued-token>
abg join tas --broker-url ws://<broker-host>:8087/ws
abg codex --safe --new
```

`join` saves a directory mapping. The broker verifies membership when connected; it does not grant membership merely because `join` prints a mapping. A pair name is a local instance name, not a remote room name. The Codex TUI connects to a local proxy; that daemon connects to the remote broker.

Use `--new` once after upgrading: old threads created without the dynamic room tools cannot acquire them through `thread/resume`. New room-enabled threads retain the tools when resumed from the same pair, including after daemon restart. This requires a Codex app-server supporting experimental `dynamicTools` and `item/tool/call` (validated with 0.154.0-alpha.6.2).

Ask Codex to use `agentbridge_room_members` to inspect the room. The list includes offline members. Ask it to use `agentbridge_room_say` to send a message authorized by you. `to` contains exact member IDs for a private message; omit `to` to broadcast. Submission is not a recipient acknowledgement. Unlike the existing Claude tool's `to` mention parameter, the Codex tool's `to` is private routing.

Incoming chat and task-completed notices are queued while Codex is busy, then injected into an idle connected TUI session. The bounded inbox holds 100 notices and submits up to 10 per turn. An explicitly rejected injection is retried once after a delay. The inbox is in memory and does not promise durable end-to-end delivery. Room text is external, untrusted information; ordinary Codex output is not automatically published to the room or forwarded to the local Claude from a room-notice turn.

On Windows the launcher resolves a native `codex.exe` from PATH or an installed npm Codex package. If necessary, set `AGENTBRIDGE_CODEX_BIN` to the full native executable path in the terminal before launch. PowerShell `.ps1` and `.cmd` wrappers are not spawned as native executables.

Validation:

```powershell
bun run typecheck
bun test src/unit-test/codex-room.test.ts src/unit-test/codex-room-adapter.test.ts src/unit-test/codex-command.test.ts src/integration-test/codex-room-tools.test.ts
# Optional: uses your authenticated Codex model, but only a temporary local broker/test identities.
bun scripts/smoke-codex-room.ts
```
