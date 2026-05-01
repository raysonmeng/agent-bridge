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

# Phase C: probe pending unacked Codex messages (non-consuming).
# Hook should never fail because the peek can't run, so all errors are swallowed.
pending_suffix=""
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$(realpath "$0")")")}"
peek_script="${plugin_root}/scripts/peek_codex_queue.py"
python_bin="${AGENTBRIDGE_PYTHON:-}"
if [ -z "$python_bin" ]; then
  if [ -x "/c/Users/tomin/AppData/Local/Programs/Python/Python312/python.exe" ]; then
    python_bin="/c/Users/tomin/AppData/Local/Programs/Python/Python312/python.exe"
  elif command -v python3 >/dev/null 2>&1; then
    python_bin="python3"
  elif command -v python >/dev/null 2>&1; then
    python_bin="python"
  fi
fi
if [ -n "$python_bin" ] && [ -f "$peek_script" ]; then
  pending_count="$("$python_bin" -X utf8 "$peek_script" --format=count 2>/dev/null || echo 0)"
  if [ -n "$pending_count" ] && [ "$pending_count" != "0" ]; then
    pending_suffix=" ${pending_count} unread Codex message(s) pending — they will be injected on your next prompt."
  fi
fi

if [ -n "$health_json" ]; then
  tui_connected="false"
  if printf '%s' "$health_json" | grep -q '"tuiConnected":true'; then
    tui_connected="true"
  fi

  if [ "$tui_connected" = "true" ]; then
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge is running. Daemon healthy, Codex TUI connected. Bridge is ready for communication.${pending_suffix}"}}
EOF
  else
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is running but Codex TUI is not connected yet. Start Codex in another terminal with: agentbridge codex${pending_suffix}"}}
EOF
  fi
else
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is not reachable on http://127.0.0.1:${port}/healthz yet. Start the bridge with: agentbridge claude (this terminal) + agentbridge codex (another terminal). If you're already using agentbridge claude, the daemon may still be starting up."}}
EOF
fi
