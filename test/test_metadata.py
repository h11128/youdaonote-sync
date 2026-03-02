# -*- coding:utf-8 -*-
"""
SyncMetadata 元数据模块测试（CRUD、迁移、GC、verify、heal、扫描缓存）
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
from src.sync.metadata_health import gc, verify, heal
from src.sync.metadata_aux import (
    log_sync_action, get_sync_log, get_file_refs, set_file_refs,
    get_all_cached_refs, save_base_content, get_base_content,
    get_tree_hash, set_tree_hash, get_all_tree_hashes,
)
from src.sync.utils import (
    decide_action, SyncAction, filter_by_direction, SyncDirection,
    SyncItem, VerifyIssueType, sanitize_filename,
)
from src.sync.scanner import map_cloud_name
from src.sync.moves import normalize_filename
from src.sync.dedup import _cloud_score
from src.common import format_file_size
from src.convert.md_to_note import markdown_to_note_json


# ========== SyncMetadata 测试 ==========

class SyncMetadataTest(unittest.TestCase):
    """
    元数据管理测试
    python -m pytest test/test_sync.py::SyncMetadataTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.metadata_path = os.path.join(self.tmpdir, "sync_metadata.json")
        self.meta = SyncMetadata(metadata_path=self.metadata_path)

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_and_load(self):
        """保存后重新打开，数据一致"""
        # Given
        self.meta.set_file_info("a/b.md", "WEB123", cloud_mtime=1000, local_mtime=1000)

        # When
        self.meta.save()
        reloaded = SyncMetadata(metadata_path=self.metadata_path)

        # Then
        self.assertEqual(reloaded.get_file_id("a/b.md"), "WEB123")
        reloaded.close()

    def test_set_and_get_file_info(self):
        """设置文件信息后能正确读取"""
        # When
        self.meta.set_file_info(
            "notes/test.md", "WEBabc123", cloud_mtime=2000,
            local_mtime=2000, parent_id="PARENT1", domain=1,
        )

        # Then
        info = self.meta.get_file_info("notes/test.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEBabc123")
        self.assertEqual(info["cloud_mtime"], 2000)
        self.assertEqual(info["local_mtime"], 2000)
        self.assertEqual(info["parent_id"], "PARENT1")
        self.assertEqual(info["domain"], 1)

    def test_get_file_id_not_found(self):
        """查询不存在的路径返回 None"""
        self.assertIsNone(self.meta.get_file_id("no/such/file.md"))

    def test_remove_file(self):
        """删除后再查询返回 None"""
        # Given
        self.meta.set_file_info("x.md", "WEB1", cloud_mtime=1)

        # When
        self.meta.remove_file_info("x.md")

        # Then
        self.assertIsNone(self.meta.get_file_id("x.md"))

    def test_record_sync_sets_all_fields(self):
        """record_sync atomically writes all metadata fields"""
        # When
        self.meta.record_sync(
            "x.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=100,
            parent_id="DIR1",
            domain=1,
            content_hash="hash_abc",
            cloud_content_hash="hash_abc",
            action="uploaded",
            direction="push",
        )

        # Then
        info = self.meta.get_file_info("x.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")
        self.assertEqual(info["cloud_mtime"], 200)
        self.assertEqual(info["local_mtime"], 100)
        self.assertEqual(info.get("parent_id"), "DIR1")
        self.assertEqual(info.get("domain"), 1)
        self.assertEqual(info.get("content_hash"), "hash_abc")
        self.assertEqual(info.get("cloud_content_hash"), "hash_abc")
        self.assertGreater(info.get("last_sync_at", 0), 0)

    def test_find_by_file_id(self):
        """根据云端 ID 反查本地路径"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1)
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2)

        # Then
        self.assertEqual(self.meta.find_by_file_id("WEBA"), "a.md")
        self.assertEqual(self.meta.find_by_file_id("WEBB"), "b.md")
        self.assertIsNone(self.meta.find_by_file_id("WEBC"))

    def test_directory_operations(self):
        """目录的增删查"""
        # Given / When
        self.meta.set_dir_info("docs", "DIR1", parent_id="ROOT")

        # Then
        self.assertEqual(self.meta.get_dir_id("docs"), "DIR1")
        self.assertEqual(self.meta.find_by_dir_id("DIR1"), "docs")

        # When
        self.meta.remove_dir("docs")

        # Then
        self.assertIsNone(self.meta.get_dir_id("docs"))

    def test_get_all_files(self):
        """获取所有文件记录"""
        # Given
        self.meta.set_file_info("a.md", "A", cloud_mtime=1)
        self.meta.set_file_info("b.md", "B", cloud_mtime=2)

        # When
        all_files = self.meta.get_all_files()

        # Then
        self.assertEqual(len(all_files), 2)
        self.assertIn("a.md", all_files)
        self.assertIn("b.md", all_files)

    def test_path_normalization(self):
        """反斜杠路径被统一为正斜杠"""
        # When
        self.meta.set_file_info("a\\b\\c.md", "WEB1", cloud_mtime=1)

        # Then
        self.assertIsNotNone(self.meta.get_file_info("a/b/c.md"))

    def test_load_corrupt_json_migration_safe(self):
        """损坏的旧 JSON 文件不会导致迁移崩溃"""
        # Given — 写入一个损坏的 JSON 文件
        with open(self.metadata_path, "w") as f:
            f.write("this is not json")

        # When — 创建新实例（会尝试迁移 JSON）
        meta2 = SyncMetadata(metadata_path=self.metadata_path)

        # Then — 不崩溃，数据库为空
        self.assertEqual(meta2.get_all_files(), {})
        meta2.close()

    # ---------- 反向索引 (find_cloud_file_by_hash) ----------

    def test_find_cloud_file_by_hash_hit(self):
        """通过 content_hash 查找云端文件——命中"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")

        # When
        result = self.meta.find_cloud_file_by_hash("abc123")

        # Then
        self.assertEqual(result, "a.md")

    def test_find_cloud_file_by_hash_miss(self):
        """通过 content_hash 查找——未命中"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")

        # When / Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("zzz999"))

    def test_find_cloud_file_by_hash_exclude_self(self):
        """排除自身后，如果没有其他匹配则返回 None"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")

        # When
        result = self.meta.find_cloud_file_by_hash("abc123", exclude_path="a.md")

        # Then
        self.assertIsNone(result)

    def test_find_cloud_file_by_hash_exclude_self_with_other(self):
        """排除自身后，返回另一个匹配"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2, content_hash="abc123")

        # When
        result = self.meta.find_cloud_file_by_hash("abc123", exclude_path="a.md")

        # Then
        self.assertEqual(result, "b.md")

    def test_find_cloud_file_by_hash_ignores_no_file_id(self):
        """没有 file_id 的文件不会被查询命中"""
        # Given — file_id 为空字符串
        self.meta.set_file_info("local.md", "", cloud_mtime=1, local_mtime=1, content_hash="abc123")

        # When / Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("abc123"))

    def test_hash_index_survives_save_reload(self):
        """保存后重新打开，hash 查询仍正常"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="hash1")
        self.meta.save()

        # When
        reloaded = SyncMetadata(metadata_path=self.metadata_path)

        # Then
        self.assertEqual(reloaded.find_cloud_file_by_hash("hash1"), "a.md")
        reloaded.close()

    def test_hash_index_updated_on_remove(self):
        """删除文件后反向索引同步清理"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="hash1")

        # When
        self.meta.remove_file_info("a.md")

        # Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("hash1"))

    def test_hash_index_reindex_on_remove(self):
        """删除文件后，同 hash 的其他文件仍可通过 hash 查找"""
        # Given — 两个文件共享同一个 content_hash
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="shared")
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2, content_hash="shared")

        # When — 删除其中一个
        self.meta.remove_file_info("a.md")

        # Then — 另一个仍可查到
        result = self.meta.find_cloud_file_by_hash("shared")
        self.assertEqual(result, "b.md")

    def test_hash_index_updated_on_update_content_hash(self):
        """update_content_hash 后反向索引更新"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="old")

        # When
        self.meta.update_content_hash("a.md", "new")

        # Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("old"))
        self.assertEqual(self.meta.find_cloud_file_by_hash("new"), "a.md")


    # ---- cache_cloud_file_info 测试 ----

    def test_cache_cloud_creates_new_record(self):
        """cache_cloud_file_info 新记录：写入 file_id/cloud_mtime，local_mtime=0"""
        self.meta.cache_cloud_file_info("cloud.md", "WEB1", cloud_mtime=5000,
                                        parent_id="P1", domain=1)

        info = self.meta.get_file_info("cloud.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")
        self.assertEqual(info["cloud_mtime"], 5000)
        self.assertEqual(info["local_mtime"], 0)

    def test_cache_cloud_preserves_existing_mtime(self):
        """cache_cloud_file_info 已有记录：只更新 file_id，保留 cloud_mtime 和 local_mtime"""
        # Given: 已同步的文件（有 cloud_mtime 和 local_mtime）
        self.meta.set_file_info("synced.md", "OLD_ID", cloud_mtime=1000,
                                local_mtime=2000)

        # When: 扫描缓存更新 file_id
        self.meta.cache_cloud_file_info("synced.md", "NEW_ID", cloud_mtime=9999)

        # Then: file_id 更新，但 mtime 保留原值
        info = self.meta.get_file_info("synced.md")
        self.assertEqual(info["file_id"], "NEW_ID")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 2000)

    def test_cache_cloud_empty_path_raises(self):
        """cache_cloud_file_info 空路径抛 ValueError"""
        with self.assertRaises(ValueError):
            self.meta.cache_cloud_file_info("", "WEB1", cloud_mtime=100)



