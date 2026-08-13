#!/usr/bin/env python3
"""Fixture tests for desktop backup inspect + recover-diary-sources."""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
RECOVER = SCRIPTS / "recover-diary-sources.py"
INSPECT = SCRIPTS / "inspect-youdao-desktop-backup.py"


def _write_fixture(root: Path, *, with_backup: bool = True) -> Path:
    account = "h11128@163.com"
    data = root / "ynote-desktop" / account / "ynote-data"
    data.mkdir(parents=True)
    db = data / f"{account}.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE note (fileId TEXT, title TEXT, del INTEGER, modifyTime INTEGER)"
    )
    con.execute(
        "INSERT INTO note VALUES (?,?,?,?)",
        ("WEBdeleted11", "2026年8月11日.note", 1, 1720000000),
    )
    con.execute(
        "INSERT INTO note VALUES (?,?,?,?)",
        ("WEBactive11", "2026年8月11日.note", 0, 1720001000),
    )
    con.commit()
    con.close()
    if with_backup:
        backup = data / "backupNote" / "WEBdeleted11"
        backup.mkdir(parents=True)
        payload = json.dumps({"8": "unique aug11 handwriting from backupNote v38"})
        (backup / "1").write_bytes(gzip.compress(b'{"8":"tiny"}'))
        (backup / "38").write_bytes(gzip.compress(payload.encode("utf-8")))
    return data


def _empty_account(root: Path, account: str) -> Path:
    data = root / "ynote-desktop" / account / "ynote-data"
    data.mkdir(parents=True)
    db = data / f"{account}.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE note (fileId TEXT, title TEXT, del INTEGER, modifyTime INTEGER)"
    )
    con.commit()
    con.close()
    return data


def _run(
    script: Path,
    args: list[str],
    data: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(script), *args]
    if data is not None:
        cmd.extend(["--data-dir", str(data)])
    run_env = os.environ.copy()
    if env:
        run_env.update(env)
    return subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        check=False,
        cwd=str(SCRIPTS),
        env=run_env,
    )


class RecoverDiarySourcesTest(unittest.TestCase):
    def test_exit2_when_desktop_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "no-such-ynote-data"
            proc = _run(RECOVER, ["--title", "2026年8月11日"], missing)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("VERDICT: desktop_unavailable_cannot_claim_lost", proc.stdout)

    def test_finds_deleted_backup_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = _write_fixture(Path(tmp))
            out = Path(tmp) / "extract"
            proc = _run(
                RECOVER,
                ["--title", "2026年8月11日", "--extract-dir", str(out)],
                data,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("desktop_backup: checked", proc.stdout)
            self.assertIn("desktop_deleted_rows: 1", proc.stdout)
            self.assertIn("VERDICT: backup_versions_exist", proc.stdout)
            self.assertIn("richest: fileId=WEBdeleted11 v=38", proc.stdout)
            extracted = list(out.glob("WEBdeleted11-v38.md"))
            self.assertEqual(len(extracted), 1)
            self.assertIn(
                "unique aug11 handwriting", extracted[0].read_text(encoding="utf-8")
            )

    def test_checked_no_rows_is_not_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = _write_fixture(Path(tmp))
            proc = _run(RECOVER, ["--title", "2026年9月9日"], data)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("VERDICT: desktop_checked_no_matching_rows", proc.stdout)

    def test_rows_without_backup_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = _write_fixture(Path(tmp), with_backup=False)
            proc = _run(RECOVER, ["--title", "2026年8月11日"], data)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("VERDICT: desktop_rows_no_backup_versions", proc.stdout)

    def test_scans_all_accounts_under_appdata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _empty_account(root, "aaa-first@x.com")
            _write_fixture(root)
            proc = _run(
                RECOVER,
                ["--title", "2026年8月11日"],
                env={"APPDATA": str(root), "YNOTE_DESKTOP_DATA": ""},
            )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("VERDICT: backup_versions_exist", proc.stdout)
        self.assertIn("WEBdeleted11", proc.stdout)

    def test_inspect_lists_deleted_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = _write_fixture(Path(tmp))
            proc = _run(INSPECT, ["--title", "2026年8月11日"], data)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("WEBdeleted11", proc.stdout)
        self.assertIn("del=1", proc.stdout)


if __name__ == "__main__":
    unittest.main()
