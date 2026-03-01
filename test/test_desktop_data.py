# -*- coding:utf-8 -*-
"""
桌面客户端数据集成测试
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


# ========== Phase 2: 桌面客户端数据集成测试 ==========

class DesktopDataPathMapTest(unittest.TestCase):
    """_build_path_map 路径重建逻辑"""

    def test_build_simple_tree(self):
        """单层文件夹树正确重建路径"""
        from src.sync.desktop_data import _build_path_map
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""CREATE TABLE note_book (
            fileId TEXT, title TEXT, parentId TEXT, del INTEGER DEFAULT 0
        )""")
        conn.execute("INSERT INTO note_book VALUES ('ROOT', '根', '', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D1', '文档', 'ROOT', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D2', '日记', 'ROOT', 0)")
        conn.commit()

        paths = _build_path_map(conn)
        conn.close()

        self.assertEqual(paths.get("ROOT"), "")
        self.assertEqual(paths.get("D1"), "文档")
        self.assertEqual(paths.get("D2"), "日记")

    def test_build_nested_tree(self):
        """嵌套文件夹树正确重建路径"""
        from src.sync.desktop_data import _build_path_map
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""CREATE TABLE note_book (
            fileId TEXT, title TEXT, parentId TEXT, del INTEGER DEFAULT 0
        )""")
        conn.execute("INSERT INTO note_book VALUES ('ROOT', '根', '', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D1', 'level1', 'ROOT', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D2', 'level2', 'D1', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D3', 'level3', 'D2', 0)")
        conn.commit()

        paths = _build_path_map(conn)
        conn.close()

        self.assertEqual(paths.get("D1"), "level1")
        self.assertEqual(paths.get("D2"), "level1/level2")
        self.assertEqual(paths.get("D3"), "level1/level2/level3")

    def test_build_tree_skips_deleted(self):
        """标记 del=1 的文件夹被跳过"""
        from src.sync.desktop_data import _build_path_map
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""CREATE TABLE note_book (
            fileId TEXT, title TEXT, parentId TEXT, del INTEGER DEFAULT 0
        )""")
        conn.execute("INSERT INTO note_book VALUES ('ROOT', '根', '', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D1', 'keep', 'ROOT', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D2', 'deleted', 'ROOT', 1)")
        conn.commit()

        paths = _build_path_map(conn)
        conn.close()

        self.assertIn("D1", paths)
        self.assertNotIn("D2", paths)

    def test_build_tree_no_table(self):
        """没有 note_book 表时返回空"""
        from src.sync.desktop_data import _build_path_map
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        conn = sqlite3.connect(db_path)
        paths = _build_path_map(conn)
        conn.close()
        self.assertEqual(paths, {})

    def test_circular_reference_safe(self):
        """循环引用不会无限递归"""
        from src.sync.desktop_data import _build_path_map
        db_path = os.path.join(tempfile.mkdtemp(), "test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""CREATE TABLE note_book (
            fileId TEXT, title TEXT, parentId TEXT, del INTEGER DEFAULT 0
        )""")
        conn.execute("INSERT INTO note_book VALUES ('A', 'a', 'B', 0)")
        conn.execute("INSERT INTO note_book VALUES ('B', 'b', 'A', 0)")
        conn.commit()

        paths = _build_path_map(conn)
        conn.close()
        # should not crash; actual values depend on resolve order





class SeedMetadataFromDesktopTest(unittest.TestCase):
    """seed_metadata_from_desktop 冷启动种子导入"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.data_dir = os.path.join(self.tmpdir, "ynote-data")
        os.makedirs(self.data_dir, exist_ok=True)
        self._create_desktop_db()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()

    def _create_desktop_db(self):
        """创建一个模拟的桌面客户端数据库"""
        db_path = os.path.join(self.data_dir, "user.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""CREATE TABLE note_book (
            fileId TEXT, title TEXT, parentId TEXT, del INTEGER DEFAULT 0
        )""")
        conn.execute("INSERT INTO note_book VALUES ('ROOT', '根', '', 0)")
        conn.execute("INSERT INTO note_book VALUES ('D1', 'docs', 'ROOT', 0)")

        conn.execute("""CREATE TABLE note (
            fileId TEXT, title TEXT, parentId TEXT, modifyTime INTEGER,
            createTime INTEGER, domain INTEGER, version INTEGER,
            del INTEGER DEFAULT 0, dir INTEGER DEFAULT 0
        )""")
        conn.execute("""INSERT INTO note VALUES
            ('F1', 'hello.note', 'D1', 1700000000000, 1699000000000, 0, 100, 0, 0)""")
        conn.execute("""INSERT INTO note VALUES
            ('F2', 'readme.md', 'D1', 1700001000000, 1699001000000, 1, 101, 0, 0)""")
        conn.execute("""INSERT INTO note VALUES
            ('F3', 'deleted.md', 'D1', 1700002000000, 0, 1, 50, 1, 0)""")
        conn.commit()
        conn.close()

    def test_seed_imports_files_and_dirs(self):
        """导入文件和目录到 metadata"""
        from src.sync.desktop_data import seed_metadata_from_desktop
        count = seed_metadata_from_desktop(self.meta, self.data_dir)

        self.assertGreater(count, 0)
        self.assertEqual(self.meta.get_dir_id("docs"), "D1")
        self.assertIsNotNone(self.meta.get_file_id("docs/hello.md"))
        self.assertIsNotNone(self.meta.get_file_id("docs/readme.md"))

    def test_seed_skips_deleted(self):
        """已删除的文件不导入"""
        from src.sync.desktop_data import seed_metadata_from_desktop
        seed_metadata_from_desktop(self.meta, self.data_dir)
        self.assertIsNone(self.meta.get_file_id("docs/deleted.md"))

    def test_seed_sets_version(self):
        """导入后设置 last_cloud_version"""
        from src.sync.desktop_data import seed_metadata_from_desktop
        seed_metadata_from_desktop(self.meta, self.data_dir)
        version = self.meta.get_state_int("last_cloud_version")
        self.assertEqual(version, 101)

    def test_seed_converts_millisecond_timestamps(self):
        """毫秒时间戳被转换为秒"""
        from src.sync.desktop_data import seed_metadata_from_desktop
        seed_metadata_from_desktop(self.meta, self.data_dir)
        info = self.meta.get_file_info("docs/hello.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["cloud_mtime"], 1700000000)

    def test_seed_no_data_dir(self):
        """数据目录不存在时返回 0"""
        from src.sync.desktop_data import seed_metadata_from_desktop
        count = seed_metadata_from_desktop(self.meta, "/nonexistent")
        self.assertEqual(count, 0)

    def test_seed_no_db_file(self):
        """数据目录存在但没有 .db 文件时返回 0"""
        from src.sync.desktop_data import seed_metadata_from_desktop
        empty_dir = os.path.join(self.tmpdir, "empty")
        os.makedirs(empty_dir)
        count = seed_metadata_from_desktop(self.meta, empty_dir)
        self.assertEqual(count, 0)





class ReadDesktopFileTest(unittest.TestCase):
    """read_desktop_file 桌面缓存文件读取"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.data_dir = os.path.join(self.tmpdir, "ynote-data")
        file_dir = os.path.join(self.data_dir, "file", "a")
        os.makedirs(file_dir, exist_ok=True)
        with open(os.path.join(file_dir, "abc123"), "wb") as f:
            f.write(b'<?xml version="1.0"?><note>test</note>')

    def test_read_existing_file(self):
        """读取存在的缓存文件"""
        from src.sync.desktop_data import read_desktop_file
        content = read_desktop_file("abc123", self.data_dir)
        self.assertIsNotNone(content)
        self.assertIn(b"<note>", content)

    def test_read_nonexistent_file(self):
        """文件不存在时返回 None"""
        from src.sync.desktop_data import read_desktop_file
        content = read_desktop_file("xyz999", self.data_dir)
        self.assertIsNone(content)

    def test_read_no_data_dir(self):
        """数据目录不存在时返回 None"""
        from src.sync.desktop_data import read_desktop_file
        content = read_desktop_file("abc123", "/nonexistent")
        self.assertIsNone(content)

    def test_read_empty_file_id(self):
        """空 file_id 返回 None"""
        from src.sync.desktop_data import read_desktop_file
        content = read_desktop_file("", self.data_dir)
        self.assertIsNone(content)

    def test_bucket_is_first_char_lowercase(self):
        """bucket 目录名是 fileId 首字符的小写"""
        from src.sync.desktop_data import read_desktop_file
        bucket_dir = os.path.join(self.data_dir, "file", "x")
        os.makedirs(bucket_dir, exist_ok=True)
        with open(os.path.join(bucket_dir, "x_file"), "wb") as f:
            f.write(b"data")
        content = read_desktop_file("x_file", self.data_dir)
        self.assertEqual(content, b"data")
        content_miss = read_desktop_file("y_file", self.data_dir)
        self.assertIsNone(content_miss)





