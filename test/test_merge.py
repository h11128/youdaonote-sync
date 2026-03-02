# -*- coding:utf-8 -*-
"""
合并测试（three_way_merge、diff3）
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
from src.sync.metadata_aux import save_base_content, get_base_content
from src.sync.utils import (
    decide_action, SyncAction, filter_by_direction, SyncDirection,
    SyncItem, VerifyIssueType, sanitize_filename,
)
from src.sync.scanner import map_cloud_name
from src.sync.moves import normalize_filename
from src.sync.dedup import _cloud_score
from src.common import format_file_size
from src.convert.md_to_note import markdown_to_note_json


# ========== Feature: three_way_merge 测试 ==========

class ThreeWayMergeTest(unittest.TestCase):

    def test_no_conflict_both_sides_add(self):
        from src.sync.merge import three_way_merge
        base = "line1\nline2\nline3\n"
        ours = "line0\nline1\nline2\nline3\n"     # 头部加行
        theirs = "line1\nline2\nline3\nline4\n"    # 尾部加行
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("line0", result.merged_text)
        self.assertIn("line4", result.merged_text)

    def test_no_conflict_one_side_edits(self):
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\nccc\n"
        ours = "aaa\nbbb\nccc\n"     # 没改
        theirs = "aaa\nBBB\nccc\n"   # 改了第二行
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("BBB", result.merged_text)

    def test_conflict_both_edit_same_line(self):
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\nccc\n"
        ours = "aaa\nXXX\nccc\n"
        theirs = "aaa\nYYY\nccc\n"
        result = three_way_merge(base, ours, theirs)
        self.assertTrue(result.has_conflicts)
        self.assertEqual(result.conflict_count, 1)
        self.assertIn("<<<<<<< LOCAL", result.merged_text)
        self.assertIn(">>>>>>> CLOUD", result.merged_text)

    def test_empty_base(self):
        from src.sync.merge import three_way_merge
        result = three_way_merge("", "hello\n", "world\n")
        self.assertIsNotNone(result.merged_text)

    def test_both_same_change_no_conflict(self):
        """双方做了相同修改 → 无冲突"""
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\n"
        ours = "aaa\nXXX\n"
        theirs = "aaa\nXXX\n"
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("XXX", result.merged_text)

    def test_no_changes(self):
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\n"
        result = three_way_merge(base, base, base)
        self.assertFalse(result.has_conflicts)
        self.assertEqual(result.merged_text, base)



# ========== Unit: diff3 merge ====================================

class Diff3MergeTest(unittest.TestCase):

    def test_no_conflict(self):
        from src.sync.merge import three_way_merge
        base = "line1\nline2\nline3\n"
        ours = "line1\nline2_modified\nline3\n"
        theirs = "line1\nline2\nline3_modified\n"
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("line2_modified", result.merged_text)
        self.assertIn("line3_modified", result.merged_text)

    def test_conflict_markers(self):
        from src.sync.merge import three_way_merge
        base = "shared\n"
        ours = "local version\n"
        theirs = "cloud version\n"
        result = three_way_merge(base, ours, theirs)
        self.assertTrue(result.has_conflicts)
        self.assertEqual(result.conflict_count, 1)
        self.assertIn("<<<<<<< LOCAL", result.merged_text)
        self.assertIn(">>>>>>> CLOUD", result.merged_text)
        self.assertIn("local version", result.merged_text)
        self.assertIn("cloud version", result.merged_text)

    def test_both_same_change_no_conflict(self):
        from src.sync.merge import three_way_merge
        base = "old\n"
        ours = "new\n"
        theirs = "new\n"
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertEqual(result.merged_text.strip(), "new")

    def test_empty_base(self):
        from src.sync.merge import three_way_merge
        result = three_way_merge("", "hello\n", "hello\n")
        self.assertFalse(result.has_conflicts)

    def test_one_side_delete(self):
        from src.sync.merge import three_way_merge
        base = "a\nb\nc\n"
        ours = "a\nc\n"  # deleted line b
        theirs = "a\nb\nc\n"  # unchanged
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertNotIn("b\n", result.merged_text)



# ========== E2E: diff3 merge ====================================

class Diff3E2ETest(unittest.TestCase):
    """diff3 完整流程: base 存储 → 合并 → 写入本地"""

    def test_diff3_with_base_storage(self):
        from src.sync.merge import three_way_merge

        base = "line1\nline2\nline3\n"
        ours = "line1\nmodified locally\nline3\n"
        theirs = "line1\nline2\nmodified on cloud\n"

        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("modified locally", result.merged_text)
        self.assertIn("modified on cloud", result.merged_text)

        # Simulate saving base and verifying retrieval
        tmpdir = tempfile.mkdtemp()
        try:
            from src.sync.metadata import SyncMetadata
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
            save_base_content(meta, "test.md",
                             result.merged_text.encode("utf-8"),
                             "merged_hash")
            retrieved = get_base_content(meta, "test.md")
            self.assertEqual(retrieved.decode("utf-8"),
                             result.merged_text)
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Unit: merge.py edge cases ====================================

class MergeNoneInputTest(unittest.TestCase):
    """P1: three_way_merge must reject None inputs."""

    def test_none_base_raises(self):
        from src.sync.merge import three_way_merge
        with self.assertRaises(TypeError):
            three_way_merge(None, "a", "b")

    def test_none_ours_raises(self):
        from src.sync.merge import three_way_merge
        with self.assertRaises(TypeError):
            three_way_merge("base", None, "b")

    def test_none_theirs_raises(self):
        from src.sync.merge import three_way_merge
        with self.assertRaises(TypeError):
            three_way_merge("base", "a", None)

    def test_empty_strings_ok(self):
        from src.sync.merge import three_way_merge
        result = three_way_merge("", "", "")
        self.assertFalse(result.has_conflicts)
        self.assertEqual(result.merged_text, "")



if __name__ == "__main__":
    unittest.main()
