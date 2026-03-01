# -*- coding:utf-8 -*-
"""
去重测试（_cloud_score、碰撞防护、删除顺序、Bloom+dedup 集成）
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


# ========== _cloud_score 评分测试 ==========

class CloudScoreTest(unittest.TestCase):
    """
    去重评分逻辑测试
    python -m pytest test/test_sync.py::CloudScoreTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.metadata_path = os.path.join(self.tmpdir, "sync_metadata.json")
        self.meta = SyncMetadata(metadata_path=self.metadata_path)

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_deeper_path_scores_higher(self):
        """路径越深分数越高"""
        # Given
        shallow = "a.md"
        deep = "dir1/dir2/a.md"

        # When
        score_shallow = _cloud_score(shallow, None, self.tmpdir)
        score_deep = _cloud_score(deep, None, self.tmpdir)

        # Then
        self.assertGreater(score_deep, score_shallow)

    def test_shorter_name_scores_higher(self):
        """同一目录下，文件名越短分数越高"""
        # Given — 两个文件在同一级目录
        clean = "dir/test.md"
        messy = "dir/test(1)(14-42-31).md"

        # When
        score_clean = _cloud_score(clean, None, self.tmpdir)
        score_messy = _cloud_score(messy, None, self.tmpdir)

        # Then — 深度相同，clean name 分数更高
        self.assertGreater(score_clean, score_messy)

    def test_earlier_create_time_scores_higher(self):
        """创建时间越早分数越高"""
        # Given
        self.meta.set_file_info("old.md", "WEB1", cloud_mtime=2000, create_time=1000)
        self.meta.set_file_info("new.md", "WEB2", cloud_mtime=2000, create_time=5000)

        # When
        score_old = _cloud_score("old.md", self.meta, self.tmpdir)
        score_new = _cloud_score("new.md", self.meta, self.tmpdir)

        # Then — 同深度同名长度，早创建的分数更高
        self.assertGreater(score_old, score_new)

    def test_score_without_metadata(self):
        """没有元数据时也不崩溃"""
        # When / Then — 不抛异常
        score = _cloud_score("any/path.md", None, self.tmpdir)
        self.assertIsInstance(score, tuple)
        self.assertEqual(len(score), 3)



# ========== 去重碰撞防护测试 ==========

