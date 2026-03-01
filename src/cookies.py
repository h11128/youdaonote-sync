#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记 Cookie 管理器
统一的 Cookie 加载、保存、备份功能
"""

import json
import logging
import os
import platform
from datetime import datetime
from typing import Dict, List, NamedTuple, Optional, Tuple

from src.common import get_script_directory, get_config_directory


class CookieEntry(NamedTuple):
    """cookies.json 中的单条记录"""
    name: str
    value: str
    domain: str
    path: str


class CookieManager:
    """
    Cookie 管理器
    提供统一的 Cookie 管理功能
    """

    # 必需的 Cookie 名称
    REQUIRED_COOKIES = ['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS']

    @staticmethod
    def _find_missing_cookies(cookie_names) -> set:
        """返回 cookie_names 中缺少的必需 cookie 名称集合。"""
        return set(CookieManager.REQUIRED_COOKIES) - set(cookie_names)

    @staticmethod
    def has_required_cookies(cookie_names) -> bool:
        """检查给定的 cookie 名称列表是否包含所有必需的 cookie。"""
        return all(name in cookie_names for name in CookieManager.REQUIRED_COOKIES)

    @staticmethod
    def get_default_path() -> str:
        """
        获取默认的 cookies.json 路径
        :return: cookies.json 文件路径
        """
        return os.path.join(get_config_directory(), "cookies.json")

    @staticmethod
    def load(cookies_path: str = None) -> Tuple[List[CookieEntry], str]:
        """
        加载 cookies
        :param cookies_path: cookies.json 文件路径
        :return: (cookies 列表, 错误信息)
        """
        if cookies_path is None:
            cookies_path = CookieManager.get_default_path()

        try:
            with open(cookies_path, "rb") as f:
                json_str = f.read().decode("utf-8")

            cookies_dict = json.loads(json_str)
            raw = cookies_dict.get("cookies", [])

            if not raw:
                return [], "cookies.json 中没有找到 cookies 数据"

            cookies = [
                CookieEntry(*c) for c in raw
                if isinstance(c, list) and len(c) >= 4
            ]
            if not cookies:
                return [], "cookies.json 中没有有效的 cookie 条目"

            return cookies, ""

        except FileNotFoundError:
            return [], f"找不到文件: {cookies_path}"
        except json.JSONDecodeError as e:
            return [], f"JSON 解析错误: {e}"
        except Exception as e:
            return [], f"加载 cookies 失败: {e}"

    @staticmethod
    def save(cookies_data: Dict, cookies_path: str = None, backup: bool = True) -> Tuple[bool, str]:
        """
        保存 cookies
        :param cookies_data: cookies 数据字典，格式为 {"cookies": [...]}
        :param cookies_path: 保存路径
        :param backup: 是否备份现有文件
        :return: (是否成功, 错误信息)
        """
        if cookies_path is None:
            cookies_path = CookieManager.get_default_path()

        try:
            # 备份现有文件
            if backup:
                CookieManager.backup(cookies_path)

            # 保存新文件
            with open(cookies_path, 'w', encoding='utf-8') as f:
                json.dump(cookies_data, f, indent=4, ensure_ascii=False)

            return True, ""

        except Exception as e:
            return False, f"保存 cookies 失败: {e}"

    @staticmethod
    def backup(cookies_path: str = None) -> Optional[str]:
        """
        备份 cookies 文件
        :param cookies_path: cookies.json 文件路径
        :return: 备份文件路径，如果没有备份则返回 None
        """
        if cookies_path is None:
            cookies_path = CookieManager.get_default_path()

        if not os.path.exists(cookies_path):
            return None

        try:
            # 生成备份文件名
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            
            # 确定备份目录
            script_dir = get_script_directory()
            backups_dir = os.path.join(script_dir, "backups")
            
            # 确保 backups 目录存在
            os.makedirs(backups_dir, exist_ok=True)
            backup_path = os.path.join(backups_dir, f"cookies.json.backup.{timestamp}")

            # 复制文件
            with open(cookies_path, 'r', encoding='utf-8') as f:
                content = f.read()
            with open(backup_path, 'w', encoding='utf-8') as f:
                f.write(content)

            return backup_path

        except Exception as e:
            logging.warning(f"备份失败: {e}")
            return None

    @staticmethod
    def validate(cookies_path: str = None) -> Tuple[bool, str]:
        """
        验证 cookies 是否有效（格式检查）
        :param cookies_path: cookies.json 文件路径
        :return: (是否有效, 错误信息)
        """
        cookies, error = CookieManager.load(cookies_path)
        
        if error:
            return False, error

        cookie_names = [c.name for c in cookies]
        missing = CookieManager._find_missing_cookies(cookie_names)
        
        if missing:
            return False, f"缺少必需的 cookies: {', '.join(missing)}"

        for cookie in cookies:
            if not cookie.value or cookie.value == "**":
                return False, f"Cookie {cookie.name} 的值为空或未设置"

        return True, ""

    @staticmethod
    def create_from_dict(cookie_dict: Dict[str, str]) -> Dict:
        """
        从字典创建 cookies 数据
        :param cookie_dict: 字典格式的 cookies，如 {"YNOTE_CSTK": "xxx", ...}
        :return: cookies.json 格式的数据
        """
        cookies_data = {"cookies": []}
        
        for name in CookieManager.REQUIRED_COOKIES:
            value = cookie_dict.get(name, "")
            cookies_data["cookies"].append(
                CookieEntry(name, value, ".note.youdao.com", "/")
            )
        
        return cookies_data

    @staticmethod
    def _get_desktop_setting_path() -> Optional[str]:
        """定位有道云笔记桌面客户端的 setting.json。

        桌面客户端是 Electron 应用，数据目录在:
        - Windows: %APPDATA%/ynote-desktop/setting.json
        - macOS:   ~/Library/Application Support/ynote-desktop/setting.json
        - Linux:   ~/.config/ynote-desktop/setting.json
        """
        system = platform.system()
        if system == "Windows":
            base = os.environ.get("APPDATA", "")
        elif system == "Darwin":
            base = os.path.expanduser("~/Library/Application Support")
        else:
            base = os.environ.get("XDG_CONFIG_HOME",
                                  os.path.expanduser("~/.config"))
        if not base:
            return None
        path = os.path.join(base, "ynote-desktop", "setting.json")
        return path if os.path.isfile(path) else None

    @staticmethod
    def load_from_desktop() -> Tuple[List[CookieEntry], str]:
        """从有道云笔记桌面客户端读取 cookies。

        桌面客户端在 setting.json 的 ``cookies`` 字段保存了完整的
        session cookies（YNOTE_SESS / YNOTE_CSTK / YNOTE_LOGIN 等），
        且会在每次启动时自动刷新，不会像浏览器导出的 cookie 那样过期。

        :return: (cookies 列表 [[name, value, domain, path], ...], error_msg)
        """
        setting_path = CookieManager._get_desktop_setting_path()
        if not setting_path:
            return [], "未找到有道云笔记桌面客户端数据"

        try:
            with open(setting_path, "r", encoding="utf-8") as f:
                setting = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            return [], f"读取桌面客户端 setting.json 失败: {e}"

        raw_cookies = setting.get("cookies", [])
        if not raw_cookies:
            return [], "桌面客户端 setting.json 中没有 cookies"

        result: List[CookieEntry] = []
        for c in raw_cookies:
            if not isinstance(c, dict):
                continue
            name = c.get("name", "")
            value = c.get("value", "")
            domain = c.get("domain", "") or ".note.youdao.com"
            path = c.get("path", "/")
            if name and value:
                result.append(CookieEntry(name, value, domain, path))

        if not result:
            return [], "桌面客户端 cookies 为空"

        cookie_names = [c.name for c in result]
        missing = CookieManager._find_missing_cookies(cookie_names)
        if missing:
            return [], f"桌面客户端 cookies 缺少: {', '.join(missing)}"

        logging.info(f"从桌面客户端读取了 {len(result)} 个 cookies")
        return result, ""

    @staticmethod
    def extract_from_browser() -> Tuple[Optional[Dict], str]:
        """
        从浏览器自动提取 cookies。

        .. deprecated:: 实际实现已移至 ``src.auth.extract_cookies_from_browser``
        """
        from src.auth import extract_cookies_from_browser
        return extract_cookies_from_browser()

    @staticmethod
    def convert_playwright_cookies(playwright_cookies: List[Dict]) -> Tuple[Optional[Dict], str]:
        """
        将 Playwright 的 cookies 格式转换为项目需要的格式
        :param playwright_cookies: Playwright 返回的 cookies 列表
        :return: (cookies 数据, 错误信息)
        """
        found_cookies = {}

        for cookie in playwright_cookies:
            name = cookie.get('name', '')
            if name in CookieManager.REQUIRED_COOKIES:
                found_cookies[name] = cookie.get('value', '')

        # 检查是否找到所有必需的 cookies
        missing = CookieManager._find_missing_cookies(found_cookies.keys())
        if missing:
            return None, f"缺少必需的 cookies: {', '.join(missing)}"

        # 构建 cookies 数据
        cookies_data = CookieManager.create_from_dict(found_cookies)
        return cookies_data, ""
