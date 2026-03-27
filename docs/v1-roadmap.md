# AgentBridge v1 Roadmap

## 1. Current v1.0 State

AgentBridge v1.0 already provides a working local bridge between Claude Code and Codex in the same workspace.

Current capabilities:

- A persistent local daemon process that can survive Claude restarts.
- Automatic daemon startup and reuse from the Claude-side bridge.
- A Codex app-server proxy and TUI attach flow.
- Bidirectional message flow between Claude and Codex through the `reply` tool.
- Basic readiness, disconnect, reconnect, and status notifications.
- Buffered delivery of Codex messages while Claude is temporarily disconnected.

Current architectural limits:

- Only `agentMessage` items are forwarded today.
- The bridge assumes one active Codex thread.
- The bridge assumes one Claude foreground connection.
- A newer Claude connection replaces the older one.

## 2. v1 Optimization Goals

The goal of the v1 roadmap is to improve day-to-day usability without introducing the larger architectural refactor planned for v2.

Guiding principles:

- Improve the single-Claude, single-Codex path rather than redesigning the system.
- Prioritize visible user experience gains over architectural ambition.
- Reduce noise, improve turn discipline, and add clearer collaboration modes.
- Keep changes small enough to ship incrementally and validate quickly.
- Avoid pulling v2 or later multi-agent infrastructure into v1.

In short, v1 should make the bridge feel smoother every day, while v2 remains the milestone for deeper architectural change.

## Status Update (March 2026)

The current codebase has now shipped most of the v1 roadmap ideas in concrete form.

Notable shipped status:

- marker-aware filtering, buffering, and summaries are implemented
- turn coordination and busy-guard behavior are implemented
- role-aware collaboration guidance is implemented
- dual-mode Claude delivery (`push` and `pull`) is implemented
- Phase 3, the CLI/distribution milestone, is complete

For the concrete Phase 3 outcome, see [docs/phase3-spec.md](phase3-spec.md). The rest of this roadmap is still useful as design rationale, but §6 below should now be read as implemented product status rather than a future recommendation.

## 3. v1.1 Smart Message Filtering

### Problem

The current bridge forwards every `agentMessage` as-is. In practice, many of those messages are low-value status confirmations, repeated log-reading chatter, or intermediate exchanges that clutter the Claude-side experience.

### Proposed improvement

Use a prompt-led filtering strategy rather than a heavy bridge-side rule engine. The v1.1 design is:

**Prompt Contract + Marker Protocol + Lightweight Bridge Filter**

This approach keeps the implementation small while using the agent itself to decide what is worth forwarding across the bridge.

#### A. Codex-side Bridge Messaging Contract

Codex should be instructed to use `agentMessage` only for high-value communication that is genuinely useful to Claude. Intermediate reasoning, repeated status confirmations, and low-value progress chatter should be kept internal whenever possible.

Codex should also be instructed to mark outbound bridge messages with one of the following markers:

| Marker | Bridge behavior |
|--------|-----------------|
| `[IMPORTANT]` | Forward immediately |
| `[STATUS]` | Buffer and summarize |
| `[FYI]` | Drop by default |
| `untagged` | Forward by default |

Within this contract, `[STATUS]` should also carry concise intermediate progress summaries when ongoing work is worth surfacing. Instead of having the bridge reconstruct low-level event streams, Codex should summarize meaningful intermediate activity directly inside `[STATUS]` messages.

The same contract may also treat prefixes such as `@codex:` and `@claude:` as lightweight intent markers. In v1 they remain conventions rather than a full routing capability, but they still make the intended target more explicit.

#### B. Claude-side Channel Instructions

Claude-side channel instructions should explain how to interpret the marker protocol:

- `[IMPORTANT]` means the message needs attention, decision-making, review, or a meaningful response.
- `[STATUS]` means the message is progress context and does not always require an immediate reply.
- `[FYI]` means the message is background context that can usually be treated lightly.

This keeps both sides aligned on what counts as high-value bridge traffic.

#### C. Bridge-side Marker-Aware Filtering

The bridge still provides lightweight enforcement and summary behavior, but it does not try to outsmart the agent with a large rule engine.

- `[IMPORTANT]` messages are forwarded immediately.
- `[STATUS]` messages are buffered and later emitted as a summary.
- `[FYI]` messages are dropped by default.
- Untagged messages are forwarded by default for safety and backward compatibility.

Summary buffers should flush under these conditions:

1. The buffered `STATUS` count reaches a configured threshold.
2. A time window expires without a summary having been emitted.
3. A new `[IMPORTANT]` message arrives and should be preceded by the pending summary.
4. The current turn completes.
5. Claude reconnects or another bridge lifecycle event makes it useful to flush pending context.

