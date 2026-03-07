# -*- coding:utf-8 -*-
"""
格式转换测试

python -m pytest test/test_convert.py -v
"""

import os
import sys
import unittest

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.convert.note_convert import (
    YoudaoNoteConvert,
    xml_bytes_to_markdown,
    json_bytes_to_markdown,
    html_string_to_markdown,
)

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


class YoudaoNoteConvertTest(unittest.TestCase):
    """
    测试格式转换
    python -m pytest test/test_convert.py::YoudaoNoteConvertTest -v
    """

    def test_convert_xml_to_markdown_content(self):
        """
        测试 xml 转换 markdown
        python -m pytest test/test_convert.py::YoudaoNoteConvertTest::test_convert_xml_to_markdown_content -v
        """
        with open(os.path.join(FIXTURES_DIR, "test.note"), "rb") as f:
            data = f.read()
        content = xml_bytes_to_markdown(data)
        with open(os.path.join(FIXTURES_DIR, "test.md"), "rb") as f:
            content_target = f.read().decode()
        self.assertEqual(
            content.replace("\r\n", "\n"), content_target.replace("\r\n", "\n")
        )

    def test_html_to_markdown(self):
        """测试 html 转换 markdown（直接调用 markdownify）"""
        from markdownify import markdownify as md

        new_content = md(
            f"""<div><span style='color: rgb(68, 68, 68); line-height: 1.5; font-family: "Monaco","Consolas","Lucida Console","Courier New","serif"; font-size: 12px; background-color: rgb(247, 247, 247);'><a href="http://bbs.pcbeta.com/viewthread-1095891-1-1.html">http://bbs.pcbeta.com/viewthread-1095891-1-1.html</a></span></div>"""
        )
        expected_content = """<http://bbs.pcbeta.com/viewthread-1095891-1-1.html>"""
        self.assertEqual(new_content, expected_content)

    def test_html_string_to_markdown_simple(self):
        """测试 html_string_to_markdown 纯函数：简单 HTML"""
        # Given
        html = "<h1>Title</h1><p>Hello <strong>world</strong></p>"

        # When
        result = html_string_to_markdown(html)

        # Then
        self.assertIn("Title", result)
        self.assertIn("**world**", result)

    def test_html_string_to_markdown_link(self):
        """测试 html_string_to_markdown 纯函数：链接"""
        # Given
        html = '<a href="http://example.com">example</a>'

        # When
        result = html_string_to_markdown(html)

        # Then
        self.assertIn("example", result)
        self.assertIn("http://example.com", result)

    def test_convert_json_to_markdown_content(self):
        """
        测试 json 转换 markdown
        python -m pytest test/test_convert.py::YoudaoNoteConvertTest::test_convert_json_to_markdown_content -v
        """
        with open(os.path.join(FIXTURES_DIR, "test.json"), "rb") as f:
            data = f.read()
        content = json_bytes_to_markdown(data)
        with open(os.path.join(FIXTURES_DIR, "test-json.md"), "rb") as f:
            content_target = f.read().decode()
        self.assertEqual(
            content.replace("\r\n", "\n"), content_target.replace("\r\n", "\n")
        )

    def test_convert_json_to_markdown_single_line(self):
        """
        测试 json 转换 markdown 单行富文本
        python -m pytest test/test_convert.py::YoudaoNoteConvertTest::test_convert_json_to_markdown_single_line -v
        """
        with open(os.path.join(FIXTURES_DIR, "test-convert.json"), "rb") as f:
            data = f.read()
        line = json_bytes_to_markdown(data)
        with open(os.path.join(FIXTURES_DIR, "test-convert.md"), "rb") as f:
            target = f.read().decode()
        self.assertEqual(
            line.replace("\r\n", "\n"), target.replace("\r\n", "\n")
        )


if __name__ == "__main__":
    unittest.main()
