# -*- coding:utf-8 -*-
"""
端到端集成测试 — 验证同步引擎的完整流程

mock 层：API 网络请求 / 文件下载器 / 文件上传器 / Git
真实层：SyncManager / SyncMetadata(SQLite) / scanner / decision / moves / utils
"""

import os
import shutil
import sys
import tempfile
import unittest
from contextlib import contextmanager

import httpx

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.sync.engine import SyncManager, SyncDirection
from src.sync.metadata import SyncMetadata


# ==================== Mock 组件 ====================


class MockSyncApi:
    """模拟 SyncApi — 提供云端目录树数据（通过 httpx.MockTransport）"""

    DIR_MES_URL = "http://mock/{dir_id}?len={page_size}&cstk={cstk}"
    DIR_PAGE_SIZE = 100
    cstk = "mock_cstk"

    def __init__(self, cloud_tree: dict = None):
        self._cloud_tree = cloud_tree or {}

    def get_root_id(self) -> str:
        return "ROOT"

    def create_async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        for dir_id, data in self._cloud_tree.items():
            if f"/{dir_id}?" in url:
                return httpx.Response(200, json=data)
        return httpx.Response(200, json={"entries": []})


class MockDownloader:
    """模拟下载器 — 把预定义内容写到本地磁盘"""

    def __init__(self, file_contents: dict = None):
        self._contents = file_contents or {}
        self.calls = []

    def download_file(self, file_id, file_name, local_dir,
                      modify_time=0, create_time=0,
                      convert_to_md=True, skip_action_check=False):
        self.calls.append({
            "file_id": file_id, "file_name": file_name,
            "local_dir": local_dir,
        })
        content = self._contents.get(file_id, b"default content for " + file_id.encode())
        path = os.path.join(local_dir, file_name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(content)
        return True


class MockUploader:
    """模拟上传器 — 记录上传调用"""

    def __init__(self):
        self.calls = []

    def upload_file(self, local_path, parent_id, rel_path="", force=False):
        self.calls.append({
            "local_path": local_path, "parent_id": parent_id,
            "rel_path": rel_path,
        })
        return True, None

    def ensure_cloud_dir(self, dir_name, parent_id, relative_path,
                         defer_save=False):
        return f"DIR_{dir_name}"

    def ensure_parent_dir(self, rel_path):
        return "MOCK_PARENT"


class MockGit:
    """模拟 Git — 不做任何操作"""
    def has_changes(self, paths): return False
    def commit_sync(self, paths, stats): pass


# ==================== 辅助函数 ====================


def _cloud_file(file_id, name, mtime=1000, ctime=500, domain=1):
    """构造一个云端文件 entry"""
    return {"fileEntry": {
        "id": file_id, "name": name, "dir": False,
        "modifyTimeForSort": mtime, "createTimeForSort": ctime,
        "domain": domain,
    }}


def _cloud_dir(dir_id, name):
    """构造一个云端目录 entry"""
    return {"fileEntry": {
        "id": dir_id, "name": name, "dir": True,
        "modifyTimeForSort": 0, "createTimeForSort": 0, "domain": 0,
    }}


@contextmanager
def _sync_env(cloud_tree=None, file_contents=None):
    """创建一次性同步环境（临时目录 + 所有 mock 组件）

    metadata 放在独立目录，避免 SQLite 文件被 scan_local 识别为本地文件。
    """
    sync_dir = tempfile.mkdtemp(prefix="sync_")
    meta_dir = tempfile.mkdtemp(prefix="meta_")
    meta = SyncMetadata(metadata_path=os.path.join(meta_dir, "meta.json"))
    api = MockSyncApi(cloud_tree or {})
    downloader = MockDownloader(file_contents or {})
    uploader = MockUploader()
    git = MockGit()

    manager = SyncManager(
        api=api, local_dir=sync_dir, metadata=meta,
        downloader=downloader, uploader=uploader, git=git,
    )
    try:
        yield manager, meta, downloader, uploader, sync_dir
    finally:
        meta.close()
        shutil.rmtree(sync_dir, ignore_errors=True)
        shutil.rmtree(meta_dir, ignore_errors=True)


# ==================== E2E 测试 ====================


class E2EDownloadTest(unittest.TestCase):
    """场景：云端有文件，本地为空 → 下载"""

    def test_download_new_files(self):
        """云端两个文件 → 全部下载到本地，metadata 正确"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "hello.md", mtime=2000),
                _cloud_file("WEB2", "world.md", mtime=3000),
            ]},
        }
        contents = {
            "WEB1": b"# Hello\nWorld\n",
            "WEB2": b"# World\nHello\n",
        }

        with _sync_env(cloud, contents) as (mgr, meta, dl, ul, tmpdir):
            stats = mgr.sync(direction=SyncDirection.PULL,
                             auto_git=False, auto_dedup=False)

            # 验证统计
            self.assertEqual(stats["downloaded"], 2)
            self.assertEqual(stats["errors"], 0)

            # 验证文件写到了磁盘
            self.assertTrue(os.path.exists(os.path.join(tmpdir, "hello.md")))
            self.assertTrue(os.path.exists(os.path.join(tmpdir, "world.md")))
            with open(os.path.join(tmpdir, "hello.md"), "rb") as f:
                self.assertEqual(f.read(), b"# Hello\nWorld\n")

            # 验证 metadata
            info = meta.get_file_info("hello.md")
            self.assertIsNotNone(info)
            self.assertEqual(info["file_id"], "WEB1")
            self.assertEqual(info["cloud_mtime"], 2000)
            self.assertIsNotNone(info.get("content_hash"))

            # 验证 downloader 被调用了
            self.assertEqual(len(dl.calls), 2)

    def test_download_nested_directory(self):
        """云端有嵌套目录 → 递归下载"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_dir("DIR1", "notes"),
            ]},
            "DIR1": {"entries": [
                _cloud_file("WEB1", "deep.md", mtime=1000),
            ]},
        }
        contents = {"WEB1": b"nested content"}

        with _sync_env(cloud, contents) as (mgr, meta, dl, ul, tmpdir):
            stats = mgr.sync(direction=SyncDirection.PULL,
                             auto_git=False, auto_dedup=False)

            self.assertTrue(stats["downloaded"] >= 1)
            self.assertTrue(
                os.path.exists(os.path.join(tmpdir, "notes", "deep.md")))