The bridge should expose two modes:

- `filtered` (default)
- `full`

Advantages of this approach:

1. It requires much less code than a large bridge-side classifier.
2. It lets the agent use context awareness rather than shallow local rules.
3. It preserves a simple fallback path because untagged messages still forward by default.
4. It creates a lightweight convention that can evolve into stronger semantics in later versions.

Known limitations:

1. Prompt guidance is a soft constraint, not a hard guarantee.
2. Codex may occasionally mislabel a message or omit a marker.
3. The bridge still needs a lightweight fallback path for imperfect adherence.

### Implementation scope

- Add a Codex-side bridge messaging contract through injected instructions or reminders.
- Update Claude-side channel instructions to explain marker meaning and handling.
- Add marker-aware bridge filtering with buffered summary flush behavior.
- Ship `filtered` as the default mode while preserving a `full` mode for debugging or raw inspection.
- Keep the implementation local to the current single-bridge path rather than introducing a broader policy system.

### Expected user impact

- Claude sessions become noticeably less noisy by default.
- Important collaboration messages stand out more clearly.
- Progress remains visible through summaries instead of raw chatter.
- Users get a better bridge experience without needing a larger architectural migration first.

## 4. v1.2 Turn-Based Coordination

### Problem

The current bridge can detect when Codex is already in an active turn, but it does not enforce strong coordination. This can lead to replies arriving at awkward times or multiple actions being pushed into a workflow that is effectively serial.

### Proposed improvement

Use a lightweight bidirectional coordination strategy instead of introducing a queue-heavy bridge scheduler. The v1.2 design is:

**Bidirectional Coordination via Hard Turn Signals + Soft Attention Window**

This design treats coordination as a two-way collaboration problem rather than only blocking Claude-to-Codex interruptions. It introduces a shared coordination concept while keeping the implementation intentionally asymmetric and small.

#### A. Unified coordination concept

Conceptually, each agent has a visible collaboration state such as `busy`, `ready`, or `attention-window`. In v1 this idea is only partially implemented:

- Codex has a hard turn signal because the bridge can detect turn start and completion.
- Claude does not expose an equivalent hard turn signal, so Claude-side coordination must use a soft attention model instead.

This shared concept leaves room for richer multi-agent coordination later without building a generalized coordinator now.

#### B. Codex -> Claude via marker filtering and attention window

The Codex-to-Claude side should continue to rely on the v1.1 marker contract:

- `[IMPORTANT]` may interrupt and forward immediately.
- `[STATUS]` should usually be buffered and summarized.
- `[FYI]` should usually be dropped.

After Codex emits a high-value completion or milestone message, the bridge should give Claude a short attention window. During that window, low-priority Codex progress updates should not keep interrupting Claude:

- `[IMPORTANT]` still forwards.
- `[STATUS]` is buffered instead of pushed immediately.
- `[FYI]` remains low priority or dropped.

This gives Claude room to read, think, and respond without pretending that the bridge can truly detect Claude's internal reasoning state.

#### C. Claude -> Codex via turn status notifications, wait behavior, and busy reject

When Codex starts a turn, the bridge should notify Claude that Codex is busy. When the turn completes, the bridge should notify Claude that Codex is ready again.

Claude-side instructions should explain that during the busy period, Claude should avoid calling the `reply` tool and instead wait for the completion notification. If Claude still tries to reply during an active Codex turn, the bridge should return a minimal busy response instead of silently injecting overlapping work.

Advantages of this approach:

1. It treats coordination as a two-way problem instead of only blocking one direction.
2. It keeps coordination visible to the user instead of hiding it inside a queue.
3. It uses hard Codex turn signals where available and soft attention handling where hard signals do not exist.
4. It stays aligned with the v1 principle of improving experience without architectural redesign.

Known limitations:

1. Claude attention is inferred through a soft window rather than detected as a true turn state.
2. Claude instructions remain a soft constraint and may not always be followed perfectly.
3. This design leaves room for future multi-agent coordination, but it does not implement a generalized coordinator in v1.

Why this version does not introduce message queues:

- A queue adds more state, ordering rules, and edge cases than v1 needs.
- Queue semantics quickly push the design toward a generalized coordination framework.
- For v1, visible status, marker-aware buffering, and minimal reject behavior are a better fit than hidden deferred execution.

### Implementation scope

