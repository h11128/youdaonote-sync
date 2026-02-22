import json
import re
import xml.etree.ElementTree as ET


# ========== 单遍替换表（替代 12 次链式 .replace()）==========

_MD_ESCAPE_RE = re.compile(r'[\\*_#&<>\u201c\u2019\t\r\n]')

_MD_ESCAPE_MAP = {
    "\\": "\\\\",
    "*": "\\*",
    "_": "\\_",
    "#": "\\#",
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\u201c": "&quot;",
    "\u2019": "&apos;",
    "\t": "&emsp;",
    "\r": "<br>",
    "\n": "<br>",
}


def _md_escape_repl(m: re.Match) -> str:
    return _MD_ESCAPE_MAP.get(m.group(), m.group())


def _encode_string_to_md(text: str) -> str:
    """将字符串转义防止 markdown 识别错误（单遍正则替换）。"""
    if not text or text == " ":
        return text
    # 先处理 \r\n → <br>（必须在单字符替换之前）
    text = text.replace("\r\n", "<br>").replace("\n\r", "<br>")
    return _MD_ESCAPE_RE.sub(_md_escape_repl, text)


# ========== XML 元素转换函数 ==========

def _get_text_by_key(element_children, key="text") -> str:
    for sub_element in element_children:
        if key in sub_element.tag:
            return sub_element.text if sub_element.text else ""
    return ""


def convert_para_func(**kwargs):
    """正常文本（粗体、斜体、删除线、链接）"""
    return kwargs.get("text")


def convert_heading_func(**kwargs):
    """标题"""
    level = kwargs.get("element").attrib.get("level", 0)
    level = 1 if level in (["a", "b"]) else level
    text = kwargs.get("text")
    return " ".join(["#" * int(level), text]) if text else text


def convert_image_func(**kwargs):
    """图片"""
    image_url = _get_text_by_key(list(kwargs.get("element")), "source")
    return f"![{kwargs.get('text')}]({image_url})"


def convert_attach_func(**kwargs):
    """附件"""
    element = kwargs.get("element")
    filename = _get_text_by_key(list(element), "filename")
    resource_url = _get_text_by_key(list(element), "resource")
    return f"[{filename}]({resource_url})"


def convert_code_func(**kwargs):
    """代码块"""
    language = _get_text_by_key(list(kwargs.get("element")), "language")
    return f"```{language}\n{kwargs.get('text')}```"


def convert_todo_func(**kwargs):
    """to-do"""
    return f"- [ ] {kwargs.get('text')}"


def convert_quote_func(**kwargs):
    """引用"""
    return f"> {kwargs.get('text')}"


def convert_horizontal_line_func(**kwargs):
    """分割线"""
    return "---"


def convert_list_item_func(**kwargs):
    """列表"""
    list_id = kwargs.get("element").attrib["list-id"]
    is_ordered = kwargs.get("list_item").get(list_id)
    text = kwargs.get("text")
    if is_ordered == "unordered":
        return f"- {text}"
    elif is_ordered == "ordered":
        return f"1. {text}"


def convert_table_func(**kwargs):
    """表格转换"""
    element = kwargs.get("element")
    content = _get_text_by_key(element, "content")

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
        cell_value = _encode_string_to_md(values)
        table_data_line.append(cell_value)
        if len(table_data_line) == table_data_len:
            table_data_arr.append(table_data_line)
            table_data_line = []

    if len(table_data_arr) == 1:
        table_data_arr.insert(0, list(" " * table_data_len))
        table_data_arr.insert(1, list("-" * table_data_len))
    elif len(table_data_arr) > 1:
        table_data_arr.insert(1, list("-" * table_data_len))

    lines = []
    for table_line in table_data_arr:
        cells_str = " | ".join(str(c) for c in table_line)
        lines.append(f"| {cells_str} |")
    return "\n".join(lines) + "\n" if lines else ""


# ========== 转换函数注册表 ==========

_CONVERTERS = {
    "para": convert_para_func,
    "heading": convert_heading_func,
    "image": convert_image_func,
    "attach": convert_attach_func,
    "code": convert_code_func,
    "todo": convert_todo_func,
    "quote": convert_quote_func,
    "horizontal_line": convert_horizontal_line_func,
    "list_item": convert_list_item_func,
    "table": convert_table_func,
}


# ========== 向后兼容：保留 XmlElementConvert 类作为代理 ==========

class XmlElementConvert:
    """向后兼容代理，所有方法委托给模块级函数。"""

    get_text_by_key = staticmethod(_get_text_by_key)
    _encode_string_to_md = staticmethod(_encode_string_to_md)
    convert_para_func = staticmethod(convert_para_func)
    convert_heading_func = staticmethod(convert_heading_func)
    convert_image_func = staticmethod(convert_image_func)
    convert_attach_func = staticmethod(convert_attach_func)
    convert_code_func = staticmethod(convert_code_func)
    convert_todo_func = staticmethod(convert_todo_func)
    convert_quote_func = staticmethod(convert_quote_func)
    convert_horizontal_line_func = staticmethod(convert_horizontal_line_func)
    convert_list_item_func = staticmethod(convert_list_item_func)
    convert_table_func = staticmethod(convert_table_func)


# ========== 公共入口 ==========

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
        text = _get_text_by_key(list(element))
        name = element.tag.replace("{http://note.youdao.com}", "").replace("-", "_")
        convert_func = _CONVERTERS.get(name)
        if not convert_func:
            new_content_list.append(text)
            continue
        line_content = convert_func(text=text, element=element, list_item=list_item)
        new_content_list.append(line_content)
    return "\n\n".join(new_content_list)