class E2EUploadTest(unittest.TestCase):
    """场景：本地有文件，云端没有 → 上传"""

    def test_upload_local_files(self):
        """本地两个文件 → 全部上传"""
        with _sync_env() as (mgr, meta, dl, ul, tmpdir):
            # 准备本地文件
            with open(os.path.join(tmpdir, "local1.md"), "w") as f:
                f.write("# Local File 1\n")
            with open(os.path.join(tmpdir, "local2.md"), "w") as f:
                f.write("# Local File 2\n")

            stats = mgr.sync(direction=SyncDirection.PUSH,
                             auto_git=False, auto_dedup=False)

            self.assertEqual(stats["uploaded"], 2)
            self.assertEqual(stats["errors"], 0)
            self.assertEqual(len(ul.calls), 2)

            uploaded_rels = {c["rel_path"] for c in ul.calls}
            self.assertIn("local1.md", uploaded_rels)
            self.assertIn("local2.md", uploaded_rels)


class E2ESkipTest(unittest.TestCase):
    """场景：两边一致 → 跳过"""

    def test_unchanged_files_skipped(self):
        """metadata 记录的 mtime 与实际一致 → 全部跳过"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "a.md", mtime=1000),
            ]},
        }

        with _sync_env(cloud) as (mgr, meta, dl, ul, tmpdir):
            # 创建本地文件
            path = os.path.join(tmpdir, "a.md")
            with open(path, "w") as f:
                f.write("content")
            local_mtime = int(os.stat(path).st_mtime)

            # 预设 metadata（模拟之前同步过）
            meta.set_file_info(
                "a.md", "WEB1", cloud_mtime=1000,
                local_mtime=local_mtime)

            stats = mgr.sync(auto_git=False, auto_dedup=False)

            self.assertEqual(stats["downloaded"], 0)
            self.assertEqual(stats["uploaded"], 0)
            self.assertTrue(stats["skipped"] >= 1)
            self.assertEqual(len(dl.calls), 0)
            self.assertEqual(len(ul.calls), 0)


class E2EDryRunTest(unittest.TestCase):
    """场景：dry_run 模式 → 什么都不做"""

    def test_dry_run_no_side_effects(self):
        """dry_run 不下载、不上传、不改 metadata"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "new.md", mtime=5000),
            ]},
        }

        with _sync_env(cloud) as (mgr, meta, dl, ul, tmpdir):
            # 创建一个本地文件（会被识别为 upload 候选）
            with open(os.path.join(tmpdir, "local_only.md"), "w") as f:
                f.write("upload me")

            stats = mgr.sync(dry_run=True, auto_git=False, auto_dedup=False)

            # 没有实际操作
            self.assertEqual(len(dl.calls), 0)
            self.assertEqual(len(ul.calls), 0)

            # metadata 中没有任何记录
            self.assertIsNone(meta.get_file_info("new.md"))

            # 本地没有新文件
            self.assertFalse(
                os.path.exists(os.path.join(tmpdir, "new.md")))


