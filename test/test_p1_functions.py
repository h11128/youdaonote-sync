# -*- coding:utf-8 -*-
"""P1 函数的单元测试"""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.sync.scanner import scan_local
from src.common import load_config
from src.cookies import CookieManager
from src.sync.utils import backup_file
from src.transfer.download import YoudaoNoteDownload, FileAction
from src.sync.decision import calibrate_metadata, build_item
from src.sync.metadata import SyncMetadata
from src.sync.utils import SyncAction


# ========== scan_local 测试 ==========

class ScanLocalTest(unittest.TestCase):
    """
    本地扫描测试
    python -m pytest test/test_p1_functions.py::ScanLocalTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_empty_directory_returns_empty_dict(self):
        """空目录返回空字典"""
        # Given
        empty_dir = os.path.join(self.tmpdir, "empty")
        os.makedirs(empty_dir)

        # When
        result = scan_local(empty_dir)

        # Then
        self.assertEqual(result, {})

    def test_empty_local_dir_raises_value_error(self):
        """空 local_dir 抛出 ValueError"""
        # When / Then
        with self.assertRaises(ValueError) as ctx:
            scan_local("")
        self.assertIn("不能为空", str(ctx.exception))

    def test_directory_with_md_files_returns_correct_paths(self):
        """目录中有 .md 文件时返回正确的相对路径"""
        # Given
        with open(os.path.join(self.tmpdir, "a.md"), "w") as f:
            f.write("# a")
        subdir = os.path.join(self.tmpdir, "sub")
        os.makedirs(subdir)
        with open(os.path.join(subdir, "b.md"), "w") as f:
            f.write("# b")

        # When
        result = scan_local(self.tmpdir)

        # Then
        self.assertIn("a.md", result)
        self.assertIn("sub/b.md", result)
        self.assertEqual(result["a.md"]["is_dir"], False)
        self.assertEqual(result["sub"]["is_dir"], True)

    def test_hidden_files_skipped(self):
        """隐藏文件（dotfiles）被跳过"""
        # Given
        with open(os.path.join(self.tmpdir, ".hidden"), "w") as f:
            f.write("x")
        with open(os.path.join(self.tmpdir, "visible.md"), "w") as f:
            f.write("# v")

        # When
        result = scan_local(self.tmpdir)

        # Then
        self.assertNotIn(".hidden", result)
        self.assertIn("visible.md", result)

    def test_images_and_attachments_dirs_skipped(self):
        """images/ 和 attachments/ 目录被跳过"""
        # Given
        images_dir = os.path.join(self.tmpdir, "images")
        attachments_dir = os.path.join(self.tmpdir, "attachments")
        os.makedirs(images_dir)
        os.makedirs(attachments_dir)
        with open(os.path.join(images_dir, "img.png"), "w") as f:
            f.write("x")
        with open(os.path.join(self.tmpdir, "note.md"), "w") as f:
            f.write("# note")

        # When
        result = scan_local(self.tmpdir)

        # Then — images 和 attachments 及其内容被跳过
        self.assertNotIn("images", result)
        self.assertNotIn("attachments", result)
        self.assertNotIn("images/img.png", result)
        self.assertIn("note.md", result)

    def test_note_file_mapped_to_md(self):
        """ .note 文件映射为 .md"""
        # Given
        with open(os.path.join(self.tmpdir, "test.note"), "w") as f:
            f.write('{"5":[]}')

        # When
        result = scan_local(self.tmpdir)

        # Then — 以 .md 为 key 存储
        self.assertIn("test.md", result)
        self.assertEqual(result["test.md"]["path"], os.path.join(self.tmpdir, "test.note"))

    def test_md_takes_priority_when_both_note_and_md_exist(self):
        """ .note 和 .md 同时存在时，.md 优先"""
        # Given
        with open(os.path.join(self.tmpdir, "dup.note"), "w") as f:
            f.write('{"5":[]}')
        with open(os.path.join(self.tmpdir, "dup.md"), "w") as f:
            f.write("# md version")

        # When
        result = scan_local(self.tmpdir)

        # Then — 只保留 dup.md，指向 .md 文件
        self.assertIn("dup.md", result)
        self.assertEqual(result["dup.md"]["path"], os.path.join(self.tmpdir, "dup.md"))

    def test_conflict_files_skipped(self):
        """ .conflict. 文件被跳过"""
        # Given
        with open(os.path.join(self.tmpdir, "a.conflict.20240101_120000.md"), "w") as f:
            f.write("conflict")
        with open(os.path.join(self.tmpdir, "normal.md"), "w") as f:
            f.write("# normal")

        # When
        result = scan_local(self.tmpdir)

        # Then
        self.assertNotIn("a.conflict.20240101_120000.md", result)
        self.assertIn("normal.md", result)


# ========== load_config 测试 ==========

class LoadConfigTest(unittest.TestCase):
    """
    配置加载测试
    python -m pytest test/test_p1_functions.py::LoadConfigTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_nonexistent_file_returns_defaults_with_empty_error(self):
        """配置文件不存在时返回默认值且无错误"""
        # Given — 使用不包含 config.json 的目录
        with patch("src.common.get_config_directory", return_value=self.tmpdir):
            # When
            config, error = load_config()

            # Then
            self.assertEqual(error, "")
            self.assertIn("local_dir", config)
            self.assertIn("ydnote_dir", config)
            self.assertEqual(config["local_dir"], "")
            self.assertEqual(config["is_relative_path"], True)

    def test_valid_json_returns_correct_dict(self):
        """有效 JSON 返回正确字典"""
        # Given
        config_path = os.path.join(self.tmpdir, "config.json")
        expected = {"local_dir": "/notes", "ydnote_dir": "root", "is_relative_path": False}
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(expected, f, ensure_ascii=False)

        with patch("src.common.get_config_directory", return_value=self.tmpdir):
            # When
            config, error = load_config()

            # Then
            self.assertEqual(error, "")
            self.assertEqual(config["local_dir"], "/notes")
            self.assertEqual(config["ydnote_dir"], "root")
            self.assertEqual(config["is_relative_path"], False)

    def test_invalid_json_returns_empty_dict_with_error(self):
        """无效 JSON 返回空字典和错误信息"""
        # Given
        config_path = os.path.join(self.tmpdir, "config.json")
        with open(config_path, "w", encoding="utf-8") as f:
            f.write("{ invalid json }")

        with patch("src.common.get_config_directory", return_value=self.tmpdir):
            # When
            config, error = load_config()

            # Then
            self.assertEqual(config, {})
            self.assertIn("格式错误", error)


