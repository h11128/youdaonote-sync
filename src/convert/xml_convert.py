import json
import xml.etree.ElementTree as ET


class XmlElementConvert(object):
    """
    XML Element 转换规则
    """

    @staticmethod
    def convert_para_func(**kwargs):
        """正常文本（粗体、斜体、删除线、链接）"""
        return kwargs.get("text")

    @staticmethod
    def convert_heading_func(**kwargs):
        """标题"""
        level = kwargs.get("element").attrib.get("level", 0)
        level = 1 if level in (["a", "b"]) else level
        text = kwargs.get("text")
        return " ".join(["#" * int(level), text]) if text else text

    @staticmethod
    def convert_image_func(**kwargs):
        """图片"""
        image_url = XmlElementConvert.get_text_by_key(
            list(kwargs.get("element")), "source"
        )
        return "![{text}]({image_url})".format(
            text=kwargs.get("text"), image_url=image_url
        )

    @staticmethod
    def convert_attach_func(**kwargs):
        """附件"""
        element = kwargs.get("element")
        filename = XmlElementConvert.get_text_by_key(list(element), "filename")
        resource_url = XmlElementConvert.get_text_by_key(list(element), "resource")
        return "[{text}]({resource_url})".format(
            text=filename, resource_url=resource_url
        )

    @staticmethod
    def convert_code_func(**kwargs):
        """代码块"""
        language = XmlElementConvert.get_text_by_key(
            list(kwargs.get("element")), "language"
        )
        return "```{language}\n{code}```".format(
            language=language, code=kwargs.get("text")
        )

    @staticmethod
    def convert_todo_func(**kwargs):
        """to-do"""
        return "- [ ] {text}".format(text=kwargs.get("text"))

    @staticmethod
    def convert_quote_func(**kwargs):
        """引用"""
        return "> {text}".format(text=kwargs.get("text"))

    @staticmethod
    def convert_horizontal_line_func(**kwargs):
        """分割线"""
        return "---"

    @staticmethod
    def convert_list_item_func(**kwargs):
        """列表"""
        list_id = kwargs.get("element").attrib["list-id"]
        is_ordered = kwargs.get("list_item").get(list_id)
        text = kwargs.get("text")
        if is_ordered == "unordered":
            return "- {text}".format(text=text)
        elif is_ordered == "ordered":
            return "1. {text}".format(text=text)

    @staticmethod
    def convert_table_func(**kwargs):
        """
        表格转换
        :param kwargs:
        :return:
        """
        element = kwargs.get("element")
        content = XmlElementConvert.get_text_by_key(element, "content")

        table_data_str = ""
        nl = "\n"
        try:
            table_data = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return content if content else ""
        table_data_len = len(table_data.get("widths", []))
        table_data_arr = []
        table_data_line = []

        for cells in table_data.get("cells", []):
            values = cells.get("value")
            if values is None:
                values = ""
            cell_value = XmlElementConvert._encode_string_to_md(values)
            table_data_line.append(cell_value)
            # 攒齐一行放到 table_data_arr 中，并重置 table_data_line
            if len(table_data_line) == table_data_len:
                table_data_arr.append(table_data_line)
                table_data_line = []

        # 如果只有一行，那就给他加一个空白 title 行
        if len(table_data_arr) == 1:
            table_data_arr.insert(0, [ch for ch in (" " * table_data_len)])
            table_data_arr.insert(1, [ch for ch in ("-" * table_data_len)])
        elif len(table_data_arr) > 1:
            table_data_arr.insert(1, [ch for ch in ("-" * table_data_len)])

        for table_line in table_data_arr:
            table_data_str += "|"
            for table_data in table_line:
                table_data_str += f" %s |" % table_data
            table_data_str += f"{nl}"

        return table_data_str

    @staticmethod
    def get_text_by_key(element_children, key="text"):
        """
        获取文本内容
        :return:
        """
        for sub_element in element_children:
            if key in sub_element.tag:
                return sub_element.text if sub_element.text else ""
        return ""

    @staticmethod
    def _encode_string_to_md(original_text):
        """将字符串转义防止 markdown 识别错误"""
        if len(original_text) <= 0 or original_text == " ":
            return original_text

        original_text = original_text.replace("\\", "\\\\")  # \\ 反斜杠
        original_text = original_text.replace("*", "\\*")  # \* 星号
        original_text = original_text.replace("_", "\\_")  # \_ 下划线
        original_text = original_text.replace("#", "\\#")  # \# 井号

        # markdown 中需要转义的字符
        original_text = original_text.replace("&", "&amp;")
        original_text = original_text.replace("<", "&lt;")
        original_text = original_text.replace(">", "&gt;")
        original_text = original_text.replace("\u201c", "&quot;")  # left double quote
        original_text = original_text.replace("\u2019", "&apos;")  # right single quote

        original_text = original_text.replace("\t", "&emsp;")

        # 换行 <br>
        original_text = original_text.replace("\r\n", "<br>")
        original_text = original_text.replace("\n\r", "<br>")
        original_text = original_text.replace("\r", "<br>")
        original_text = original_text.replace("\n", "<br>")

        return original_text


def xml_bytes_to_markdown(data: bytes) -> str:
    """将有道云 XML 格式的字节转换为 Markdown 字符串。"""
    root = ET.fromstring(data)
    list_item = {}
    for child in root[0]:
        if "list" in child.tag:
            list_item[child.attrib["id"]] = child.attrib["type"]

    body_element = root[1]
    new_content_list = []
    for element in list(body_element):
        text = XmlElementConvert.get_text_by_key(list(element))
        name = element.tag.replace("{http://note.youdao.com}", "").replace("-", "_")
        convert_func = getattr(
            XmlElementConvert, "convert_{}_func".format(name), None
        )
        if not convert_func:
            new_content_list.append(text)
            continue
        line_content = convert_func(text=text, element=element, list_item=list_item)
        new_content_list.append(line_content)
    return "\n\n".join(new_content_list)