- Surface Codex turn start and completion as Claude-visible bridge notifications.
- Update Claude-side channel instructions so Claude waits during the busy period.
- Add a short Claude attention window after Codex emits a high-value completion or milestone message.
- Buffer low-priority Codex `STATUS` messages during that attention window.
- Add a minimal busy guard on the existing reply path.
- Reuse existing turn lifecycle and marker signals rather than introducing a queue, scheduler, or generalized coordination framework.

### Expected user impact

- Coordination becomes visibly bidirectional rather than feeling one-sided.
- Claude gets space to respond after important Codex updates without being drowned in follow-up chatter.
- Claude can respond to the user more naturally when Codex is still working.
- Collaboration rhythm becomes more predictable without introducing heavy scheduling machinery.

## 5. v1.3 Role-Aware Collaboration

### Problem

The current bridge provides transport, but not much collaboration structure. Claude and Codex can talk to each other, but they do not yet have a consistent default division of roles or a lightweight way to coordinate how they think through a problem together.

### Proposed improvement

Introduce role-aware collaboration as:

**Role Contract + Thinking Patterns**

This keeps the collaboration model lightweight while giving the agents a more intentional way to divide labor and reason together.

In v1, these patterns are applied to the current single-Claude, single-Codex bridge path. Conceptually, they can extend to future multi-agent collaboration, but v1 does not claim to implement that broader topology.

#### A. Role Contract

The bridge should establish a default role contract:

- Claude defaults toward reviewer, planner, and debugger or hypothesis challenger behavior.
- Codex defaults toward implementer, executor, and reproducer or verifier behavior.

This defines who tends to do what, without hard-locking either side into a rigid hierarchy.

#### B. Thinking Patterns

The bridge should also support lightweight collaboration thinking patterns. These are not heavy workflow modes. They are prompt-level patterns that shape how Claude and Codex work through a task together.

Recommended built-in patterns:

1. **Independent Analysis and Convergence**
   Participants first form independent views, then compare conclusions, identify agreement, challenge disagreement, and converge or explicitly record remaining disagreement.

2. **Architect -> Builder -> Critic**
   Participants distribute roles across framing, building, and critique. One participant may frame the plan, constraints, and acceptance criteria, another may build, and another may return as critic or verifier to close the loop.

3. **Hypothesis -> Experiment -> Interpretation**
   Participants divide the work across hypothesis generation, experimentation, and interpretation, then update their conclusions based on the result.

#### C. Explicit Collaboration Language

The bridge contract should encourage explicit sentence forms instead of adding more marker syntax. For analytical collaboration, the agents should be encouraged to say things such as:

- `My independent view is: ...`
- `I agree on: ...`
- `I disagree on: ...`
- `I am persuaded because: ...`
- `Current consensus: ...`

This keeps the collaboration readable without introducing a heavier protocol layer.

#### D. Task-Driven Pattern Selection

Different task types should bias different default thinking patterns:

- analytical and review tasks favor **Independent Analysis and Convergence**
- implementation tasks favor **Architect -> Builder -> Critic**
- debugging tasks favor **Hypothesis -> Experiment -> Interpretation**

This preserves flexibility without requiring the user to constantly switch explicit modes.

### Implementation scope

- Establish a default role contract between Claude and Codex.
- Add lightweight thinking-pattern guidance through bridge contract and channel instructions.
- Encourage explicit collaboration phrasing rather than introducing new marker syntax.
- Let task type bias which pattern is used by default.
- Keep the implementation inside the existing single-bridge path rather than introducing a workflow engine or generalized policy layer.

### Expected user impact

- Users get clearer default collaboration behavior with less manual setup.
- Analytical tasks benefit from more independent reasoning and more explicit convergence.
- Implementation and debugging flows feel more intentional and less ad hoc.
- The bridge feels more structured without becoming a workflow engine.

## 6. Distribution and CLI Status

Phase 3 shipped the v1 distribution milestone as a local CLI-first workflow.

The product shape that actually landed is:

- a repository-local `agentbridge` CLI exposed through the package `bin`
- a plugin-oriented Claude integration path
- a persistent daemon reused across Claude restarts
- project config generation plus machine-local runtime state management

### What shipped

The current command set is:

- `agentbridge init`
- `agentbridge dev`
- `agentbridge claude`
- `agentbridge codex`
- `agentbridge kill`

What those commands do in practice:

- `init`
  - checks `bun`, `claude`, and `codex`
  - enforces the minimum Claude version
  - creates `.agentbridge/config.json`
  - creates `.agentbridge/collaboration.md`
  - attempts plugin installation as a best-effort step
- `dev`
  - developer-only local marketplace and plugin-cache workflow
