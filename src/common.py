import os
import platform
import sys
import uuid
from enum import IntEnum


# ========== 常量 ==========

MARKDOWN_SUFFIX = ".md"


# ========== 枚举 ==========

class NoteDomain(IntEnum):
    """有道云笔记类型"""
    NOTE = 0       # 普通笔记（XML/JSON 格式）
    MARKDOWN = 1   # Markdown 笔记


# ========== 工具函数 ==========

def normalize_sep(path: str) -> str:
    """将路径中的反斜杠统一为正斜杠。"""
    return path.replace("\\", "/")


def generate_file_id() -> str:
    """生成新的有道云文件 ID。"""
    return "WEB" + uuid.uuid4().hex


def get_script_directory():
    """获取脚本所在的目录"""

    if getattr(sys, "frozen", False):
        # 如果是打包后的可执行文件
        return os.path.dirname(sys.executable)
    else:
        # 如果是普通脚本
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_config_directory():
    """获取配置文件目录"""
    return os.path.join(get_script_directory(), "config")


def format_file_size(size: int) -> str:
    """将字节数格式化为可读的文件大小字符串。"""
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f}MB"
    elif size >= 1024:
        return f"{size / 1024:.1f}KB"
    return f"{size}B"


def load_config():
    """
    加载配置文件。
    :return: (config_dict, error_msg)
    """
    import json
    config_path = os.path.join(get_config_directory(), "config.json")

    if not os.path.exists(config_path):
        return {
            "local_dir": "",
            "ydnote_dir": "",
            "smms_secret_token": "",
            "is_relative_path": True,
            "sync_include": [],
            "sync_exclude": [],
        }, ""

    try:
        with open(config_path, "rb") as f:
            config_str = f.read().decode("utf-8")
        config_dict = json.loads(config_str)
        config_dict.setdefault("sync_include", [])
        config_dict.setdefault("sync_exclude", [])
        return config_dict, ""
    except json.JSONDecodeError as e:
        return {}, f"config.json 格式错误: {e}"
    except OSError as e:
        return {}, f"读取配置失败: {e}"


def safe_long_path(path: str) -> str:
    """
    处理 Windows 长路径问题。
    
    Windows 默认最大路径长度 260 字符（MAX_PATH），超过后文件操作会报错。
    对于超长路径，添加 ``\\\\?\\`` 前缀来突破限制。
    非 Windows 系统或短路径原样返回。
    
    :param path: 文件路径
    :return: 可能添加了长路径前缀的路径
    """
    if platform.system() != "Windows":
        return path
    # 已有前缀则跳过
    if path.startswith("\\\\?\\"):
        return path
    # 路径足够短则不处理（留一些余量给文件名拼接）
    if len(path) < 240:
        return path
    # \\?\ 前缀要求绝对路径且使用反斜杠
    abs_path = os.path.abspath(path)
    return "\\\\?\\" + abs_path
