# -*- coding:utf-8 -*-
"""
移动检测测试（reconcile_moves、_execute_cloud_moves、跨目录移动）
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




class DetectCloudMovesTest(unittest.TestCase):
    """_detect_cloud_moves 错误处理测试"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(
            metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_source_missing_skips_move_and_restores_state(self):
        """源文件不存在时：完整恢复原始状态（local_files + only_local + only_cloud）"""
        from src.sync.moves import _detect_cloud_moves

        self.meta.set_file_info(
            "old/a.md", "WEB1", cloud_mtime=1000, local_mtime=1000)

        only_local = {"old/a.md"}
        only_cloud = {"new/a.md"}
        cloud_files = {
            "new/a.md": {"id": "WEB1", "parent_id": "P2", "name": "a.md",
                         "is_dir": False, "mtime": 2000, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/a.md": {"path": os.path.join(self.tmpdir, "old", "a.md"),
                         "mtime": 1000, "is_dir": False},
        }
        cloud_id_to_path = {"WEB1": "new/a.md"}

        count = _detect_cloud_moves(
            only_local, only_cloud, cloud_id_to_path,
            cloud_files, local_files, self.meta,
            local_dir=self.tmpdir, dry_run=False,
        )

        self.assertEqual(count, 0)
        self.assertIn("old/a.md", local_files,
                       "Original entry must be restored in local_files")
        self.assertNotIn("new/a.md", local_files,
                         "Target path must not remain in local_files")
        self.assertIn("old/a.md", only_local,
                       "Original path must be restored in only_local")
        self.assertIn("new/a.md", only_cloud,
                       "Cloud path should remain so engine downloads it")

    def test_shutil_move_failure_restores_state(self):
        """shutil.move 失败时应恢复 dict 状态"""
        from unittest.mock import patch
        from src.sync.moves import _detect_cloud_moves

        # Given — 源文件存在，但目标目录无法创建
        src_dir = os.path.join(self.tmpdir, "old")
        os.makedirs(src_dir, exist_ok=True)
        src_file = os.path.join(src_dir, "a.md")
        with open(src_file, "w") as f:
            f.write("content")

        self.meta.set_file_info(
            "old/a.md", "WEB1", cloud_mtime=1000, local_mtime=1000)

        only_local = {"old/a.md"}
        only_cloud = {"new/a.md"}
        cloud_files = {
            "new/a.md": {"id": "WEB1", "parent_id": "P2", "name": "a.md",
                         "is_dir": False, "mtime": 2000, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/a.md": {"mtime": 1000, "is_dir": False, "path": src_file},
        }
        cloud_id_to_path = {"WEB1": "new/a.md"}

        # When — 模拟 shutil.move 抛 OSError
        with patch("src.sync.moves.shutil.move",
                    side_effect=OSError("Permission denied")):
            count = _detect_cloud_moves(
                only_local, only_cloud, cloud_id_to_path,
                cloud_files, local_files, self.meta,
                local_dir=self.tmpdir, dry_run=False,
            )

        # Then — 状态应恢复
        self.assertEqual(count, 0)
        self.assertIn("old/a.md", only_local)
        self.assertIn("new/a.md", only_cloud)
        self.assertIn("old/a.md", local_files)

    def test_dry_run_does_not_move_or_update_metadata(self):
        """dry_run 模式不应移动文件或更新 metadata"""
        from src.sync.moves import _detect_cloud_moves

        # Given
        src_dir = os.path.join(self.tmpdir, "old")
        os.makedirs(src_dir)
        src_file = os.path.join(src_dir, "a.md")
        with open(src_file, "w") as f:
            f.write("content")

        self.meta.set_file_info(
            "old/a.md", "WEB1", cloud_mtime=1000, local_mtime=1000)

        only_local = {"old/a.md"}
        only_cloud = {"new/a.md"}
        cloud_files = {
            "new/a.md": {"id": "WEB1", "parent_id": "P2", "name": "a.md",
                         "is_dir": False, "mtime": 2000, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/a.md": {"mtime": 1000, "is_dir": False, "path": src_file},
        }
        cloud_id_to_path = {"WEB1": "new/a.md"}

        # When
        count = _detect_cloud_moves(
            only_local, only_cloud, cloud_id_to_path,
            cloud_files, local_files, self.meta,
            local_dir=self.tmpdir, dry_run=True,
        )

        # Then — 文件未移动
        self.assertEqual(count, 1)
        self.assertTrue(os.path.exists(src_file))
        # metadata 中旧路径不应被删除
        self.assertIsNotNone(self.meta.get_file_info("old/a.md"))



# ========== Feature: 跨目录移动方向感知 测试 ==========

class CrossDirMoveDirectionTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_local_wins_when_newer(self):
        """本地 mtime 更新 → 保留本地路径，云端文件排队删除"""
        from src.sync.moves import _detect_cross_dir_duplicates
        from src.sync.utils import compute_content_hash
        import xxhash

        h = xxhash.xxh3_128(b"same content").hexdigest()

        local_path = os.path.join(self.local_dir, "new_dir", "doc.md")
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "w") as f:
            f.write("same content")

        only_local = {"new_dir/doc.md"}
        only_cloud = {"old_dir/doc.md"}
        cloud_files = {
            "old_dir/doc.md": {"id": "CLOUD1", "parent_id": "P1", "name": "doc.md",
                               "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1}
        }
        local_files = {
            "new_dir/doc.md": {"path": local_path, "mtime": 2000, "is_dir": False}
        }
        self.meta.set_file_info("old_dir/doc.md", "CLOUD1",
                                cloud_mtime=1000, content_hash=h)
        self.meta.save()

        hash_cache = {local_path: h}
        count, pending = _detect_cross_dir_duplicates(
            only_local, only_cloud, cloud_files, local_files,
            self.meta, self.local_dir, dry_run=True, hash_cache=hash_cache)

        self.assertEqual(count, 1)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].file_id, "CLOUD1")
        self.assertEqual(pending[0].new_local_path, "new_dir/doc.md")
        self.assertNotIn("old_dir/doc.md", cloud_files)
        self.assertIn("new_dir/doc.md", only_local)

    def test_cloud_wins_when_newer(self):
        """云端 mtime 更新 → 本地跟随云端路径"""
        from src.sync.moves import _detect_cross_dir_duplicates
        import xxhash

        h = xxhash.xxh3_128(b"same content").hexdigest()

        local_path = os.path.join(self.local_dir, "old_dir", "doc.md")
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "w") as f:
            f.write("same content")

        only_local = {"old_dir/doc.md"}
        only_cloud = {"new_dir/doc.md"}
        cloud_files = {
            "new_dir/doc.md": {"id": "CLOUD1", "parent_id": "P1", "name": "doc.md",
                               "is_dir": False, "mtime": 3000, "ctime": 100, "domain": 1}
        }
        local_files = {
            "old_dir/doc.md": {"path": local_path, "mtime": 1000, "is_dir": False}
        }
        self.meta.set_file_info("new_dir/doc.md", "CLOUD1",
                                cloud_mtime=3000, content_hash=h)
        self.meta.save()

        hash_cache = {local_path: h}
        count, pending = _detect_cross_dir_duplicates(
            only_local, only_cloud, cloud_files, local_files,
            self.meta, self.local_dir, dry_run=False, hash_cache=hash_cache)

        self.assertEqual(count, 1)
        self.assertEqual(len(pending), 0)
        self.assertNotIn("old_dir/doc.md", only_local)
        self.assertIn("new_dir/doc.md", local_files)

    def test_pending_deletes_include_local_path_and_domain(self):
        """pending tuple 包含 4 个元素: (file_id, old_cloud_path, new_local_path, domain)"""
        from src.sync.moves import _detect_cross_dir_duplicates
        import xxhash

        h = xxhash.xxh3_128(b"content").hexdigest()
        local_path = os.path.join(self.local_dir, "a", "f.md")
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "w") as f:
            f.write("content")

        only_local = {"a/f.md"}
        only_cloud = {"b/f.md"}
        cloud_files = {
            "b/f.md": {"id": "C1", "parent_id": "P", "name": "f.md",
                        "is_dir": False, "mtime": 500, "ctime": 0, "domain": 1}
        }
        local_files = {
            "a/f.md": {"path": local_path, "mtime": 1000, "is_dir": False}
        }
        self.meta.set_file_info("b/f.md", "C1", cloud_mtime=500, content_hash=h)
        self.meta.save()

        hash_cache = {local_path: h}
        count, pending = _detect_cross_dir_duplicates(
            only_local, only_cloud, cloud_files, local_files,
            self.meta, self.local_dir, dry_run=True, hash_cache=hash_cache)

        self.assertEqual(count, 1)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].file_id, "C1")
        self.assertEqual(pending[0].old_cloud_path, "b/f.md")
        self.assertEqual(pending[0].new_local_path, "a/f.md")
        self.assertEqual(pending[0].domain, 1)



