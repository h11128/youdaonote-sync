# -*- coding:utf-8 -*-
"""
引擎集成测试（dry_run E2E、sync_log、domain、lock、retry）
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


# ========== Feature 2: PID Lock 测试 ==========

class SyncLockTest(unittest.TestCase):
    """_SyncLock PID 锁"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_acquire_and_release(self):
        from src.sync.engine import _SyncLock
        lock = _SyncLock(self.tmpdir)
        self.assertTrue(lock.acquire())
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, ".sync.lock")))
        lock.release()
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, ".sync.lock")))

    def test_double_acquire_same_pid_succeeds(self):
        """同一进程的 PID 存活检查 → 返回 False（已有实例）"""
        from src.sync.engine import _SyncLock
        lock1 = _SyncLock(self.tmpdir)
        lock2 = _SyncLock(self.tmpdir)
        self.assertTrue(lock1.acquire())
        self.assertFalse(lock2.acquire())
        lock1.release()

    def test_stale_lock_taken_over(self):
        """过期锁被接管"""
        from src.sync.engine import _SyncLock
        import json, time
        lock_path = os.path.join(self.tmpdir, ".sync.lock")
        with open(lock_path, "w") as f:
            json.dump({"pid": 99999999, "started": time.time() - 7200}, f)

        lock = _SyncLock(self.tmpdir)
        self.assertTrue(lock.acquire())
        lock.release()

    def test_dead_pid_lock_taken_over(self):
        """PID 不存在时锁被接管"""
        from src.sync.engine import _SyncLock
        import json, time
        lock_path = os.path.join(self.tmpdir, ".sync.lock")
        with open(lock_path, "w") as f:
            json.dump({"pid": 99999999, "started": time.time()}, f)

        lock = _SyncLock(self.tmpdir)
        self.assertTrue(lock.acquire())
        lock.release()



# ========== Feature 4: Retry + Backoff 测试 ==========

class RetryWithBackoffTest(unittest.TestCase):

    def test_succeeds_immediately(self):
        from src.sync.utils import retry_with_backoff
        result = retry_with_backoff(lambda: 42)
        self.assertEqual(result, 42)

    def test_retries_on_timeout(self):
        import httpx
        from src.sync.utils import retry_with_backoff
        attempts = []

        def flaky():
            attempts.append(1)
            if len(attempts) < 3:
                raise httpx.ConnectError("connection refused")
            return "ok"

        result = retry_with_backoff(flaky, max_retries=3, base_delay=0.01)
        self.assertEqual(result, "ok")
        self.assertEqual(len(attempts), 3)

    def test_raises_after_max_retries(self):
        import httpx
        from src.sync.utils import retry_with_backoff

        def always_fail():
            raise httpx.TimeoutException("timeout")

        with self.assertRaises(httpx.TimeoutException):
            retry_with_backoff(always_fail, max_retries=2, base_delay=0.01)

    def test_no_retry_on_4xx(self):
        import httpx
        from src.sync.utils import retry_with_backoff
        attempts = []

        def client_error():
            attempts.append(1)
            resp = httpx.Response(403, request=httpx.Request("GET", "http://x"))
            raise httpx.HTTPStatusError("forbidden", request=resp.request, response=resp)

        with self.assertRaises(httpx.HTTPStatusError):
            retry_with_backoff(client_error, max_retries=3, base_delay=0.01)
        self.assertEqual(len(attempts), 1)

    def test_retries_on_5xx(self):
        """5xx HTTPStatusError 应被重试"""
        import httpx
        from src.sync.utils import retry_with_backoff
        attempts = []

        def server_error():
            attempts.append(1)
            if len(attempts) < 3:
                resp = httpx.Response(502, request=httpx.Request("GET", "http://x"))
                raise httpx.HTTPStatusError("bad gateway", request=resp.request, response=resp)
            return "recovered"

        result = retry_with_backoff(server_error, max_retries=3, base_delay=0.01)
        self.assertEqual(result, "recovered")
        self.assertEqual(len(attempts), 3)

    def test_non_retryable_exception_propagates(self):
        from src.sync.utils import retry_with_backoff

        def raise_value_error():
            raise ValueError("bad input")

        with self.assertRaises(ValueError):
            retry_with_backoff(raise_value_error, max_retries=3, base_delay=0.01)