class E2EMoveDetectionTest(unittest.TestCase):
    """场景：云端文件移动 → 本地自动跟随"""

    def test_cloud_move_followed_locally(self):
        """文件在云端从 old/a.md 移到 new/a.md → 本地跟随"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_dir("DIR_NEW", "new"),
            ]},
            "DIR_NEW": {"entries": [
                _cloud_file("WEB1", "a.md", mtime=1000),
            ]},
        }

        with _sync_env(cloud) as (mgr, meta, dl, ul, tmpdir):
            # 准备本地旧位置的文件
            old_dir = os.path.join(tmpdir, "old")
            os.makedirs(old_dir)
            old_file = os.path.join(old_dir, "a.md")
            with open(old_file, "w") as f:
                f.write("original content")

            # 预设 metadata：旧路径关联到 WEB1
            meta.set_file_info(
                "old/a.md", "WEB1", cloud_mtime=1000,
                local_mtime=int(os.stat(old_file).st_mtime))

            stats = mgr.sync(auto_git=False, auto_dedup=False)

            # 文件应该被移到新位置
            new_file = os.path.join(tmpdir, "new", "a.md")
            self.assertTrue(os.path.exists(new_file),
                            f"文件应在 {new_file}")
            self.assertFalse(os.path.exists(old_file),
                             "旧位置文件应已移走")

            # metadata 应更新为新路径
            self.assertIsNone(meta.get_file_info("old/a.md"))
            new_info = meta.get_file_info("new/a.md")
            self.assertIsNotNone(new_info)
            self.assertEqual(new_info["file_id"], "WEB1")

            # 不应触发额外下载（移动不是下载）
            self.assertEqual(len(dl.calls), 0)


class E2EMetadataPersistenceTest(unittest.TestCase):
    """场景：同步后 metadata 持久化正确"""

    def test_metadata_survives_reload(self):
        """同步、关闭、重新打开 metadata → 数据完整"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "persist.md", mtime=9000, domain=0),
            ]},
        }
        contents = {"WEB1": b"persistence test"}

        sync_dir = tempfile.mkdtemp(prefix="sync_")
        meta_dir = tempfile.mkdtemp(prefix="meta_")
        meta_path = os.path.join(meta_dir, "meta.json")
        try:
            meta1 = SyncMetadata(metadata_path=meta_path)
            api = MockSyncApi(cloud)
            dl = MockDownloader(contents)
            mgr = SyncManager(
                api=api, local_dir=sync_dir, metadata=meta1,
                downloader=dl, uploader=MockUploader(), git=MockGit(),
            )
            mgr.sync(direction=SyncDirection.PULL,
                     auto_git=False, auto_dedup=False)
            meta1.close()

            meta2 = SyncMetadata(metadata_path=meta_path)
            info = meta2.get_file_info("persist.md")
            self.assertIsNotNone(info, "重新打开后数据应存在")
            self.assertEqual(info["file_id"], "WEB1")
            self.assertEqual(info["cloud_mtime"], 9000)
            self.assertIsNotNone(info.get("content_hash"))
            meta2.close()
        finally:
            shutil.rmtree(sync_dir, ignore_errors=True)
            shutil.rmtree(meta_dir, ignore_errors=True)


class E2EContentHashDedupTest(unittest.TestCase):
    """场景：上传时发现内容已在云端 → 跳过"""

    def test_upload_skipped_when_hash_matches(self):
        """本地文件的 hash 与 metadata 中已有云端文件相同 → 跳过上传"""
        from src.sync.utils import compute_content_hash

        with _sync_env() as (mgr, meta, dl, ul, tmpdir):
            # 准备一个本地文件
            path_a = os.path.join(tmpdir, "a.md")
            with open(path_a, "w", encoding="utf-8") as f:
                f.write("identical content")
            content_hash = compute_content_hash(path_a)

            # 模拟：云端已有同内容文件（在 metadata 中记录）
            meta.set_file_info(
                "cloud_existing.md", "WEB_EXISTING", cloud_mtime=5000,
                content_hash=content_hash)

            stats = mgr.sync(direction=SyncDirection.PUSH,
                             auto_git=False, auto_dedup=False)

            # a.md 应被跳过（内容已在云端）
            self.assertEqual(len(ul.calls), 0)
            self.assertTrue(stats["skipped"] >= 1)