# ========== _execute_cloud_moves 测试 ==========

class ExecuteCloudMovesTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_manager(self):
        from src.sync.engine import SyncManager
        from unittest.mock import MagicMock

        api = MagicMock()
        api.move_file.return_value = {"responseCode": 0}
        api.rename_file.return_value = {"responseCode": 0}

        uploader = MagicMock()
        uploader.ensure_parent_dir.return_value = "NEW_PARENT_ID"

        mgr = SyncManager(
            api=api, local_dir=self.local_dir, metadata=self.meta,
            downloader=None, uploader=uploader)
        return mgr, api, uploader

    def test_move_calls_api_and_updates_metadata(self):
        """成功移动: 调用 move_file API + metadata 从旧路径迁移到新路径"""
        mgr, api, _ = self._make_manager()

        self.meta.set_file_info("old_dir/doc.md", file_id="F1",
                                cloud_mtime=1000, content_hash="abc")

        local_file = os.path.join(self.local_dir, "new_dir", "doc.md")
        os.makedirs(os.path.dirname(local_file), exist_ok=True)
        with open(local_file, "w") as f:
            f.write("content")

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F1", "old_dir/doc.md", "new_dir/doc.md", 1)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, {"new_dir/doc.md"})
        api.move_file.assert_called_once_with("F1", "NEW_PARENT_ID", 1)
        api.rename_file.assert_not_called()

        self.assertIsNone(self.meta.get_file_info("old_dir/doc.md"))
        info = self.meta.get_file_info("new_dir/doc.md")
        self.assertEqual(info["file_id"], "F1")
        self.assertEqual(info["content_hash"], "abc")

    def test_move_with_rename(self):
        """文件名也变了时，同时调用 rename_file"""
        mgr, api, _ = self._make_manager()

        self.meta.set_file_info("old/a.md", file_id="F2", cloud_mtime=500)

        local_file = os.path.join(self.local_dir, "new", "b.md")
        os.makedirs(os.path.dirname(local_file), exist_ok=True)
        with open(local_file, "w") as f:
            f.write("x")

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F2", "old/a.md", "new/b.md", 1)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, {"new/b.md"})
        api.move_file.assert_called_once()
        api.rename_file.assert_called_once_with("F2", "b.md", 1)

    def test_move_failure_falls_back(self):
        """move_file API 抛异常 → 存入 _failed_moves"""
        mgr, api, _ = self._make_manager()
        api.move_file.side_effect = Exception("API error")

        self.meta.set_file_info("old/f.md", file_id="F3", cloud_mtime=100)

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F3", "old/f.md", "new/f.md", 1)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, set())
        self.assertEqual(len(mgr._failed_moves), 1)
        self.assertIsNotNone(self.meta.get_file_info("old/f.md"))

    def test_ensure_parent_failure_falls_back(self):
        """ensure_parent_dir 返回 None → 存入 _failed_moves"""
        mgr, api, uploader = self._make_manager()
        uploader.ensure_parent_dir.return_value = None

        self.meta.set_file_info("old/g.md", file_id="F4", cloud_mtime=100)

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F4", "old/g.md", "new/g.md", 0)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, set())
        self.assertEqual(len(mgr._failed_moves), 1)
        api.move_file.assert_not_called()



