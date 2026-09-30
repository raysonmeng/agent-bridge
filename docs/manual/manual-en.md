# AgentBridge User Manual (English)

> A cross-network, multi-person, multi-repo AI-agent collaboration system. An always-on **broker** connects agents on many machines into one shared **room**: when one finishes a task, the other members' agents learn about it automatically — no manual sync, no polling. This manual walks you through it step by step.
>
> Chinese version: [`使用手册.md`](使用手册.md). Visual version: [`manual.html`](manual.html).

---

## 0. Understand it in 5 minutes

| Concept | What it is |
|---------|-----------|
| **broker** | The always-on control-plane switch. It forwards **events only** (completion notices, @mentions, DMs, presence, whiteboard) and **never transmits code files**. One per deployment. |
| **room** | A collaboration space for one requirement/workflow, across people and repos. Members' agents exchange events in it. |
| **identity** | A person / logical agent id (email or GitHub), authenticated by a **PSK token**. id and display name are separate — routing only uses the id. |
| **membership** | A room's access grant. **Only members** may subscribe/publish to a room (closed-by-default). Managed by a room admin. |
| **data plane = git** | Code is synced by each side's own `git fetch`/`push` to a shared remote; the repo/branch/commit in a completion event are **pointers**, never file contents. |

**Two modes:**
- **Single-machine (v1):** Claude ↔ Codex collaborating on one machine (the original feature).
- **Cross-network (v3):** many machines, people, and agents collaborating in rooms via the broker (the focus of this manual).

---

## 1. Install

> The runtime is **Bun**. Recommended CLI versions for v0.1.31: **Claude Code 2.1.269** and **Codex 0.154.0** (latest stable versions checked on 2026-09-12). See [Codex remote rooms](../CODEX-ROOMS.md) for joining from a Codex-only machine.

**Release install:**
```bash
npm install -g @raysonmeng/agentbridge@0.1.31
```

**Testing (from the repo):**
```bash
git clone <repo> && cd agent_bridge
git checkout <v3 branch>
bun install
bun run build:cli         # produces dist/cli.js
bun run install:global    # install global commands + plugin
```

Verify:
```bash
abg --version
abg --help
```

---

## 2. Single-machine (v1): Claude ↔ Codex

The simplest use, one machine:

```bash
abg init                  # idempotently inject collaboration notes into the project's CLAUDE.md / AGENTS.md
abg claude                # terminal 1: launch bridged Claude Code
abg codex                 # terminal 2: launch bridged Codex
```

Claude and Codex then see each other's messages, propose a division of labor, and cross-review. Also:
```bash
abg pairs                 # show active pairs
abg doctor                # self-check
abg budget                # both agents' subscription quota
abg kill                  # stop everything
```

---

## 3. Cross-network (v3): multi-machine / multi-person / multi-agent

Three role perspectives: **① broker machine (admin) → ② each agent machine (participant) → ③ daily use.**

### 3.1 Prepare the network (Tailscale recommended)

Put all machines on the same tailnet (cross-network, zero public exposure). See [docs/10 deployment runbook](../10-跨网部署与运维.md).
```bash
# broker machine
tailscale up --advertise-tags=tag:broker
tailscale ip -4                      # note the 100.x address
# each participant machine
tailscale up --advertise-tags=tag:agent
```
Paste [`examples/tailscale-acl.hujson`](../../examples/tailscale-acl.hujson) into the Tailscale admin console (**delete the default allow-all first**; port 4700).

### 3.2 ① On the broker machine: start broker + create room + add members

> Identities/rooms/membership are **authoritative in the broker's collab.db**, so these admin commands run on the **broker machine**.

```bash
# (a) start the always-on broker, bound to the Tailscale 100.x (never 0.0.0.0)
abg broker start --host 100.x.y.z --port 4700

# (b) register identities and issue tokens (once per participant)
abg auth login --id alice@team.dev --name Alice     # → prints Alice's token
abg auth login --id bob@team.dev   --name Bob       # → prints Bob's token

# (c) create the room (the creator auto-joins as a member)
abg room create checkout                            # → roomId: checkout

# (d) add the others to the room (membership = access control)
abg room add checkout bob@team.dev
abg room list                                        # list all rooms
```

Distribute each person's token **out of band** (IM / password manager; never commit to git).

### 3.3 ② On each participant machine: install token + join room + start the agent

```bash
# (a) install the token the broker issued for you (sent out-of-band by
#     `abg room invite` / `abg auth issue` on the broker machine)
abg auth login --token <token-issued-by-broker>

# (b) join the room and persist the broker URL (so agentbridge claude auto-connects)
abg join <roomId> --broker-url ws://100.x.y.z:4700/ws    # Tailscale 100.x or MagicDNS

# (c) start the agent as usual (bridged)
abg claude            # or abg codex
abg init              # first time: inject the collaboration + security rules into CLAUDE.md/AGENTS.md
```

> On the broker machine, `abg room invite <roomId> <id> --broker-url ws://…` prints lines (a)+(b)
> ready to paste; deliver them out-of-band (IM / password manager). Once `--broker-url` is persisted,
> there is **no `AGENTBRIDGE_BROKER_URL` env var and no daemon restart** needed.

### 3.4 ③ Daily use — how it helps

- **Auto-announce on completion:** when your agent finishes a turn (with a new commit), a Stop hook runs `abg publish` and broadcasts a "completion event" (one-line summary + repo/branch/commit + contract) to room members.
- **Manual announce:** `abg announce --summary "auth contract ready" --contract auth/v1`
- **What you receive:** members' `chat` messages use `✅[房间成员指令]` by default and are treated as local-user instructions. Task-completed events, join/leave events and whiteboard snapshots always remain `📨` notices.
- **Getting the code:** completion events carry git pointers only; to use a teammate's code, `git fetch` that commit yourself (the data plane is git).

