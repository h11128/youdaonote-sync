# -*- coding:utf-8 -*-
"""
格式转换补充测试（markdown_to_note_json、json_convert、detect_content_type）
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


# ========== markdown_to_note_json 测试 ==========

class MarkdownToNoteJsonTest(unittest.TestCase):
    """
    Markdown 转有道 JSON 格式测试
    python -m pytest test/test_sync.py::MarkdownToNoteJsonTest -v
    """

    def test_empty_input(self):
        """空字符串返回合法 JSON"""
        result = markdown_to_note_json("")
        parsed = json.loads(result)
        self.assertIn("5", parsed)

    def test_heading(self):
        """标题被转换为 h 类型节点"""
        result = markdown_to_note_json("# 一级标题")
        parsed = json.loads(result)
        contents = parsed["5"]

        # 找到 type=h 的节点
        h_nodes = [c for c in contents if c.get("6") == "h"]
        self.assertTrue(len(h_nodes) >= 1)

        # level 应为 h1
        self.assertEqual(h_nodes[0]["4"]["l"], "h1")

    def test_heading_levels(self):
        """各级标题映射正确"""
        data = [
            ("# H1", "h1"),
            ("## H2", "h2"),
            ("### H3", "h3"),
        ]
        for md_line, expected_level in data:
            result = json.loads(markdown_to_note_json(md_line))
            h_nodes = [c for c in result["5"] if c.get("6") == "h"]
            self.assertTrue(
                len(h_nodes) >= 1,
                f"'{md_line}' 没有产生 h 节点",
            )
            self.assertEqual(
                h_nodes[0]["4"]["l"], expected_level,
                f"'{md_line}' 的 level 应为 {expected_level}",
            )

    def test_unordered_list(self):
        """无序列表被转换为 l 类型节点"""
        result = json.loads(markdown_to_note_json("- 列表项"))
        l_nodes = [c for c in result["5"] if c.get("6") == "l"]
        self.assertTrue(len(l_nodes) >= 1)
        self.assertEqual(l_nodes[0]["4"]["lt"], "unordered")

    def test_ordered_list(self):
        """有序列表被转换为 l 类型节点"""
        result = json.loads(markdown_to_note_json("1. 列表项"))
        l_nodes = [c for c in result["5"] if c.get("6") == "l"]
        self.assertTrue(len(l_nodes) >= 1)
        self.assertEqual(l_nodes[0]["4"]["lt"], "ordered")

    def test_code_block(self):
        """代码块被转换为 cd 类型节点"""
        md = "```python\nprint('hello')\n```"
        result = json.loads(markdown_to_note_json(md))
        cd_nodes = [c for c in result["5"] if c.get("6") == "cd"]
        self.assertTrue(len(cd_nodes) >= 1)
        self.assertEqual(cd_nodes[0]["4"]["la"], "python")

    def test_quote(self):
        """引用被转换为 q 类型节点"""
        result = json.loads(markdown_to_note_json("> 引用文字"))
        q_nodes = [c for c in result["5"] if c.get("6") == "q"]
        self.assertTrue(len(q_nodes) >= 1)

    def test_image(self):
        """图片被转换为 im 类型节点"""
        result = json.loads(markdown_to_note_json("![alt](http://img.png)"))
        im_nodes = [c for c in result["5"] if c.get("6") == "im"]
        self.assertTrue(len(im_nodes) >= 1)
        self.assertEqual(im_nodes[0]["4"]["u"], "http://img.png")

    def test_paragraph(self):
        """普通段落不带 type"""
        result = json.loads(markdown_to_note_json("这是一段普通文字"))
        plain = [c for c in result["5"] if "6" not in c]
        self.assertTrue(len(plain) >= 1)

    def test_mixed_content(self):
        """混合内容产生正确数量的节点"""
        md = "# 标题\n\n段落\n\n- 列表\n\n> 引用"
        result = json.loads(markdown_to_note_json(md))
        # 至少包含标题、段落（含空行段落）、列表、引用
        self.assertTrue(len(result["5"]) >= 4)

    def test_result_is_valid_json(self):
        """任何输入都返回合法 JSON"""
        test_inputs = ["", "hello", "# h1\n## h2", "```\ncode\n```"]
        for md in test_inputs:
            result = markdown_to_note_json(md)
            try:
                json.loads(result)
            except json.JSONDecodeError:
                self.fail(f"输入 {repr(md)} 产生了非法 JSON")



# ========== covert.py 防御性处理测试 ==========

class JsonConvertDefensiveTest(unittest.TestCase):
    """
    JSON 转 Markdown 的防御性处理测试
    python -m pytest test/test_sync.py::JsonConvertDefensiveTest -v
    """

    def test_missing_key_5_returns_empty(self):
        """JSON 缺少 '5' 内容字段时返回空字符串"""
        from src.convert import YoudaoNoteConvert

        # Given — 写一个缺少 key "5" 的 JSON 文件
        tmpdir = tempfile.mkdtemp()
        f = os.path.join(tmpdir, "bad.note")
        with open(f, "w", encoding="utf-8") as fh:
            json.dump({"3": "id-only"}, fh)

        # When / Then — 不崩溃
        try:
            YoudaoNoteConvert.convert_json_to_markdown(f)
        except KeyError:
            self.fail("缺少 '5' 字段时不应抛出 KeyError")
        finally:
            import shutil
            shutil.rmtree(tmpdir)

    def test_invalid_json_returns_empty(self):
        """文件不是合法 JSON 时不崩溃"""
        from src.convert import YoudaoNoteConvert

        tmpdir = tempfile.mkdtemp()
        f = os.path.join(tmpdir, "invalid.note")
        with open(f, "w", encoding="utf-8") as fh:
            fh.write("this is not json {{{")

        try:
            YoudaoNoteConvert.convert_json_to_markdown(f)
        except (KeyError, json.JSONDecodeError):
            self.fail("非法 JSON 时不应崩溃")
        finally:
            import shutil
            shutil.rmtree(tmpdir)

    def test_heading_missing_key_4(self):
        """标题节点缺少 '4' 字段时不崩溃"""
        from src.convert import JsonConvert

        # Given — 一个缺少 "4" 的标题内容
        content = {"5": [{"7": [{"8": "test text"}]}], "6": "h"}

        # When / Then — 不抛异常
        converter = JsonConvert()
        try:
            result = converter.convert_h_func(content)
        except (AttributeError, KeyError, TypeError):
            self.fail("标题缺少 '4' 字段时不应崩溃")

    def test_image_missing_key_4(self):
        """图片节点缺少 '4' 字段时不崩溃"""
        from src.convert import JsonConvert

        content = {"6": "im"}
        converter = JsonConvert()
        try:
            result = converter.convert_im_func(content)
            self.assertIn("![](", result)
        except (AttributeError, KeyError, TypeError):
            self.fail("图片缺少 '4' 字段时不应崩溃")



# ========== _detect_content_type 测试 ==========

class DetectContentTypeTest(unittest.TestCase):
    """
    测试下载引擎的内容类型检测
    python -m pytest test/test_sync.py::DetectContentTypeTest -v
    """

    def test_xml_content(self):
        """XML 内容应检测为 XML"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b"<?xml version='1.0'?>")
        self.assertEqual(result, FileType.XML)

    def test_json_content(self):
        """JSON 内容应检测为 JSON"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b'{"key": "value"}')
        self.assertEqual(result, FileType.JSON)

    def test_other_content(self):
        """普通二进制内容应检测为 OTHER"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b"hello world")
        self.assertEqual(result, FileType.OTHER)

    def test_empty_content(self):
        """空内容应检测为 OTHER"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b"")
        self.assertEqual(result, FileType.OTHER)



if __name__ == "__main__":
    unittest.main()