class E2EConflictTest(unittest.TestCase):
    """场景：两边都修改了 → 冲突处理"""

    def test_conflict_creates_backup(self):
        """双方修改 + PULL 方向 → 备份本地版本，下载云端版本"""
        # 使用固定 mtime，确保 cloud_mtime == local_mtime → CONFLICT
        fixed_mtime = 2000

        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "conflict.md", mtime=fixed_mtime),
            ]},
        }
        contents = {"WEB1": b"cloud version"}

        with _sync_env(cloud, contents) as (mgr, meta, dl, ul, tmpdir):
            path = os.path.join(tmpdir, "conflict.md")
            with open(path, "w") as f:
                f.write("local version")
            # 强制设置文件 mtime 与云端相同
            os.utime(path, (fixed_mtime, fixed_mtime))

            # metadata 记录更旧的版本（两边都比 meta 新 → 双方都 changed）
            meta.set_file_info(
                "conflict.md", "WEB1", cloud_mtime=1000,
                local_mtime=1000)

            stats = mgr.sync(direction=SyncDirection.PULL,
                             auto_git=False, auto_dedup=False)

            self.assertEqual(stats["conflicts"], 1)

            # 云端版本被下载
            self.assertEqual(len(dl.calls), 1)
            with open(path, "rb") as f:
                self.assertEqual(f.read(), b"cloud version")

            # 本地旧版本应被备份
            backup_files = [f for f in os.listdir(tmpdir)
                            if ".conflict." in f]
            self.assertTrue(len(backup_files) >= 1,
                            f"应有备份文件，实际: {os.listdir(tmpdir)}")


class E2EBidirectionalTest(unittest.TestCase):
    """场景：BOTH 方向 — 同时下载和上传"""

    def test_mixed_download_and_upload(self):
        """云端有新文件 + 本地有新文件 → 同时下载和上传"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "from_cloud.md", mtime=5000),
            ]},
        }
        contents = {"WEB1": b"cloud content"}

        with _sync_env(cloud, contents) as (mgr, meta, dl, ul, tmpdir):
            # 本地有一个文件
            with open(os.path.join(tmpdir, "from_local.md"), "w") as f:
                f.write("local content")

            stats = mgr.sync(direction=SyncDirection.BOTH,
                             auto_git=False, auto_dedup=False)

            self.assertTrue(stats["downloaded"] >= 1, "应下载云端文件")
            self.assertTrue(stats["uploaded"] >= 1, "应上传本地文件")
            self.assertEqual(stats["errors"], 0)

            # 两个文件都应在本地
            self.assertTrue(
                os.path.exists(os.path.join(tmpdir, "from_cloud.md")))
            self.assertTrue(
                os.path.exists(os.path.join(tmpdir, "from_local.md")))


class E2ESecondSyncIdempotentTest(unittest.TestCase):
    """场景：第二次同步 — 应该全部跳过"""

    def test_second_sync_all_skipped(self):
        """第一次下载后，第二次同步应全部跳过"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "stable.md", mtime=1000),
            ]},
        }
        contents = {"WEB1": b"stable content"}

        with _sync_env(cloud, contents) as (mgr, meta, dl, ul, tmpdir):
            # 第一次同步
            stats1 = mgr.sync(direction=SyncDirection.PULL,
                              auto_git=False, auto_dedup=False)
            self.assertEqual(stats1["downloaded"], 1)

            # 第二次同步 — 同一个 manager，metadata 已有记录
            stats2 = mgr.sync(direction=SyncDirection.PULL,
                              auto_git=False, auto_dedup=False)
            self.assertEqual(stats2["downloaded"], 0)
            self.assertTrue(stats2["skipped"] >= 1)


class E2EDomainZeroTest(unittest.TestCase):
    """场景：domain=0（普通笔记）的完整流程"""

    def test_domain_zero_round_trip(self):
        """下载 domain=0 文件 → metadata 记录 0 → 再次同步正确识别"""
        cloud = {
            "ROOT": {"entries": [
                _cloud_file("WEB1", "plain.note", mtime=2000, domain=0),
            ]},
        }
        contents = {"WEB1": b"plain note content"}

        with _sync_env(cloud, contents) as (mgr, meta, dl, ul, tmpdir):
            stats = mgr.sync(direction=SyncDirection.PULL,
                             auto_git=False, auto_dedup=False)

            # .note 文件在 scan 时会映射为 .md
            info = meta.get_file_info("plain.md")
            self.assertIsNotNone(info)
            self.assertIn("domain", info, "domain=0 应保留在 metadata 中")
            self.assertEqual(info["domain"], 0)


if __name__ == "__main__":
    unittest.main()
