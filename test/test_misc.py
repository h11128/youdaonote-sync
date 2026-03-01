# -*- coding:utf-8 -*-
"""
杂项测试（safe_long_path、safe_json、format_file_size、git_helper、API mock）
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


# ========== safe_long_path 测试 ==========

class SafeLongPathTest(unittest.TestCase):
    """
    Windows 长路径处理测试
    python -m pytest test/test_sync.py::SafeLongPathTest -v
    """

    def test_short_path_unchanged(self):
        """短路径原样返回"""
        from src.common import safe_long_path
        path = "C:\\Users\\test\\notes\\file.md"
        result = safe_long_path(path)
        # 短路径不应被修改（除非恰好在 Windows 且超长）
        if len(path) < 240:
            self.assertFalse(result.startswith("\\\\?\\"))

    def test_already_prefixed_unchanged(self):
        """已有 \\\\?\\ 前缀的路径不会重复添加"""
        from src.common import safe_long_path
        path = "\\\\?\\" + "C:\\" + "a" * 300 + ".md"
        result = safe_long_path(path)
        # 不应出现双重前缀
        self.assertFalse(result.startswith("\\\\?\\\\\\?\\"))

    def test_empty_path(self):
        """空路径不崩溃"""
        from src.common import safe_long_path
        result = safe_long_path("")
        self.assertEqual(result, "" if len("") < 240 else result)



# ========== api._safe_json 测试 ==========

class SafeJsonTest(unittest.TestCase):
    """
    API JSON 安全解析测试
    python -m pytest test/test_sync.py::SafeJsonTest -v
    """

    def test_valid_json(self):
        """正常 JSON 响应解析成功"""
        from src.api import YoudaoNoteApi

        class FakeResp:
            status_code = 200
            text = '{"key": "value"}'
            def json(self):
                return {"key": "value"}

        result = YoudaoNoteApi._safe_json(FakeResp())
        self.assertEqual(result, {"key": "value"})

    def test_invalid_json_raises_runtime_error(self):
        """非 JSON 响应抛出 RuntimeError 并包含有用信息"""
        from src.api import YoudaoNoteApi

        class FakeResp:
            status_code = 502
            text = "<html>Bad Gateway</html>"
            def json(self):
                raise ValueError("No JSON")

        with self.assertRaises(RuntimeError) as ctx:
            YoudaoNoteApi._safe_json(FakeResp())

        self.assertIn("502", str(ctx.exception))
        self.assertIn("Bad Gateway", str(ctx.exception))

    def test_empty_response_raises_runtime_error(self):
        """空响应抛出 RuntimeError"""
        from src.api import YoudaoNoteApi

        class FakeResp:
            status_code = 200
            text = ""
            def json(self):
                raise ValueError("Empty")

        with self.assertRaises(RuntimeError):
            YoudaoNoteApi._safe_json(FakeResp())





class FormatFileSizeTest(unittest.TestCase):
    """format_file_size() 文件大小格式化"""

    def test_zero_bytes(self):
        """0 → 0B"""
        # Given
        size = 0
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "0B")

    def test_bytes(self):
        """512 → 512B"""
        # Given
        size = 512
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "512B")

    def test_one_kb(self):
        """1024 → 1.0KB"""
        # Given
        size = 1024
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "1.0KB")

    def test_one_point_five_kb(self):
        """1536 → 1.5KB"""
        # Given
        size = 1536
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "1.5KB")

    def test_one_mb(self):
        """1048576 → 1.0MB"""
        # Given
        size = 1048576
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "1.0MB")

    def test_ten_mb(self):
        """10485760 → 10.0MB"""
        # Given
        size = 10485760
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "10.0MB")





class ApiContextManagerTest(unittest.TestCase):
    """P0: httpx.Client should be properly closed"""

    def test_context_manager_closes_session(self):
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        mock_transport = MagicMock()
        with patch("httpx.HTTPTransport", return_value=mock_transport):
            with patch("httpx.Client") as mock_client_cls:
                mock_session = MagicMock()
                mock_client_cls.return_value = mock_session

                with YoudaoNoteApi("/fake/cookies.json") as api:
                    pass

                mock_session.close.assert_called_once()

    def test_close_method_exists(self):
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client", return_value=MagicMock()):
                api = YoudaoNoteApi("/fake/cookies.json")
                api.close()
                api.session.close.assert_called_once()





class ApiHttpErrorHandlingTest(unittest.TestCase):
    """P1: HTTP network errors should be wrapped"""

    def test_http_get_wraps_network_error(self):
        import httpx
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client") as mock_cls:
                mock_session = MagicMock()
                mock_session.get.side_effect = httpx.ConnectError("DNS failed")
                mock_cls.return_value = mock_session

                api = YoudaoNoteApi("/fake/cookies.json")
                with self.assertRaises(RuntimeError) as ctx:
                    api.http_get("https://example.com")
                self.assertIn("网络请求失败", str(ctx.exception))

    def test_http_post_wraps_timeout(self):
        import httpx
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client") as mock_cls:
                mock_session = MagicMock()
                mock_session.post.side_effect = httpx.ReadTimeout("timed out")
                mock_cls.return_value = mock_session

                api = YoudaoNoteApi("/fake/cookies.json")
                with self.assertRaises(RuntimeError) as ctx:
                    api.http_post("https://example.com", data={})
                self.assertIn("网络请求失败", str(ctx.exception))

    def test_http_status_error_still_raised_directly(self):
        import httpx
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client") as mock_cls:
                mock_session = MagicMock()
                mock_resp = MagicMock()
                mock_resp.status_code = 403
                mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
                    "Forbidden", request=MagicMock(), response=mock_resp
                )
                mock_session.get.return_value = mock_resp
                mock_cls.return_value = mock_session

                api = YoudaoNoteApi("/fake/cookies.json")
                with self.assertRaises(httpx.HTTPStatusError):
                    api.http_get("https://example.com")





class SyncApiProtocolTest(unittest.TestCase):
    """P1: SyncApi protocol should include async client and URL attributes"""

    def test_protocol_has_required_methods(self):
        from src.protocols import SyncApi
        members = dir(SyncApi)
        self.assertIn("create_async_client", members)
        self.assertIn("get_root_id", members)
        self.assertIn("get_file_by_id", members)
        self.assertIn("delete_file", members)

    def test_protocol_has_required_annotations(self):
        from src.protocols import SyncApi
        annotations = getattr(SyncApi, "__annotations__", {})
        proto_attrs = getattr(SyncApi, "__protocol_attrs__", set())
        all_attrs = set(annotations.keys()) | proto_attrs
        self.assertIn("DIR_MES_URL", all_attrs)
        self.assertIn("DIR_PAGE_SIZE", all_attrs)
        self.assertIn("cstk", all_attrs)





class WindowsPidCheckTest(unittest.TestCase):
    """P1-9: _is_pid_alive works on current platform."""

    def test_current_pid_alive(self):
        from src.sync.engine import _SyncLock
        self.assertTrue(_SyncLock._is_pid_alive(os.getpid()))

    def test_invalid_pid_not_alive(self):
        from src.sync.engine import _SyncLock
        self.assertFalse(_SyncLock._is_pid_alive(0))
        self.assertFalse(_SyncLock._is_pid_alive(-1))

    def test_nonexistent_pid_not_alive(self):
        from src.sync.engine import _SyncLock
        self.assertFalse(_SyncLock._is_pid_alive(99999999))



# ========== Unit: git_helper.py ==========================================

class GitHelperBasicTest(unittest.TestCase):
    """Basic tests for GitHelper."""

    def test_non_git_dir(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertFalse(gh.is_git_repo())
            self.assertFalse(gh.has_changes(["some/path"]))
            self.assertFalse(gh.commit_sync(["some/path"], {"downloaded": 1}))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_empty_changed_paths_returns_false(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertFalse(gh.commit_sync([], {}))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_has_changes_needs_paths_and_repo(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertFalse(gh.has_changes([]))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_get_file_content_non_repo(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertIsNone(gh.get_file_content("some/file.md"))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Unit: common.py load_config narrow exception =================

class LoadConfigExceptionTest(unittest.TestCase):
    """P0: load_config should not catch arbitrary exceptions."""

    def test_missing_config_returns_defaults(self):
        from src.common import load_config
        config, err = load_config()
        self.assertIsInstance(config, dict)

    def test_format_file_size(self):
        from src.common import format_file_size
        self.assertEqual(format_file_size(0), "0B")
        self.assertEqual(format_file_size(1023), "1023B")
        self.assertIn("KB", format_file_size(2048))
        self.assertIn("MB", format_file_size(2 * 1024 * 1024))



if __name__ == "__main__":
    unittest.main()
