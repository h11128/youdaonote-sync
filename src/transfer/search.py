#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记搜索引擎
从 GUI 体系提取的统一搜索逻辑
"""

import logging
from enum import Enum
from typing import List, Dict, Optional, TYPE_CHECKING

from src.common import DirId

if TYPE_CHECKING:
    from src.protocols import DirBrowser


class SearchType(Enum):
    """搜索范围类型"""
    ALL = "all"
    FOLDER = "folder"
    FILE = "file"


class YoudaoNoteSearch:
    """
    有道云笔记搜索引擎
    提供统一的搜索和目录浏览功能
    """

    MAX_SEARCH_DEPTH = 50

    def __init__(self, api: "DirBrowser"):
        """
        初始化搜索引擎
        :param api: 已登录的 YoudaoNoteApi 实例
        """
        self.api = api

    def get_root_id(self) -> DirId:
        """获取根目录 ID（委托给 api.get_root_id()）。"""
        return self.api.get_root_id()

    def list_directory(self, dir_id: DirId = None) -> Dict:
        """
        列出目录内容
        :param dir_id: 目录 ID，为空则列出根目录
        :return: 目录信息字典，包含 entries 列表
        """
        if dir_id is None:
            dir_id = self.get_root_id()
        
        return self.api.get_dir_info_by_id(dir_id)

    def get_directory_entries(self, dir_id: DirId = None) -> List[Dict]:
        """
        获取目录下的所有条目（文件和文件夹）
        :param dir_id: 目录 ID，为空则获取根目录
        :return: 条目列表，每个条目包含 id, name, is_dir, size, modify_time 等
        """
        dir_info = self.list_directory(dir_id)
        entries = dir_info.get('entries', [])
        
        result = []
        for entry in entries:
            file_entry = entry.get('fileEntry', {})
            result.append({
                'id': file_entry.get('id', ''),
                'name': file_entry.get('name', ''),
                'is_dir': file_entry.get('dir', False),
                'size': file_entry.get('size', 0),
                'modify_time': file_entry.get('modifyTimeForSort', 0),
                'create_time': file_entry.get('createTimeForSort', 0),
                'entry': file_entry  # 保留原始数据
            })
        
        return result

    def search_by_name(self, name: str, search_type: SearchType = SearchType.ALL,
                       exact_match: bool = False) -> List[Dict]:
        """
        根据名称搜索文件或文件夹
        :param name: 搜索的名称（不能为空）
        :param search_type: 搜索类型 ("all", "folder", "file")
        :param exact_match: 是否精确匹配
        :return: 搜索结果列表
        """
        if not name:
            raise ValueError("name 不能为空")
        root_id = self.get_root_id()
        results = []
        
        logging.info(f"🔍 搜索 '{name}' (类型: {search_type}, 精确匹配: {exact_match})")
        self._search_recursively(root_id, name, search_type, exact_match, results)
        
        return results

    def _search_recursively(self, dir_id: DirId, target_name: str,
                           search_type: SearchType,
                           exact_match: bool, results: List[Dict],
                           current_path: str = "", depth: int = 0) -> None:
        """
        递归搜索
        :param dir_id: 当前目录 ID
        :param target_name: 目标名称
        :param search_type: 搜索类型
        :param exact_match: 是否精确匹配
        :param results: 结果列表（会被修改）
        :param current_path: 当前路径
        :param depth: 当前递归深度
        """
        if depth >= self.MAX_SEARCH_DEPTH:
            logging.warning(f"搜索深度已达上限 ({self.MAX_SEARCH_DEPTH})，跳过: {current_path}")
            return

        try:
            dir_info = self.api.get_dir_info_by_id(dir_id)

            for entry in dir_info.get('entries', []):
                file_entry = entry.get('fileEntry', {})
                entry_name = file_entry.get('name', '')
                entry_id = file_entry.get('id', '')
                is_dir = file_entry.get('dir', False)

                # 构建当前路径
                current_entry_path = f"{current_path}/{entry_name}" if current_path else entry_name

                # 检查是否匹配
                if exact_match:
                    is_match = entry_name == target_name
                else:
                    is_match = target_name.lower() in entry_name.lower()

                should_include = (
                    search_type == SearchType.ALL
                    or (search_type == SearchType.FOLDER and is_dir)
                    or (search_type == SearchType.FILE and not is_dir)
                )

                if is_match and should_include:
                    results.append({
                        'id': entry_id,
                        'name': entry_name,
                        'path': current_entry_path,
                        'is_dir': is_dir,
                        'size': file_entry.get('size', 0),
                        'modify_time': file_entry.get('modifyTimeForSort', 0),
                        'create_time': file_entry.get('createTimeForSort', 0),
                        'entry': file_entry
                    })

                # 如果是文件夹，继续递归搜索
                if is_dir:
                    self._search_recursively(entry_id, target_name, search_type, 
                                           exact_match, results, current_entry_path,
                                           depth + 1)

        except Exception as e:
            logging.error(f"搜索目录 {current_path} 时出错: {e}")

    def search_folders(self, name: str, exact_match: bool = False) -> List[Dict]:
        """
        搜索文件夹（便捷方法）
        :param name: 文件夹名称
        :param exact_match: 是否精确匹配
        :return: 搜索结果列表
        """
        return self.search_by_name(name, search_type=SearchType.FOLDER, exact_match=exact_match)

    def search_files(self, name: str, exact_match: bool = False) -> List[Dict]:
        """
        搜索文件（便捷方法）
        :param name: 文件名称
        :param exact_match: 是否精确匹配
        :return: 搜索结果列表
        """
        return self.search_by_name(name, search_type=SearchType.FILE, exact_match=exact_match)

    def find_folder_by_path(self, path: str) -> Optional[DirId]:
        """
        根据路径查找文件夹 ID
        :param path: 路径，如 "folder1/folder2"
        :return: 文件夹 ID，未找到返回 None
        """
        if not path or path == "/":
            return self.get_root_id()

        # 分割路径
        path_parts = [part for part in path.split('/') if part]

        # 从根目录开始查找
        current_id = self.get_root_id()

        for part in path_parts:
            dir_info = self.api.get_dir_info_by_id(current_id)
            found = False

            for entry in dir_info.get('entries', []):
                file_entry = entry.get('fileEntry', {})
                if file_entry.get('dir', False) and file_entry.get('name') == part:
                    current_id = file_entry['id']
                    found = True
                    break

            if not found:
                return None

        return current_id