- `claude`
  - launches Claude with `--dangerously-load-development-channels plugin:agentbridge@agentbridge`
- `codex`
  - ensures the daemon is running
  - launches Codex with the injected proxy arguments
- `kill`
  - stops the daemon precisely and writes a killed sentinel to prevent reconnect races

### Actual quick-start flow

The real first-run flow in the current codebase is:

1. Clone the repository and run `bun install`
2. Run `agentbridge init`
3. Start Claude Code with `agentbridge claude`
4. Start Codex with `agentbridge codex`
5. Stop the daemon later with `agentbridge kill`

This is simpler and more opinionated than the original proposal. Instead of generic `start` and `attach` commands, the CLI now encodes the actual Claude-side and Codex-side entrypoints directly.

### What did not ship from the earlier proposal

The original recommended command set included:

- `agentbridge doctor`
- `agentbridge start`
- `agentbridge stop`
- `agentbridge status`
- `agentbridge attach`

Those commands did not ship in Phase 3.

The implemented CLI chose task-specific commands instead because they map more directly to the real workflow:

- `claude` replaces a generic frontend startup command
- `codex` replaces a generic daemon-plus-attach flow
- `kill` replaces a generic stop path, while also handling the reconnect sentinel correctly

### Important deviations from the original distribution plan

- The CLI exists, but the package is not yet published as a public npm artifact.
  - The package is still marked `private`.
- `init` does not patch a global Claude MCP config file.
  - It generates project config and attempts plugin installation instead.
- Claude startup still depends on the development-channel flag rather than a stable marketplace `--channels` flow.

### Why this still counts as a successful v1 outcome

Phase 3 solved the operational problems that mattered most for v1:

- repeatable local setup
- explicit Claude and Codex startup commands
- reliable daemon reuse and shutdown
- project-level collaboration defaults
- a clean place to centralize runtime lifecycle logic

That gives AgentBridge a real product surface now, even though public packaging and marketplace polish remain follow-up work.

## 7. Collaboration Awareness Injection

### Problem

By default, each agent behaves as if it is working alone. Even if AgentBridge is connected, the participant may not clearly know that another agent is actively collaborating in the same workflow, or how that collaboration is supposed to work.

### Proposed improvement

Use the bridge to inject collaboration awareness automatically.

After the bridge connects, each agent should be told two things:

1. you are not working alone
2. this is how collaboration should work

This keeps the model simple. The user should not need to manually create project context files, prompt overlays, or coordination documents just to get the basic collaborative behavior.

In v1, the bridge should package the existing collaboration guidance from v1.1, v1.2, and v1.3 into a single collaboration-awareness injection:

- message quality and marker expectations from v1.1
- turn and attention expectations from v1.2
- role contract and thinking-pattern expectations from v1.3

### Delivery path

The injection path should stay lightweight and runtime-specific:

- Claude receives collaboration awareness through channel instructions
- Codex receives collaboration awareness through bridge contract reminders

This keeps the implementation aligned with the current architecture rather than introducing a larger prompt-management system.

### User experience goal

The target experience is zero configuration for basic collaboration awareness.

Users should not need to:

- create extra project prompt files
- manually synchronize instructions across agents
- manage a separate prompt system just to tell the agents they are collaborating

The bridge itself should establish that shared awareness automatically when the session starts.

## 8. Dual-Mode Message Transport: Channel Push + Tool Pull

### Problem

The current bridge relies entirely on Claude Code's experimental Channel capability (`notifications/claude/channel`) for delivering Codex messages to Claude in real time. This requires the user to start Claude Code with `--dangerously-load-development-channels`, which in turn mandates OAuth authentication. Users who authenticate with an API key cannot use AgentBridge at all.

This is a hard adoption blocker. API key users are a significant portion of the Claude Code user base, and requiring OAuth just to use a local development tool is an unnecessary barrier.

### Proposed improvement

Support two parallel message delivery modes within the same bridge, sharing the same daemon, message queue, and reply path:

**Channel Push (OAuth users):**
- When the channel capability is available, push messages in real time via `notifications/claude/channel`.
- Identical to the current v1.0 behavior.
- Claude receives messages as `<channel>` tags injected into the conversation stream.
- No user action required — messages appear automatically.

**Tool Pull (API key users):**
- When the channel capability is not available, queue messages in the bridge process.
- Provide a `get_messages` tool that Claude can call to retrieve pending messages.
- Return queued messages as structured tool results.
- Update MCP instructions to tell Claude about the `get_messages` tool and when to use it.

### Detection strategy

The bridge should detect which mode is available at startup and select automatically:

