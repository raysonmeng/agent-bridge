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

# In-session plugin-update reminder: compare the INSTALLED plugin version against
# the latest npm version cached by the CLI notifier (src/update-notifier.ts). This
# is how a user who updated the npm CLI but not the plugin learns of the mismatch
# from inside Claude Code. Best-effort + silent: never blocks the hook.
plugin_notice=""
if command -v bun >/dev/null 2>&1 && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  plugin_notice="$(bun "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-update-notice.mjs" "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || true)"
fi

health_json="$(curl -fsS --max-time 1 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"

if [ -n "$health_json" ]; then
  tui_connected="false"
  if printf '%s' "$health_json" | grep -q '"tuiConnected":true'; then
    tui_connected="true"
  fi

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
