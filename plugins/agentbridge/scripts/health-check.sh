#!/usr/bin/env bash

set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"

workspace="${CLAUDE_PROJECT_DIR:-${PWD}}"
cooldown_seconds="${AGENTBRIDGE_HEALTH_HOOK_COOLDOWN_SECONDS:-120}"
state_root="${AGENTBRIDGE_HOOK_STATE_DIR:-${TMPDIR:-/tmp}/agentbridge-hooks}"
port="${AGENTBRIDGE_CONTROL_PORT:-4502}"

# In multi-pair mode the resolver exports AGENTBRIDGE_PAIR_ID, inherited here via
# the SessionStart hook env. Scope the suggested commands to that pair so the
# user is not sent to a different (cwd-derived) pair. Guard the charset (the
# resolver already restricts it) so nothing unsafe is interpolated into the JSON.
pair_id="${AGENTBRIDGE_PAIR_ID:-}"
pair_arg=""
if printf '%s' "$pair_id" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  pair_arg=" --pair ${pair_id}"
fi

# ── PR4 §6: resume-ack degraded escape hatch ─────────────────────────────────
# When the daemon's Claude-side ResumeAckTracker exhausts retries with no ack, it
# drops a sentinel in the state dir. Surface it here BEFORE the cooldown gate so
# a fresh session within the cooldown window still sees it (else it'd be eaten),
# then CONSUME (delete) the sentinel so the notice shows exactly once.
resolve_state_dir() {
  if [ -n "${AGENTBRIDGE_STATE_DIR:-}" ]; then
    printf '%s' "${AGENTBRIDGE_STATE_DIR}"
    return
  fi
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      printf '%s' "${HOME}/Library/Application Support/AgentBridge"
      ;;
    *)
      local xdg="${XDG_STATE_HOME:-}"
      if [ -n "$xdg" ]; then
        printf '%s' "${xdg}/agentbridge"
      else
        printf '%s' "${HOME}/.local/state/agentbridge"
      fi
      ;;
  esac
}

