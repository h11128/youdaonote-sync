"""
全量拉取引擎

从 YoudaoNoteDownload 提取而来，负责递归遍历云端目录并下载全部文件。
YoudaoNoteDownload 仅负责单文件下载，不再包含遍历逻辑。
"""

import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Tuple, TYPE_CHECKING

from src.common import get_script_directory, normalize_sep

if TYPE_CHECKING:
    from src.protocols import DirBrowser
    from src.transfer.download import YoudaoNoteDownload

_DownloadTask = Tuple[str, str, str, int, int]  # (file_id, name, local_dir, mtime, ctime)

DOWNLOAD_WORKERS = 8


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
            tasks = self._collect_download_tasks(root_id, local_dir)
            logging.info(f"扫描完成: {len(tasks)} 个文件待下载")
            self._execute_downloads(tasks)
            logging.info("全量导出完成!")
            return True

        except (OSError, RuntimeError) as e:
            logging.error(f"全量导出失败: {e}")
            return False

    def _collect_download_tasks(self, dir_id: str, local_dir: str) -> List[_DownloadTask]:
        """递归遍历云端目录树，收集所有文件下载任务（目录立即创建）。"""
        tasks: List[_DownloadTask] = []
        dir_info = self.api.get_dir_info_by_id(dir_id)
        entries = dir_info.get('entries', [])

        for entry in entries:
            file_entry = entry.get('fileEntry', {})
            entry_id = file_entry.get('id', '')
            name = file_entry.get('name', '')
            is_dir = file_entry.get('dir', False)

            if is_dir:
                sub_dir = normalize_sep(os.path.join(local_dir, name))
                os.makedirs(sub_dir, exist_ok=True)
                tasks.extend(self._collect_download_tasks(entry_id, sub_dir))
            else:
                modify_time = file_entry.get('modifyTimeForSort', 0)
                create_time = file_entry.get('createTimeForSort', 0)
                tasks.append((entry_id, name, local_dir, modify_time, create_time))

        return tasks

    def _execute_downloads(self, tasks: List[_DownloadTask]) -> None:
        """并发下载所有文件。"""
        if not tasks:
            return

        workers = min(len(tasks), DOWNLOAD_WORKERS)
        succeeded, failed = 0, 0

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(
                    self.downloader.download_file,
                    fid, name, ldir, mtime, ctime,
                ): (fid, name)
                for fid, name, ldir, mtime, ctime in tasks
            }
            for fut in as_completed(futures):
                fid, name = futures[fut]
                try:
                    fut.result()
                    succeeded += 1
                except Exception as e:
                    failed += 1
                    logging.error(f"下载失败: {name} ({fid}) - {e}")

        if failed > 0:
            logging.warning(f"下载统计: 成功={succeeded}, 失败={failed}")
