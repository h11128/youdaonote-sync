# -*- coding:utf-8 -*-
"""
上传处理器测试
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


# ========== _UPLOAD_HANDLERS dispatch 测试 ==========

class UploadHandlerDispatchTest(unittest.TestCase):
    """
    测试上传处理器分发逻辑
    python -m pytest test/test_sync.py::UploadHandlerDispatchTest -v
    """

    def test_md_dispatches_to_upload_markdown(self):
        """".md" 文件应映射到 _upload_markdown"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".md")
        self.assertEqual(handler_name, "_upload_markdown")

    def test_note_dispatches_to_skip(self):
        """".note" 文件应映射到 _upload_note_skip"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".note")
        self.assertEqual(handler_name, "_upload_note_skip")

    def test_unknown_suffix_falls_back_to_auto(self):
        """未知后缀应 fallback 到 _upload_auto"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".xyz", "_upload_auto")
        self.assertEqual(handler_name, "_upload_auto")

    def test_upload_auto_text_file_goes_markdown(self):
        """_upload_auto 对 UTF-8 文本文件应走 _upload_markdown 路径"""
        from unittest.mock import MagicMock, patch
        from src.transfer.upload import YoudaoNoteUpload

        tmpdir = tempfile.mkdtemp()
        try:
            txt_path = os.path.join(tmpdir, "readme.txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write("hello world")

            uploader = YoudaoNoteUpload(MagicMock(), SyncMetadata(
                metadata_path=os.path.join(tmpdir, "meta.json")))
            with patch.object(uploader, "_upload_markdown",
                              return_value=(True, None)) as mock_md:
                ok, err = uploader._upload_auto(txt_path, "pid", "readme.txt")
                mock_md.assert_called_once()
                self.assertTrue(ok)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_upload_auto_binary_file_goes_binary(self):
        """_upload_auto 对二进制文件：先走 markdown 失败（[BINARY]），再回退到 binary"""
        from unittest.mock import MagicMock, patch
        from src.transfer.upload import YoudaoNoteUpload

        tmpdir = tempfile.mkdtemp()
        try:
            bin_path = os.path.join(tmpdir, "chart.pdf")
            with open(bin_path, "wb") as f:
                f.write(b"\x00\x01\x02\xff\xfe\xfd" * 100)

            uploader = YoudaoNoteUpload(MagicMock(), SyncMetadata(
                metadata_path=os.path.join(tmpdir, "meta.json")))
            with patch.object(uploader, "_upload_binary",
                              return_value=(True, None)) as mock_bin:
                ok, err = uploader._upload_auto(bin_path, "pid", "chart.pdf")
                mock_bin.assert_called_once_with(bin_path, "pid", "chart.pdf", False)
                self.assertTrue(ok)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_upload_binary_calls_push_binary_file(self):
        """_upload_binary returns UploadResult and calls api.push_binary_file"""
        from unittest.mock import MagicMock
        from src.transfer.upload import YoudaoNoteUpload
        from src.sync.utils import UploadResult

        tmpdir = tempfile.mkdtemp()
        try:
            pdf_path = os.path.join(tmpdir, "doc.pdf")
            pdf_content = b"%PDF-1.4 fake content"
            with open(pdf_path, "wb") as f:
                f.write(pdf_content)

            mock_api = MagicMock()
            mock_api.push_binary_file.return_value = {
                "entry": {"modifyTimeForSort": 1000}
            }
            meta = SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))
            uploader = YoudaoNoteUpload(mock_api, meta)

            ok, result = uploader._upload_binary(pdf_path, "parent1", "doc.pdf", force=True)

            self.assertTrue(ok)
            self.assertIsInstance(result, UploadResult)
            self.assertEqual(result.cloud_mtime, 1000)
            self.assertEqual(result.parent_id, "parent1")
            mock_api.push_binary_file.assert_called_once()
            call_kwargs = mock_api.push_binary_file.call_args
            self.assertEqual(call_kwargs.kwargs["name"], "doc.pdf")
            self.assertEqual(call_kwargs.kwargs["file_bytes"], pdf_content)
            self.assertTrue(call_kwargs.kwargs["is_create"])
        finally:
            meta.close()
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)



if __name__ == "__main__":
    unittest.main()
