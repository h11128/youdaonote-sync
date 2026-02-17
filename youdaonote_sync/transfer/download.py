#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记下载引擎
统一的下载逻辑，供 CLI 和 GUI 使用
"""

import json
import logging
import os
import platform
import re
import xml.etree.ElementTree as ET
from enum import Enum
from typing import Dict, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from youdaonote_sync.protocols import DownloadApi

from youdaonote_sync.convert.note_convert import YoudaoNoteConvert
from youdaonote_sync.transfer.image import ImagePull
from youdaonote_sync.common import get_script_directory, safe_long_path, load_config

# 尝试导入 Windows 特定模块
try:
    from win32_setctime import setctime
    HAS_WIN32_SETCTIME = True
except ImportError:
    HAS_WIN32_SETCTIME = False


MARKDOWN_SUFFIX = ".md"


class FileType(Enum):
    """文件类型枚举"""
    OTHER = 0
    MARKDOWN = 1
    XML = 2
    JSON = 3


class FileAction(Enum):
    """文件操作枚举"""
    SKIP = "跳过"
    ADD = "新增"
    UPDATE = "更新"


class YoudaoNoteDownload:
    """
    有道云笔记下载引擎
    提供统一的文件和文件夹下载功能
    """

    def __init__(self, api: "DownloadApi", smms_secret_token: str = "",
                 is_relative_path: bool = True,
                 image_puller: ImagePull = None):
        """
        初始化下载引擎

        :param api: 已登录的 YoudaoNoteApi 实例
        :param smms_secret_token: SM.MS 图床 token（可选）
        :param is_relative_path: 是否使用相对路径
        :param image_puller: 注入的 ImagePull 实例（可选，默认按需创建）
        """
        self.api = api
        self.smms_secret_token = smms_secret_token
        self.is_relative_path = is_relative_path
        self._image_puller = image_puller

        # 文件名中需要替换的特殊字符
        self._regex_symbol = re.compile(r"[<]")
        self._del_regex_symbol = re.compile(r'[\\/":\|\*\?#>]')

    def download_file(self, file_id: str, file_name: str, local_dir: str,
                      modify_time: int = 0, create_time: int = 0,
                      convert_to_md: bool = True,
                      skip_action_check: bool = False) -> bool:
        """
        下载单个文件（编排层，按步骤调用子方法）。
        :return: 是否成功
        """
        if not file_id:
            raise ValueError("file_id 不能为空")
        if not file_name:
            raise ValueError("file_name 不能为空")
        if not local_dir:
            raise ValueError("local_dir 不能为空")
        try:
            file_name = self._optimize_file_name(file_name)
            youdao_file_suffix = os.path.splitext(file_name)[1]
            mtime_sec = modify_time / 1000 if modify_time else 0

            # 1. 可转换文件的 SKIP 预判
            if not skip_action_check and convert_to_md and youdao_file_suffix in [".note", ".clip", ""]:
                candidate_md = os.path.join(
                    local_dir, os.path.splitext(file_name)[0] + MARKDOWN_SUFFIX
                ).replace("\\", "/")
                if self._get_file_action(candidate_md, mtime_sec) == FileAction.SKIP:
                    logging.debug(f"跳过文件: {candidate_md}")
                    return True

            # 2. 下载 + 类型检测
            file_type, content = self._download_and_detect(file_id, youdao_file_suffix)

            # 3. 确定最终本地路径
            original_path, local_path = self._resolve_paths(
                file_name, local_dir, file_type, convert_to_md)

            # 4. 判断操作类型
            file_action = self._determine_action(
                local_path, mtime_sec, skip_action_check)
            if file_action == FileAction.SKIP:
                logging.debug(f"跳过文件: {local_path}")
                return True

            # 5. 原子写入 + 格式转换
            self._atomic_write(file_id, content, original_path, local_path,
                               file_type, youdao_file_suffix, convert_to_md)

            # 6. 图片链接迁移
            self._migrate_images(file_type, youdao_file_suffix, local_path)

            # 7. 设置文件时间
            self._set_file_time(local_path,
                                create_time / 1000 if create_time else 0, mtime_sec)

            tip = f"，原格式为 {file_type.name}" if file_type != FileType.OTHER else ""
            logging.info(f"{file_action.value}「{local_path}」{tip}")
            return True

        except Exception as e:
            logging.error(f"下载文件 {file_name} 失败: {e}")
            return False

    # ---------- download_file 子步骤 ----------

    def _resolve_paths(self, file_name: str, local_dir: str,
                       file_type: FileType, convert_to_md: bool
                       ) -> Tuple[str, str]:
        """返回 (original_file_path, local_file_path)，已做长路径保护。"""
        original = os.path.join(local_dir, file_name).replace("\\", "/")
        if file_type != FileType.OTHER and convert_to_md:
            local = os.path.join(
                local_dir, os.path.splitext(file_name)[0] + MARKDOWN_SUFFIX
            ).replace("\\", "/")
        else:
            local = original
        return safe_long_path(original), safe_long_path(local)

    def _determine_action(self, local_path: str, mtime_sec: float,
                          skip_action_check: bool) -> FileAction:
        """判断文件操作类型（ADD / UPDATE / SKIP）。"""
        if skip_action_check:
            return FileAction.UPDATE if os.path.exists(local_path) else FileAction.ADD
        return self._get_file_action(local_path, mtime_sec)

    def _atomic_write(self, file_id: str, content: Optional[bytes],
                      original_path: str, local_path: str,
                      file_type: FileType, suffix: str,
                      convert_to_md: bool) -> None:
        """写入临时文件 → 转换 → 替换为最终文件。失败时清理临时文件。"""
        tmp_original = original_path + ".tmp"
        tmp_local = local_path + ".tmp" if local_path != original_path else tmp_original
        try:
            self._save_and_convert(file_id, content, tmp_original, tmp_local,
                                   file_type, suffix, convert_to_md)

            if convert_to_md and file_type in (FileType.XML, FileType.JSON):
                converted = os.path.splitext(tmp_original)[0] + MARKDOWN_SUFFIX
                src = converted if os.path.exists(converted) else tmp_original
                os.replace(src, local_path)
            else:
                final_src = tmp_original
                if local_path != original_path and os.path.exists(tmp_local):
                    final_src = tmp_local
                os.replace(final_src, local_path)

            # 清理残留
            for leftover in (tmp_original, tmp_original.replace(".tmp", MARKDOWN_SUFFIX)):
                if leftover != local_path and os.path.exists(leftover):
                    try:
                        os.remove(leftover)
                    except OSError:
                        pass
        except BaseException:
            for p in (tmp_original,
                      os.path.splitext(tmp_original)[0] + MARKDOWN_SUFFIX,
                      tmp_local):
                if os.path.exists(p):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
            raise

    def _migrate_images(self, file_type: FileType, suffix: str,
                        local_path: str) -> None:
        """在文件到达最终位置后迁移图片链接。"""
        if file_type != FileType.OTHER or suffix == MARKDOWN_SUFFIX:
            try:
                puller = self._image_puller or ImagePull(
                    self.api, self.smms_secret_token, self.is_relative_path)
                puller.migration_ydnote_url(local_path)
            except Exception as e:
                logging.warning(f"图片链接迁移失败: {e}")

    def download_folder(self, folder_id: str, folder_name: str,
                        local_dir: str) -> bool:
        """
        下载整个文件夹（递归）。
        实际递归逻辑委托给 PullEngine。
        """
        from youdaonote_sync.transfer.pull import PullEngine
        try:
            local_folder_path = os.path.join(local_dir, folder_name).replace("\\", "/")
            if not os.path.exists(local_folder_path):
                os.makedirs(local_folder_path, exist_ok=True)
            logging.info(f"📁 下载文件夹: {folder_name} -> {local_folder_path}")
            engine = PullEngine(self.api, self)
            engine._download_dir_recursively(folder_id, local_folder_path)
            logging.info(f"✅ 文件夹下载完成: {folder_name}")
            return True
        except Exception as e:
            logging.error(f"下载文件夹 {folder_name} 失败: {e}")
            return False

    def _optimize_file_name(self, name: str) -> str:
        """
        优化文件名，移除特殊字符
        :param name: 原文件名
        :return: 优化后的文件名
        """
        # 去除换行符
        name = name.replace("\n", "")
        # 去除首尾空格
        name = name.strip()
        # 替换特殊字符
        name = self._regex_symbol.sub("_", name)
        name = self._del_regex_symbol.sub("", name)
        return name

    # 需要下载内容才能判断类型的后缀
    _NEED_DOWNLOAD_EXTS = frozenset({".note", ".clip", ""})

    # 基于内容前缀的类型检测器（按优先级排列）
    _CONTENT_DETECTORS = [
        (b"<?xml", FileType.XML),
        (b'{"', FileType.JSON),
    ]

    def _download_and_detect(self, file_id: str, youdao_file_suffix: str) -> Tuple[FileType, Optional[bytes]]:
        """
        一次性下载文件内容并判断类型，避免重复下载。
        对于 .md 和其他已知类型，不需要提前下载内容来判断类型。
        对于 .note/.clip/无后缀文件，需要看内容前几个字节。

        :param file_id: 文件 ID
        :param youdao_file_suffix: 文件后缀
        :return: (文件类型, 文件二进制内容)  如果不需要下载内容则 content 为 None
        """
        if youdao_file_suffix == MARKDOWN_SUFFIX:
            return FileType.MARKDOWN, None

        if youdao_file_suffix not in self._NEED_DOWNLOAD_EXTS:
            return FileType.OTHER, None

        response = self.api.get_file_by_id(file_id)
        content = response.content
        return self._detect_content_type(content), content

    @classmethod
    def _detect_content_type(cls, content: bytes) -> FileType:
        """根据内容前缀检测文件类型（可扩展）。"""
        for magic, ftype in cls._CONTENT_DETECTORS:
            if content.startswith(magic):
                return ftype
        return FileType.OTHER

    def _get_file_action(self, local_file_path: str, modify_time: float) -> FileAction:
        """
        判断文件操作类型
        :param local_file_path: 本地文件路径
        :param modify_time: 修改时间（秒）
        :return: 文件操作类型
        """
        if not os.path.exists(local_file_path):
            return FileAction.ADD

        # 如果云端修改时间小于等于本地文件时间，跳过
        if modify_time and modify_time <= os.path.getmtime(local_file_path):
            return FileAction.SKIP

        return FileAction.UPDATE

    def _save_and_convert(self, file_id: str, content: Optional[bytes],
                          original_file_path: str, local_file_path: str,
                          file_type: FileType, youdao_file_suffix: str,
                          convert_to_md: bool):
        """
        保存已下载的内容并转换文件格式。
        如果 content 为 None（如 .md 文件在 _download_and_detect 中未提前下载），
        则在此处下载。
        
        :param file_id: 文件 ID（content 为 None 时用于下载）
        :param content: 已下载的文件二进制内容（可能为 None）
        :param original_file_path: 原始文件路径
        :param local_file_path: 本地文件路径
        :param file_type: 文件类型
        :param youdao_file_suffix: 原始后缀
        :param convert_to_md: 是否转换为 Markdown
        """
        # 如果 content 为 None，说明 _download_and_detect 阶段没有下载（如 .md 文件）
        if content is None:
            response = self.api.get_file_by_id(file_id)
            content = response.content

        with open(original_file_path, "wb") as f:
            f.write(content)

        # 转换为 Markdown
        if convert_to_md:
            if file_type == FileType.XML:
                try:
                    YoudaoNoteConvert.convert_xml_to_markdown(original_file_path)
                except ET.ParseError:
                    logging.info("此 note 笔记为旧格式 HTML，转换为 Markdown...")
                    YoudaoNoteConvert.convert_html_to_markdown(original_file_path)
                except Exception as e:
                    logging.warning(f"XML 转换失败，跳过: {e}")
            elif file_type == FileType.JSON:
                YoudaoNoteConvert.convert_json_to_markdown(original_file_path)

        # 图片链接迁移由调用方在文件移动到最终位置后执行（见 download_file）

    def _set_file_time(self, file_path: str, create_time: float, modify_time: float):
        """
        设置文件时间
        :param file_path: 文件路径
        :param create_time: 创建时间（秒）
        :param modify_time: 修改时间（秒）
        """
        if not create_time and not modify_time:
            return

        try:
            if platform.system() == "Windows" and HAS_WIN32_SETCTIME:
                if create_time:
                    setctime(file_path, create_time)
            
            if modify_time:
                os.utime(file_path, (create_time or modify_time, modify_time))
        except Exception as e:
            logging.warning(f"设置文件时间失败: {e}")

    def download_by_search_result(self, result: Dict, local_dir: str) -> bool:
        """
        根据搜索结果下载
        :param result: 搜索结果字典，包含 id, name, is_dir, entry 等
        :param local_dir: 本地目录
        :return: 是否成功
        """
        if result.get('is_dir'):
            return self.download_folder(
                result['id'], 
                result['name'], 
                local_dir
            )
        else:
            entry = result.get('entry', {})
            return self.download_file(
                result['id'],
                result['name'],
                local_dir,
                entry.get('modifyTimeForSort', 0),
                entry.get('createTimeForSort', 0)
            )

    def pull_all(self, local_dir: str = None, ydnote_dir: str = None) -> bool:
        """
        全量导出所有笔记。

        .. deprecated:: 实际实现已移至 ``PullEngine.pull_all``
        """
        from youdaonote_sync.transfer.pull import PullEngine
        return PullEngine(self.api, self).pull_all(local_dir, ydnote_dir)



# load_config 已移至 common.py，此处通过 import 保持向后兼容
