import json
import logging
from typing import Tuple


# 有道云 JSON 笔记的字段语义映射
F_ATTRS = "4"       # 元素属性（链接 URL、语言、列表类型等）
F_CHILDREN = "5"    # 子元素列表
F_TYPE = "6"        # 元素类型标识（h/im/a/cd/la/q/l/t 等）
F_SPANS = "7"       # 文本 span 列表
F_TEXT = "8"         # span 中的文本内容
F_TEXT_ATTRS = "9"   # span 的文本样式属性
F_ATTR_TYPE = "2"    # 样式属性的类型标识（b=粗体, i=斜体）


class JsonConvert(object):
    """有道云 JSON 笔记转 Markdown"""

    def _get_common_text(self, content: dict) -> str:
        all_text = ""
        children = content.get(F_CHILDREN)
        if children:
            spans = children[0].get(F_SPANS)
            if not spans:
                return all_text
            for span in spans:
                text = span.get(F_TEXT)
                text_attrs = span.get(F_TEXT_ATTRS)
                if text and text_attrs:
                    text = self._convert_text_attribute(text, text_attrs)
                all_text += text
        return all_text

    def _convert_text_attribute(self, text: str, text_attrs: list):
        if isinstance(text_attrs, list) and text_attrs and text:
            for attr in text_attrs:
                if attr[F_ATTR_TYPE] == "b":
                    text = f"**{text}**"
                elif attr[F_ATTR_TYPE] == "i":
                    text = f"*{text}*"
        return text

    def convert_text_func(self, content) -> str:
        """正常文本、粗体、斜体、删除线、链接"""
        all_text = ""
        one_children = content.get(F_CHILDREN)
        if one_children:
            for child in one_children:
                two_children = child.get(F_CHILDREN)
                text_type = child.get(F_TYPE)
                spans = child.get(F_SPANS)

                if spans and not two_children:
                    text = ""
                    for span in spans:
                        raw = span.get(F_TEXT)
                        text_attrs = span.get(F_TEXT_ATTRS)
                        if raw and text_attrs:
                            raw = self._convert_text_attribute(raw, text_attrs)
                        text += raw

                elif text_type == "li" and two_children:
                    source_text = self._get_common_text(child)
                    attrs = child.get(F_ATTRS)
                    if attrs:
                        hf = attrs.get("hf")
                        text = f"[{source_text}]({hf})"
                    else:
                        text = ""
                else:
                    text = ""
                if text:
                    all_text += text
        return all_text

    def convert_h_func(self, content) -> str:
        """标题"""
        attrs = content.get(F_ATTRS) or {}
        type_name = attrs.get("l")
        text = self._get_common_text(content=content)
        if text and type_name:
            level_str = type_name.replace("h", "")
            try:
                level = int(level_str)
            except ValueError:
                level = 1
            text = " ".join(["#" * level, text])
        return text

    def convert_im_func(self, content):
        """图片"""
        attrs = content.get(F_ATTRS) or {}
        image_url = attrs.get("u", "")
        return f"![]({image_url})"

    def convert_a_func(self, content):
        """附件"""
        attrs = content.get(F_ATTRS) or {}
        fn = attrs.get("fn", "")
        fl = attrs.get("re", "")
        return f"[{fn}]({fl})"

    def convert_cd_func(self, content):
        """代码块"""
        attrs = content.get(F_ATTRS) or {}
        language = attrs.get("la", "")
        codes: list = content.get(F_CHILDREN) or []
        code_block = ""
        for code in codes:
            text = self._get_common_text(code)
            code_block += text + "\n"
        return f"```{language}\n{code_block}```"

    def convert_la_func(self, content):
        """高亮块"""
        lines: list = content.get(F_CHILDREN)
        highlight_block = ""
        for line in lines:
            text = self._get_common_text(line)
            highlight_block += text + "\n"
        return f"```\n{highlight_block}```"

    def convert_q_func(self, content):
        """引用"""
        q_text_list = content.get(F_CHILDREN) or []
        text = ""
        for q_text_dict in q_text_list:
            q_text = self._get_common_text(q_text_dict)
            q_text = q_text.replace("\n", "")
            text += f"> {q_text}\n"
        return text

    def convert_l_func(self, content):
        """有序列表和无序列表"""
        text = self._get_common_text(content=content)
        attrs = content.get(F_ATTRS) or {}
        is_ordered = attrs.get("lt", "unordered")
        if is_ordered == "unordered":
            level = attrs.get("ll", 1) or 1
            return "\t" * (level - 1) + f"- {text}"
        elif is_ordered == "ordered":
            return f"1. {text}"

    def convert_t_func(self, content):
        """表格转换"""
        tr_list = content.get(F_CHILDREN) or []
        if not tr_list:
            return ""
        table_lines = ""

        for index, tc in enumerate(tr_list):
            table_content_list = tc.get(F_CHILDREN) or []
            table_content_len = len(table_content_list)
            if index == 1:
                table_line = "| -- " * table_content_len + "|\n| "
            else:
                table_line = "| "
            for table_content in table_content_list:
                try:
                    inner = (table_content.get(F_CHILDREN) or [{}])[0]
                    inner2 = (inner.get(F_CHILDREN) or [{}])[0]
                    spans = inner2.get(F_SPANS)
                    table_text = spans[0].get(F_TEXT, " ") if spans else " "
                except (IndexError, AttributeError, TypeError):
                    table_text = " "
                table_line = table_line + table_text + " | "
            table_lines = table_lines + table_line + "\n"
        return table_lines


def json_bytes_to_markdown(data: bytes) -> str:
    """将有道云 JSON 格式的字节转换为 Markdown 字符串。"""
    try:
        json_data = json.loads(data.decode("utf-8"))
    except Exception as e:
        logging.error(e)
        return ""

    json_contents = json_data.get(F_CHILDREN)
    if not json_contents:
        logging.warning("JSON 笔记缺少内容字段，跳过转换")
        return ""

    converter = JsonConvert()
    new_content_list = []
    for content in json_contents:
        ctype = content.get(F_TYPE)
        if ctype:
            convert_func = getattr(
                converter, f"convert_{ctype}_func", None
            )
            if not convert_func:
                line_content = converter.convert_text_func(content)
            else:
                line_content = convert_func(content)
        else:
            line_content = converter.convert_text_func(content)
        if line_content:
            new_content_list.append(line_content)
    return "\n\n".join(new_content_list)