class DedupCollisionTest(unittest.TestCase):
    """
    MD5 碰撞防护测试：同 hash 不同大小的文件不应被去重
    python -m pytest test/test_sync.py::DedupCollisionTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_same_hash_different_size_not_deduped(self):
        """同 hash 但不同大小的文件不当作重复"""
        from src.sync.dedup import auto_dedup

        meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))
        try:
            f1 = os.path.join(self.tmpdir, "file1.md")
            f2 = os.path.join(self.tmpdir, "file2.md")
            with open(f1, "w") as f:
                f.write("short")
            with open(f2, "w") as f:
                f.write("this is a much longer content")

            meta.set_file_info("file1.md", "WEB1", cloud_mtime=1, content_hash="collision_hash")
            meta.set_file_info("file2.md", "WEB2", cloud_mtime=2, content_hash="collision_hash")
            meta.save()

            # When
            stats = auto_dedup(self.tmpdir, metadata=meta, dry_run=True)

            # Then
            self.assertEqual(stats["deleted"], 0)
        finally:
            meta.close()

    def test_same_hash_same_size_deduped(self):
        """同 hash 同大小的文件正常去重"""
        from src.sync.dedup import auto_dedup

        meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))
        try:
            f1 = os.path.join(self.tmpdir, "file1.md")
            f2 = os.path.join(self.tmpdir, "file2.md")
            content = "identical content"
            with open(f1, "w") as f:
                f.write(content)
            with open(f2, "w") as f:
                f.write(content)

            real_hash = SyncMetadata.compute_content_hash(f1)
            meta.set_file_info("file1.md", "WEB1", cloud_mtime=1, content_hash=real_hash)
            meta.set_file_info("file2.md", "WEB2", cloud_mtime=2, content_hash=real_hash)
            meta.save()

            # When
            stats = auto_dedup(self.tmpdir, metadata=meta, dry_run=True)

            # Then
            self.assertEqual(stats["deleted"], 1)
            self.assertEqual(stats["kept"], 1)
        finally:
            meta.close()



# ========== score_func 自定义评分测试 ==========

class CustomScoreFuncTest(unittest.TestCase):
    """
    测试 auto_dedup / _resolve_cloud_group 的 score_func 参数
    python -m pytest test/test_sync.py::CustomScoreFuncTest -v
    """

    def test_custom_score_func_used(self):
        """自定义 score_func 应被 _resolve_cloud_group 使用"""
        from src.sync.dedup import _resolve_cloud_group

        # Given
        tmpdir = tempfile.mkdtemp()
        meta = SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))
        try:
            meta.set_file_info("a/x.md", "WEB1", cloud_mtime=1000, local_mtime=1000)
            meta.set_file_info("b/x.md", "WEB2", cloud_mtime=1000, local_mtime=1000)

            def custom_score(path, metadata, root):
                return 100 if path.startswith("b/") else 0

            # When
            keep, remove = _resolve_cloud_group(
                ["a/x.md", "b/x.md"], meta, set(), tmpdir,
                {"skipped": 0}, score_func=custom_score,
            )

            # Then
            self.assertEqual(keep, ["b/x.md"])
            self.assertEqual(remove, ["a/x.md"])
        finally:
            meta.close()
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== E2E: Bloom + dedup integration =======================

class BloomDedupE2ETest(unittest.TestCase):

    def test_bloom_prefilter_for_dedup(self):
        """Bloom filter 作为去重预过滤：快速排除不存在的 hash"""
        from src.sync.bloom import BloomFilter
        from src.sync.utils import compute_content_hash

        tmpdir = tempfile.mkdtemp()
        try:
            existing_hashes = set()
            bf = BloomFilter(100)

            for i in range(5):
                p = os.path.join(tmpdir, f"file{i}.md")
                with open(p, "w") as f:
                    f.write(f"content {i}")
                h = compute_content_hash(p)
                existing_hashes.add(h)
                bf.add(h)

            # All existing hashes should be "might contain"
            for h in existing_hashes:
                self.assertTrue(bf.might_contain(h))

            # A new file's hash should likely not be in the filter
            new_p = os.path.join(tmpdir, "unique.md")
            with open(new_p, "w") as f:
                f.write("unique content that definitely wasn't seen before xyz123")
            new_h = compute_content_hash(new_p)
            # Can't assert False (FP possible), but check it works
            _ = bf.might_contain(new_h)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class DedupDeleteOrderTest(unittest.TestCase):
    """Dedup deletes local FIRST, then cloud (safe order to prevent data loss)."""

    def test_cloud_failure_still_deletes_local(self):
        """Local delete happens first; cloud failure only affects cloud_deleted stat."""
        from src.sync.dedup import _execute_removals
        from unittest.mock import MagicMock

        tmpdir = tempfile.mkdtemp()
        try:
            local_file = os.path.join(tmpdir, "dup.md")
            with open(local_file, "w") as f:
                f.write("content")

            mock_api = MagicMock()
            mock_api.delete_file.side_effect = Exception("cloud error")
            mock_meta = MagicMock()

            actions = [("dup.md", "cloud_id_123", "keep.md", "duplicate")]
            stats = {"deleted": 1, "cloud_deleted": 1}

            _execute_removals(actions, tmpdir, mock_meta, mock_api,
                              dry_run=False, stats=stats)

            self.assertFalse(os.path.exists(local_file),
                             "Local file should be deleted first (before cloud attempt)")
            self.assertEqual(stats["deleted"], 1, "Local delete succeeded")
            self.assertEqual(stats["cloud_deleted"], 0, "Cloud delete failed, stat decremented")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class DedupDeletionOrderTest(unittest.TestCase):
    """P0-4: Dedup should delete local first, then cloud."""

    def test_local_delete_failure_skips_cloud_delete(self):
        from src.sync.dedup import _execute_removals
        from src.common import safe_long_path

        tmpdir = tempfile.mkdtemp()
        try:
            cloud_deletes = []

            class MockApi:
                def delete_file(self, fid):
                    cloud_deletes.append(fid)

            stats = {"deleted": 1, "cloud_deleted": 1}
            actions = [
                ("nonexistent/file.md", "cloud_id_1", "keep.md", "test reason")
            ]

            _execute_removals(actions, tmpdir, None, MockApi(), dry_run=False, stats=stats)

            self.assertEqual(len(cloud_deletes), 0,
                             "Cloud should NOT be deleted when local delete fails")
            self.assertEqual(stats["deleted"], 0)
            self.assertEqual(stats["cloud_deleted"], 0)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_successful_local_and_cloud_delete(self):
        from src.sync.dedup import _execute_removals

        tmpdir = tempfile.mkdtemp()
        try:
            local_file = os.path.join(tmpdir, "dup.md")
            with open(local_file, "w") as f:
                f.write("content")

            cloud_deletes = []

            class MockApi:
                def delete_file(self, fid):
                    cloud_deletes.append(fid)

            stats = {"deleted": 1, "cloud_deleted": 1}
            actions = [("dup.md", "cloud_id_1", "keep.md", "test reason")]

            _execute_removals(actions, tmpdir, None, MockApi(), dry_run=False, stats=stats)

            self.assertFalse(os.path.exists(local_file))
            self.assertEqual(cloud_deletes, ["cloud_id_1"])
            self.assertEqual(stats["deleted"], 1)
            self.assertEqual(stats["cloud_deleted"], 1)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class DedupStatsLoggingTest(unittest.TestCase):
    """P1-11: Stats in log should reflect actual (post-execution) counts."""

    def test_stats_decremented_on_failure(self):
        from src.sync.dedup import _execute_removals

        tmpdir = tempfile.mkdtemp()
        try:
            stats = {"deleted": 2, "cloud_deleted": 0}
            actions = [
                ("missing1.md", None, "keep.md", "reason1"),
                ("missing2.md", None, "keep.md", "reason2"),
            ]

            _execute_removals(actions, tmpdir, None, None, dry_run=False, stats=stats)

            self.assertEqual(stats["deleted"], 0,
                             "Stats should be decremented for each failed deletion")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class DedupClassifyUnreadableTest(unittest.TestCase):
    """P1: Unreadable files should be skipped, not grouped as sz=-1 duplicates."""

    def test_unreadable_files_skipped(self):
        from src.sync.dedup import _classify_duplicates

        stats = {"skipped": 0}
        raw = {"hash1": ["nonexistent/a.md", "nonexistent/b.md"]}
        tmpdir = tempfile.mkdtemp()
        try:
            result = _classify_duplicates(raw, tmpdir, stats)
            self.assertEqual(len(result), 0,
                             "Unreadable files should not form a duplicate group")
            self.assertEqual(stats["skipped"], 2)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Unit: discard_orphan_duplicates ========================

class DiscardOrphanDuplicatesTest(unittest.TestCase):
    """
    孤儿本地副本检测: 云端移动后旧本地副本应被跳过
    python -m pytest test/test_new_features.py::DiscardOrphanDuplicatesTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.file_a = os.path.join(self.tmpdir, "old", "note.md")
        self.file_b = os.path.join(self.tmpdir, "new", "note.md")
        os.makedirs(os.path.dirname(self.file_a))
        os.makedirs(os.path.dirname(self.file_b))
        with open(self.file_a, "w") as f:
            f.write("same content")
        with open(self.file_b, "w") as f:
            f.write("same content")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_orphan_removed_when_same_name_and_hash(self):
        """same filename + same hash in both → orphan removed from local_files"""
        from src.sync.moves import discard_orphan_duplicates

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 1)
        self.assertNotIn("old/note.md", local_files)
        self.assertIn("new/note.md", local_files)

    def test_different_content_not_removed(self):
        """same filename but different hash → not an orphan"""
        from src.sync.moves import discard_orphan_duplicates

        with open(self.file_a, "w") as f:
            f.write("different content here")

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 0)
        self.assertIn("old/note.md", local_files)

    def test_different_name_not_removed(self):
        """different filename but same hash → not an orphan"""
        from src.sync.moves import discard_orphan_duplicates

        renamed = os.path.join(self.tmpdir, "old", "other.md")
        os.rename(self.file_a, renamed)

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/other.md": {"path": renamed, "mtime": 50, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 0)
        self.assertIn("old/other.md", local_files)

    def test_directory_entries_skipped(self):
        """is_dir entries should not be considered"""
        from src.sync.moves import discard_orphan_duplicates

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "is_dir": True, "parent_id": "",
                                       "name": "new/note.md", "ctime": 0, "domain": 1}}
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": True},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 0)

    def test_no_candidates_returns_zero(self):
        """no only_local files → returns 0"""
        from src.sync.moves import discard_orphan_duplicates

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {"new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False}}

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 0)

    def test_multiple_orphans(self):
        """multiple orphans all removed"""
        from src.sync.moves import discard_orphan_duplicates

        file_c = os.path.join(self.tmpdir, "old", "readme.md")
        file_d = os.path.join(self.tmpdir, "new", "readme.md")
        with open(file_c, "w") as f:
            f.write("readme text")
        with open(file_d, "w") as f:
            f.write("readme text")

        cloud_files = {
            "new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                           "is_dir": False, "ctime": 0, "domain": 1},
            "new/readme.md": {"id": "WEB2", "mtime": 200, "parent_id": "", "name": "new/readme.md",
                             "is_dir": False, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": False},
            "old/readme.md": {"path": file_c, "mtime": 60, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
            "new/readme.md": {"path": file_d, "mtime": 200, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 2)
        self.assertNotIn("old/note.md", local_files)
        self.assertNotIn("old/readme.md", local_files)

    def test_hash_cache_populated(self):
        """hash_cache should be populated for computed hashes"""
        from src.sync.moves import discard_orphan_duplicates

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }
        cache = {}

        discard_orphan_duplicates(cloud_files, local_files, self.tmpdir,
                                  hash_cache=cache)

        self.assertIn(self.file_a, cache)
        self.assertIn(self.file_b, cache)
        self.assertEqual(cache[self.file_a], cache[self.file_b])

    def test_md_formatting_only_diff_treated_as_orphan(self):
        """Markdown files with only formatting diffs (*** vs ---,
        list markers, trailing whitespace) should be treated as orphans"""
        from src.sync.moves import discard_orphan_duplicates

        with open(self.file_a, "w", encoding="utf-8") as f:
            f.write("# Title\n\n***\n\n1.  Item one\n*   Item two\n")
        with open(self.file_b, "w", encoding="utf-8") as f:
            f.write("# Title\n\n---\n\n1. Item one\n- Item two\n")

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 1)
        self.assertNotIn("old/note.md", local_files)

    def test_md_real_content_diff_not_removed(self):
        """Markdown files with actual content differences should NOT be removed"""
        from src.sync.moves import discard_orphan_duplicates

        with open(self.file_a, "w", encoding="utf-8") as f:
            f.write("# Title\n\nOld paragraph with different text.\n")
        with open(self.file_b, "w", encoding="utf-8") as f:
            f.write("# Title\n\nNew paragraph with completely new text.\n")

        cloud_files = {"new/note.md": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/note.md",
                                       "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/note.md": {"path": self.file_a, "mtime": 50, "is_dir": False},
            "new/note.md": {"path": self.file_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 0)
        self.assertIn("old/note.md", local_files)

    def test_non_md_formatting_diff_not_removed(self):
        """Non-.md files with formatting-only diffs should NOT be normalized"""
        from src.sync.moves import discard_orphan_duplicates

        py_a = os.path.join(self.tmpdir, "old", "script.py")
        py_b = os.path.join(self.tmpdir, "new", "script.py")
        with open(py_a, "w") as f:
            f.write("x = 1\n\n\n\ny = 2\n")
        with open(py_b, "w") as f:
            f.write("x = 1\ny = 2\n")

        cloud_files = {"new/script.py": {"id": "WEB1", "mtime": 100, "parent_id": "", "name": "new/script.py",
                                         "is_dir": False, "ctime": 0, "domain": 1}}
        local_files = {
            "old/script.py": {"path": py_a, "mtime": 50, "is_dir": False},
            "new/script.py": {"path": py_b, "mtime": 100, "is_dir": False},
        }

        count = discard_orphan_duplicates(cloud_files, local_files, self.tmpdir)

        self.assertEqual(count, 0)
        self.assertIn("old/script.py", local_files)



if __name__ == "__main__":
    unittest.main()
