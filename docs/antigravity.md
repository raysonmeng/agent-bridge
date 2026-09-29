# Explicit AgentBridge messaging (local routing v2)

Claude, Codex and agy decide whether they are communicating and explicitly name
both the recipient and (for a reply) the original message. The daemon validates
and delivers; it does not collect ordinary model answers or guess recipients.

```text
Agent explicitly calls send(to, text) or reply(to, in_reply_to, text)
    -> sender validation -> authenticated daemon -> exact native session
```

Normal conversation, progress text, thoughts and tool output are not business
messages. The Codex proxy can still relay native protocol traffic to its own UI;
that traffic is not captured in the daemon's chat inbox or forwarded to peers.
Registration, heartbeats, status and delivery ACKs remain control-plane traffic.

## Start

In the same project directory, open three terminals using the same pair:

```sh
abg --pair chat claude
abg --pair chat codex --new
abg --pair chat agy
```

`abg agy` preserves the native UI and defaults to `--dangerously-skip-permissions`,
automatically approving tool permission requests. Use `abg agy --safe` or
`AGENTBRIDGE_SAFE=1` to avoid adding this default and retain native approval rules;
explicit native `--mode` or `--sandbox` also suppresses the default. An explicitly
supplied skip-permissions flag remains your choice even with `--safe`.
In safe mode, approve its one-time persistent `agy attach` command.
That adapter enables inbound delivery through
the native agentapi, but does not read transcripts or harvest replies.

The previously installed AgentBridge native Stop plugin is disabled. Its cached
`agy-hook` entrypoint remains an inert compatibility stub: it returns normally,
without parsing transcripts or contacting daemon. Unrelated plugins are untouched.

Native runtime credentials remain isolated in the adapter, not in shared daemon
or Codex child environments. Each agy session has an independent slot.

## Explicit new messages

```sh
abg --pair chat chat --list
abg --pair chat chat --from agy --to codex --message 'Please check this change.'
```

Claude uses `reply(text=..., to="agy:<session-id>")`. Codex uses
`agentbridge_local_send(text=..., to="agy:<session-id>")`. Despite the historical
Claude tool name, omitting `in_reply_to` means a new request. The recipient is
required before the client sends a business envelope.

## Explicit replies

Incoming messages display `from`, `to` and `message_id`. To reply:

```sh
abg --pair chat chat --from agy --to codex \
  --reply-to '<original-message-id>' --message 'Here is my answer.'
```

Claude/Codex tools use both `to` and `in_reply_to`. Daemon requires the original
request to have been sent to this reply author and originated from this exact
recipient. Missing, ambiguous, expired or mismatched metadata is an error; the
body is neither forwarded nor retained as an unmatched message. A normal answer
printed in any native UI is not an implicit reply.

Replies carry the original `in_reply_to` to the receiver. They do not create a
new return route; no automatic acknowledgement loop is formed. An explicit reply
association is consumed once, including when delivery becomes unconfirmed;
there is no automatic retry that could duplicate instructions.

`agy` is only an alias when exactly one native session is attached. Otherwise
use `agy:<conversation-id>`. A native agy terminal tool derives its exact sender
ID. CLI `--from` is an authenticated local operator's label, not a remote identity.
Inside an agy session (`ANTIGRAVITY_CONVERSATION_ID` present) `abg chat` pins the sender to that exact session
and refuses `--from user|claude|codex` or another agy ID. Outside a native session, any process that holds this
pair's control token acts as the local operator; that same-user trust boundary is not a sandbox.
There is no `user` delivery endpoint: user-originated requests can be answered
locally in the native UI; do not invent a peer address for the human.

## Observation and lifecycle

### Local members joining

Daemon collects an online profile (`id`, `sessionId`, `name`, `model`,
`modelSource`) after an agent is admitted, and sends a membership notice to all
other currently connected local agents. Multiple agy sessions remain distinct.
These are control notices, not requests: no automatic reply, reply association
or business inbox record is created. Same-session reconnects within 30 seconds
are deduplicated; disconnects remove the online profile. A failed transport is
not automatically retried. Codex notices wait for idle/budget eligibility.

`abg --pair chat chat --list` includes online profiles under `agents`; its older
`members` array remains a list of addressable routes, not an online guarantee.
Codex's model is taken from its successful native thread start/resume response
(`modelSource: runtime`). Claude and agy pass explicit `--agent` / `--model`
launch selections (Claude also supports `ANTHROPIC_MODEL`), labelled
`modelSource: configured`, not a runtime-confirmed model. Without a known model,
the profile says `model: null, modelSource: unknown`; no default is guessed and
no transcript, credential file or ordinary assistant output is collected.

`abg --pair chat chat --inbox` is retained as a compatibility command showing
only the latest 100 explicit reply delivery attempts, not personal conversation.
`forwarded` means accepted by the destination transport, not read by its model.
Unknown/ordinary replies are no longer stored. Pending correlation metadata is
bounded to 256 requests / ten minutes. There is no durable offline mailbox.

Native submissions have a bounded timeout and are not automatically retried.
Codex delivery waits for a safe idle turn and budget gates. After sending, yield
rather than keeping the originating model turn busy waiting for a queued reply.

Routing v2 is deliberately incompatible with old implicit routing. New clients
refuse older daemons; old automatic hook uploads and old agy adapters are rejected
by the new daemon. Existing running daemons are not hot-patched: restart a selected
pair when safe or use a fresh pair. Existing Codex threads may use CLI commands;
new dynamic tools require a new thread. No account/chats/config deletion is needed.

Legacy implicit partner forwarding and Codex-specific `on_busy`, `require_reply`,
`wrap_up`, and `idempotency_key` are not part of this local messaging API. They
are rejected rather than silently reinterpreted. Budget and permission checks
remain in force. Remote room/broker protocol is not migrated in this change.