state_dir="$(resolve_state_dir)"
resume_sentinel="${state_dir}/resume-ack-degraded.json"
if [ -f "$resume_sentinel" ]; then
  resume_id="$(grep -o '"resumeId"[[:space:]]*:[[:space:]]*"[^"]*"' "$resume_sentinel" 2>/dev/null | head -n1 | sed 's/.*"resumeId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  # Staleness gate: the sentinel carries degradedAt (epoch MILLISECONDS, written by
  # writeResumeAckDegradedSentinel). A degrade that happened long ago points at a
  # checkpoint that is probably already handled, so surfacing "continue from
  # checkpoint" would mislead. Drop (still consuming) a sentinel older than the TTL.
  # Default 24h survives an overnight away-window (the core use case — wake up and
  # the recovery notice is still there) yet suppresses multi-day-stale notices;
  # configurable via AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC. Fail-open: a missing,
  # non-numeric, or implausibly-long (>16-digit) degradedAt / TTL is treated as
  # FRESH so a possibly-real recovery is never silently suppressed. (A parseable
  # but genuinely old timestamp is still aged normally → stale.)
  degraded_at_ms="$(grep -o '"degradedAt"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$resume_sentinel" 2>/dev/null | head -n1 | grep -o '[0-9][0-9]*$')"
  resume_ttl_sec="${AGENTBRIDGE_RESUME_SENTINEL_TTL_SEC:-86400}"
  resume_stale=0
  # Accept only a plausible 1–16 digit integer for BOTH operands: 16 digits keeps
  # every value (epoch-ms ~13 digits, any sane TTL ≤ ~9.99e15) far under bash's
  # signed 64-bit ceiling, so the subtraction below can never overflow; anything
  # longer / non-numeric / missing is rejected here → FRESH (fail-open).
  if printf '%s' "$degraded_at_ms" | grep -Eq '^[0-9]{1,16}$' && printf '%s' "$resume_ttl_sec" | grep -Eq '^[0-9]{1,16}$'; then
    # Compare in SECONDS (degradedAt is epoch ms → integer-divide by 1000) and never
    # multiply the user TTL by 1000, so the comparison can't overflow. `10#` forces
    # base-10 so a leading-zero value (e.g. 0888…) parses decimally instead of as
    # octal — an octal-invalid operand would otherwise make the $(( )) arithmetic
    # fail, and in bash a failed arithmetic assignment terminates the enclosing
    # if-block (regardless of set flags), skipping the consume (rm) below and leaking
    # the sentinel. The ^[0-9]{1,16}$ guard above + `10#` together make this
    # arithmetic TOTAL for every accepted input (no octal abort, no int64 overflow),
    # so age_sec is always assigned and the unconditional rm below always runs
    # (consume-once holds).
    now_sec="$(date +%s 2>/dev/null)"
    age_sec=$(( ${now_sec:-0} - 10#${degraded_at_ms} / 1000 ))
    if [ "$age_sec" -gt "$resume_ttl_sec" ]; then
      resume_stale=1
    fi
  fi
  rm -f "$resume_sentinel" 2>/dev/null || true  # consume once, whether surfaced or dropped-as-stale
  if [ "$resume_stale" -eq 0 ]; then
    # Defense-in-depth (resume_id is daemon-controlled, but harden anyway): only
    # interpolate it into the JSON heredoc if it matches the known-safe id charset
    # (system_budget_claude_recovered_<seq> — a plain monotonic sequence, no salt;
    # the salt lives in BridgeMessage.id, not in the resumeId the sentinel stores).
    # Anything else (a corrupted or
    # tampered sentinel carrying " or \) collapses to "unknown" so the emitted hook
    # JSON can never be broken by the value — mirrors the pair_id guard above.
    if ! printf '%s' "$resume_id" | grep -Eq '^[A-Za-z0-9._-]+$'; then
      resume_id="unknown"
    fi
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge: 上次额度刷新后的续接通知未被确认（resume_id=${resume_id:-unknown}），可能上一个会话已空闲或退出。请从 .agent/checkpoint.md 的「下一步」继续未完成的任务。"}}
EOF
    exit 0
  fi
  # stale → sentinel consumed above; fall through to the normal health check below.
fi

# ── injection.runtime opt-out ────────────────────────────────────────────────
# An explicit injection.runtime=false silences this hook for the workspace
# ENTIRELY: the user opted the project out of runtime delivery, so neither
# collaboration context nor start-the-bridge notices should reach the session.
# The verdict comes from the SAME code path the context injection uses
# (isRuntimeInjectionEnabled via the bundled helper's --check mode) — shell
# never re-implements JSON parsing. Only a literal "disabled" exits; any
# helper failure (missing bun/bundle, crash) fails OPEN so a broken helper
# cannot mute the notices. The resume-ack sentinel above stays exempt on
# purpose: it is a one-shot, consume-once recovery escape hatch.
if command -v bun >/dev/null 2>&1 && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  injection_state="$(bun "${CLAUDE_PLUGIN_ROOT}/server/bridge-server.js" --print-session-context --check --workspace "$workspace" 2>/dev/null || true)"
  if [ "$injection_state" = "disabled" ]; then
    exit 0
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$state_root" 2>/dev/null || true
workspace_key="$(printf '%s' "$workspace" | cksum | awk '{print $1}')"
stamp_file="${state_root}/sessionstart-${workspace_key}.stamp"
now="$(date +%s)"

# In-session plugin-update reminder: compare the INSTALLED plugin version against
# the latest npm version cached by the CLI notifier (src/update-notifier.ts). This
# is how a user who updated the npm CLI but not the plugin learns of the mismatch
# from inside Claude Code. Best-effort + silent: never blocks the hook.
# Computed BEFORE the cooldown gate because the runtime-context path below
# bypasses that gate and also carries the notice.
plugin_notice=""
if command -v bun >/dev/null 2>&1 && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  plugin_notice="$(bun "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-update-notice.mjs" "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || true)"
fi

health_json="$(curl -fsS --max-time 1 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"

tui_connected="false"
if [ -n "$health_json" ] && printf '%s' "$health_json" | grep -q '"tuiConnected":true'; then
  tui_connected="true"
fi

# ── Runtime collaboration context (the pluggable CLAUDE.md replacement) ──────
# When the bridge is fully up (daemon healthy + Codex TUI attached), delegate to
# the bundled server entry: it decides whether `injection.runtime` allows it and
# prints the COMPLETE hook JSON (status line + collaboration context). This path
# deliberately BYPASSES the cooldown stamp — the context is load-bearing and
# every new session (startup/resume/clear/compact) must receive it, unlike the
# informational notices below. Empty output (injection disabled by config, or
# the entry failed) falls through to the cooldown-gated short notices.
if [ "$tui_connected" = "true" ] && command -v bun >/dev/null 2>&1 && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  context_json="$(bun "${CLAUDE_PLUGIN_ROOT}/server/bridge-server.js" --print-session-context --workspace "$workspace" --notice "${plugin_notice}" 2>/dev/null || true)"
  if [ -n "$context_json" ]; then
    printf '%s\n' "$context_json"
    exit 0
  fi
fi

if [ -f "$stamp_file" ]; then
  last_notice="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  if [ $((now - last_notice)) -lt "$cooldown_seconds" ]; then
    exit 0
  fi
fi

printf '%s' "$now" >"$stamp_file" 2>/dev/null || true

if [ -n "$health_json" ]; then
  if [ "$tui_connected" = "true" ]; then
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge is running. Daemon healthy, Codex TUI connected. Bridge is ready for communication.${plugin_notice:+ $plugin_notice}"}}
EOF
  else
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is running but Codex TUI is not connected yet. Start Codex in another terminal with: agentbridge codex${pair_arg}${plugin_notice:+ $plugin_notice}"}}
EOF
  fi
else
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is not reachable on http://127.0.0.1:${port}/healthz yet. Start the bridge with: agentbridge claude${pair_arg} (this terminal) + agentbridge codex${pair_arg} (another terminal). If you're already using agentbridge claude${pair_arg}, the daemon may still be starting up.${plugin_notice:+ $plugin_notice}"}}
EOF
fi
