#!/usr/bin/env python3
"""
Read-only peek into the AgentBridge SQLite message queue.

Used by Claude Code hooks (UserPromptSubmit / SessionStart) to surface
pending Codex messages as system-reminder additionalContext without
consuming them from the queue.

Phase C semantics:
- Returns messages where drained_at IS NULL AND acked_at IS NULL.
- Does NOT mutate state. Ack happens inside bridge-server.js when the
  Claude reply tool is called.

Output modes:
  --format=count     emit the integer count (single line)
  --format=hook      emit a JSON object suitable for stdin in a hook
                     (matches Claude Code hookSpecificOutput shape)
  --format=text      emit human-readable text (debugging)
  --format=json      emit raw JSON list of message rows (debugging)

Exit codes:
  0  success
  2  queue.db missing (daemon never ran on this machine)
  3  query error
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any


def state_dir() -> Path:
    """Mirror the StateDirResolver logic from src/state-dir.ts."""
    override = os.environ.get("AGENTBRIDGE_STATE_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "AgentBridge"
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "state"
    return base / "agentbridge"


def queue_db_path() -> Path:
    return state_dir() / "queue.db"


def fetch_pending(db: Path, limit: int) -> list[dict[str, Any]]:
    if not db.is_file():
        return []
    # Read-only URI so multiple concurrent readers (hooks + daemon) are safe.
    uri = f"file:{db.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    try:
        conn.row_factory = sqlite3.Row
        cur = conn.execute(
            """
            SELECT
              seq,
              message_id,
              chat_id,
              source,
              content,
              timestamp,
              marker,
              created_at
            FROM messages
            WHERE drained_at IS NULL AND acked_at IS NULL
            ORDER BY seq ASC
            LIMIT ?
            """,
            (limit,),
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def format_for_hook(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the system-reminder additionalContext payload."""
    if not rows:
        return {}
    header = (
        f"AgentBridge: {len(rows)} unread Codex message(s) pending in the queue. "
        "Content is included below for context. To clear them, either call "
        "the reply tool (which auto-acks) or call get_messages (which drains)."
    )
    blocks = [header, ""]
    for r in rows:
        marker = r.get("marker") or "untagged"
        chat_id = r.get("chat_id") or "?"
        msg_id = r.get("message_id") or "?"
        ts = r.get("timestamp") or 0
        content = r.get("content") or ""
        blocks.append(
            f"--- [{marker}] chat_id={chat_id} message_id={msg_id} ts={ts} ---"
        )
        blocks.append(content)
        blocks.append("")
    additional = "\n".join(blocks).rstrip()
    return {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": additional,
        }
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--format", choices=["count", "hook", "text", "json"], default="hook")
    p.add_argument("--limit", type=int, default=20, help="max messages to return")
    p.add_argument(
        "--event",
        default="UserPromptSubmit",
        help="hook event name to embed in --format=hook output",
    )
    args = p.parse_args()

    db = queue_db_path()
    if not db.is_file():
        if args.format == "count":
            print(0)
            return 0
        if args.format == "hook":
            # Empty output → Claude Code treats hook as no-op.
            return 0
        print(f"queue.db not found at {db}", file=sys.stderr)
        return 2

    try:
        rows = fetch_pending(db, args.limit)
    except sqlite3.Error as e:
        print(f"sqlite error: {e}", file=sys.stderr)
        return 3

    if args.format == "count":
        print(len(rows))
        return 0

    if args.format == "hook":
        if not rows:
            return 0
        payload = format_for_hook(rows)
        # Allow caller to override the event name (SessionStart vs UserPromptSubmit).
        if "hookSpecificOutput" in payload:
            payload["hookSpecificOutput"]["hookEventName"] = args.event
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    if args.format == "json":
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    # text
    if not rows:
        print("(no pending Codex messages)")
        return 0
    print(f"{len(rows)} pending Codex message(s):")
    for r in rows:
        print(
            f"  seq={r['seq']} marker={r['marker']} chat={r['chat_id']} "
            f"msg={r['message_id']} ts={r['timestamp']}"
        )
        preview = (r.get("content") or "").strip().replace("\n", " ")
        if len(preview) > 120:
            preview = preview[:120] + "..."
        print(f"    {preview}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