# ========== 第三轮审查补全测试 ==========


class MetadataPartialUpdateTest(unittest.TestCase):
    """UPSERT 部分更新 + domain=0 + close 安全性测试"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(
            metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_partial_update_preserves_existing_fields(self):
        """先设全字段，再只更新 file_id+cloud_mtime，原有字段应保留"""
        # Given
        self.meta.set_file_info(
            "a.md", "WEB1", cloud_mtime=1000, local_mtime=1000,
            parent_id="P1", domain=1, content_hash="abc123",
            create_time=500,
        )

        # When — 第二次调用只传必需参数
        self.meta.set_file_info("a.md", "WEB1", cloud_mtime=2000)

        # Then — 可选字段应保留原值
        info = self.meta.get_file_info("a.md")
        self.assertEqual(info["cloud_mtime"], 2000)
        self.assertEqual(info["content_hash"], "abc123")
        self.assertEqual(info["domain"], 1)
        self.assertEqual(info["parent_id"], "P1")
        self.assertEqual(info["create_time"], 500)

    def test_domain_zero_preserved(self):
        """domain=0（普通笔记）不应被过滤"""
        # When
        self.meta.set_file_info(
            "note.md", "WEB1", cloud_mtime=1000, domain=0)

        # Then
        info = self.meta.get_file_info("note.md")
        self.assertIn("domain", info)
        self.assertEqual(info["domain"], 0)

    def test_domain_zero_in_get_all_files(self):
        """get_all_files 也应包含 domain=0"""
        self.meta.set_file_info(
            "note.md", "WEB1", cloud_mtime=1000, domain=0)

        all_files = self.meta.get_all_files()
        self.assertIn("domain", all_files["note.md"])
        self.assertEqual(all_files["note.md"]["domain"], 0)

    def test_close_twice_no_crash(self):
        """close() 调用两次不应抛异常"""
        self.meta.close()
        self.meta.close()

    def test_find_cloud_file_by_hash_ignores_null_rows(self):
        """content_hash 为 NULL 的行不应被 find_cloud_file_by_hash 匹配"""
        # Given — 一行有 hash，一行无 hash（NULL）
        self.meta.set_file_info(
            "a.md", "WEB1", cloud_mtime=1000, content_hash="abc")
        self.meta.set_file_info(
            "b.md", "WEB2", cloud_mtime=1000)

        # When — 搜索 "abc"
        result = self.meta.find_cloud_file_by_hash("abc")
        self.assertEqual(result, "a.md")

        # When — 搜索 None
        result_none = self.meta.find_cloud_file_by_hash(None)
        self.assertIsNone(result_none)



# ========== Feature 1: WAL Checkpoint 测试 ==========

class WalCheckpointTest(unittest.TestCase):
    """metadata.save() 每 50 次触发 WAL checkpoint"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_count_increments(self):
        for i in range(10):
            self.meta.set_file_info(f"f{i}.md", "WEB1", cloud_mtime=1000)
            self.meta.save()
        self.assertEqual(self.meta._save_count, 10)

    def test_checkpoint_runs_without_error_at_50(self):
        """50 次 save 后 WAL checkpoint 不报错（间接验证：若 checkpoint 出错会被静默吞掉）"""
        for i in range(51):
            self.meta.set_file_info(f"f{i}.md", "WEB1", cloud_mtime=1000)
            self.meta.save()
        self.assertEqual(self.meta._save_count, 51)

    def test_maybe_wal_checkpoint_is_called(self):
        """直接调用 _maybe_wal_checkpoint 验证不抛异常"""
        self.meta._save_count = 49
        self.meta._maybe_wal_checkpoint()
        self.assertEqual(self.meta._save_count, 50)



# ========== Feature 3: Delete Tracking 测试 ==========

