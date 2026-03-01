"""
GUI 业务逻辑控制器

不依赖 tkinter，纯 Python 数据层。
负责：登录、目录加载、搜索、下载调度。
所有方法返回纯数据（dict / list / bool），UI 层负责渲染。
"""

import os
import time
from typing import Dict, List, Optional, Tuple

from src.api import YoudaoNoteApi
from src.common import format_file_size, load_config, FileId, DirId
from src.cookies import CookieManager
from src.transfer.download import YoudaoNoteDownload
from src.transfer.search import YoudaoNoteSearch, SearchType


class GUIController:
    """GUI 的业务逻辑层，不包含任何 UI 代码。"""

    def __init__(self):
        self.api: Optional[YoudaoNoteApi] = None
        self.searcher: Optional[YoudaoNoteSearch] = None
        self.downloader: Optional[YoudaoNoteDownload] = None
        self.current_dir_id: Optional[str] = None
        self.current_path: str = "/"
        self.is_search_mode: bool = False

    # ---------- 登录 ----------

    def login(self) -> Tuple[bool, str]:
        """
        使用 cookies 登录。
        :return: (成功?, 错误信息)
        """
        try:
            cookies_path = CookieManager.get_default_path()
            self.api = YoudaoNoteApi(cookies_path=cookies_path)
            error_msg = self.api.login_by_cookies()
            if error_msg:
                return False, f"Cookie登录失败: {error_msg}"

            self.searcher = YoudaoNoteSearch(self.api)
            self.downloader = YoudaoNoteDownload(self.api)
            return True, ""
        except Exception as e:
            return False, f"登录时出错: {e}"

    # ---------- 目录 ----------

    def get_root_dir_id(self) -> Tuple[Optional[str], str]:
        """获取根目录 ID。返回 (dir_id, error_msg)。"""
        try:
            return self.api.get_root_id(), ""
        except Exception as e:
            return None, str(e)

    def load_root_directory(self) -> Tuple[Optional[str], str]:
        """
        加载根目录并设置 current_dir_id / current_path。
        返回 (dir_id, error_msg)。
        """
        dir_id, err = self.get_root_dir_id()
        if err:
            return None, err
        self.current_dir_id = dir_id
        self.current_path = "/"
        return dir_id, ""

    def load_directory_contents(self, dir_id: DirId) -> Tuple[List[dict], List[dict], str]:
        """
        加载指定目录的内容。
        返回 (folders, files, error_msg)。每个元素是 fileEntry dict。
        """
        try:
            dir_info = self.api.get_dir_info_by_id(dir_id)
            entries = dir_info.get("entries", [])
            folders, files = [], []
            for entry in entries:
                fe = entry.get("fileEntry", {})
                (folders if fe.get("dir", False) else files).append(fe)
            return folders, files, ""
        except Exception as e:
            return [], [], f"加载目录内容失败: {e}"

    def enter_folder(self, folder_name: str, folder_id: DirId) -> None:
        """更新导航状态（进入子文件夹）。"""
        if self.current_path == "/":
            self.current_path = f"/{folder_name}"
        else:
            self.current_path = f"{self.current_path}/{folder_name}"
        self.current_dir_id = folder_id
        self.is_search_mode = False

    def go_back(self) -> bool:
        """
        返回上级。返回 True 表示需要重新加载根目录，False 表示只需刷新当前目录。
        """
        if self.is_search_mode:
            self.is_search_mode = False
            return False  # 只需刷新 current_dir
        self.current_path = "/"
        return True  # 需要重新加载根目录

    # ---------- 搜索 ----------

    def search(self, keyword: str, search_type: str = "all",
               exact_match: bool = False) -> Tuple[List[dict], str]:
        """
        全局搜索。返回 (results, error_msg)。
        每个 result = {'entry': fileEntry, 'path': str, 'is_dir': bool}
        """
        self.is_search_mode = True
        try:
            raw_results = self.searcher.search_by_name(keyword, SearchType(search_type), exact_match)
            results = [
                {"entry": r["entry"], "path": r["path"], "is_dir": r["is_dir"]}
                for r in raw_results
            ]
            return results, ""
        except Exception as e:
            return [], f"搜索失败: {e}"

    # ---------- 下载 ----------

    def download_file(self, file_id: FileId, file_name: str, local_dir: str) -> bool:
        return self.downloader.download_file(file_id, file_name, local_dir)

    def download_folder(self, folder_id: DirId, folder_name: str, local_dir: str) -> bool:
        return self.downloader.download_folder(folder_id, folder_name, local_dir)

    # ---------- 格式化 ----------

    @staticmethod
    def format_entry(file_entry: dict, is_dir: bool, path: str = None) -> dict:
        """
        把 fileEntry dict 格式化为 UI 行数据。
        返回 {'name', 'display_text', 'item_type', 'size_str', 'time_str', 'file_id',
               'is_dir', 'entry_data', 'full_path'}
        """
        name = file_entry.get("name", "无名称")
        fid = file_entry.get("id", "")
        size = file_entry.get("size", 0)
        mtime = file_entry.get("modifyTimeForSort", 0)

        size_str = format_file_size(size) if size > 0 else "-"
        time_str = (time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime / 1000))
                    if mtime > 0 else "-")
        item_type = "文件夹" if is_dir else "文件"
        display = path if path else name

        return {
            "name": name,
            "display_text": display,
            "item_type": item_type,
            "size_str": size_str,
            "time_str": time_str,
            "file_id": fid,
            "is_dir": is_dir,
            "entry_data": file_entry,
            "full_path": path,
        }

    @staticmethod
    def get_default_download_dir() -> str:
        """从配置文件读取默认下载目录。"""
        try:
            config, _ = load_config()
            local_dir = config.get("local_dir", "")
            if local_dir and os.path.isabs(local_dir):
                return local_dir
        except Exception:
            pass
        return os.path.abspath("./youdaonote-sync")