# ========== Integration: sync_log in _record_file_change =========

class SyncLogIntegrationTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_record_file_change_logs_action(self):
        from src.sync.utils import SyncAction, SyncItem
        from src.sync.engine import SyncManager
        from unittest.mock import MagicMock

        api = MagicMock()
        api.get_root_id.return_value = "root"
        mgr = SyncManager(api, self.local_dir, metadata=self.meta)

        p = os.path.join(self.local_dir, "test.md")
        with open(p, "w") as f:
            f.write("hello")
        self.meta.set_file_info("test.md", "f1", 100,
                                content_hash="old_hash")
        self.meta.save()

        item = SyncItem(
            relative_path="test.md",
            local_path=p,
            cloud_id="f1",
            cloud_parent_id="root",
            local_mtime=200,
            cloud_mtime=200,
            is_dir=False,
            action=SyncAction.DOWNLOAD,
            cloud_name="test.md",
            domain=1,
            cloud_ctime=50,
        )
        mgr._record_file_change(item, "downloaded",
                                local_mtime=200, content_hash="new_hash")
        mgr.metadata.save()

        logs = self.meta.get_sync_log(path="test.md")
        self.assertGreaterEqual(len(logs), 1)
        self.assertEqual(logs[0]["action"], "downloaded")
        self.assertEqual(logs[0]["old_hash"], "old_hash")
        self.assertEqual(logs[0]["new_hash"], "new_hash")

        # cloud_content_hash should also be cached
        cached = self.meta.get_cloud_content_hash("test.md")
        self.assertEqual(cached, "new_hash")



# ========== Integration: incremental ref index ===================

class IncrementalRefIndexTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.root = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.root, exist_ok=True)

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_incremental_refs_cached(self):
        from src.sync.dedup import build_all_indexes
        from src.sync.utils import compute_content_hash

        md_path = os.path.join(self.root, "doc.md")
        img_path = os.path.join(self.root, "img.png")
        with open(md_path, "w") as f:
            f.write("![alt](img.png)\n")
        with open(img_path, "wb") as f:
            f.write(b"\x89PNG")

        local_files = {
            "doc.md": {"path": md_path, "mtime": 100, "is_dir": False},
            "img.png": {"path": img_path, "mtime": 100, "is_dir": False},
        }

        # First build: parses md, caches refs
        _, refs1 = build_all_indexes(self.root, self.meta,
                                     local_files=local_files)
        self.assertIn("img.png", refs1)

        # Set metadata mtime to match so cache is used
        self.meta.set_file_info("doc.md", "f1", 100, local_mtime=100)
        self.meta.save()

        # Second build: should use cached refs
        _, refs2 = build_all_indexes(self.root, self.meta,
                                     local_files=local_files)
        self.assertIn("img.png", refs2)

        # Verify refs are in metadata
        cached = self.meta.get_file_refs("doc.md")
        self.assertIn("img.png", cached)



# ========== E2E: complete dry_run flow ===========================

