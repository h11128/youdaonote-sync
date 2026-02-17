import os

from src.common import MARKDOWN_SUFFIX
from src.convert.json_convert import json_bytes_to_markdown
from src.convert.xml_convert import xml_bytes_to_markdown


def html_string_to_markdown(html: str) -> str:
    """将 HTML 字符串转换为 Markdown 字符串。"""
    from markdownify import markdownify as md
    return md(html)


# ========== 文件级接口（向后兼容）==========

class YoudaoNoteConvert(object):
    """
    有道云笔记 note 内容转换为 markdown 内容。

    文件级方法内部调用纯函数，保持向后兼容。
    """

    @staticmethod
    def convert_html_to_markdown(file_path):
        """转换 HTML 文件为 Markdown 文件"""
        with open(file_path, "rb") as f:
            content_str = f.read().decode("utf-8")
        new_content = html_string_to_markdown(content_str)
        base = os.path.splitext(file_path)[0]
        new_file_path = "".join([base, MARKDOWN_SUFFIX])
        os.rename(file_path, new_file_path)
        with open(new_file_path, "wb") as f:
            f.write(new_content.encode())

    @staticmethod
    def convert_xml_to_markdown(file_path) -> bool:
        """转换 XML 文件为 Markdown 文件"""
        base = os.path.splitext(file_path)[0]
        new_file_path = "".join([base, MARKDOWN_SUFFIX])
        if os.path.getsize(file_path) == 0:
            os.rename(file_path, new_file_path)
            return False
        with open(file_path, "rb") as f:
            data = f.read()
        new_content = xml_bytes_to_markdown(data)
        os.rename(file_path, new_file_path)
        with open(new_file_path, "wb") as f:
            f.write(new_content.encode("utf-8"))
        return True

    @staticmethod
    def convert_json_to_markdown(file_path) -> str:
        """转换 JSON 文件为 Markdown 文件。返回新文件路径，空文件返回空字符串。"""
        base = os.path.splitext(file_path)[0]
        new_file_path = "".join([base, MARKDOWN_SUFFIX])
        if os.path.getsize(file_path) == 0:
            os.rename(file_path, new_file_path)
            return ""
        with open(file_path, "rb") as f:
            data = f.read()
        new_content = json_bytes_to_markdown(data)
        with open(new_file_path, "wb") as f:
            f.write(new_content.encode("utf-8"))
        if os.path.exists(file_path):
            os.remove(file_path)
        return new_file_path
