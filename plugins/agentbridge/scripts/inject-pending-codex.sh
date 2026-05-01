#!/usr/bin/env bash
# Phase C: UserPromptSubmit hook.
# Injects unacked + undrained Codex messages from the AgentBridge queue
# into Claude's context as a system-reminder additionalContext block.
# Non-consuming — ack happens inside the reply tool, drain happens via
# get_messages / wait_for_messages MCP tools.

set -uo pipefail

# Drain stdin (Claude Code sends a JSON event on stdin to hooks).
INPUT="$(cat 2>/dev/null || true)"
unset INPUT  # not used yet; reserved for future filtering

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$(realpath "$0")")")}"
PEEK_SCRIPT="${PLUGIN_ROOT}/scripts/peek_codex_queue.py"

# Discover Python. Tony's box: explicit Python 3.12 path. Fallback to PATH.
PYTHON="${AGENTBRIDGE_PYTHON:-}"
if [ -z "${PYTHON}" ]; then
  if [ -x "/c/Users/tomin/AppData/Local/Programs/Python/Python312/python.exe" ]; then
    PYTHON="/c/Users/tomin/AppData/Local/Programs/Python/Python312/python.exe"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON="python"
  else
    exit 0  # No Python — silently no-op so hook never blocks user prompts.
  fi
fi

if [ ! -f "${PEEK_SCRIPT}" ]; then
  exit 0
fi

OUTPUT="$("${PYTHON}" -X utf8 "${PEEK_SCRIPT}" --format=hook --event=UserPromptSubmit 2>/dev/null)"
if [ -z "${OUTPUT}" ]; then
  exit 0  # No pending messages → no-op.
fi

printf '%s\n' "${OUTPUT}"