class DeleteTrackingTest(unittest.TestCase):
    """delete tracking: previously_synced → SKIP"""

    def test_local_only_new_file_uploads(self):
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=1000, cloud_mtime=None,
            meta_local_mtime=None, meta_cloud_mtime=None,
            previously_synced=False)
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_local_only_previously_synced_skips(self):
        """本地有 + 云端没 + 之前同步过 → 云端已删除 → SKIP"""
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=1000, cloud_mtime=None,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.SKIP)

    def test_cloud_only_new_file_downloads(self):
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=2000,
            meta_local_mtime=None, meta_cloud_mtime=None,
            previously_synced=False)
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_cloud_only_previously_synced_skips(self):
        """本地没 + 云端有 + 之前同步过 + 云端未修改 → 本地已删除 → SKIP"""
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=2000,
            meta_local_mtime=1000, meta_cloud_mtime=2000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.SKIP)

    def test_local_only_previously_synced_but_modified_uploads(self):
        """本地有 + 云端没 + 之前同步过 + 本地有修改 → 重新上传"""
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=2000, cloud_mtime=None,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_cloud_only_previously_synced_but_modified_downloads(self):
        """本地没 + 云端有 + 之前同步过 + 云端有修改 → 重新下载"""
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=2000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_mark_synced_sets_timestamp(self):
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
            meta.set_file_info("a.md", "WEB1", cloud_mtime=100)
            meta.mark_synced("a.md", ts=12345)
            info = meta.get_file_info("a.md")
            self.assertEqual(info["last_sync_at"], 12345)
            meta.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_last_sync_at_default_zero(self):
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
            meta.set_file_info("b.md", "WEB2", cloud_mtime=200)
            info = meta.get_file_info("b.md")
            self.assertNotIn("last_sync_at", info)
            meta.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Feature: GC 测试 ==========

class MetadataGCTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_gc_removes_orphan_files(self):
        """本地不存在 + last_sync_at 过期 → 被清理"""
        import time
        self.meta.set_file_info("gone.md", "WEB1", cloud_mtime=100)
        self.meta.mark_synced("gone.md", ts=int(time.time()) - 40 * 86400)
        self.meta.save()

        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["files"], 1)
        self.assertIsNone(self.meta.get_file_info("gone.md"))

    def test_gc_keeps_existing_files(self):
        """本地存在的文件不被清理"""
        import time
        path = os.path.join(self.local_dir, "exist.md")
        with open(path, "w") as f:
            f.write("hi")
        self.meta.set_file_info("exist.md", "WEB2", cloud_mtime=100)
        self.meta.mark_synced("exist.md", ts=int(time.time()) - 40 * 86400)
        self.meta.save()

        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["files"], 0)
        self.assertIsNotNone(self.meta.get_file_info("exist.md"))

    def test_gc_removes_orphan_dirs(self):
        self.meta.set_dir_info("old_dir", "DIR1", "ROOT")
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["dirs"], 1)

    def test_gc_cleans_old_sync_log(self):
        """超过 max_log_age_days 的日志被清理"""
        import time
        old_ts = int(time.time()) - 100 * 86400
        log_sync_action(self.meta, "a.md", "downloaded", timestamp_override=old_ts)
        log_sync_action(self.meta, "b.md", "uploaded")
        self.meta.save()

        stats = gc(self.meta, self.local_dir, max_log_age_days=90)
        self.assertEqual(stats["logs"], 1)
        remaining = get_sync_log(self.meta)
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["path"], "b.md")

    def test_gc_removes_orphan_base(self):
        """file_base 中文件不存在 → 被清理"""
        save_base_content(self.meta, "phantom.md", b"old", "hash1")
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["bases"], 1)



# ========== Feature: verify 测试 ==========

class MetadataVerifyTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_verify_detects_orphan(self):
        self.meta.set_file_info("missing.md", "WEB1", cloud_mtime=100)
        self.meta.save()
        issues = verify(self.meta, self.local_dir)
        self.assertTrue(any(t == VerifyIssueType.ORPHAN for _, t, _ in issues))

    def test_verify_detects_hash_mismatch(self):
        from src.sync.utils import compute_content_hash
        path = os.path.join(self.local_dir, "changed.md")
        with open(path, "w") as f:
            f.write("original")
        real_hash = compute_content_hash(path)
        self.meta.set_file_info("changed.md", "WEB2", cloud_mtime=100,
                                content_hash="fake_hash_that_wont_match")
        self.meta.save()
        issues = verify(self.meta, self.local_dir)
        self.assertTrue(any(t == VerifyIssueType.HASH_MISMATCH for _, t, _ in issues))

    def test_verify_auto_fix(self):
        from src.sync.utils import compute_content_hash
        path = os.path.join(self.local_dir, "fix.md")
        with open(path, "w") as f:
            f.write("data")
        self.meta.set_file_info("fix.md", "WEB3", cloud_mtime=100,
                                content_hash="wrong")
        self.meta.save()
        issues = verify(self.meta, self.local_dir, auto_fix=True)
        self.assertTrue(len(issues) > 0)
        info = self.meta.get_file_info("fix.md")
        actual = compute_content_hash(path)
        self.assertEqual(info["content_hash"], actual)

    def test_verify_clean_passes(self):
        path = os.path.join(self.local_dir, "ok.md")
        with open(path, "w") as f:
            f.write("fine")
        from src.sync.utils import compute_content_hash
        h = compute_content_hash(path)
        self.meta.set_file_info("ok.md", "WEB4", cloud_mtime=100,
                                content_hash=h)
        self.meta.save()
        issues = verify(self.meta, self.local_dir)
        self.assertEqual(len(issues), 0)



# ========== record_sync 测试 ==========

