#!/usr/bin/env bash
#
# Wrapper for Codex TUI that protects terminal state from corruption.
#
# Problem: Codex TUI enables raw mode, keyboard enhancement, bracketed paste,
# focus tracking, and alternate screen. If the process is killed with SIGKILL,
# these modes are not restored, leaving the terminal unusable.
#
# Solution: Save terminal state before launch, restore on exit regardless of
# how the child process terminated.
#
# Usage: ./agentbridge-attach.sh [proxy-url]
#   Default proxy URL: ws://127.0.0.1:4501

set -uo pipefail

PROXY_URL="${1:-ws://127.0.0.1:4501}"

# Save terminal state
if [ -t 0 ]; then
  SAVED_STTY=$(stty -g 2>/dev/null || true)
else
  SAVED_STTY=""
fi

restore_terminal() {
  # Restore saved terminal settings (exact user state, not generic "sane")
  if [ -n "$SAVED_STTY" ] && [ -t 0 ]; then
    if ! stty "$SAVED_STTY" 2>/dev/null; then
      # Fallback to stty sane only if restoring saved state fails
      stty sane 2>/dev/null || true
    fi
  fi

  # Disable terminal modes that Codex TUI enables
  # These are safe no-ops if the modes were never enabled
  printf '\e[<u' 2>/dev/null || true        # Disable keyboard enhancement
  printf '\e[?2004l' 2>/dev/null || true     # Disable bracketed paste
  printf '\e[?1004l' 2>/dev/null || true     # Disable focus tracking
  printf '\e[?1049l' 2>/dev/null || true     # Leave alternate screen
  printf '\e[?25h' 2>/dev/null || true       # Show cursor
  printf '\e[0m' 2>/dev/null || true         # Reset character attributes
}

# Register cleanup on any exit
trap restore_terminal EXIT

echo "Attaching Codex TUI to AgentBridge proxy at ${PROXY_URL}..."
echo "(Terminal state saved — will be restored on exit)"
echo ""

# Launch Codex as child process (not exec, so we survive its death)
# Preserve exit code for debugging — don't mask with || true
CHILD_EXIT=0
codex --enable tui_app_server --remote "$PROXY_URL" || CHILD_EXIT=$?

# restore_terminal runs automatically via EXIT trap
exit "$CHILD_EXIT"