# ========== CookieManager.validate 测试 ==========

class CookieManagerValidateTest(unittest.TestCase):
    """
    Cookie 验证测试
    python -m pytest test/test_p1_functions.py::CookieManagerValidateTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_cookies(self, path, cookies_data):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cookies_data, f, ensure_ascii=False, indent=2)

    def test_valid_cookies_returns_true_empty_error(self):
        """有效的 cookies 文件（3 个必需 cookie）返回 (True, "")"""
        # Given
        cookies_path = os.path.join(self.tmpdir, "cookies.json")
        cookies_data = {
            "cookies": [
                ["YNOTE_CSTK", "cstk_value", ".note.youdao.com", "/"],
                ["YNOTE_LOGIN", "login_value", ".note.youdao.com", "/"],
                ["YNOTE_SESS", "sess_value", ".note.youdao.com", "/"],
            ]
        }
        self._write_cookies(cookies_path, cookies_data)

        # When
        is_valid, error = CookieManager.validate(cookies_path)

        # Then
        self.assertTrue(is_valid)
        self.assertEqual(error, "")

    def test_missing_ynote_cstk_returns_false(self):
        """缺少 YNOTE_CSTK 返回 (False, "缺少...")"""
        # Given
        cookies_path = os.path.join(self.tmpdir, "cookies.json")
        cookies_data = {
            "cookies": [
                ["YNOTE_LOGIN", "login_value", ".note.youdao.com", "/"],
                ["YNOTE_SESS", "sess_value", ".note.youdao.com", "/"],
            ]
        }
        self._write_cookies(cookies_path, cookies_data)

        # When
        is_valid, error = CookieManager.validate(cookies_path)

        # Then
        self.assertFalse(is_valid)
        self.assertIn("缺少", error)
        self.assertIn("YNOTE_CSTK", error)

    def test_empty_value_asterisk_returns_false(self):
        """空值 "**" 返回 (False, "...为空或未设置")"""
        # Given
        cookies_path = os.path.join(self.tmpdir, "cookies.json")
        cookies_data = {
            "cookies": [
                ["YNOTE_CSTK", "**", ".note.youdao.com", "/"],
                ["YNOTE_LOGIN", "login_value", ".note.youdao.com", "/"],
                ["YNOTE_SESS", "sess_value", ".note.youdao.com", "/"],
            ]
        }
        self._write_cookies(cookies_path, cookies_data)

        # When
        is_valid, error = CookieManager.validate(cookies_path)

        # Then
        self.assertFalse(is_valid)
        self.assertIn("为空或未设置", error)

    def test_nonexistent_file_returns_false(self):
        """文件不存在返回 (False, "找不到文件...")"""
        # Given
        cookies_path = os.path.join(self.tmpdir, "no_such_cookies.json")

        # When
        is_valid, error = CookieManager.validate(cookies_path)

        # Then
        self.assertFalse(is_valid)
        self.assertIn("找不到文件", error)


# ========== convert_playwright_cookies 测试 ==========

class ConvertPlaywrightCookiesTest(unittest.TestCase):
    """
    Playwright cookies 转换测试
    python -m pytest test/test_p1_functions.py::ConvertPlaywrightCookiesTest -v
    """

    def test_full_valid_cookies_returns_correct_format(self):
        """完整有效的 cookies 返回正确格式"""
        # Given
        playwright_cookies = [
            {"name": "YNOTE_CSTK", "value": "cstk", "domain": ".note.youdao.com"},
            {"name": "YNOTE_LOGIN", "value": "login", "domain": ".note.youdao.com"},
            {"name": "YNOTE_SESS", "value": "sess", "domain": ".note.youdao.com"},
        ]

        # When
        result, error = CookieManager.convert_playwright_cookies(playwright_cookies)

        # Then
        self.assertEqual(error, "")
        self.assertIsNotNone(result)
        self.assertIn("cookies", result)
        self.assertEqual(len(result["cookies"]), 3)
        names = [c[0] for c in result["cookies"]]
        self.assertEqual(set(names), {"YNOTE_CSTK", "YNOTE_LOGIN", "YNOTE_SESS"})

    def test_missing_required_cookie_returns_none_and_error(self):
        """缺少必需 cookie 返回 (None, error)"""
        # Given
        playwright_cookies = [
            {"name": "YNOTE_CSTK", "value": "cstk", "domain": ".note.youdao.com"},
            {"name": "YNOTE_LOGIN", "value": "login", "domain": ".note.youdao.com"},
            # 缺少 YNOTE_SESS
        ]

        # When
        result, error = CookieManager.convert_playwright_cookies(playwright_cookies)

        # Then
        self.assertIsNone(result)
        self.assertIn("缺少", error)

    def test_extra_cookies_ignored(self):
        """额外 cookie 被忽略，只保留必需的 3 个"""
        # Given
        playwright_cookies = [
            {"name": "YNOTE_CSTK", "value": "cstk", "domain": ".note.youdao.com"},
            {"name": "YNOTE_LOGIN", "value": "login", "domain": ".note.youdao.com"},
            {"name": "YNOTE_SESS", "value": "sess", "domain": ".note.youdao.com"},
            {"name": "EXTRA_COOKIE", "value": "extra", "domain": ".note.youdao.com"},
        ]

        # When
        result, error = CookieManager.convert_playwright_cookies(playwright_cookies)

        # Then
        self.assertEqual(error, "")
        self.assertEqual(len(result["cookies"]), 3)


# ========== backup_file 测试 ==========

class BackupFileTest(unittest.TestCase):
    """
    文件备份测试
    python -m pytest test/test_p1_functions.py::BackupFileTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_existing_file_creates_conflict_timestamp_copy(self):
        """存在的文件创建 .conflict.TIMESTAMP 副本"""
        # Given
        file_path = os.path.join(self.tmpdir, "test.md")
        content = "# hello world"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

        # When
        backup_path = backup_file(file_path)

        # Then
        self.assertIsNotNone(backup_path)
        self.assertTrue(backup_path.startswith(os.path.join(self.tmpdir, "test.conflict.")))
        self.assertTrue(backup_path.endswith(".md"))
        self.assertTrue(os.path.exists(backup_path))

    def test_nonexistent_file_returns_none(self):
        """不存在的文件返回 None"""
        # Given
        file_path = os.path.join(self.tmpdir, "no_such.md")

        # When
        result = backup_file(file_path)

        # Then
        self.assertIsNone(result)

    def test_backup_file_has_same_content(self):
        """备份文件内容与原文件相同"""
        # Given
        file_path = os.path.join(self.tmpdir, "content.md")
        content = "original content\nline2"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

        # When
        backup_path = backup_file(file_path)

        # Then
        self.assertIsNotNone(backup_path)
        with open(backup_path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), content)