class MovesGhostEntryTest(unittest.TestCase):
    """P0-3: When source file doesn't exist, don't create ghost local_files entry."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_cloud_move_missing_source_restores_state(self):
        from src.sync.moves import _detect_cloud_moves

        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir)

        self.meta.set_file_info("old/file.md", "fid1", 100, 100)
        self.meta.save()

        local_files = {
            "old/file.md": {"path": os.path.join(local_dir, "old/file.md"), "mtime": 100, "is_dir": False}
        }
        cloud_files = {
            "new/file.md": {"id": "fid1", "mtime": 200, "is_dir": False, "parent_id": "p1", "domain": 1, "ctime": 50,
                           "name": "new/file.md"}
        }

        only_local = {"old/file.md"}
        only_cloud = {"new/file.md"}
        cloud_id_to_path = {"fid1": "new/file.md"}

        _detect_cloud_moves(
            only_local, only_cloud, cloud_id_to_path,
            cloud_files, local_files, self.meta, local_dir, dry_run=False)

        self.assertIn("old/file.md", local_files,
                       "Original entry must be restored after failed move")
        self.assertNotIn("new/file.md", local_files,
                         "Target path must not remain in local_files")
        self.assertIn("old/file.md", only_local,
                       "Original path must be restored in only_local")
        self.assertIn("new/file.md", only_cloud,
                       "Cloud path should remain for engine to download")



# ========== Unit: moves.py _common_ancestor_depth ========================

class CommonAncestorDepthTest(unittest.TestCase):

    def test_same_parent(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("a/b/c.md", "a/b/d.md"), 2)

    def test_no_common(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("x/a.md", "y/b.md"), 0)

    def test_root_files(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("a.md", "b.md"), 0)

    def test_one_level_common(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("docs/a.md", "docs/sub/b.md"), 1)

    def test_backslash_normalized(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("a\\b\\c.md", "a\\b\\d.md"), 2)



# ========== Unit: reconcile_moves integration ============================

class ReconcileMovesIntegrationTest(unittest.TestCase):
    """Integration test for the full reconcile_moves pipeline."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "test_meta.db"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_file_id_move_detected(self):
        from src.sync.moves import reconcile_moves

        src_dir = os.path.join(self.local_dir, "old")
        os.makedirs(src_dir)
        with open(os.path.join(src_dir, "a.md"), "w") as f:
            f.write("content")

        self.meta.set_file_info("old/a.md", "WEB1", cloud_mtime=100, local_mtime=100)
        self.meta.save()

        cloud_files = {
            "new/a.md": {"id": "WEB1", "mtime": 200, "is_dir": False,
                         "parent_id": "P2", "domain": 1, "ctime": 0,
                         "name": "new/a.md"},
        }
        local_files = {
            "old/a.md": {"mtime": 100, "is_dir": False,
                         "path": os.path.join(self.local_dir, "old/a.md")},
        }

        pending = reconcile_moves(
            cloud_files, local_files, self.meta,
            self.local_dir, dry_run=False)

        self.assertNotIn("old/a.md", local_files)
        self.assertIn("new/a.md", local_files)
        self.assertTrue(os.path.exists(os.path.join(self.local_dir, "new/a.md")))
        self.assertEqual(pending, [])

    def test_dry_run_no_disk_changes(self):
        from src.sync.moves import reconcile_moves

        self.meta.set_file_info("old/b.md", "WEB2", cloud_mtime=100, local_mtime=100)
        self.meta.save()

        cloud_files = {
            "new/b.md": {"id": "WEB2", "mtime": 200, "is_dir": False,
                         "parent_id": "P3", "domain": 1, "ctime": 0,
                         "name": "new/b.md"},
        }
        local_files = {
            "old/b.md": {"mtime": 100, "is_dir": False,
                         "path": os.path.join(self.local_dir, "old/b.md")},
        }

        reconcile_moves(cloud_files, local_files, self.meta,
                        self.local_dir, dry_run=True)

        self.assertIn("new/b.md", local_files)
        self.assertNotIn("old/b.md", local_files)

    def test_no_moves_returns_empty(self):
        from src.sync.moves import reconcile_moves

        cloud_files = {"a.md": {"id": "WEB1", "mtime": 100, "is_dir": False, "parent_id": "", "name": "a.md",
                                "ctime": 0, "domain": 1}}
        local_files = {"a.md": {"mtime": 100, "is_dir": False, "path": "x"}}

        pending = reconcile_moves(cloud_files, local_files, self.meta,
                                  self.local_dir, dry_run=True)
        self.assertEqual(pending, [])



