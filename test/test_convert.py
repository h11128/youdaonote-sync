# -*- coding:utf-8 -*-
"""
格式转换测试

python -m pytest test/test_convert.py -v
"""

import os
import sys
import unittest

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from youdaonote.convert.note_convert import YoudaoNoteConvert

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
        content = YoudaoNoteConvert._covert_xml_to_markdown_content(
            os.path.join(FIXTURES_DIR, "test.note")
        )
        with open(os.path.join(FIXTURES_DIR, "test.md"), "rb") as f:
            content_target = f.read().decode()
        self.assertEqual(
            content.replace("\r\n", "\n"), content_target.replace("\r\n", "\n")
        )

    def test_html_to_markdown(self):
        """测试 html 转换 markdown"""
        from markdownify import markdownify as md

        new_content = md(
            f"""<div><span style='color: rgb(68, 68, 68); line-height: 1.5; font-family: "Monaco","Consolas","Lucida Console","Courier New","serif"; font-size: 12px; background-color: rgb(247, 247, 247);'><a href="http://bbs.pcbeta.com/viewthread-1095891-1-1.html">http://bbs.pcbeta.com/viewthread-1095891-1-1.html</a></span></div>"""
        )
        expected_content = """<http://bbs.pcbeta.com/viewthread-1095891-1-1.html>"""
        self.assertEqual(new_content, expected_content)

    def test_convert_json_to_markdown_content(self):
        """
        测试 json 转换 markdown
        python -m pytest test/test_convert.py::YoudaoNoteConvertTest::test_convert_json_to_markdown_content -v
        """
        content = YoudaoNoteConvert._covert_json_to_markdown_content(
            os.path.join(FIXTURES_DIR, "test.json")
        )
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
        line = YoudaoNoteConvert._covert_json_to_markdown_content(
            os.path.join(FIXTURES_DIR, "test-convert.json")
        )
        with open(os.path.join(FIXTURES_DIR, "test-convert.md"), "rb") as f:
            target = f.read().decode()
        self.assertEqual(
            line.replace("\r\n", "\n"), target.replace("\r\n", "\n")
        )


if __name__ == "__main__":
    unittest.main()
