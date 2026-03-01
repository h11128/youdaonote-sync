# -*- coding:utf-8 -*-
"""
同步决策测试（decide_action、filter_by_direction、calibrate_metadata）
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


# ========== decide_action 测试 ==========

class DecideActionTest(unittest.TestCase):
    """
    同步决策逻辑测试
    python -m pytest test/test_sync.py::DecideActionTest -v
    """

    def test_neither_exists(self):
        """两边都不存在 → 跳过"""
        result = decide_action(
            local_exists=False, cloud_exists=False,
            local_mtime=None, cloud_mtime=None,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.SKIP)

    def test_only_local(self):
        """只有本地 → 上传"""
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=1000, cloud_mtime=None,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_only_cloud(self):
        """只有云端 → 下载"""
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=1000,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_unchanged(self):
        """两边都没有变化 → 跳过"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=100, cloud_mtime=100,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.SKIP)

    def test_only_local_changed(self):
        """只有本地修改 → 上传"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=200, cloud_mtime=100,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_only_cloud_changed(self):
        """只有云端修改 → 下载"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=100, cloud_mtime=200,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_changed_local_newer(self):
        """两边都改了，本地更新 → 上传"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=300, cloud_mtime=200,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_both_changed_cloud_newer(self):
        """两边都改了，云端更新 → 下载"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=200, cloud_mtime=300,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_changed_same_time(self):
        """两边都改了，时间相同 → 冲突"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=200, cloud_mtime=200,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.CONFLICT)

    def test_no_metadata_both_exist(self):
        """没有元数据记录，两边都有 → 根据时间决定"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=500, cloud_mtime=300,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.UPLOAD)





class FilterByDirectionTest(unittest.TestCase):
    """filter_by_direction() 按方向过滤"""

    def test_pull_only_download_and_conflict(self):
        """PULL direction → only DOWNLOAD and CONFLICT, SKIP counted separately"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result, skip_count = filter_by_direction(items, SyncDirection.PULL)
        # Then
        self.assertEqual(len(result), 2)
        actions = {i.action for i in result}
        self.assertEqual(actions, {SyncAction.DOWNLOAD, SyncAction.CONFLICT})
        self.assertEqual(skip_count, 2)

    def test_push_only_upload(self):
        """PUSH direction → only UPLOAD, rest are skipped"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result, skip_count = filter_by_direction(items, SyncDirection.PUSH)
        # Then
        self.assertEqual(len(result), 1)
        actions = {i.action for i in result}
        self.assertEqual(actions, {SyncAction.UPLOAD})
        self.assertEqual(skip_count, 3)

    def test_both_returns_non_skip_items(self):
        """BOTH direction → all non-SKIP items, SKIP counted"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result, skip_count = filter_by_direction(items, SyncDirection.BOTH)
        # Then
        self.assertEqual(len(result), 3)
        self.assertEqual(skip_count, 1)





class DecideActionEdgeCaseTest(unittest.TestCase):
    """decide_action 边界条件测试"""

    def test_both_changed_mtime_zero_local_newer(self):
        """两边都变了，cloud_mtime=0 时应根据数值比较（0 不是 None）"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=500, cloud_mtime=0,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_both_changed_local_mtime_zero_cloud_newer(self):
        """local_mtime=0, cloud 有真实时间 → 下载"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=0, cloud_mtime=500,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_mtime_zero_conflict(self):
        """两边 mtime 都是 0 → 冲突"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=0, cloud_mtime=0,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.CONFLICT)





class FilterByDirectionEdgeTest(unittest.TestCase):
    """filter_by_direction 边界测试"""

    def test_empty_list(self):
        """空列表不崩溃"""
        result, skip_count = filter_by_direction([], SyncDirection.BOTH)
        self.assertEqual(result, [])
        self.assertEqual(skip_count, 0)

    def test_all_skip_items(self):
        """全是 SKIP 项"""
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.SKIP),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.SKIP),
        ]
        result, skip_count = filter_by_direction(items, SyncDirection.BOTH)
        self.assertEqual(result, [])
        self.assertEqual(skip_count, 2)