# ========== _get_file_action 测试 ==========

class GetFileActionTest(unittest.TestCase):
    """
    下载引擎文件操作判断测试
    python -m pytest test/test_p1_functions.py::GetFileActionTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.downloader = YoudaoNoteDownload(api=None)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_file_not_exists_returns_add(self):
        """文件不存在返回 FileAction.ADD"""
        # Given
        local_path = os.path.join(self.tmpdir, "nonexistent.md")

        # When
        result = self.downloader._get_file_action(local_path, 1000.0)

        # Then
        self.assertEqual(result, FileAction.ADD)

    def test_file_exists_cloud_mtime_le_local_returns_skip(self):
        """文件存在且云端 mtime <= 本地 mtime 返回 SKIP"""
        # Given
        file_path = os.path.join(self.tmpdir, "local.md")
        with open(file_path, "w") as f:
            f.write("content")
        local_mtime = os.path.getmtime(file_path)
        cloud_mtime = local_mtime - 1  # 云端更旧

        # When
        result = self.downloader._get_file_action(file_path, cloud_mtime)

        # Then
        self.assertEqual(result, FileAction.SKIP)

    def test_file_exists_cloud_mtime_gt_local_returns_update(self):
        """文件存在且云端 mtime > 本地 mtime 返回 UPDATE"""
        # Given
        file_path = os.path.join(self.tmpdir, "local.md")
        with open(file_path, "w") as f:
            f.write("content")
        local_mtime = os.path.getmtime(file_path)
        cloud_mtime = local_mtime + 100  # 云端更新

        # When
        result = self.downloader._get_file_action(file_path, cloud_mtime)

        # Then
        self.assertEqual(result, FileAction.UPDATE)


# ========== calibrate_metadata 测试 ==========

class CalibrateMetadataTest(unittest.TestCase):
    """
    元数据校准测试
    python -m pytest test/test_p1_functions.py::CalibrateMetadataTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.metadata_path = os.path.join(self.tmpdir, "sync_metadata.json")
        self.meta = SyncMetadata(metadata_path=self.metadata_path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_both_sides_exist_no_metadata_creates_baseline(self):
        """两端都存在且无元数据时建立基线"""
        # Given
        file_path = os.path.join(self.tmpdir, "note.md")
        with open(file_path, "w") as f:
            f.write("# content")
        cloud_files = {"note.md": {"id": "WEB1", "parent_id": "P1", "name": "note.md",
                                    "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1}}
        local_files = {"note.md": {"path": file_path, "mtime": 1000, "is_dir": False}}

        # When
        count = calibrate_metadata(self.meta, cloud_files, local_files)

        # Then
        self.assertEqual(count, 1)
        info = self.meta.get_file_info("note.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")

    def test_metadata_already_exists_skipped(self):
        """元数据已存在时跳过"""
        # Given
        file_path = os.path.join(self.tmpdir, "note.md")
        with open(file_path, "w") as f:
            f.write("# content")
        self.meta.set_file_info("note.md", "WEB1", cloud_mtime=1000, local_mtime=1000)
        self.meta.mark_synced("note.md")
        cloud_files = {"note.md": {"id": "WEB1", "parent_id": "P1", "name": "note.md",
                                    "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1}}
        local_files = {"note.md": {"path": file_path, "mtime": 1000, "is_dir": False}}

        # When
        count = calibrate_metadata(self.meta, cloud_files, local_files)

        # Then
        self.assertEqual(count, 0)

    def test_only_one_side_not_calibrated(self):
        """只有一端存在时不校准"""
        # Given — 只有云端
        cloud_files = {"note.md": {"id": "WEB1", "parent_id": "", "name": "note.md",
                                    "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1}}
        local_files = {}

        # When
        count = calibrate_metadata(self.meta, cloud_files, local_files)

        # Then
        self.assertEqual(count, 0)
        self.assertIsNone(self.meta.get_file_id("note.md"))


# ========== build_item 测试 ==========

class BuildItemTest(unittest.TestCase):
    """
    同步项构建测试
    python -m pytest test/test_p1_functions.py::BuildItemTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.metadata_path = os.path.join(self.tmpdir, "sync_metadata.json")
        self.meta = SyncMetadata(metadata_path=self.metadata_path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_only_cloud_returns_download(self):
        """只有云端 → DOWNLOAD"""
        # Given
        cloud = {"id": "WEB1", "parent_id": "P1", "name": "note.md",
                 "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1}
        local = None

        # When
        item = build_item("note.md", cloud, local, self.meta, self.tmpdir)

        # Then
        self.assertEqual(item.action, SyncAction.DOWNLOAD)

    def test_only_local_returns_upload(self):
        """只有本地 → UPLOAD"""
        # Given
        file_path = os.path.join(self.tmpdir, "note.md")
        with open(file_path, "w") as f:
            f.write("# content")
        cloud = None
        local = {"path": file_path, "mtime": 1000, "is_dir": False}

        # When
        item = build_item("note.md", cloud, local, self.meta, self.tmpdir)

        # Then
        self.assertEqual(item.action, SyncAction.UPLOAD)

    def test_both_sides_no_changes_returns_skip(self):
        """两端都有且无变化 → SKIP"""
        # Given
        file_path = os.path.join(self.tmpdir, "note.md")
        with open(file_path, "w") as f:
            f.write("# content")
        mtime = int(os.path.getmtime(file_path))
        self.meta.set_file_info("note.md", "WEB1", cloud_mtime=mtime, local_mtime=mtime)
        cloud = {"id": "WEB1", "parent_id": "P1", "name": "note.md",
                 "is_dir": False, "mtime": mtime, "ctime": 0, "domain": 1}
        local = {"path": file_path, "mtime": mtime, "is_dir": False}

        # When
        item = build_item("note.md", cloud, local, self.meta, self.tmpdir)

        # Then
        self.assertEqual(item.action, SyncAction.SKIP)


# ========== SearchType 测试 ==========

class SearchTypeTest(unittest.TestCase):
    """SearchType(Enum) 枚举行为和类型转换"""

    def test_value_matches_string(self):
        """SearchType 成员的 .value 与定义字符串一致"""
        from src.transfer.search import SearchType

        self.assertEqual(SearchType.ALL.value, "all")
        self.assertEqual(SearchType.FOLDER.value, "folder")
        self.assertEqual(SearchType.FILE.value, "file")

    def test_string_to_enum_conversion(self):
        """字符串可通过 SearchType() 构造函数转为枚举"""
        from src.transfer.search import SearchType

        self.assertIs(SearchType("all"), SearchType.ALL)
        self.assertIs(SearchType("folder"), SearchType.FOLDER)
        self.assertIs(SearchType("file"), SearchType.FILE)

    def test_invalid_string_raises(self):
        """无效字符串抛 ValueError（fail fast）"""
        from src.transfer.search import SearchType

        with self.assertRaises(ValueError):
            SearchType("invalid")


# ========== DownloadTask 测试 ==========

class DownloadTaskTest(unittest.TestCase):
    """DownloadTask NamedTuple named access"""

    def test_named_field_access(self):
        """NamedTuple 字段可通过名称访问"""
        from src.transfer.pull import DownloadTask

        t = DownloadTask("FID", "note.md", "/tmp", 1000, 500)

        self.assertEqual(t.file_id, "FID")
        self.assertEqual(t.name, "note.md")
        self.assertEqual(t.local_dir, "/tmp")
        self.assertEqual(t.modify_time, 1000)
        self.assertEqual(t.create_time, 500)

    def test_tuple_unpacking_still_works(self):
        """NamedTuple 向后兼容 positional unpacking"""
        from src.transfer.pull import DownloadTask

        t = DownloadTask("FID", "note.md", "/tmp", 1000, 500)
        fid, name, ldir, mtime, ctime = t

        self.assertEqual(fid, "FID")
        self.assertEqual(name, "note.md")


if __name__ == "__main__":
    unittest.main()