class RecordSyncTest(unittest.TestCase):
    """metadata.record_sync — single atomic post-sync write"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_creates_new_record(self):
        self.meta.record_sync(
            "a/test.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=100,
            parent_id="DIR1",
            domain=1,
            content_hash="hash_a",
            action="uploaded",
            direction="push",
        )
        info = self.meta.get_file_info("a/test.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")
        self.assertEqual(info["cloud_mtime"], 200)
        self.assertEqual(info["local_mtime"], 100)
        self.assertEqual(info.get("parent_id"), "DIR1")
        self.assertEqual(info.get("domain"), 1)
        self.assertEqual(info.get("content_hash"), "hash_a")
        self.assertGreater(info.get("last_sync_at", 0), 0)

    def test_updates_existing_record(self):
        self.meta.set_file_info("b.md", "WEB1", cloud_mtime=100, local_mtime=50)
        self.meta.record_sync(
            "b.md",
            file_id="WEB1",
            cloud_mtime=300,
            local_mtime=200,
            content_hash="hash_b",
            action="downloaded",
            direction="pull",
        )
        info = self.meta.get_file_info("b.md")
        self.assertEqual(info["cloud_mtime"], 300)
        self.assertEqual(info["local_mtime"], 200)
        self.assertEqual(info.get("content_hash"), "hash_b")

    def test_preserves_optional_fields_on_update(self):
        self.meta.set_file_info("c.md", "WEB1", cloud_mtime=100, local_mtime=50,
                                parent_id="DIR1", domain=1)
        self.meta.record_sync(
            "c.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=150,
        )
        info = self.meta.get_file_info("c.md")
        self.assertEqual(info.get("parent_id"), "DIR1")
        self.assertEqual(info.get("domain"), 1)

    def test_sets_original_domain_once(self):
        self.meta.record_sync(
            "d.md",
            file_id="WEB1",
            cloud_mtime=100,
            local_mtime=50,
            original_domain=0,
            action="downloaded",
            direction="pull",
        )
        self.assertEqual(self.meta.get_original_domain("d.md"), 0)

        self.meta.record_sync(
            "d.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=150,
            original_domain=1,
        )
        self.assertEqual(self.meta.get_original_domain("d.md"), 0)

    def test_writes_sync_log(self):
        self.meta.record_sync(
            "e.md",
            file_id="WEB1",
            cloud_mtime=100,
            local_mtime=50,
            action="uploaded",
            direction="push",
        )
        logs = get_sync_log(self.meta, limit=10, path="e.md")
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["path"], "e.md")
        self.assertEqual(logs[0]["action"], "uploaded")
        self.assertEqual(logs[0]["direction"], "push")

    def test_empty_path_raises(self):
        with self.assertRaises(ValueError):
            self.meta.record_sync(
                "",
                file_id="WEB1",
                cloud_mtime=100,
                local_mtime=50,
            )



# ========== heal 测试 ==========

class MetadataHealTest(unittest.TestCase):
    """metadata.heal — lightweight self-healing pass"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_detects_orphan_without_file_id(self):
        self.meta.set_file_info("ghost.md", "", cloud_mtime=0, local_mtime=100)
        self.meta.save()
        stats = heal(self.meta, self.local_dir, auto_fix=False)
        self.assertEqual(stats["orphan"], 1)
        self.assertIsNotNone(self.meta.get_file_info("ghost.md"))

    def test_fixes_orphan_when_auto_fix(self):
        self.meta.set_file_info("ghost.md", "", cloud_mtime=0, local_mtime=100)
        self.meta.save()
        heal(self.meta, self.local_dir, auto_fix=True)
        self.assertIsNone(self.meta.get_file_info("ghost.md"))

    def test_detects_mtime_drift(self):
        from src.sync.utils import compute_content_hash
        fpath = os.path.join(self.local_dir, "drift.md")
        with open(fpath, "w") as f:
            f.write("same content")
        real_hash = compute_content_hash(fpath)
        real_mtime = int(os.path.getmtime(fpath))

        self.meta.set_file_info("drift.md", "WEB1", cloud_mtime=100,
                                local_mtime=real_mtime - 100,
                                content_hash=real_hash)
        self.meta.save()

        stats = heal(self.meta, self.local_dir, auto_fix=False)
        self.assertEqual(stats["mtime_drift"], 1)

    def test_fixes_mtime_drift(self):
        from src.sync.utils import compute_content_hash
        fpath = os.path.join(self.local_dir, "drift2.md")
        with open(fpath, "w") as f:
            f.write("same content 2")
        real_hash = compute_content_hash(fpath)
        real_mtime = int(os.path.getmtime(fpath))

        self.meta.set_file_info("drift2.md", "WEB1", cloud_mtime=100,
                                local_mtime=real_mtime - 50,
                                content_hash=real_hash)
        self.meta.save()

        heal(self.meta, self.local_dir, auto_fix=True)
        info = self.meta.get_file_info("drift2.md")
        self.assertEqual(info["local_mtime"], real_mtime)

    def test_backfills_missing_hash(self):
        fpath = os.path.join(self.local_dir, "nohash.md")
        with open(fpath, "w") as f:
            f.write("need hash")
        self.meta.set_file_info("nohash.md", "WEB1", cloud_mtime=100,
                                local_mtime=int(os.path.getmtime(fpath)))
        self.meta.save()

        stats = heal(self.meta, self.local_dir, auto_fix=True)
        self.assertEqual(stats["hash_backfill"], 1)
        info = self.meta.get_file_info("nohash.md")
        self.assertIsNotNone(info.get("content_hash"))

    def test_detects_zero_cloud_mtime(self):
        fpath = os.path.join(self.local_dir, "zerocloud.md")
        with open(fpath, "w") as f:
            f.write("zero cloud")
        self.meta.set_file_info("zerocloud.md", "WEB1", cloud_mtime=0,
                                local_mtime=100)
        self.meta.save()

        stats = heal(self.meta, self.local_dir, auto_fix=False)
        self.assertEqual(stats["zero_cloud"], 1)

    def test_clean_metadata_reports_nothing(self):
        from src.sync.utils import compute_content_hash
        fpath = os.path.join(self.local_dir, "ok.md")
        with open(fpath, "w") as f:
            f.write("all good")
        real_hash = compute_content_hash(fpath)
        real_mtime = int(os.path.getmtime(fpath))
        self.meta.set_file_info("ok.md", "WEB1", cloud_mtime=100,
                                local_mtime=real_mtime,
                                content_hash=real_hash)
        self.meta.save()

        stats = heal(self.meta, self.local_dir, auto_fix=False)
        self.assertEqual(sum(stats.values()), 0)



# ========== 扫描缓存测试 ==========

