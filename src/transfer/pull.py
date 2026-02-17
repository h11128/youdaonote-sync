"""
全量拉取引擎

从 YoudaoNoteDownload 提取而来，负责递归遍历云端目录并下载全部文件。
YoudaoNoteDownload 仅负责单文件下载，不再包含遍历逻辑。
"""

import logging
import os
from typing import TYPE_CHECKING

from src.common import get_script_directory, normalize_sep

if TYPE_CHECKING:
    from src.protocols import DirBrowser
    from src.transfer.download import YoudaoNoteDownload


class PullEngine:
    """递归拉取云端目录到本地"""

    def __init__(self, api: "DirBrowser", downloader: "YoudaoNoteDownload"):
        self.api = api
        self.downloader = downloader

    def pull_all(self, local_dir: str = None, ydnote_dir: str = None) -> bool:
        """
        全量导出所有笔记

        :param local_dir: 本地目录，为空则使用默认目录
        :param ydnote_dir: 只导出指定的有道云目录，为空则导出全部
        :return: 是否成功
        """
        try:
            if not local_dir:
                local_dir = os.path.join(get_script_directory(), "youdaonote-sync")

            if not os.path.exists(local_dir):
                os.makedirs(local_dir, exist_ok=True)

            root_info = self.api.get_root_dir_info_id()
            root_id = root_info.get('fileEntry', {}).get('id')

            if not root_id:
                logging.error("无法获取根目录 ID")
                return False

            if ydnote_dir:
                dir_info = self.api.get_dir_info_by_id(root_id)
                found = False
                for entry in dir_info.get('entries', []):
                    file_entry = entry.get('fileEntry', {})
                    if file_entry.get('name') == ydnote_dir:
                        root_id = file_entry.get('id')
                        found = True
                        break
                if not found:
                    logging.error(f"未找到指定目录: {ydnote_dir}")
                    return False

            logging.info(f"开始全量导出到: {local_dir}")
            self._download_dir_recursively(root_id, local_dir)
            logging.info("全量导出完成!")
            return True

        except (OSError, RuntimeError) as e:
            logging.error(f"全量导出失败: {e}")
            return False

    def _download_dir_recursively(self, dir_id: str, local_dir: str) -> None:
        """递归下载目录"""
        dir_info = self.api.get_dir_info_by_id(dir_id)
        entries = dir_info.get('entries', [])

        for entry in entries:
            file_entry = entry.get('fileEntry', {})
            entry_id = file_entry.get('id', '')
            name = file_entry.get('name', '')
            is_dir = file_entry.get('dir', False)

            if is_dir:
                sub_dir = normalize_sep(os.path.join(local_dir, name))
                if not os.path.exists(sub_dir):
                    os.makedirs(sub_dir, exist_ok=True)
                self._download_dir_recursively(entry_id, sub_dir)
            else:
                modify_time = file_entry.get('modifyTimeForSort', 0)
                create_time = file_entry.get('createTimeForSort', 0)
                self.downloader.download_file(
                    entry_id, name, local_dir, modify_time, create_time)