1. The MCP server always declares `experimental: { "claude/channel": {} }` in its capabilities.
2. During the MCP initialization handshake, check whether the client's capabilities indicate channel support.
3. If channel support is detected: use push mode. Messages are delivered via `notifications/claude/channel` as they arrive.
4. If channel support is not detected: use pull mode. Messages are queued and served via the `get_messages` tool.

If client capability inspection is not reliable, a fallback detection approach is:

- Always register the `get_messages` tool so it works in both modes.
- Also attempt to send channel notifications.
- Support an environment variable (`AGENTBRIDGE_MODE=push|pull|auto`) as an explicit override for users who know which mode they need.

### Pull mode design

#### Message queue

- The bridge maintains an in-memory message queue for pending Codex messages.
- Messages are appended to the queue as they arrive from the daemon.
- When Claude calls `get_messages`, all queued messages are returned and the queue is cleared.
- Queue size is bounded by `AGENTBRIDGE_MAX_BUFFERED_MESSAGES` (existing config, default 100).

#### `get_messages` tool

The tool returns all pending messages since the last call:

```json
{
  "name": "get_messages",
  "description": "Check for new messages from Codex. Call this periodically or when you expect a response.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

Response when messages are available:

```
[2 new messages from Codex]

---
[1] 2024-01-15T10:30:00Z
Codex: I've finished implementing the feature...

---
[2] 2024-01-15T10:30:05Z
Codex: Tests are passing...
```

Response when no messages are pending:

```
No new messages from Codex.
```

#### Instructions update

In pull mode, the MCP server instructions should tell Claude:

- The `get_messages` tool is available for checking Codex messages.
- Call `get_messages` after sending a reply to check for responses.
- Call `get_messages` when the user asks about Codex status or progress.
- The `reply` tool works identically in both modes.

#### Hint in reply responses

When messages are pending, the `reply` tool response should include a hint:

```
Reply sent to Codex. Note: 3 pending messages from Codex — call get_messages to read them.
```

This gives Claude a natural prompt to check for messages without requiring separate polling logic.

### Shared behavior

Both modes share:

- The same `reply` tool and reply delivery path.
- The same daemon and control WebSocket.
- The same Codex adapter and message interception.
- The same message format (`BridgeMessage`).

The only difference is the delivery direction: push (server → client notification) vs. pull (client → server tool call).

### Implementation scope

- `claude-adapter.ts`: Add mode detection logic. Add `get_messages` tool registration. Add message queue for pull mode. Add pending message hints in `reply` responses.
- `bridge.ts`: Adjust the `codexMessage` handler to either push or queue based on detected mode.
- `types.ts`: No changes needed — `BridgeMessage` is shared.
- Add `AGENTBRIDGE_MODE` environment variable support (`auto` | `push` | `pull`, default `auto`).
- Update MCP instructions to cover both modes.

### Expected user impact

- API key users can use AgentBridge for the first time without any special flags.
- OAuth users retain full real-time push behavior with no changes.
- The bridge startup command simplifies to just `claude` for API key users.
- The `get_messages` tool provides a clear, explicit interface for message retrieval.
- Pending message hints in `reply` responses naturally guide Claude to check for new messages.

### Known limitations

- Pull mode is inherently less real-time than push mode. Claude only sees new messages when it actively calls `get_messages`.
- There is no mechanism to "wake up" Claude when a message arrives in pull mode. The user or Claude must initiate the check.
- In pull mode, if Claude does not call `get_messages`, messages accumulate silently.
- These limitations are acceptable trade-offs for supporting API key authentication.

## 9. Out of Scope for v1

The following items are intentionally left out of v1 because they either require architectural restructuring or would pull later-version complexity into the current codebase:

- Multi-session support for multiple Claude connections and multiple Codex threads.
- Fixing the singleton Claude attachment model in a general way.
- Full room-based or multi-agent routing.
- True third-agent integration such as Claude, Codex, and Gemini in the same session topology.
- Generalized policy infrastructure for agent assignment and semantic routing.
- Full durability and recovery infrastructure for multi-agent state.

These items belong to v2 or later because they cross the boundary from user experience optimization into architectural redesign.

## 10. Version Positioning: v1 -> v2 -> v3 -> v4

- **v1** focuses on improving the single-bridge user experience: better message quality, clearer turn discipline, and more intentional role-aware collaboration.
- **v2** introduces the architectural foundation for multi-agent, multi-room, and recoverable collaboration.
- **v3** can build smarter coordination and richer policy behavior on top of the v2 foundation.
- **v4** can explore broader orchestration and more advanced multi-runtime collaboration.