class SyncStateTest(unittest.TestCase):
    """sync_state 表的 get/set 操作"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()

    def test_get_state_missing_returns_none(self):
        """未设置的 key 返回 None"""
        self.assertIsNone(self.meta.get_state("nonexistent"))

    def test_set_and_get_state(self):
        """写入后能读回"""
        self.meta.set_state("my_key", "hello")
        self.assertEqual(self.meta.get_state("my_key"), "hello")

    def test_set_state_upsert(self):
        """重复写入同 key 更新值"""
        self.meta.set_state("k", "v1")
        self.meta.set_state("k", "v2")
        self.assertEqual(self.meta.get_state("k"), "v2")

    def test_get_state_int(self):
        """get_state_int 正确解析整数"""
        self.meta.set_state("ver", "12345")
        self.assertEqual(self.meta.get_state_int("ver"), 12345)

    def test_get_state_int_default(self):
        """get_state_int 缺失时返回 default"""
        self.assertEqual(self.meta.get_state_int("missing", 99), 99)

    def test_get_state_int_invalid(self):
        """get_state_int 非整数字符串返回 default"""
        self.meta.set_state("bad", "not_a_number")
        self.assertEqual(self.meta.get_state_int("bad", 0), 0)

    def test_state_persists_across_reopen(self):
        """关闭再打开后 state 仍在"""
        self.meta.set_state("persist", "yes")
        self.meta.save()
        self.meta.close()
        meta2 = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.assertEqual(meta2.get_state("persist"), "yes")
        meta2.close()





class ScanCacheTest(unittest.TestCase):
    """SyncManager 的扫描缓存逻辑（_load_cloud_files_from_cache 等）"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.api = _FakeApi()
        self.manager = _make_manager(self.api, self.local_dir, self.meta)

    def tearDown(self):
        self.meta.close()

    def test_empty_cache_returns_empty(self):
        """metadata 为空时 _load_cloud_files_from_cache 返回空 dict"""
        result = self.manager._load_cloud_files_from_cache()
        self.assertEqual(result, {})

    def test_cache_roundtrip_files(self):
        """set_file_info → _load_cloud_files_from_cache 返回正确结构"""
        self.meta.set_file_info("docs/hello.md", file_id="F1",
                                cloud_mtime=1000, parent_id="D1",
                                domain=1, create_time=900)
        result = self.manager._load_cloud_files_from_cache()

        self.assertIn("docs/hello.md", result)
        info = result["docs/hello.md"]
        self.assertEqual(info["id"], "F1")
        self.assertEqual(info["parent_id"], "D1")
        self.assertFalse(info["is_dir"])
        self.assertEqual(info["mtime"], 1000)
        self.assertEqual(info["domain"], 1)

    def test_cache_excludes_dirs(self):
        """目录不从缓存加载（避免幽灵目录导致虚假 DOWNLOAD）"""
        self.meta.set_dir_info("docs", dir_id="D1", parent_id="ROOT")
        result = self.manager._load_cloud_files_from_cache()
        self.assertNotIn("docs", result)

    def test_cache_excludes_conflict_files(self):
        """.conflict. 文件不从缓存加载（scan_local 也跳过它们）"""
        self.meta.set_file_info(
            "diary/04-13.conflict.20260214_190827.md",
            file_id="C1", cloud_mtime=1000)
        self.meta.set_file_info("diary/normal.md",
                                file_id="C2", cloud_mtime=2000)
        result = self.manager._load_cloud_files_from_cache()
        self.assertNotIn("diary/04-13.conflict.20260214_190827.md", result)
        self.assertIn("diary/normal.md", result)

    def test_cache_skips_local_only_files(self):
        """没有 file_id 的纯本地文件不出现在缓存中"""
        self.meta.set_file_info("local.md", file_id="",
                                cloud_mtime=0)
        result = self.manager._load_cloud_files_from_cache()
        self.assertNotIn("local.md", result)

    def test_save_scan_version(self):
        """_save_scan_version 写入 metadata 并记录 version"""
        cloud_files = {
            "a.md": {"id": "F1", "parent_id": "R", "name": "a.md",
                     "is_dir": False, "mtime": 500, "ctime": 400, "domain": 1},
            "dir1": {"id": "D1", "parent_id": "R", "name": "dir1",
                     "is_dir": True, "mtime": 0, "ctime": 0, "domain": 0},
        }
        self.manager._save_scan_version(cloud_files, 999)

        self.assertEqual(self.meta.get_state_int("last_cloud_version"), 999)
        self.assertIsNotNone(self.meta.get_state("last_scan_time"))
        self.assertEqual(self.meta.get_file_id("a.md"), "F1")
        self.assertEqual(self.meta.get_dir_id("dir1"), "D1")

    def test_save_scan_version_preserves_synced_mtime(self):
        """_save_scan_version 不覆盖已同步文件的 cloud_mtime/local_mtime"""
        # Given: 文件已同步，有 cloud_mtime=1000 和 local_mtime=2000
        self.meta.set_file_info("synced.md", "F1", cloud_mtime=1000,
                                local_mtime=2000)

        # When: 全量扫描写入缓存（云端 mtime 可能已变为 3000）
        cloud_files = {
            "synced.md": {"id": "F1", "parent_id": "R", "name": "synced.md",
                          "is_dir": False, "mtime": 3000, "ctime": 0, "domain": 1},
        }
        self.manager._save_scan_version(cloud_files, 100)

        # Then: cloud_mtime 和 local_mtime 保持不变（由 cache_cloud_file_info 保证）
        info = self.meta.get_file_info("synced.md")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 2000)

    def test_cleanup_stale_paths(self):
        """_cleanup_stale_paths 清理云端已不存在的文件记录"""
        # Given: metadata 中有 3 个文件
        self.meta.set_file_info("alive.md", "F1", cloud_mtime=100)
        self.meta.set_file_info("dead.md", "F2", cloud_mtime=200)
        self.meta.set_file_info("local_only.md", "", cloud_mtime=0)

        # When: 云端扫描只包含 alive.md
        cloud_files = {
            "alive.md": {"id": "F1", "parent_id": "R", "name": "alive.md",
                         "is_dir": False, "mtime": 100, "ctime": 0, "domain": 1},
        }
        self.manager._cleanup_stale_paths(cloud_files)

        # Then: dead.md 的 file_id 被清空，alive.md 和 local_only.md 不受影响
        self.assertIsNone(self.meta.get_file_id("dead.md"))
        self.assertEqual(self.meta.get_file_id("alive.md"), "F1")

    def test_apply_incremental_preserves_synced_mtime(self):
        """_apply_incremental_changes 不覆盖已同步文件的 cloud_mtime/local_mtime"""
        # Given: 文件已同步
        self.meta.set_file_info("note.md", "F1", cloud_mtime=1000,
                                local_mtime=2000)
        cloud_files = {
            "note.md": {"id": "F1", "parent_id": "R", "name": "note.md",
                        "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1},
        }

        # When: 增量更新带来新的 cloud mtime
        changed = [_fake_entry("F1", "note.md", version=600, mtime=5000)]
        self.manager._apply_incremental_changes(cloud_files, changed)

        # Then: cloud_files 记录了新 mtime（供 decide_action 比较用）
        self.assertEqual(cloud_files["note.md"]["mtime"], 5000)
        # 但 metadata 中保留原始 mtime（代表"上次同步时"的值）
        info = self.meta.get_file_info("note.md")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 2000)

    def test_try_cached_no_version_returns_none(self):
        """没有 cached version 时返回 None"""
        from unittest.mock import patch
        with patch.object(self.manager, "_try_seed_from_desktop", return_value=False):
            result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNone(result)

    def test_try_cached_fresh_returns_cache(self):
        """缓存 version >= 云端 version 时返回缓存"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "500")
        self.api._recent = [_fake_entry("F1", "a.md", version=500)]

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNotNone(result)
        self.assertIn("a.md", result)

    def test_try_cached_stale_small_change_incremental(self):
        """缓存过期但变化量 < 30 时做增量更新"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "500")

        self.api._recent = [
            _fake_entry("F1", "a.md", version=501, mtime=200),
            _fake_entry("F2", "old.md", version=400),
        ]

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNotNone(result)
        self.assertIn("a.md", result)
        self.assertEqual(result["a.md"]["mtime"], 200)
        self.assertEqual(self.meta.get_state_int("last_cloud_version"), 501)

    def test_try_cached_stale_all_changed_full_scan(self):
        """所有 listRecent 条目都比缓存新 → 无法确定完整变更集 → 返回 None"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "100")

        self.api._recent = [
            _fake_entry("F1", "a.md", version=501),
            _fake_entry("F2", "b.md", version=502),
            _fake_entry("F3", "c.md", version=503),
        ]

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNone(result)

    def test_try_cached_api_fail_uses_stale_cache(self):
        """listRecent 失败时使用旧缓存"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "500")
        self.api._recent_error = True

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNotNone(result)
        self.assertIn("a.md", result)





