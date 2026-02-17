import json
import logging
from typing import Tuple


class JsonConvert(object):
    """
    json 转换规则
    """

    def _get_common_text(self, content: dict) -> Tuple[list, str]:
        """获取通常文本
        :return
            text(text): 文本内容
        """
        all_text = ""
        # 5 内容
        five_contents = content.get("5")
        # 判断是否是普通文本
        if five_contents:
            seven_contents = five_contents[0].get("7")
            if not seven_contents:
                return all_text
            for seven_content in seven_contents:
                # 8 文本
                text = seven_content.get("8")
                # 9 文本属性
                text_attrs = seven_content.get("9")
                if text and text_attrs:
                    text = self._convert_text_attribute(text, text_attrs)
                all_text += text
        return all_text

    def _convert_text_attribute(self, text: str, text_attrs: list):
        """文本属性"""

        if isinstance(text_attrs, list) and text_attrs and text:
            for attr in text_attrs:
                if attr["2"] == "b":
                    # 粗体
                    text = f"**{text}**"
                elif attr["2"] == "i":
                    # 斜体
                    text = f"*{text}*"

        return text

    def convert_text_func(self, content) -> str:
        """正常文本、粗体、斜体、删除线、链接"""
        all_text = ""
        one_five_contents = content.get("5")
        if one_five_contents:
            for one_five_content in one_five_contents:
                # 包含 6 和 7
                two_five_contents = one_five_content.get("5")
                # 文本类型
                text_type = one_five_content.get("6")
                # 文本和属性
                seven_contents = one_five_content.get("7")

                # 获取文本和属性
                if seven_contents and not two_five_contents:
                    text = ""
                    for seven_content in seven_contents:
                        # 8 文本
                        raw = seven_content.get("8")
                        # 9 文本属性
                        text_attrs = seven_content.get("9")
                        if raw and text_attrs:
                            raw = self._convert_text_attribute(raw, text_attrs)
                        text += raw

                # 链接类型
                elif text_type == "li" and two_five_contents:
                    source_text = self._get_common_text(one_five_content)
                    # 附加信息
                    four_contents = one_five_content.get("4")
                    if four_contents:
                        hf = four_contents.get("hf")
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
        four = content.get("4") or {}
        type_name = four.get("l")
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
        four = content.get("4") or {}
        image_url = four.get("u", "")
        return "![]({image_url})".format(image_url=image_url)

    def convert_a_func(self, content):
        """附件"""
        four = content.get("4") or {}
        fn = four.get("fn", "")
        fl = four.get("re", "")
        return "[{text}]({resource_url})".format(text=fn, resource_url=fl)

    def convert_cd_func(self, content):
        """代码块"""
        four = content.get("4") or {}
        language = four.get("la", "")
        codes: list = content.get("5") or []
        code_block = ""
        for code in codes:
            text = self._get_common_text(code)
            code_block += text + "\n"

        return "```{language}\n{code_block}```".format(
            language=language, code_block=code_block
        )

    def convert_la_func(self, content):
        """高亮块"""
        lines: list = content.get("5")
        highlight_block = ""
        for line in lines:
            text = self._get_common_text(line)
            highlight_block += text + "\n"

        return "```\n{highlight_block}```".format(highlight_block=highlight_block)

    def convert_q_func(self, content):
        """引用"""
        q_text_list = content.get("5") or []
        text = ""
        for q_text_dict in q_text_list:
            q_text = self._get_common_text(q_text_dict)
            # 去除第一行的换行
            q_text = q_text.replace("\n", "")
            text += "> {q_text}\n".format(q_text=q_text)
        return text

    def convert_l_func(self, content):
        """有序列表和无序列表，有序列表转成无序列表"""
        text = self._get_common_text(content=content)
        four = content.get("4") or {}
        is_ordered = four.get("lt", "unordered")
        if is_ordered == "unordered":
            level = four.get("ll", 1) or 1
            return "\t" * (level - 1) + "- {text}".format(text=text)
        elif is_ordered == "ordered":
            return "1. {text}".format(text=text)

    def convert_t_func(self, content):
        """
        表格转换
        """
        nl = "\n"
        tr_list = content.get("5") or []
        if not tr_list:
            return ""
        table_lines = ""

        for index, tc in enumerate(tr_list):
            table_content_list = tc.get("5") or []
            table_content_len = len(table_content_list)
            if index == 1:
                table_line = "| -- " * table_content_len + "|\n| "
            else:
                table_line = "| "
            for table_content in table_content_list:
                try:
                    inner_5 = (table_content.get("5") or [{}])[0]
                    inner_5_2 = (inner_5.get("5") or [{}])[0]
                    table_text_list = inner_5_2.get("7")
                    table_text = table_text_list[0].get("8", " ") if table_text_list else " "
                except (IndexError, AttributeError, TypeError):
                    table_text = " "
                table_line = table_line + table_text + " | "
            table_lines = table_lines + table_line + f"{nl}"
        return table_lines


def json_bytes_to_markdown(data: bytes) -> str:
    """将有道云 JSON 格式的字节转换为 Markdown 字符串。"""
    try:
        json_data = json.loads(data.decode("utf-8"))
    except Exception as e:
        logging.error(e)
        return ""

    json_contents = json_data.get("5")
    if not json_contents:
        logging.warning("JSON 笔记缺少 '5' 内容字段，跳过转换")
        return ""

    converter = JsonConvert()
    new_content_list = []
    for content in json_contents:
        ctype = content.get("6")
        if ctype:
            convert_func = getattr(
                converter, "convert_{}_func".format(ctype), None
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
