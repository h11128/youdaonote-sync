#!/usr/bin/env python3
"""Tests for deny-youdao-diary-note-delete-hook.py."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "deny-youdao-diary-note-delete-hook.py"


def run_hook(payload: dict) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    out = json.loads(proc.stdout or "{}")
    return proc.returncode, out


class DenyYoudaoNoteDeleteHookTest(unittest.TestCase):
    def test_denies_delete_empty_script(self):
        code, out = run_hook(
            {
                "command": (
                    "npx tsx ts-src/scripts/delete-empty-diary-notes.mts "
                    "2026-08-07"
                )
            }
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.get("permission"), "deny")

    def test_denies_delete_file_diary_note(self):
        code, out = run_hook(
            {
                "tool_name": "Shell",
                "tool_input": {
                    "command": "api.deleteFile('2026年8月7日.note')",
                },
            }
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.get("permission"), "deny")

    def test_allows_inspect(self):
        code, out = run_hook(
            {"command": "npx tsx ts-src/scripts/inspect-diary-notes.mts"}
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, {})

    def test_allows_restore(self):
        code, out = run_hook(
            {
                "command": (
                    "npx tsx ts-src/scripts/restore-diary-notes-from-md.mts "
                    "2026-08-07"
                )
            }
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, {})

    def test_allows_unrelated_shell(self):
        code, out = run_hook({"command": "npm run diagnose -- summary"})
        self.assertEqual(code, 0)
        self.assertEqual(out, {})

    def test_denies_even_if_inspect_also_present(self):
        code, out = run_hook(
            {
                "command": (
                    "npx tsx scripts/inspect-diary-notes.mts && "
                    "npx tsx scripts/delete-empty-diary-notes.mts"
                )
            }
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.get("permission"), "deny")

    def test_denies_multiline_delete_file(self):
        code, out = run_hook(
            {"command": "api.deleteFile(\n  '2026年8月7日.note')"}
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.get("permission"), "deny")

    def test_denies_name_before_delete_file(self):
        code, out = run_hook(
            {"command": "n='2026年8月7日.note'; api.deleteFile(n)"}
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.get("permission"), "deny")

    def test_allows_delete_file_by_id_only(self):
        # Intentional: fileId-only is too broad to DENY at shell layer.
        code, out = run_hook(
            {"command": "api.deleteFile('WEB019c3c358a414b528d3b757457f0c89a')"}
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, {})

    def test_bad_json_fail_open(self):
        proc = subprocess.run(
            [sys.executable, str(HOOK)],
            input="not-json",
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout or "{}"), {})

    def test_installed_hookrule_pattern_matches_sot(self):
        rules_path = (
            Path.home() / ".cursor" / "audit-logs" / "custom_rules.json"
        )
        if not rules_path.exists():
            self.skipTest("custom_rules.json not installed on this machine")
        import importlib.util

        spec = importlib.util.spec_from_file_location("deny_youdao_note", HOOK)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        raw = json.loads(rules_path.read_text(encoding="utf-8-sig"))
        rule = next(
            r
            for r in raw
            if isinstance(r, dict)
            and r.get("id") == "youdao_note_listing_size_delete_deny"
        )
        self.assertEqual(rule["check"]["pattern"], mod.DENY_PATTERN)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