class IncrementalUpdateTest(unittest.TestCase):
    """_apply_incremental_changes 增量更新逻辑"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.api = _FakeApi()
        self.manager = _make_manager(self.api,
                                     os.path.join(self.tmpdir, "notes"),
                                     self.meta)

    def tearDown(self):
        self.meta.close()

    def test_update_existing_file(self):
        """已有文件的 mtime 被更新"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        cloud_files = self.manager._load_cloud_files_from_cache()

        changed = [_fake_entry("F1", "a.md", version=600, mtime=999)]
        self.manager._apply_incremental_changes(cloud_files, changed)

        self.assertEqual(cloud_files["a.md"]["mtime"], 999)

    def test_update_existing_dir(self):
        """已有目录被更新"""
        self.meta.set_dir_info("docs", dir_id="D1", parent_id="ROOT")
        cloud_files = self.manager._load_cloud_files_from_cache()

        changed = [_fake_entry("D1", "docs", version=600, is_dir=True,
                               parent_id="ROOT2")]
        self.manager._apply_incremental_changes(cloud_files, changed)

        self.assertEqual(cloud_files["docs"]["parent_id"], "ROOT2")

    def test_new_file_not_in_cache_logged(self):
        """新文件（缓存中没有对应 file_id）不会崩溃"""
        cloud_files = {}
        changed = [_fake_entry("FNEW", "brand_new.md", version=700)]
        self.manager._apply_incremental_changes(cloud_files, changed)

    def test_skip_empty_entries(self):
        """空 id 或空 name 的条目被跳过"""
        cloud_files = {}
        changed = [
            {"fileEntry": {"id": "", "name": "x.md", "version": 1}},
            {"fileEntry": {"id": "F1", "name": "", "version": 1}},
        ]
        self.manager._apply_incremental_changes(cloud_files, changed)
        self.assertEqual(cloud_files, {})





class ListRecentApiTest(unittest.TestCase):
    """api.list_recent 和 _safe_json_list"""

    def test_safe_json_list_with_list(self):
        """正常列表响应"""
        from src.api import YoudaoNoteApi
        import unittest.mock as mock
        resp = mock.Mock()
        resp.json.return_value = [{"a": 1}, {"b": 2}]
        result = YoudaoNoteApi._safe_json_list(resp)
        self.assertEqual(len(result), 2)

    def test_safe_json_list_with_dict(self):
        """非列表响应返回空列表"""
        from src.api import YoudaoNoteApi
        import unittest.mock as mock
        resp = mock.Mock()
        resp.json.return_value = {"error": "bad"}
        result = YoudaoNoteApi._safe_json_list(resp)
        self.assertEqual(result, [])

    def test_safe_json_list_with_exception(self):
        """解析异常返回空列表"""
        from src.api import YoudaoNoteApi
        import unittest.mock as mock
        resp = mock.Mock()
        resp.json.side_effect = ValueError("bad json")
        result = YoudaoNoteApi._safe_json_list(resp)
        self.assertEqual(result, [])





