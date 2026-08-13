#!/usr/bin/env python3
"""Deny shell deletes of Youdao diary .note by listing size.

Handles Cursor beforeShellExecution.command and preToolUse Shell
tool_input.command. Inspect/restore scripts are allowed.
"""

from __future__ import annotations

import json
import re
import sys

DENY_MSG = (
    "DENY: Youdao listing size is not emptiness. "
    "Do not run delete-empty-diary-notes or deleteFile on diary .note names. "
    "Inspect with inspect-diary-notes; restore with restore-diary-notes-from-md. "
    "Empty only if a real download returns 0 bytes and the note JSON has no children."
)

# SOT for Cursor HookRule youdao_note_listing_size_delete_deny as well.
# Bidirectional + [\s\S] so name-first / wrapped-call still match.
# fileId-only deleteFile is intentionally not matched (too broad).
DENY_PATTERN = (
    r"(?is)(?:delete-empty-diary-notes|"
    r"(?:deleteFile|\.deleteFile)\b[\s\S]{0,400}"
    r"年[\s\S]{0,80}月[\s\S]{0,80}日\.note|"
    r"年[\s\S]{0,80}月[\s\S]{0,80}日\.note[\s\S]{0,400}"
    r"(?:deleteFile|\.deleteFile)\b)"
)
DENY_RE = re.compile(DENY_PATTERN)


def extract_command(payload: dict) -> str:
    if payload.get("command"):
        return str(payload["command"])
    inp = payload.get("tool_input") or payload.get("arguments") or {}
    if isinstance(inp, dict) and inp.get("command"):
        return str(inp["command"])
    return ""


def should_deny(command: str) -> bool:
    return bool(command and DENY_RE.search(command))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        print("{}")
        return 0

    if not isinstance(payload, dict):
        print("{}")
        return 0

    tool = (payload.get("tool_name") or payload.get("toolName") or "").strip()
    if tool and tool not in ("Shell", ""):
        print("{}")
        return 0

    if not should_deny(extract_command(payload)):
        print("{}")
        return 0

    out = {
        "permission": "deny",
        "agent_message": DENY_MSG,
        "user_message": "Blocked Youdao diary .note delete (listing-size guard).",
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