class DownloadDesktopCacheTest(unittest.TestCase):
    """YoudaoNoteDownload 桌面缓存集成"""

    def test_desktop_cache_hit_skips_http(self):
        """桌面缓存命中时不调用 HTTP"""
        from src.transfer.download import YoudaoNoteDownload, FileType
        tmpdir = tempfile.mkdtemp()
        data_dir = os.path.join(tmpdir, "ynote-data")
        file_dir = os.path.join(data_dir, "file", "f")
        os.makedirs(file_dir)
        with open(os.path.join(file_dir, "file123"), "wb") as f:
            f.write(b'<?xml version="1.0"?><note/>')

        class MockApi:
            def get_file_by_id(self, fid):
                raise AssertionError("Should not be called")

        dl = YoudaoNoteDownload(MockApi(), desktop_data_dir=data_dir)
        ftype, content = dl._download_and_detect("file123", ".note")
        self.assertEqual(ftype, FileType.XML)
        self.assertIn(b"<note/>", content)

    def test_desktop_cache_miss_falls_back_to_http(self):
        """桌面缓存未命中时走 HTTP"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        class MockResp:
            content = b'{"5": [{"type": "text"}]}'

        class MockApi:
            def get_file_by_id(self, fid):
                return MockResp()

        dl = YoudaoNoteDownload(MockApi(), desktop_data_dir="/nonexistent")
        ftype, content = dl._download_and_detect("xyz", ".note")
        self.assertEqual(ftype, FileType.JSON)

    def test_no_desktop_dir_falls_back(self):
        """没有桌面数据目录时正常 fallback"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        class MockResp:
            content = b'<?xml version="1.0"?><note/>'

        class MockApi:
            def get_file_by_id(self, fid):
                return MockResp()

        dl = YoudaoNoteDownload(MockApi())
        ftype, content = dl._download_and_detect("file1", ".note")
        self.assertEqual(ftype, FileType.XML)



if __name__ == "__main__":
    unittest.main()