class DryRunE2ETest(unittest.TestCase):
    """模拟完整同步流程（扫描 → 决策 → 冲突精炼 → 输出）。"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_e2e_new_local_file_detected_as_upload(self):
        """本地新增文件 + 云端没有 → UPLOAD"""
        from src.sync.decision import build_item
        from src.sync.utils import SyncAction

        p = os.path.join(self.local_dir, "new.md")
        with open(p, "w") as f:
            f.write("brand new note")

        local = {"path": p, "mtime": int(time.time()), "is_dir": False}
        item = build_item("new.md", None, local, self.meta, self.local_dir)
        self.assertEqual(item.action, SyncAction.UPLOAD)

    def test_e2e_cloud_only_file_detected_as_download(self):
        """云端有文件 + 本地没有 → DOWNLOAD"""
        from src.sync.decision import build_item
        from src.sync.utils import SyncAction

        cloud = {"id": "c1", "mtime": 1000, "parent_id": "root",
                 "name": "cloud.md", "is_dir": False,
                 "domain": 1, "ctime": 900}
        item = build_item("cloud.md", cloud, None, self.meta, self.local_dir)
        self.assertEqual(item.action, SyncAction.DOWNLOAD)

    def test_e2e_both_same_detected_as_skip(self):
        """两端都有 + mtime 一致 + 已标记同步 → SKIP"""
        from src.sync.decision import build_item, calibrate_metadata
        from src.sync.utils import SyncAction

        p = os.path.join(self.local_dir, "synced.md")
        with open(p, "w") as f:
            f.write("synced content")
        mtime = int(os.path.getmtime(p))

        cloud_files = {
            "synced.md": {"id": "c1", "mtime": mtime, "parent_id": "root",
                          "name": "synced.md", "is_dir": False,
                          "domain": 1, "ctime": mtime}
        }
        local_files = {
            "synced.md": {"path": p, "mtime": mtime, "is_dir": False}
        }
        calibrate_metadata(self.meta, cloud_files, local_files)

        cloud = cloud_files["synced.md"]
        local = local_files["synced.md"]
        item = build_item("synced.md", cloud, local, self.meta, self.local_dir)
        self.assertEqual(item.action, SyncAction.SKIP)

    def test_e2e_conflict_detection(self):
        """两端都变化 + mtime 相同 → CONFLICT"""
        from src.sync.decision import build_item
        from src.sync.utils import SyncAction

        p = os.path.join(self.local_dir, "conflict.md")
        with open(p, "w") as f:
            f.write("local version")

        self.meta.set_file_info("conflict.md", "c1", 500,
                                local_mtime=500, content_hash="old_hash")
        self.meta.mark_synced("conflict.md", ts=100)
        self.meta.save()

        # mtime 相同且都比 meta 新 → 无法分出胜负 → CONFLICT
        cloud = {"id": "c1", "mtime": 600, "parent_id": "root",
                 "name": "conflict.md", "is_dir": False,
                 "domain": 1, "ctime": 500}
        local = {"path": p, "mtime": 600, "is_dir": False}

        item = build_item("conflict.md", cloud, local, self.meta,
                          self.local_dir)
        self.assertEqual(item.action, SyncAction.CONFLICT)

    def test_e2e_calibrate_and_build_full_set(self):
        """模拟完整 calibrate → build_item 流程，验证结果数量和分布"""
        from src.sync.decision import calibrate_metadata, build_item
        from src.sync.utils import SyncAction

        # 创建 3 个本地文件
        for name in ("a.md", "b.md", "c.md"):
            with open(os.path.join(self.local_dir, name), "w") as f:
                f.write(f"content of {name}")

        cloud_files = {
            "a.md": {"id": "ca", "mtime": 100, "parent_id": "root",
                     "name": "a.md", "is_dir": False,
                     "domain": 1, "ctime": 50},
            "b.md": {"id": "cb", "mtime": 100, "parent_id": "root",
                     "name": "b.md", "is_dir": False,
                     "domain": 1, "ctime": 50},
            "d.md": {"id": "cd", "mtime": 100, "parent_id": "root",
                     "name": "d.md", "is_dir": False,
                     "domain": 1, "ctime": 50},
        }
        local_files = {}
        for name in ("a.md", "b.md", "c.md"):
            p = os.path.join(self.local_dir, name)
            local_files[name] = {
                "path": p, "mtime": int(os.path.getmtime(p)), "is_dir": False
            }

        hc = {}
        calibrate_metadata(self.meta, cloud_files, local_files, hash_cache=hc)

        all_paths = set(cloud_files.keys()) | set(local_files.keys())
        items = [
            build_item(p, cloud_files.get(p), local_files.get(p),
                       self.meta, self.local_dir, hash_cache=hc)
            for p in all_paths
        ]

        actions = {i.relative_path: i.action for i in items}

        # a.md, b.md: calibrated (both exist) → SKIP
        self.assertEqual(actions["a.md"], SyncAction.SKIP)
        self.assertEqual(actions["b.md"], SyncAction.SKIP)
        # c.md: local only → UPLOAD
        self.assertEqual(actions["c.md"], SyncAction.UPLOAD)
        # d.md: cloud only → DOWNLOAD
        self.assertEqual(actions["d.md"], SyncAction.DOWNLOAD)





class EngineMetaDirtyLockTest(unittest.TestCase):
    """P1: _meta_dirty should be protected by lock"""

    def test_try_flush_is_threadsafe(self):
        import threading
        from unittest.mock import MagicMock
        from src.sync.engine import SyncManager

        mock_api = MagicMock()
        mock_api.get_root_id.return_value = "root"

        tmpdir = tempfile.mkdtemp()
        try:
            mgr = SyncManager.__new__(SyncManager)
            mgr._lock = threading.Lock()
            mgr._meta_dirty = 0
            mgr.METADATA_SAVE_BATCH = 5
            mgr.metadata = MagicMock()

            errors = []

            def call_flush(n):
                try:
                    for _ in range(n):
                        mgr._try_flush_metadata()
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=call_flush, args=(20,))
                       for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(len(errors), 0, f"Thread errors: {errors}")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class EngineTryFinallyTest(unittest.TestCase):
    """P0-2: metadata.save() should run even when _async_main raises."""

    def test_metadata_saved_on_exception(self):
        from src.sync.utils import SyncDirection
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))

            class FakeApi:
                def get_root_id(self):
                    return "root"
                def create_async_client(self):
                    raise RuntimeError("simulated API failure")

            from src.sync.engine import SyncManager
            mgr = SyncManager(api=FakeApi(), local_dir=tmpdir,
                              metadata=meta,
                              downloader=object(),
                              uploader=object())
            mgr._meta_dirty = 5

            try:
                mgr._sync_inner("root", "", SyncDirection.BOTH, False, False, False)
            except Exception:
                pass

            self.assertEqual(mgr._meta_dirty, 0,
                             "metadata should have been flushed in finally block")
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class EngineSeedFromDesktopTest(unittest.TestCase):
    """engine._try_seed_from_desktop"""

    def test_seed_skipped_when_metadata_has_data(self):
        """metadata 已有数据时不尝试导入"""
        tmpdir = tempfile.mkdtemp()
        meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
        meta.set_file_info("existing.md", file_id="F1", cloud_mtime=100)

        from src.sync.engine import SyncManager
        mgr = SyncManager(
            api=type('', (), {'cstk': '', 'DIR_MES_URL': '', 'DIR_PAGE_SIZE': 100})(),
            local_dir=tmpdir, metadata=meta,
            downloader=None, uploader=None)

        result = mgr._try_seed_from_desktop()
        self.assertFalse(result)
        meta.close()

    def test_seed_returns_false_when_no_desktop(self):
        """桌面客户端不存在时返回 False"""
        tmpdir = tempfile.mkdtemp()
        meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

        from src.sync.engine import SyncManager
        from unittest.mock import patch
        mgr = SyncManager(
            api=type('', (), {'cstk': '', 'DIR_MES_URL': '', 'DIR_PAGE_SIZE': 100})(),
            local_dir=tmpdir, metadata=meta,
            downloader=None, uploader=None)

        with patch("src.sync.desktop_data.find_desktop_data_dir", return_value=None):
            result = mgr._try_seed_from_desktop()
        self.assertFalse(result)
        meta.close()



# ========== Phase 3: original_domain 引擎集成测试 ==========

class RecordFileDomainTest(unittest.TestCase):
    """_record_file_change 记录 original_domain"""

    def test_download_records_original_domain(self):
        """下载 domain=0 文件时 original_domain 被记录"""
        from src.sync.utils import SyncItem, SyncAction
        tmpdir = tempfile.mkdtemp()
        local_dir = os.path.join(tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)
        meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

        from src.sync.engine import SyncManager
        fake_api = type('', (), {
            'cstk': '', 'DIR_MES_URL': '', 'DIR_PAGE_SIZE': 100
        })()
        mgr = SyncManager(api=fake_api, local_dir=local_dir,
                          metadata=meta, downloader=None, uploader=None)

        item = SyncItem(
            relative_path="docs/test.md", local_path=os.path.join(local_dir, "docs/test.md"),
            cloud_id="F1", cloud_parent_id="D1", local_mtime=1000,
            cloud_mtime=1000, is_dir=False,
            action=SyncAction.DOWNLOAD, cloud_name="test.note",
            domain=0, cloud_ctime=900)

        os.makedirs(os.path.join(local_dir, "docs"), exist_ok=True)
        with open(os.path.join(local_dir, "docs/test.md"), "w") as f:
            f.write("test content")

        mgr._record_file_change(item, "downloaded", local_mtime=1000)

        self.assertEqual(meta.get_original_domain("docs/test.md"), 0)
        meta.close()

    def test_download_domain1_records_domain1(self):
        """下载 domain=1 文件时 original_domain=1"""
        from src.sync.utils import SyncItem, SyncAction
        tmpdir = tempfile.mkdtemp()
        local_dir = os.path.join(tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)
        meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

        from src.sync.engine import SyncManager
        fake_api = type('', (), {
            'cstk': '', 'DIR_MES_URL': '', 'DIR_PAGE_SIZE': 100
        })()
        mgr = SyncManager(api=fake_api, local_dir=local_dir,
                          metadata=meta, downloader=None, uploader=None)

        item = SyncItem(
            relative_path="readme.md", local_path=os.path.join(local_dir, "readme.md"),
            cloud_id="F2", cloud_parent_id="ROOT", local_mtime=2000,
            cloud_mtime=2000, is_dir=False,
            action=SyncAction.DOWNLOAD, cloud_name="readme.md",
            domain=1, cloud_ctime=1900)

        with open(os.path.join(local_dir, "readme.md"), "w") as f:
            f.write("readme")

        mgr._record_file_change(item, "downloaded", local_mtime=2000)

        self.assertEqual(meta.get_original_domain("readme.md"), 1)
        meta.close()

    def test_upload_does_not_record_original_domain(self):
        """上传操作不设置 original_domain"""
        from src.sync.utils import SyncItem, SyncAction
        tmpdir = tempfile.mkdtemp()
        local_dir = os.path.join(tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)
        meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
        meta.set_file_info("new.md", file_id="F1", cloud_mtime=100)

        from src.sync.engine import SyncManager
        fake_api = type('', (), {
            'cstk': '', 'DIR_MES_URL': '', 'DIR_PAGE_SIZE': 100
        })()
        mgr = SyncManager(api=fake_api, local_dir=local_dir,
                          metadata=meta, downloader=None, uploader=None)

        item = SyncItem(
            relative_path="new.md", local_path=os.path.join(local_dir, "new.md"),
            cloud_id="F1", cloud_parent_id="ROOT", local_mtime=100,
            cloud_mtime=100, is_dir=False,
            action=SyncAction.UPLOAD, cloud_name="new.md",
            domain=1, cloud_ctime=90)

        with open(os.path.join(local_dir, "new.md"), "w") as f:
            f.write("new content")

        mgr._record_file_change(item, "uploaded", content_hash="abc123")
        self.assertIsNone(meta.get_original_domain("new.md"))
        meta.close()





class UploadDomain0WarningTest(unittest.TestCase):
    """上传 domain=0 笔记时发出警告"""

    def test_domain0_upload_logs_warning(self):
        """domain=0 上传时 logging.warning 被调用"""
        import logging
        from unittest.mock import patch
        from src.sync.utils import SyncItem, SyncAction

        tmpdir = tempfile.mkdtemp()
        local_dir = os.path.join(tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)
        meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

        meta.set_file_info("docs/test.md", file_id="F1", cloud_mtime=1000)
        meta.set_original_domain("docs/test.md", 0)

        from src.sync.engine import SyncManager
        fake_api = type('', (), {
            'cstk': '', 'DIR_MES_URL': '', 'DIR_PAGE_SIZE': 100
        })()
        fake_uploader = type('', (), {
            'ensure_parent_dir': lambda self, p: "D1",
            'upload_file': lambda self, p, pid, rp, force=False: (True, None),
        })()

        mgr = SyncManager(api=fake_api, local_dir=local_dir,
                          metadata=meta, downloader=None, uploader=fake_uploader)

        item = SyncItem(
            relative_path="docs/test.md",
            local_path=os.path.join(local_dir, "docs/test.md"),
            cloud_id="F1", cloud_parent_id="D1", local_mtime=1000,
            cloud_mtime=1000, is_dir=False,
            action=SyncAction.UPLOAD, cloud_name="test.md",
            domain=0, cloud_ctime=900)

        os.makedirs(os.path.join(local_dir, "docs"), exist_ok=True)
        with open(os.path.join(local_dir, "docs/test.md"), "w") as f:
            f.write("edited content")

        with patch("src.sync.engine.logging") as mock_log:
            mgr._do_upload(item)
            warning_calls = [c for c in mock_log.warning.call_args_list
                             if "domain=0" in str(c)]
            self.assertTrue(len(warning_calls) > 0,
                            "Should warn about domain=0 upload")

        meta.close()


# ========== diagnose_dryrun 测试 ==========

class DiagnoseDryrunTest(unittest.TestCase):
    """diagnose_dryrun 可疑 UPLOAD 检测"""

    def _make_item(self, path, action=SyncAction.UPLOAD, is_dir=False):
        return SyncItem(
            relative_path=path, local_path=f"/tmp/{path}",
            cloud_id=None, cloud_parent_id=None,
            local_mtime=1000, cloud_mtime=None,
            is_dir=is_dir, action=action,
        )

    def test_no_warnings_for_clean_upload(self):
        """全新文件（无 metadata）不应产生警告"""
        from src.sync.utils import diagnose_dryrun
        items = [self._make_item("new_file.md")]

        output = []
        with patch("builtins.print", side_effect=lambda *a, **kw: output.append(str(a))):
            diagnose_dryrun(items, lambda p: None)

        self.assertEqual(len(output), 0)

    def test_warns_on_empty_file_id_with_cloud_mtime(self):
        """metadata 有记录但 file_id 为空 → 应发出警告"""
        from src.sync.utils import diagnose_dryrun
        items = [self._make_item("orphan.md")]

        def get_meta(path):
            return {"file_id": "", "cloud_mtime": 999, "local_mtime": 800}

        output = []
        with patch("builtins.print", side_effect=lambda *a, **kw: output.append(str(a))):
            diagnose_dryrun(items, get_meta)

        text = "\n".join(output)
        self.assertIn("可疑 UPLOAD", text)
        self.assertIn("file_id 为空", text)

    def test_warns_on_previously_synced(self):
        """曾同步过的文件被标记为 UPLOAD → 应发出警告"""
        from src.sync.utils import diagnose_dryrun
        items = [self._make_item("was_synced.md")]

        def get_meta(path):
            return {"file_id": "F1", "cloud_mtime": 999,
                    "local_mtime": 800, "last_sync_at": 1700000000}

        output = []
        with patch("builtins.print", side_effect=lambda *a, **kw: output.append(str(a))):
            diagnose_dryrun(items, get_meta)

        text = "\n".join(output)
        self.assertIn("可疑 UPLOAD", text)
        self.assertIn("同步过", text)

    def test_skips_directories(self):
        """目录 UPLOAD 不应触发诊断"""
        from src.sync.utils import diagnose_dryrun
        items = [self._make_item("dir/", is_dir=True)]

        def get_meta(path):
            return {"file_id": "", "cloud_mtime": 999,
                    "local_mtime": 0, "last_sync_at": 1000}

        output = []
        with patch("builtins.print", side_effect=lambda *a, **kw: output.append(str(a))):
            diagnose_dryrun(items, get_meta)

        self.assertEqual(len(output), 0)

    def test_skips_download_items(self):
        """非 UPLOAD 动作不应触发诊断"""
        from src.sync.utils import diagnose_dryrun
        items = [self._make_item("dl.md", action=SyncAction.DOWNLOAD)]

        def get_meta(path):
            return {"file_id": "", "cloud_mtime": 999,
                    "local_mtime": 0, "last_sync_at": 1000}

        output = []
        with patch("builtins.print", side_effect=lambda *a, **kw: output.append(str(a))):
            diagnose_dryrun(items, get_meta)

        self.assertEqual(len(output), 0)


if __name__ == "__main__":
    unittest.main()