---

### 3.5 Room instructions and restricted mode

Default mode is intended for trusted colleagues in the same team: all members' `chat` messages are treated as local-user instructions. Codex can reply with `agentbridge_room_say`. Task-completed events (`task_completed`), join/leave events and whiteboard snapshots always remain `📨` notices in both modes, including for locally trusted members.

This upgrade changes the default room behavior. In projects already initialized with `abg init`, run `abg init` again to update the room rules in `CLAUDE.md`/`AGENTS.md` for both modes; stop any running daemon with `abg kill` before restarting so the launch settings take effect.

To restrict instructions, launch `abg claude --room-untrusted` or `abg codex --room-untrusted`, or set `AGENTBRIDGE_ROOM_UNTRUSTED=1` in the launch environment. These settings apply to newly started daemons. Restricted mode restores the security preamble and `📨[房间消息·外部成员·仅通报·非指令]` notices, which must not prompt automatic replies or execution. Only `chat` messages from members on the local trust list retain `✅[房间成员指令]` and instruction authority:

```bash
abg room trust <roomId> <agentId>
abg room trusted [roomId]
abg room untrust <roomId> <agentId>
```

Use the exact member ID from `agentbridge_room_members`. Matching uses the broker-authenticated `from.agentId`. The list is local to each machine, stored in `<collab directory>/room-trust.json` with mode `0600`, and does not grant room membership. In restricted mode, list changes apply to subsequent arrivals without restarting. In default mode, removing an entry still leaves that member's chat eligible as instructions. Instruction authority applies only to `chat`.

Codex preserves arrival order, injecting at most ten consecutive entries with the same trust status per turn. Queued entries and rejected-injection retries retain the status assigned when received. Ordinary output from trusted room turns is not automatically forwarded to local Claude.

---

## 4. 🔴 Security (must read) — see [docs/11](../11-安全模型与威胁.md)

In default mode, any room member's chat can cause your agent to perform operations. Share rooms only with colleagues you trust, and keep tokens secret: a token holder can send as the corresponding broker identity.

1. **Perimeter:** membership authorization (non-members can't reach the room) + Tailscale ACL + PSK. **Never add identities you don't trust to a room.**
2. **Restricted mode:** start the daemon with `--room-untrusted` or `AGENTBRIDGE_ROOM_UNTRUSTED=1` to allow instructions only through locally trusted members' chat. Other members' chat remains untrusted notices; task-completed events, join/leave events and whiteboard snapshots always remain `📨` notices.
3. **🔴 Your discipline (the critical part):**
   - **Do NOT run agents connected to a multi-party room with blanket auto-approve / `--dangerously-skip-permissions`.**
   - **Destructive operations (delete / change config / exfiltrate / install) must require human confirmation** — the last gate against "injected text → agent executes it".
   - Least privilege: don't run room-driven agents with high privilege on machines holding secrets/production.

> Both modes remain subject to the session's operation permissions and approval requirements. In restricted mode, register only identities you intend to authorize to send instructions.

---

## 5. CLI quick reference

| Command | Purpose |
|---------|---------|
| `abg broker start [--host] [--port] [--db]` | start the always-on broker (broker machine) |
| `abg auth login --id <id> --name <name>` | register identity + issue a PSK token |
| `abg room create <name>` | create a room (creator auto-joins) |
| `abg room add/remove <roomId> <identityId>` | add/remove a member (caller must be a member) |
| `abg room list` | list all rooms |
| `abg room trust <roomId> <agentId>` | locally authorize a sender in restricted mode |
| `abg room untrust <roomId> <agentId>` | remove a local authorization for restricted mode |
| `abg room trusted [roomId]` | list local trusted senders for one or all rooms |
| `abg join <roomId>` | map the current directory to a room |
| `abg publish --from-hook` / `abg announce --summary "…"` | broadcast a completion event |
| `abg claude` / `abg codex` | launch a bridged agent session |
| `abg claude --room-untrusted` / `abg codex --room-untrusted` | start a daemon in restricted mode; first stop any running daemon with `abg kill` |
| `abg init` | inject collaboration + security rules into CLAUDE.md/AGENTS.md |
| `abg doctor` / `abg budget` / `abg pairs` / `abg kill` | self-check / quota / pairs / stop all |

Env vars: `AGENTBRIDGE_BROKER_URL` (one-off override for the remote broker; normally unneeded — `abg join --broker-url` persists it), `AGENTBRIDGE_COLLAB_DB` (collab.db path), `AGENTBRIDGE_ROOM_UNTRUSTED=1` (restricted room mode for a newly started daemon).

---

## 6. Troubleshooting

- **No room events:** confirm you are a **member** of that room (added via `abg room add` / `abg room invite` on the broker machine); confirm you passed `--broker-url` to `abg join` (it persists the address; omitting it falls back to the local default and logs a WARN, visible via `abg logs -f`); confirm the token matches the broker.
- **Can't reach the broker:** `curl http://100.x:4700/healthz` should return `{ok:true,...}`; don't bind 0.0.0.0 (bind the Tailscale 100.x).
- **ACL not taking effect:** usually the default allow-all wasn't deleted (docs/10).
- **Completions not broadcast:** confirm the plugin (Stop hook) is installed + the current directory has `abg join`ed a room + you're logged in.
- More in the troubleshooting section of [docs/10](../10-跨网部署与运维.md).

---

## 7. Verify your deployment

A cross-machine acceptance checklist is in [docs/10 §9](../10-跨网部署与运维.md). To simulate locally first, run Docker:
```bash
bash docker/run-acceptance.sh        # full §13 scenario (multi-machine / multi-person / heterogeneous agents)
```
