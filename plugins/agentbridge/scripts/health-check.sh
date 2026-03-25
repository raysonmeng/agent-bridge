#!/usr/bin/env bash

set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"

workspace="${CLAUDE_PROJECT_DIR:-${PWD}}"
cooldown_seconds="${AGENTBRIDGE_HEALTH_HOOK_COOLDOWN_SECONDS:-120}"
state_root="${AGENTBRIDGE_HOOK_STATE_DIR:-${TMPDIR:-/tmp}/agentbridge-hooks}"
port="${AGENTBRIDGE_CONTROL_PORT:-4502}"

if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$state_root" 2>/dev/null || true
workspace_key="$(printf '%s' "$workspace" | cksum | awk '{print $1}')"
stamp_file="${state_root}/sessionstart-${workspace_key}.stamp"
now="$(date +%s)"

if [ -f "$stamp_file" ]; then
  last_notice="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  if [ $((now - last_notice)) -lt "$cooldown_seconds" ]; then
    exit 0
  fi
fi

printf '%s' "$now" >"$stamp_file" 2>/dev/null || true

health_json="$(curl -fsS --max-time 1 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"

if [ -n "$health_json" ]; then
  tui_connected="false"
  if printf '%s' "$health_json" | grep -q '"tuiConnected":true'; then
    tui_connected="true"
  fi

  if [ "$tui_connected" = "true" ]; then
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge is running. Daemon healthy, Codex TUI connected. Bridge is ready for communication."}}
EOF
  else
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is running but Codex TUI is not connected yet. Start Codex in another terminal with: agentbridge codex"}}
EOF
  fi
else
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is not reachable on http://127.0.0.1:${port}/healthz yet. Start the bridge with: agentbridge claude (this terminal) + agentbridge codex (another terminal). If you're already using agentbridge claude, the daemon may still be starting up."}}
EOF
fi
