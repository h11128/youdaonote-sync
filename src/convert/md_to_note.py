"""
Markdown 转有道云笔记 JSON 格式

将 Markdown 文本转换为有道云笔记的 JSON 格式，用于上传普通笔记（.note）
"""

import json
import re
import uuid
from typing import List, Dict, Any


def _generate_id() -> str:
    """生成随机 ID（4 字符 + 时间戳风格）"""
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    import random
    prefix = "".join(random.choice(chars) for _ in range(4))
    timestamp = str(int(__import__("time").time() * 1000))[-13:]
    return f"{prefix}-{timestamp}"


def _create_text_node(text: str, attrs: List[Dict] = None) -> Dict:
    """创建文本节点"""
    node = {"8": text}
    if attrs:
        node["9"] = attrs
    return node


def _make_text_line(text: str) -> Dict:
    """创建一个包含纯文本的行子元素 — 大多数元素的 '5' 列表项共用此结构。"""
    return {
        "2": "2",
        "3": _generate_id(),
        "7": [{"8": text}],
    }


def _create_element(
    type_code: str = None,
    attrs: Dict = None,
    children: List[Dict] = None,
) -> Dict:
    """
    构建有道云笔记 JSON 元素的通用工厂。
    :param type_code: 元素类型（"h" / "l" / "cd" / "q" / "im" / "li"），None 表示段落
    :param attrs: 附加属性，写入 key "4"
    :param children: key "5" 的子元素列表
    """
    elem: Dict[str, Any] = {"3": _generate_id()}
    if attrs:
        elem["4"] = attrs
    if children is not None:
        elem["5"] = children
    if type_code:
        elem["6"] = type_code
    return elem


# ---------- 各类元素的快捷创建 ----------

def _create_paragraph(text: str, text_attrs: List[Dict] = None) -> Dict:
    node = _create_text_node(text, text_attrs)
    return _create_element(children=[{
        "2": "2", "3": _generate_id(), "7": [node],
    }])


def _create_heading(text: str, level: int) -> Dict:
    return _create_element("h", {"l": f"h{level}"}, [_make_text_line(text)])


def _create_list_item(text: str, ordered: bool = False, level: int = 1) -> Dict:
    lt = "ordered" if ordered else "unordered"
    return _create_element("l", {"lt": lt, "ll": level}, [_make_text_line(text)])


def _create_code_block(code: str, language: str = "") -> Dict:
    lines = [_create_element(children=[_make_text_line(ln)]) for ln in code.split("\n")]
    return _create_element("cd", {"la": language}, lines)


def _create_quote(text: str) -> Dict:
    lines = [_create_element(children=[_make_text_line(ln)]) for ln in text.split("\n")]
    return _create_element("q", children=lines)


def _create_image(url: str, alt: str = "") -> Dict:
    return _create_element("im", {"u": url})


def _create_link(text: str, url: str) -> Dict:
    return _create_element("li", {"hf": url}, [_make_text_line(text)])


def _parse_inline_formatting(text: str) -> List[Dict]:
    """
    解析行内格式（粗体、斜体、链接等）
    
    :param text: 原始文本
    :return: 节点列表
    """
    nodes = []
    
    # 简单处理：暂时不解析行内格式，直接作为纯文本
    # 后续可以增加对 **粗体**、*斜体*、[链接](url) 等的解析
    if text:
        nodes.append(_create_text_node(text))
    
    return nodes


def _parse_markdown_line(line: str) -> Dict:
    """
    解析单行 Markdown
    
    :param line: Markdown 行
    :return: 节点字典
    """
    line = line.rstrip()
    
    # 空行
    if not line:
        return _create_paragraph("")
    
    # 标题 (# ## ### etc)
    heading_match = re.match(r'^(#{1,6})\s+(.+)$', line)
    if heading_match:
        level = len(heading_match.group(1))
        text = heading_match.group(2)
        return _create_heading(text, level)
    
    # 无序列表 (- * +)
    unordered_match = re.match(r'^(\s*)[-*+]\s+(.+)$', line)
    if unordered_match:
        indent = len(unordered_match.group(1))
        level = (indent // 2) + 1 if indent else 1
        text = unordered_match.group(2)
        return _create_list_item(text, ordered=False, level=level)
    
    # 有序列表 (1. 2. etc)
    ordered_match = re.match(r'^(\s*)\d+\.\s+(.+)$', line)
    if ordered_match:
        indent = len(ordered_match.group(1))
        level = (indent // 2) + 1 if indent else 1
        text = ordered_match.group(2)
        return _create_list_item(text, ordered=True, level=level)
    
    # 引用 (>)
    quote_match = re.match(r'^>\s*(.*)$', line)
    if quote_match:
        text = quote_match.group(1)
        return _create_quote(text)
    
    # 图片 ![alt](url)
    image_match = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', line)
    if image_match:
        alt = image_match.group(1)
        url = image_match.group(2)
        return _create_image(url, alt)
    
    # 分隔线 (--- *** ___)
    if re.match(r'^[-*_]{3,}$', line):
        return _create_paragraph("---")
    
    # 普通段落
    return _create_paragraph(line)


def markdown_to_note_json(md_content: str) -> str:
    """
    将 Markdown 转换为有道云笔记 JSON 格式
    
    :param md_content: Markdown 文本
    :return: 有道云笔记 JSON 字符串
    """
    lines = md_content.split("\n")
    content_list = []
    
    i = 0
    while i < len(lines):
        line = lines[i]
        
        # 代码块处理
        code_match = re.match(r'^```(\w*)$', line)
        if code_match:
            language = code_match.group(1)
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code_lines.append(lines[i])
                i += 1
            code_content = "\n".join(code_lines)
            content_list.append(_create_code_block(code_content, language))
            i += 1  # 跳过结束的 ```
            continue
        
        # 多行引用处理
        if line.startswith(">"):
            quote_lines = []
            while i < len(lines) and lines[i].startswith(">"):
                quote_text = re.sub(r'^>\s*', '', lines[i])
                quote_lines.append(quote_text)
                i += 1
            quote_content = "\n".join(quote_lines)
            content_list.append(_create_quote(quote_content))
            continue
        
        # 单行处理
        node = _parse_markdown_line(line)
        content_list.append(node)
        i += 1
    
    # 构建完整的 JSON 结构
    doc_id = _generate_id()
    result = {
        "2": "1",
        "3": doc_id,
        "4": {
            "version": 1,
            "incompatibleVersion": 0,
            "fv": "0"
        },
        "5": content_list,
        "title": "",
        "__compress__": True
    }
    
    return json.dumps(result, ensure_ascii=False)


def note_json_to_markdown(json_content: str) -> str:
    """
    将有道云笔记 JSON 格式转换为 Markdown（使用现有的 covert.py 逻辑）
    
    :param json_content: 有道云笔记 JSON 字符串
    :return: Markdown 文本
    """
    # 复用现有的转换逻辑
    from src.convert.note_convert import JsonConvert
    
    try:
        json_data = json.loads(json_content)
    except json.JSONDecodeError:
        return json_content
    
    json_contents = json_data.get("5", [])
    new_content_list = []
    converter = JsonConvert()
    
    for content in json_contents:
        content_type = content.get("6")
        
        if content_type:
            convert_func = getattr(converter, f"convert_{content_type}_func", None)
            if convert_func:
                line_content = convert_func(content)
            else:
                line_content = converter.convert_text_func(content)
        else:
            line_content = converter.convert_text_func(content)
        
        if line_content:
            new_content_list.append(line_content)
    
    return "\n\n".join(new_content_list)