# ========== Unit: _move_local_file helper ================================

class MoveLocalFileHelperTest(unittest.TestCase):
    """Unit tests for the extracted _move_local_file helper."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmpdir, "old"))
        with open(os.path.join(self.tmpdir, "old/a.md"), "w") as f:
            f.write("test content")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_successful_move(self):
        from src.sync.moves import _move_local_file
        local_files = {"new/a.md": {"path": os.path.join(self.tmpdir, "old/a.md"), "is_dir": False, "mtime": 0}}
        only_local = set()
        only_cloud = set()

        result = _move_local_file(
            self.tmpdir, "old/a.md", "new/a.md",
            local_files, only_local, only_cloud, dry_run=False)

        self.assertTrue(result)
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, "new/a.md")))
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, "old/a.md")))

    def test_missing_source_reverts(self):
        from src.sync.moves import _move_local_file
        local_files = {"new/a.md": {"path": "nonexistent", "is_dir": False, "mtime": 0}}
        only_local = set()
        only_cloud = set()

        result = _move_local_file(
            self.tmpdir, "missing/a.md", "new/a.md",
            local_files, only_local, only_cloud, dry_run=False)

        self.assertFalse(result)
        self.assertIn("missing/a.md", local_files)
        self.assertNotIn("new/a.md", local_files)
        self.assertIn("missing/a.md", only_local)
        self.assertIn("new/a.md", only_cloud)

    def test_dry_run_no_disk_change(self):
        from src.sync.moves import _move_local_file
        local_files = {"new/a.md": {"path": os.path.join(self.tmpdir, "old/a.md"), "is_dir": False, "mtime": 0}}
        only_local = set()
        only_cloud = set()

        result = _move_local_file(
            self.tmpdir, "old/a.md", "new/a.md",
            local_files, only_local, only_cloud, dry_run=True)

        self.assertTrue(result)
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, "old/a.md")))



if __name__ == "__main__":
    unittest.main()