# ========== Feature 5: Content Hash in decide_action 测试 ==========

class ContentHashDecisionTest(unittest.TestCase):

    def test_mtime_changed_hash_same_skips(self):
        """mtime 变了但 hash 相同 → SKIP（文件被 touch 但内容没变）"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=1000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="abc123", meta_hash="abc123")
        self.assertEqual(result, SyncAction.SKIP)

    def test_mtime_changed_hash_different_uploads(self):
        """mtime 变了且 hash 不同 → UPLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=1000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="abc123", meta_hash="def456")
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_no_hash_falls_back_to_mtime(self):
        """没有 hash 时按原 mtime 逻辑"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=1000,
            meta_local_mtime=1000, meta_cloud_mtime=1000)
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_both_changed_hash_same_still_checks_cloud(self):
        """双方 mtime 都变了但本地 hash 同 → 只有云端真正变了 → DOWNLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="abc123", meta_hash="abc123")
        self.assertEqual(result, SyncAction.DOWNLOAD)



# ========== 云端 Hash 三方比较测试 ==========

class CloudHashDecisionTest(unittest.TestCase):
    """三方 hash（local / cloud / meta）参与决策"""

    def test_both_changed_converged_skips(self):
        """双方 mtime 都变了 + cloud_hash == local_hash → 内容一样 → SKIP"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="same_hash", cloud_hash="same_hash", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.SKIP)

    def test_cloud_hash_same_as_meta_means_cloud_not_changed(self):
        """双方 mtime 都变了 + cloud_hash == meta_hash → 云端没真正变 → UPLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="new_local", cloud_hash="old_hash", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_local_hash_same_as_meta_means_local_not_changed(self):
        """双方 mtime 都变了 + local_hash == meta_hash → 本地没真正变 → DOWNLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="old_hash", cloud_hash="new_cloud", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_all_different_remains_conflict(self):
        """三方 hash 全不同 → 真正冲突 → 按 mtime 决定"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="hash_a", cloud_hash="hash_b", meta_hash="hash_c")
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_all_different_local_newer_uploads(self):
        """三方 hash 全不同 + 本地更新 → UPLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=5000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="hash_a", cloud_hash="hash_b", meta_hash="hash_c")
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_all_three_same_skips(self):
        """三方 hash 全相同 → 完全没变 → SKIP"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=2000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="same", cloud_hash="same", meta_hash="same")
        self.assertEqual(result, SyncAction.SKIP)

    def test_only_cloud_hash_no_local_hash_falls_back(self):
        """有 cloud_hash 但没 local_hash → cloud_hash 与 meta_hash 比较仍有效"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            cloud_hash="old_hash", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.UPLOAD)



# ========== Integration: calibrate_metadata + batch ==============

class CalibrateMetadataBatchTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_batch_calibration_multiple_files(self):
        from src.sync.decision import calibrate_metadata
        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)

        cloud_files = {}
        local_files = {}
        for i in range(5):
            name = f"file{i}.md"
            p = os.path.join(local_dir, name)
            with open(p, "w") as f:
                f.write(f"content {i}")
            cloud_files[name] = {
                "id": f"cloud_{i}", "mtime": 1000 + i,
                "parent_id": "root", "domain": 1, "ctime": 900 + i,
                "is_dir": False, "name": name,
            }
            local_files[name] = {
                "path": p, "mtime": 1000 + i, "is_dir": False
            }

        count = calibrate_metadata(self.meta, cloud_files, local_files)
        self.assertEqual(count, 5)
        for i in range(5):
            info = self.meta.get_file_info(f"file{i}.md")
            self.assertIsNotNone(info)
            self.assertEqual(info["file_id"], f"cloud_{i}")

    def test_incomplete_entry_recalibrated(self):
        """last_sync_at=0 且无 content_hash 的记录应被重新校准"""
        from src.sync.decision import calibrate_metadata
        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)

        p = os.path.join(local_dir, "diary.md")
        with open(p, "w") as f:
            f.write("diary content")

        # 模拟从云端扫描导入的不完整记录：file_id 有值，
        # local_mtime 用了 cloud_mtime（1000），但没有 content_hash
        self.meta.set_file_info("diary.md", file_id="F1",
                                cloud_mtime=1000, local_mtime=1000)

        actual_mtime = int(os.path.getmtime(p))
        cloud_files = {
            "diary.md": {"id": "F1", "mtime": 1000, "parent_id": "R",
                         "name": "diary.md", "is_dir": False,
                         "domain": 1, "ctime": 900},
        }
        local_files = {
            "diary.md": {"path": p, "mtime": actual_mtime, "is_dir": False},
        }

        count = calibrate_metadata(self.meta, cloud_files, local_files)
        self.assertEqual(count, 1)

        info = self.meta.get_file_info("diary.md")
        self.assertEqual(info["local_mtime"], actual_mtime)
        self.assertTrue(info.get("content_hash"))
        self.assertGreater(info.get("last_sync_at", 0), 0)

    def test_complete_entry_not_recalibrated(self):
        """有 content_hash 的记录不应被重复校准"""
        from src.sync.decision import calibrate_metadata
        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)

        p = os.path.join(local_dir, "ok.md")
        with open(p, "w") as f:
            f.write("ok content")

        self.meta.set_file_info("ok.md", file_id="F2",
                                cloud_mtime=1000, local_mtime=1000,
                                content_hash="abc123")

        cloud_files = {
            "ok.md": {"id": "F2", "mtime": 1000, "parent_id": "R",
                      "name": "ok.md", "is_dir": False,
                      "domain": 1, "ctime": 900},
        }
        local_files = {
            "ok.md": {"path": p, "mtime": 2000, "is_dir": False},
        }

        count = calibrate_metadata(self.meta, cloud_files, local_files)
        self.assertEqual(count, 0)

        info = self.meta.get_file_info("ok.md")
        self.assertEqual(info["local_mtime"], 1000)
        self.assertEqual(info["content_hash"], "abc123")

    def test_synced_entry_not_recalibrated(self):
        """last_sync_at > 0 的记录不应被重复校准（即使无 hash）"""
        from src.sync.decision import calibrate_metadata
        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)

        p = os.path.join(local_dir, "synced.md")
        with open(p, "w") as f:
            f.write("synced content")

        self.meta.set_file_info("synced.md", file_id="F3",
                                cloud_mtime=1000, local_mtime=1000)
        self.meta.mark_synced("synced.md", ts=999)

        cloud_files = {
            "synced.md": {"id": "F3", "mtime": 1000, "parent_id": "R",
                          "name": "synced.md", "is_dir": False,
                          "domain": 1, "ctime": 900},
        }
        local_files = {
            "synced.md": {"path": p, "mtime": 2000, "is_dir": False},
        }

        count = calibrate_metadata(self.meta, cloud_files, local_files)
        self.assertEqual(count, 0)

        info = self.meta.get_file_info("synced.md")
        self.assertEqual(info["local_mtime"], 1000)





class CalibrateNullHashTest(unittest.TestCase):
    """P1: calibrate_metadata should skip entries where content_hash is None"""

    def test_null_hash_skipped(self):
        from src.sync.metadata import SyncMetadata
        from src.sync.decision import calibrate_metadata

        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

            cloud_files = {
                "missing.md": {"id": "c1", "mtime": 100, "parent_id": "p1",
                               "name": "missing.md", "is_dir": False,
                               "domain": 1, "ctime": 50}
            }
            local_files = {
                "missing.md": {"path": "/nonexistent/path/missing.md",
                               "mtime": 100, "is_dir": False}
            }

            count = calibrate_metadata(meta, cloud_files, local_files)
            info = meta.get_file_info("missing.md")
            self.assertIsNone(info,
                              "Should not create metadata when hash computation fails")
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



if __name__ == "__main__":
    unittest.main()
