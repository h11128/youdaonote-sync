# -*- coding:utf-8 -*-
"""
扫描器测试（selective_filter、scan_local、async_scan_cloud、scandir）
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch, MagicMock

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.sync.metadata import SyncMetadata
from src.sync.utils import (
    decide_action, SyncAction, filter_by_direction, SyncDirection,
    SyncItem, VerifyIssueType, sanitize_filename,
)
from src.sync.scanner import map_cloud_name
from src.sync.moves import normalize_filename
from src.sync.dedup import _cloud_score
from src.common import format_file_size
from src.convert.md_to_note import markdown_to_note_json


# ========== Feature: matches_selective 测试 ==========

class MatchesSelectiveTest(unittest.TestCase):

    def test_no_filters_passes_all(self):
        from src.sync.scanner import matches_selective
        self.assertTrue(matches_selective("any/path.md", [], []))

    def test_exclude_blocks(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("secret/notes.md", [], ["secret/*"]))

    def test_include_allows(self):
        from src.sync.scanner import matches_selective
        self.assertTrue(matches_selective("work/todo.md", ["work/*"], []))

    def test_include_rejects_others(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("personal/diary.md", ["work/*"], []))

    def test_exclude_overrides_include(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("work/secret.md",
                                           ["work/*"], ["work/secret.md"]))

    def test_recursive_pattern(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("a/b/c/temp.md", [], ["*.md"]))

    def test_directory_paths(self):
        from src.sync.scanner import matches_selective
        self.assertTrue(matches_selective("docs/guide", ["docs/*"], []))



# ========== Unit: Selective sync filter ==========================

class SelectiveSyncFilterTest(unittest.TestCase):

    def test_exclude_pattern(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertFalse(_matches_selective(
            "temp/draft.md", [], ["temp/*"]))
        self.assertTrue(_matches_selective(
            "notes/hello.md", [], ["temp/*"]))

    def test_include_pattern(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertTrue(_matches_selective(
            "important/a.md", ["important/*"], []))
        self.assertFalse(_matches_selective(
            "other/b.md", ["important/*"], []))

    def test_no_filters(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertTrue(_matches_selective("anything.md", [], []))

    def test_exclude_overrides_include(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertFalse(_matches_selective(
            "notes/secret.md", ["notes/*"], ["*secret*"]))



# ========== Unit: scandir recursive ==============================

class ScandirRecursiveTest(unittest.TestCase):

    def test_scandir_finds_nested_files(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, "a", "b"))
            with open(os.path.join(tmpdir, "a", "b", "c.md"), "w") as f:
                f.write("hi")
            with open(os.path.join(tmpdir, "root.md"), "w") as f:
                f.write("root")
            files = scan_local(tmpdir)
            self.assertIn("a/b/c.md", files)
            self.assertIn("root.md", files)
            self.assertIn("a", files)
            self.assertIn("a/b", files)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_scandir_skips_hidden(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, ".hidden"))
            with open(os.path.join(tmpdir, ".hidden", "secret.md"), "w") as f:
                f.write("x")
            with open(os.path.join(tmpdir, ".dotfile"), "w") as f:
                f.write("x")
            files = scan_local(tmpdir)
            self.assertNotIn(".hidden", files)
            self.assertNotIn(".hidden/secret.md", files)
            self.assertNotIn(".dotfile", files)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_selective_sync_exclude(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, "keep"))
            os.makedirs(os.path.join(tmpdir, "skip"))
            with open(os.path.join(tmpdir, "keep", "a.md"), "w") as f:
                f.write("a")
            with open(os.path.join(tmpdir, "skip", "b.md"), "w") as f:
                f.write("b")
            files = scan_local(tmpdir, sync_exclude=["skip/*"])
            self.assertIn("keep/a.md", files)
            self.assertNotIn("skip/b.md", files)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class ScanLocalSingleWorkerTest(unittest.TestCase):
    """P0: workers<=1 should scan ALL subdirs, not just the first"""

    def test_all_subdirs_scanned_with_single_worker(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            # Create two subdirs with files
            for dname in ("dir_a", "dir_b", "dir_c"):
                dp = os.path.join(tmpdir, dname)
                os.makedirs(dp)
                with open(os.path.join(dp, "note.md"), "w") as f:
                    f.write("content")

            # Force workers=1 by mocking cpu_count
            import src.sync.scanner as scanner_mod
            orig = os.cpu_count
            try:
                os.cpu_count = lambda: 1
                files = scan_local(tmpdir)
            finally:
                os.cpu_count = orig

            file_rels = {k for k, v in files.items() if not v.get("is_dir")}
            self.assertIn("dir_a/note.md", file_rels)
            self.assertIn("dir_b/note.md", file_rels)
            self.assertIn("dir_c/note.md", file_rels)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class AsyncScanCloudPaginationTest(unittest.TestCase):
    """P0: async_scan_cloud should handle pagination like get_dir_info_by_id"""

    def test_pagination_collects_all_entries(self):
        import asyncio
        from unittest.mock import AsyncMock, MagicMock
        from src.sync.scanner import async_scan_cloud

        page1_entries = [
            {"fileEntry": {"id": f"f{i}", "name": f"file{i}.md", "dir": False,
                           "modifyTimeForSort": 100, "createTimeForSort": 50, "domain": 1}}
            for i in range(3)
        ]
        page2_entries = [
            {"fileEntry": {"id": f"f{i}", "name": f"file{i}.md", "dir": False,
                           "modifyTimeForSort": 100, "createTimeForSort": 50, "domain": 1}}
            for i in range(3, 5)
        ]

        call_count = [0]
        async def mock_get(url):
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            if call_count[0] == 0:
                resp.json.return_value = {"entries": page1_entries, "count": 5}
            else:
                resp.json.return_value = {"entries": page2_entries, "count": 5}
            call_count[0] += 1
            return resp

        client = MagicMock()
        client.get = mock_get
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=False)

        url_tmpl = "https://example.com/{dir_id}?len={page_size}&cstk={cstk}"

        async def run():
            return await async_scan_cloud(
                client, url_tmpl, page_size=3, cstk="tok",
                dir_id="root", max_concurrent=1
            )

        files = asyncio.run(run())
        self.assertEqual(len(files), 5)
        self.assertGreater(call_count[0], 1, "Should have fetched multiple pages")



if __name__ == "__main__":
    unittest.main()