class FetchCurrentVersionTest(unittest.TestCase):
    """_fetch_current_version"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.api = _FakeApi()
        self.manager = _make_manager(self.api,
                                     os.path.join(self.tmpdir, "notes"),
                                     self.meta)

    def tearDown(self):
        self.meta.close()

    def test_returns_max_version(self):
        """返回 listRecent 第一条的 version"""
        self.api._recent = [_fake_entry("F1", "a.md", version=888)]
        self.assertEqual(self.manager._fetch_current_version(), 888)

    def test_returns_zero_on_empty(self):
        """listRecent 空时返回 0"""
        self.api._recent = []
        self.assertEqual(self.manager._fetch_current_version(), 0)

    def test_returns_zero_on_error(self):
        """listRecent 报错时返回 0"""
        self.api._recent_error = True
        self.assertEqual(self.manager._fetch_current_version(), 0)



# ========== Phase 3: original_domain 测试 ==========

class OriginalDomainTest(unittest.TestCase):
    """original_domain 记录与查询"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()

    def test_set_and_get_original_domain(self):
        """设置后能读回 original_domain"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        self.assertEqual(self.meta.get_original_domain("a.md"), 0)

    def test_original_domain_not_overwritten(self):
        """set_original_domain 只在值为 NULL 时写入"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        self.meta.set_original_domain("a.md", 1)
        self.assertEqual(self.meta.get_original_domain("a.md"), 0)

    def test_original_domain_none_when_unset(self):
        """未设置时返回 None"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.assertIsNone(self.meta.get_original_domain("a.md"))

    def test_original_domain_in_get_file_info(self):
        """get_file_info 返回 original_domain"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        info = self.meta.get_file_info("a.md")
        self.assertEqual(info["original_domain"], 0)

    def test_original_domain_absent_in_get_file_info_when_unset(self):
        """get_file_info 不含 original_domain 当未设置时"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        info = self.meta.get_file_info("a.md")
        self.assertNotIn("original_domain", info)

    def test_original_domain_survives_save_reload(self):
        """保存后重新打开仍保留"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        self.meta.save()
        self.meta.close()
        meta2 = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.assertEqual(meta2.get_original_domain("a.md"), 0)
        meta2.close()

    def test_original_domain_in_get_all_files(self):
        """get_all_files 包含 original_domain"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        files = self.meta.get_all_files()
        self.assertEqual(files["a.md"]["original_domain"], 0)

    def test_nonexistent_path_returns_none(self):
        """查询不存在的路径返回 None"""
        self.assertIsNone(self.meta.get_original_domain("no/such/file.md"))



# ========== 测试辅助 ==========

def _fake_entry(fid, name, version=0, mtime=0, ctime=0, domain=0,
                is_dir=False, parent_id="ROOT"):
    """构造一个 listRecent 风格的条目"""
    return {
        "fileEntry": {
            "id": fid,
            "name": name,
            "version": version,
            "modifyTimeForSort": mtime,
            "createTimeForSort": ctime,
            "domain": domain,
            "dir": is_dir,
            "parentId": parent_id,
        }
    }





class _FakeApi:
    """最小化的 API mock，用于扫描缓存测试"""

    def __init__(self):
        self._recent = []
        self._recent_error = False
        self.cstk = "fake_cstk"
        self.DIR_MES_URL = "http://fake/{dir_id}"
        self.DIR_PAGE_SIZE = 100

    def list_recent(self, limit=30):
        if self._recent_error:
            raise ConnectionError("API unavailable")
        return self._recent[:limit]

    def create_async_client(self):
        raise NotImplementedError("Should not be called when cache is used")





def _make_manager(api, local_dir, metadata):
    """构造一个用于测试的 SyncManager（不需要 downloader/uploader）"""
    from src.sync.engine import SyncManager
    os.makedirs(local_dir, exist_ok=True)
    return SyncManager(
        api=api,
        local_dir=local_dir,
        metadata=metadata,
        downloader=None,
        uploader=None,
    )



# ========== metadata rename_path 测试 ==========

class MetadataRenamePathTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_rename_preserves_all_fields(self):
        """rename_path 保留 file_id、content_hash 等所有字段"""
        self.meta.set_file_info("old/doc.md", file_id="F1", cloud_mtime=1000,
                                local_mtime=900, content_hash="h123")
        self.meta.set_original_domain("old/doc.md", 0)

        result = self.meta.rename_path("old/doc.md", "new/doc.md")
        self.assertTrue(result)

        self.assertIsNone(self.meta.get_file_info("old/doc.md"))
        info = self.meta.get_file_info("new/doc.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "F1")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 900)
        self.assertEqual(info["content_hash"], "h123")
        self.assertEqual(info["original_domain"], 0)

    def test_rename_nonexistent_returns_false(self):
        """重命名不存在的路径返回 False"""
        result = self.meta.rename_path("no/such.md", "new.md")
        self.assertFalse(result)

    def test_rename_with_conflict_removes_old(self):
        """目标路径已存在时：删除旧路径记录（不崩溃）"""
        self.meta.set_file_info("old.md", file_id="F1", cloud_mtime=100)
        self.meta.set_file_info("new.md", file_id="F2", cloud_mtime=200)

        result = self.meta.rename_path("old.md", "new.md")
        self.assertFalse(result)
        self.assertIsNone(self.meta.get_file_info("old.md"))



# ========== Unit: metadata schema extensions =====================

class MetadataSchemaExtensionTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = self._make_meta()

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_meta(self):
        from src.sync.metadata import SyncMetadata
        return SyncMetadata(os.path.join(self.tmpdir, "test.json"))

    # -- sync_log --
    def test_log_sync_action_roundtrip(self):
        log_sync_action(self.meta, "a.md", "downloaded", direction="pull",
                                  old_hash="aaa", new_hash="bbb",
                                  cloud_id="c1", detail="ok")
        self.meta.save()
        logs = get_sync_log(self.meta, limit=10)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["path"], "a.md")
        self.assertEqual(logs[0]["action"], "downloaded")
        self.assertEqual(logs[0]["cloud_id"], "c1")

    def test_get_sync_log_filter_by_path(self):
        log_sync_action(self.meta, "a.md", "downloaded")
        log_sync_action(self.meta, "b.md", "uploaded")
        self.meta.save()
        logs = get_sync_log(self.meta, path="b.md")
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["path"], "b.md")

    # -- cloud_content_hash --
    def test_cloud_content_hash_roundtrip(self):
        self.meta.set_file_info("a.md", "f1", 100)
        self.meta.set_cloud_content_hash("a.md", "xyz123")
        self.meta.save()
        self.assertEqual(self.meta.get_cloud_content_hash("a.md"), "xyz123")

    def test_cloud_content_hash_in_file_info(self):
        self.meta.set_file_info("a.md", "f1", 100)
        self.meta.set_cloud_content_hash("a.md", "abc")
        info = self.meta.get_file_info("a.md")
        self.assertEqual(info["cloud_content_hash"], "abc")

    # -- file_refs --
    def test_file_refs_roundtrip(self):
        set_file_refs(self.meta, "doc.md", ["img/a.png", "img/b.jpg"])
        refs = get_file_refs(self.meta, "doc.md")
        self.assertEqual(sorted(refs), ["img/a.png", "img/b.jpg"])

    def test_file_refs_replace(self):
        set_file_refs(self.meta, "doc.md", ["old.png"])
        set_file_refs(self.meta, "doc.md", ["new.png"])
        self.assertEqual(get_file_refs(self.meta, "doc.md"), ["new.png"])

    def test_get_all_cached_refs(self):
        set_file_refs(self.meta, "a.md", ["x.png"])
        set_file_refs(self.meta, "b.md", ["y.png", "z.png"])
        all_refs = get_all_cached_refs(self.meta)
        self.assertIn("a.md", all_refs)
        self.assertEqual(len(all_refs["b.md"]), 2)

    # -- file_base --
    def test_base_content_roundtrip(self):
        content = b"original content here"
        save_base_content(self.meta, "a.md", content, "hash1")
        self.assertEqual(get_base_content(self.meta, "a.md"), content)

    def test_base_content_overwrite(self):
        save_base_content(self.meta, "a.md", b"v1", "h1")
        save_base_content(self.meta, "a.md", b"v2", "h2")
        self.assertEqual(get_base_content(self.meta, "a.md"), b"v2")

    def test_base_content_missing(self):
        self.assertIsNone(get_base_content(self.meta, "nonexistent.md"))

    # -- tree_hash --
    def test_tree_hash_roundtrip(self):
        self.meta.set_dir_info("notes", "d1")
        set_tree_hash(self.meta, "notes", "tree_abc")
        self.assertEqual(get_tree_hash(self.meta, "notes"), "tree_abc")

    def test_get_all_tree_hashes(self):
        self.meta.set_dir_info("a", "d1")
        self.meta.set_dir_info("b", "d2")
        set_tree_hash(self.meta, "a", "h1")
        set_tree_hash(self.meta, "b", "h2")
        hashes = get_all_tree_hashes(self.meta)
        self.assertEqual(hashes, {"a": "h1", "b": "h2"})

    # -- migration tracking --
    def test_migration_idempotent(self):
        self.meta.set_file_info("a.md", "f1", 100, content_hash="abc")
        self.meta.save()
        self.meta.close()
        meta2 = self._make_meta()
        info = meta2.get_file_info("a.md")
        self.assertEqual(info["content_hash"], "abc")
        meta2.close()



# ========== Unit: GC ============================================

class GarbageCollectionTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_gc_removes_orphan_files(self):
        old_ts = int(time.time()) - 40 * 86400
        self.meta.set_file_info("gone.md", "f1", 100)
        self.meta.mark_synced("gone.md", ts=old_ts)
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["files"], 1)
        self.assertIsNone(self.meta.get_file_info("gone.md"))

    def test_gc_keeps_existing_files(self):
        p = os.path.join(self.local_dir, "exists.md")
        with open(p, "w") as f:
            f.write("hello")
        old_ts = int(time.time()) - 40 * 86400
        self.meta.set_file_info("exists.md", "f1", 100)
        self.meta.mark_synced("exists.md", ts=old_ts)
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["files"], 0)
        self.assertIsNotNone(self.meta.get_file_info("exists.md"))

    def test_gc_removes_orphan_dirs(self):
        self.meta.set_dir_info("deleted_dir", "d1")
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["dirs"], 1)

    def test_gc_removes_old_logs(self):
        old_ts = int(time.time()) - 100 * 86400
        self.meta._conn.execute(
            "INSERT INTO sync_log (timestamp, path, action) VALUES (?, ?, ?)",
            (old_ts, "old.md", "uploaded"))
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["logs"], 1)

    def test_gc_removes_orphan_bases(self):
        save_base_content(self.meta, "gone.md", b"content", "h1")
        self.meta.save()
        stats = gc(self.meta, self.local_dir)
        self.assertEqual(stats["bases"], 1)



# ========== Unit: verify ========================================

class VerifyTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_detects_orphan(self):
        self.meta.set_file_info("gone.md", "f1", 100)
        issues = verify(self.meta, self.local_dir)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0][1], VerifyIssueType.ORPHAN)

    def test_detects_hash_mismatch(self):
        p = os.path.join(self.local_dir, "test.md")
        with open(p, "w") as f:
            f.write("actual content")
        self.meta.set_file_info("test.md", "f1", 100,
                                content_hash="wrong_hash")
        issues = verify(self.meta, self.local_dir)
        hash_issues = [i for i in issues if i[1] == VerifyIssueType.HASH_MISMATCH]
        self.assertEqual(len(hash_issues), 1)

    def test_auto_fix_hash(self):
        p = os.path.join(self.local_dir, "test.md")
        with open(p, "w") as f:
            f.write("actual content")
        self.meta.set_file_info("test.md", "f1", 100,
                                content_hash="wrong_hash")
        verify(self.meta, self.local_dir, auto_fix=True)
        info = self.meta.get_file_info("test.md")
        self.assertNotEqual(info["content_hash"], "wrong_hash")





class MetadataMigrationFailureTest(unittest.TestCase):
    """P1: failed migration should NOT be recorded in _migrations"""

    def test_failed_migration_not_recorded(self):
        from src.sync.metadata import SyncMetadata
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "test.json"))
            applied = {r[0] for r in meta._conn.execute(
                "SELECT idx FROM _migrations").fetchall()}
            for i in range(len(meta._conn.execute(
                    "SELECT idx FROM _migrations").fetchall())):
                self.assertIn(i, applied)
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class MetadataRemoveFileUnifiedTest(unittest.TestCase):
    """remove_file_info deletes metadata correctly"""

    def test_remove_file_info(self):
        from src.sync.metadata import SyncMetadata
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "test.json"))
            meta.set_file_info("a.md", "f1", 100)
            self.assertIsNotNone(meta.get_file_info("a.md"))

            meta.remove_file_info("a.md")
            self.assertIsNone(meta.get_file_info("a.md"))

            meta.set_file_info("b.md", "f2", 200)
            meta.remove_file_info("b.md")
            self.assertIsNone(meta.get_file_info("b.md"))
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Bug Fixes Regression Tests =========================================

class MetadataBatchRollbackTest(unittest.TestCase):
    """P0-1: batch() should rollback on exception, not commit partial data."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_batch_commits_on_success(self):
        with self.meta.batch() as m:
            m.set_file_info("a.md", "id1", 100, 100)

        info = self.meta.get_file_info("a.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "id1")

    def test_batch_rollbacks_on_exception(self):
        self.meta.set_file_info("existing.md", "id0", 50, 50)
        self.meta.save()

        try:
            with self.meta.batch() as m:
                m.set_file_info("bad.md", "id_bad", 200, 200)
                raise ValueError("simulated failure")
        except ValueError:
            pass

        info = self.meta.get_file_info("bad.md")
        self.assertIsNone(info, "Partial data should NOT be committed after exception")

        existing = self.meta.get_file_info("existing.md")
        self.assertIsNotNone(existing, "Pre-existing data should survive rollback")





class MetadataContextManagerTest(unittest.TestCase):
    """P1-8: SyncMetadata supports with-statement."""

    def test_context_manager(self):
        tmpdir = tempfile.mkdtemp()
        try:
            path = os.path.join(tmpdir, "meta.json")
            with SyncMetadata(metadata_path=path) as meta:
                meta.set_file_info("test.md", "id1", 100, 100)
                meta.save()

            meta2 = SyncMetadata(metadata_path=path)
            info = meta2.get_file_info("test.md")
            meta2.close()
            self.assertIsNotNone(info)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class MetadataInitFailureTest(unittest.TestCase):
    """P1-6: __init__ should close connection if migration fails."""

    def test_init_closes_conn_on_failure(self):
        tmpdir = tempfile.mkdtemp()
        try:
            db_path = os.path.join(tmpdir, "meta.db")
            import sqlite3
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE _migrations (idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
            conn.execute("INSERT INTO _migrations VALUES (0, 0)")
            conn.execute("CREATE TABLE files (path TEXT)")
            conn.commit()
            conn.close()

            with self.assertRaises(Exception):
                SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class MetadataSetTreeHashUpsertTest(unittest.TestCase):
    """P2: set_tree_hash should create row if not exists."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_set_tree_hash_creates_missing_dir(self):
        set_tree_hash(self.meta, "some/new/dir", "abc123")
        result = get_tree_hash(self.meta, "some/new/dir")
        self.assertEqual(result, "abc123")

    def test_set_tree_hash_updates_existing_dir(self):
        self.meta.set_dir_info("existing/dir", "dir_id_1", "parent_id_1")
        set_tree_hash(self.meta, "existing/dir", "hash_v1")
        self.assertEqual(get_tree_hash(self.meta, "existing/dir"), "hash_v1")

        set_tree_hash(self.meta, "existing/dir", "hash_v2")
        self.assertEqual(get_tree_hash(self.meta, "existing/dir"), "hash_v2")
        self.assertEqual(self.meta.get_dir_id("existing/dir"), "dir_id_1")



if __name__ == "__main__":
    unittest.main()
