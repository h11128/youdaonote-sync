"""
有道云笔记上传模块

负责将本地文件上传到有道云笔记
"""

import os
import logging
from typing import Optional, Tuple, Union

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.protocols import FilePusher

from src.common import generate_file_id, NoteDomain, normalize_sep, FileId, DirId
from src.sync.metadata import SyncMetadata
from src.sync.utils import UploadResult


class YoudaoNoteUpload:
    """有道云笔记上传引擎"""

    # 支持的文件后缀
    MARKDOWN_SUFFIX = ".md"
    NOTE_SUFFIX = ".note"

    # 后缀 → 处理方法名（可扩展）
    _UPLOAD_HANDLERS = {
        ".md": "_upload_markdown",
        ".note": "_upload_note_skip",
    }

    def __init__(self, api: "FilePusher", metadata: SyncMetadata = None):
        """
        初始化上传引擎
        
        :param api: YoudaoNoteApi 实例
        :param metadata: 同步元数据管理器
        """
        self.api = api
        self.metadata = metadata or SyncMetadata()

    # ========== 供 SyncManager 调用的公开方法 ==========

    def ensure_parent_dir(self, rel_path: str) -> Optional[DirId]:
        """
        确保文件的父目录在云端存在并返回其 ID。
        迭代创建不存在的中间目录（从根往下逐级创建）。

        :param rel_path: 文件或目录的相对路径
        :return: 父目录 ID，失败返回 None
        """
        parent_rel = normalize_sep(os.path.dirname(rel_path))
        if not parent_rel:
            return self.api.get_root_id()

        cached_id = self.metadata.get_dir_id(parent_rel)
        if cached_id:
            return cached_id

        # 收集需要创建的层级（从目标往上找到已有或根目录为止）
        to_create = []
        current = parent_rel
        while current:
            existing = self.metadata.get_dir_id(current)
            if existing:
                break
            to_create.append(current)
            current = normalize_sep(os.path.dirname(current))

        # current 为空说明到了根目录
        parent_id = self.metadata.get_dir_id(current) if current else self.api.get_root_id()
        if not parent_id:
            parent_id = self.api.get_root_id()

        # 从上到下逐级创建
        for dir_rel in reversed(to_create):
            dir_name = os.path.basename(dir_rel)
            parent_id = self.ensure_cloud_dir(dir_name, parent_id, dir_rel)
            if not parent_id:
                return None

        return parent_id

    def upload_file(
        self,
        local_path: str,
        parent_id: DirId,
        relative_path: str = None,
        force: bool = False,
    ) -> Tuple[bool, Union[str, UploadResult, None]]:
        """Upload a single file.

        :return: ``(True, UploadResult)`` on success, ``(True, None)`` when
            skipped, or ``(False, error_message)`` on failure.
        """
        if not os.path.exists(local_path):
            return False, f"文件不存在: {local_path}"

        if not os.path.isfile(local_path):
            return False, f"不是文件: {local_path}"

        file_name = os.path.basename(local_path)
        rel_path = relative_path or file_name
        suffix = os.path.splitext(file_name)[1].lower()

        handler_name = self._UPLOAD_HANDLERS.get(suffix, "_upload_auto")
        handler = getattr(self, handler_name)
        return handler(local_path, parent_id, rel_path, force)

    def _upload_note_skip(self, local_path: str, parent_id: DirId,
                          relative_path: str, force: bool = False
                          ) -> Tuple[bool, Optional[str]]:
        """.note 文件暂时跳过上传（需要特殊处理）。"""
        logging.warning(f"跳过 .note 文件: {local_path}")
        return True, None

    def _check_skip(self, relative_path: str, local_mtime: int,
                     force: bool) -> Tuple[bool, Optional[dict]]:
        """检查文件是否可以跳过上传。返回 (should_skip, file_info)。"""
        file_info = self.metadata.get_file_info(relative_path)
        if file_info and not force:
            if local_mtime <= file_info.get("local_mtime", 0):
                logging.debug(f"文件未修改，跳过: {relative_path}")
                return True, file_info
        return False, file_info

    def _push_and_record(
        self,
        file_info: Optional[dict],
        cloud_name: str,
        domain: int,
        body: str,
        parent_id: DirId,
        relative_path: str,
        local_mtime: int,
    ) -> Tuple[bool, Union[str, UploadResult, None]]:
        """Execute push_file and return an :class:`UploadResult` on success.

        Metadata is **not** written here — the caller (engine) is responsible
        for calling ``metadata.record_sync`` with the returned result.
        """
        if file_info and file_info.get("file_id"):
            file_id = file_info["file_id"]
            is_create = False
            logging.info(f"更新: {relative_path}")
        else:
            file_id = generate_file_id()
            is_create = True
            logging.info(f"创建: {relative_path}")

        try:
            result = self.api.push_file(
                file_id=file_id,
                parent_id=parent_id,
                name=cloud_name,
                domain=domain,
                body_string=body,
                modify_time=local_mtime,
                is_create=is_create,
            )

            if "entry" in result:
                cloud_mtime = result["entry"].get("modifyTimeForSort", local_mtime)
                logging.info(f"上传成功: {relative_path}")
                return True, UploadResult(
                    file_id=file_id,
                    cloud_mtime=cloud_mtime,
                    local_mtime=local_mtime,
                    parent_id=parent_id,
                    domain=domain,
                )
            else:
                error_msg = result.get("error", str(result))
                return False, f"上传失败: {error_msg}"
        except (OSError, RuntimeError) as e:
            return False, f"上传异常: {e}"

    def _upload_markdown(
        self,
        local_path: str,
        parent_id: DirId,
        relative_path: str,
        force: bool = False,
    ) -> Tuple[bool, Union[str, UploadResult, None]]:
        """上传 Markdown 文件"""
        file_name = os.path.basename(local_path)
        local_mtime = int(os.path.getmtime(local_path))

        skip, file_info = self._check_skip(relative_path, local_mtime, force)
        if skip:
            return True, None

        try:
            with open(local_path, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError as e:
            return False, f"[BINARY]{e}"
        except Exception as e:
            return False, f"读取文件失败: {e}"

        if not file_name.endswith(".md"):
            file_name = file_name + ".md"

        return self._push_and_record(
            file_info, file_name, NoteDomain.MARKDOWN, content,
            parent_id, relative_path, local_mtime)

    def upload_note(
        self,
        local_path: str,
        parent_id: DirId,
        relative_path: str,
        force: bool = False,
    ) -> Tuple[bool, Union[str, UploadResult, None]]:
        """上传普通笔记（将 Markdown 转换为有道 JSON 格式）"""
        from src.convert.md_to_note import markdown_to_note_json

        file_name = os.path.basename(local_path)
        local_mtime = int(os.path.getmtime(local_path))

        skip, file_info = self._check_skip(relative_path, local_mtime, force)
        if skip:
            return True, None

        try:
            with open(local_path, "r", encoding="utf-8") as f:
                md_content = f.read()
        except Exception as e:
            return False, f"读取文件失败: {e}"

        try:
            note_json = markdown_to_note_json(md_content)
        except Exception as e:
            return False, f"转换格式失败: {e}"

        base_name = os.path.splitext(file_name)[0]
        note_name = base_name + ".note"

        return self._push_and_record(
            file_info, note_name, NoteDomain.NOTE, note_json,
            parent_id, relative_path, local_mtime)

    def _upload_auto(
        self,
        local_path: str,
        parent_id: DirId,
        relative_path: str,
        force: bool = False,
    ) -> Tuple[bool, Union[str, UploadResult, None]]:
        """未知后缀：先尝试文本上传，编码失败则回退到二进制。"""
        ok, result = self._upload_markdown(local_path, parent_id, relative_path, force)
        if not ok and isinstance(result, str) and result.startswith("[BINARY]"):
            return self._upload_binary(local_path, parent_id, relative_path, force)
        return ok, result

    def _upload_binary(
        self,
        local_path: str,
        parent_id: DirId,
        relative_path: str,
        force: bool = False,
    ) -> Tuple[bool, Union[str, UploadResult, None]]:
        """Upload a binary file (PDF, images, etc.) via multipart.

        Returns ``(True, UploadResult)`` on success so that the caller can
        call ``metadata.record_sync`` with it.
        """
        file_name = os.path.basename(local_path)
        local_mtime = int(os.path.getmtime(local_path))

        skip, file_info = self._check_skip(relative_path, local_mtime, force)
        if skip:
            return True, None

        try:
            with open(local_path, "rb") as f:
                file_bytes = f.read()
        except Exception as e:
            return False, f"读取二进制文件失败: {e}"

        if file_info and file_info.get("file_id"):
            file_id = file_info["file_id"]
            is_create = False
            logging.info(f"更新(二进制): {relative_path}")
        else:
            file_id = generate_file_id()
            is_create = True
            logging.info(f"创建(二进制): {relative_path}")

        try:
            result = self.api.push_binary_file(
                file_id=file_id,
                parent_id=parent_id,
                name=file_name,
                file_bytes=file_bytes,
                modify_time=local_mtime,
                is_create=is_create,
            )

            if "entry" in result:
                cloud_mtime = result["entry"].get("modifyTimeForSort", local_mtime)
                logging.info(f"上传成功(二进制): {relative_path}")
                return True, UploadResult(
                    file_id=file_id,
                    cloud_mtime=cloud_mtime,
                    local_mtime=local_mtime,
                    parent_id=parent_id,
                    domain=NoteDomain.MARKDOWN,
                )
            else:
                error_msg = result.get("error", str(result))
                return False, f"上传失败(二进制): {error_msg}"
        except (OSError, RuntimeError) as e:
            return False, f"上传异常(二进制): {e}"

    def upload_folder(
        self,
        local_dir: str,
        parent_id: DirId,
        base_dir: str = None,
        recursive: bool = True,
        upload_as_note: bool = False,
    ) -> Tuple[int, int, list]:
        """
        上传整个文件夹
        
        :param local_dir: 本地文件夹路径
        :param parent_id: 云端父目录 ID
        :param base_dir: 基准目录（用于计算相对路径）
        :param recursive: 是否递归上传子文件夹
        :param upload_as_note: 是否将 .md 文件作为普通笔记上传
        :return: (成功数, 失败数, 错误列表)
        """
        if not os.path.exists(local_dir):
            return 0, 0, [f"目录不存在: {local_dir}"]

        if not os.path.isdir(local_dir):
            return 0, 0, [f"不是目录: {local_dir}"]

        base_dir = base_dir or local_dir
        success_count = 0
        fail_count = 0
        errors = []

        # 遍历目录
        for item in os.listdir(local_dir):
            item_path = os.path.join(local_dir, item)
            relative_path = normalize_sep(os.path.relpath(item_path, base_dir))

            # 跳过隐藏文件和目录
            if item.startswith("."):
                continue

            if os.path.isfile(item_path):
                suffix = os.path.splitext(item)[1].lower()
                
                if suffix == ".md":
                    if upload_as_note:
                        ok, result = self.upload_note(
                            item_path, parent_id, relative_path
                        )
                    else:
                        ok, result = self._upload_markdown(
                            item_path, parent_id, relative_path
                        )

                    if ok:
                        if isinstance(result, UploadResult):
                            self.metadata.record_sync(
                                relative_path,
                                file_id=result.file_id,
                                cloud_mtime=result.cloud_mtime,
                                local_mtime=result.local_mtime,
                                parent_id=result.parent_id,
                                domain=result.domain,
                                action="uploaded",
                                direction="push",
                            )
                        success_count += 1
                    else:
                        fail_count += 1
                        errors.append(result)
                else:
                    logging.debug(f"跳过非 Markdown 文件: {relative_path}")

            elif os.path.isdir(item_path) and recursive:
                # 递归处理子目录
                # 先在云端创建对应目录
                dir_id = self.ensure_cloud_dir(item, parent_id, relative_path)
                
                if dir_id:
                    sub_success, sub_fail, sub_errors = self.upload_folder(
                        item_path, dir_id, base_dir, recursive, upload_as_note
                    )
                    success_count += sub_success
                    fail_count += sub_fail
                    errors.extend(sub_errors)
                else:
                    fail_count += 1
                    errors.append(f"创建云端目录失败: {relative_path}")

        return success_count, fail_count, errors

    def ensure_cloud_dir(
        self, dir_name: str, parent_id: DirId, relative_path: str,
        defer_save: bool = False,
    ) -> Optional[DirId]:
        """
        确保云端目录存在，不存在则创建
        
        :param dir_name: 目录名
        :param parent_id: 父目录 ID
        :param relative_path: 相对路径
        :param defer_save: 是否延迟保存元数据（由调用方统一保存）
        :return: 目录 ID，失败返回 None
        """
        # 先检查元数据中是否有记录
        dir_id = self.metadata.get_dir_id(relative_path)
        if dir_id:
            return dir_id

        # 创建目录
        try:
            result = self.api.create_dir(parent_id, dir_name)
            if "fileEntry" in result:
                dir_id = result["fileEntry"]["id"]
                self.metadata.set_dir_info(relative_path, dir_id, parent_id)
                if not defer_save:
                    self.metadata.save()
                logging.info(f"创建云端目录: {relative_path}")
                return dir_id
            else:
                logging.error(f"创建目录失败: {result}")
                return None
        except Exception as e:
            logging.error(f"创建目录异常: {e}")
            return None
