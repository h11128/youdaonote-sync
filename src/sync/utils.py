"""
同步工具：枚举、数据类、纯函数

不依赖任何 src 内部模块，可被所有 sync_* 模块安全导入。
"""

import hashlib
import os
import shutil
import logging
from datetime import datetime
from enum import Enum
from dataclasses import dataclass
from typing import List, Dict, Optional

from src.common import NoteDomain


# ========== 枚举 ==========

class SyncDirection(Enum):
    """同步方向"""
    PULL = "pull"
    PUSH = "push"
    BOTH = "both"


class SyncAction(Enum):
    """同步操作"""
    DOWNLOAD = "download"
    UPLOAD = "upload"
    SKIP = "skip"
    CONFLICT = "conflict"


# ========== 数据类 ==========

@dataclass(frozen=True)
class SyncItem:
    """同步项（不可变快照）"""
    relative_path: str
    local_path: Optional[str]
    cloud_id: Optional[str]
    cloud_parent_id: Optional[str]
    local_mtime: Optional[int]
    cloud_mtime: Optional[int]
    is_dir: bool
    action: SyncAction
    cloud_name: Optional[str] = None
    domain: NoteDomain = NoteDomain.MARKDOWN
    cloud_ctime: Optional[int] = None  # 云端创建时间


# ========== 纯函数 ==========

def decide_action(
    local_exists: bool,
    cloud_exists: bool,
    local_mtime: Optional[int],
    cloud_mtime: Optional[int],
    meta_local_mtime: Optional[int],
    meta_cloud_mtime: Optional[int],
) -> SyncAction:
    """
    根据本地/云端/元数据三方时间戳决定同步操作。

    规则：
    - 只有本地 → 上传
    - 只有云端 → 下载
    - 两边都有且都有修改 → 比较时间戳，新的优先；相同则标记冲突
    - 只一边有修改 → 同步该方向
    - 都没有修改 → 跳过
    """
    if not local_exists and not cloud_exists:
        return SyncAction.SKIP
    if local_exists and not cloud_exists:
        return SyncAction.UPLOAD
    if not local_exists and cloud_exists:
        return SyncAction.DOWNLOAD

    local_changed = meta_local_mtime is None or (local_mtime is not None and local_mtime > meta_local_mtime)
    cloud_changed = meta_cloud_mtime is None or (cloud_mtime is not None and cloud_mtime > meta_cloud_mtime)

    if local_changed and cloud_changed:
        if local_mtime is not None and cloud_mtime is not None:
            if local_mtime > cloud_mtime:
                return SyncAction.UPLOAD
            if cloud_mtime > local_mtime:
                return SyncAction.DOWNLOAD
        return SyncAction.CONFLICT

    if local_changed:
        return SyncAction.UPLOAD
    if cloud_changed:
        return SyncAction.DOWNLOAD
    return SyncAction.SKIP


def filter_by_direction(
    items: List[SyncItem], direction: SyncDirection,
) -> tuple:
    """按同步方向过滤 items，同时统计跳过数。

    返回 (action_items, skip_count)，action_items 不包含 SKIP 项。
    """
    if direction == SyncDirection.BOTH:
        action = []
        skipped = 0
        for i in items:
            if i.action == SyncAction.SKIP:
                skipped += 1
            else:
                action.append(i)
        return action, skipped

    allowed = (
        {SyncAction.DOWNLOAD, SyncAction.CONFLICT}
        if direction == SyncDirection.PULL
        else {SyncAction.UPLOAD}
    )
    action = []
    skipped = 0
    for i in items:
        if i.action in allowed:
            action.append(i)
        else:
            skipped += 1
    return action, skipped


def empty_stats() -> Dict:
    """返回空的统计字典。"""
    return {"downloaded": 0, "uploaded": 0, "skipped": 0,
            "conflicts": 0, "errors": 0, "dedup_deleted": 0}


def print_preview(item: SyncItem) -> None:
    """输出单个同步项的 dry-run 预览行。"""
    labels = {
        SyncAction.DOWNLOAD: "下载",
        SyncAction.UPLOAD: "上传",
        SyncAction.SKIP: "跳过",
        SyncAction.CONFLICT: "冲突",
    }
    print(f"  {labels.get(item.action, '?'):4s}  {item.relative_path}")


def print_dryrun_summary(items: List[SyncItem]) -> None:
    """输出 dry-run 的分组统计摘要（单次遍历分桶）。"""
    from collections import Counter

    upload_files: List[SyncItem] = []
    upload_dirs: List[SyncItem] = []
    download_files: List[SyncItem] = []
    download_dirs: List[SyncItem] = []
    conflicts: List[SyncItem] = []
    skip_count = 0

    for i in items:
        if i.action == SyncAction.UPLOAD:
            (upload_dirs if i.is_dir else upload_files).append(i)
        elif i.action == SyncAction.DOWNLOAD:
            (download_dirs if i.is_dir else download_files).append(i)
        elif i.action == SyncAction.CONFLICT:
            conflicts.append(i)
        elif i.action == SyncAction.SKIP:
            skip_count += 1

    print()
    print("=" * 60)
    print("  Dry-Run 统计")
    print("=" * 60)
    print(f"  上传: {len(upload_files)} 文件 + {len(upload_dirs)} 目录")
    print(f"  下载: {len(download_files)} 文件 + {len(download_dirs)} 目录")
    print(f"  冲突: {len(conflicts)}")
    print(f"  跳过: {skip_count}")
    print(f"  总计: {len(items)}")

    if upload_files:
        print()
        print(f"  上传文件按目录:")
        by_top = Counter(i.relative_path.split("/")[0] for i in upload_files)
        for top, cnt in sorted(by_top.items(), key=lambda x: -x[1]):
            print(f"    {top}: {cnt}")

    if download_files:
        print()
        print(f"  下载文件按目录:")
        by_top = Counter(i.relative_path.split("/")[0] for i in download_files)
        for top, cnt in sorted(by_top.items(), key=lambda x: -x[1]):
            print(f"    {top}: {cnt}")

    if conflicts:
        print()
        print(f"  冲突文件:")
        for i in conflicts:
            print(f"    {i.relative_path}")


_CHUNKED_HASH_THRESHOLD = 1024 * 1024  # 1MB 以上用分块读取

_BINARY_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
    ".pdf", ".amr", ".mp3", ".mp4", ".wav", ".zip", ".rar", ".7z",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
})


def _is_text_file(file_path: str) -> bool:
    _, ext = os.path.splitext(file_path)
    return ext.lower() not in _BINARY_EXTS


def compute_content_hash(file_path: str) -> Optional[str]:
    """
    计算文件内容的 MD5 hash。

    文本文件：去掉 CRLF → LF、BOM 差异后计算（同内容不同换行符 → 相同 hash）。
    二进制文件：直接计算原始字节的 hash（避免错误修改二进制内容）。

    小文件（≤ 1MB）全量读取；大文件分块读取以避免内存峰值。

    :param file_path: 文件绝对路径（不能为空）
    :return: MD5 hex string，文件不存在或读取失败返回 None
    """
    if not file_path:
        raise ValueError("file_path 不能为空")
    try:
        size = os.path.getsize(file_path)
        if not _is_text_file(file_path):
            return _hash_binary_file(file_path, size)
        if size <= _CHUNKED_HASH_THRESHOLD:
            return _hash_small_text_file(file_path)
        return _hash_large_text_file(file_path)
    except Exception:
        return None


def _hash_binary_file(file_path: str, size: int,
                      chunk_size: int = 256 * 1024) -> str:
    """二进制文件 hash：小文件全量读，大文件用 mmap 零拷贝。"""
    import mmap
    h = hashlib.md5()
    with open(file_path, "rb") as f:
        if size <= _CHUNKED_HASH_THRESHOLD:
            h.update(f.read())
        elif size > 0:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                h.update(mm)
        # size == 0: empty file, h stays as initial
    return h.hexdigest()


def _hash_small_text_file(file_path: str) -> str:
    with open(file_path, "rb") as f:
        data = f.read()
    normalized = data.replace(b"\r\n", b"\n")
    if normalized.startswith(b"\xef\xbb\xbf"):
        normalized = normalized[3:]
    return hashlib.md5(normalized).hexdigest()


def _hash_large_text_file(file_path: str,
                          chunk_size: int = 8 * 1024 * 1024) -> str:
    """大文本文件 hash：分块读取 + 流式 CRLF/BOM 规范化。

    不使用 mmap（CRLF 规范化需要内容感知，无法零拷贝）。
    分块处理时需要特殊处理 chunk 边界处被拆开的 \\r\\n 和文件头的 BOM。
    """
    h = hashlib.md5()
    with open(file_path, "rb") as f:
        first_chunk = True
        carry_cr = False
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                if carry_cr:
                    h.update(b"\r")
                break

            if carry_cr:
                if chunk[0:1] == b"\n":
                    h.update(b"\n")
                    chunk = chunk[1:]
                else:
                    h.update(b"\r")
            carry_cr = chunk.endswith(b"\r")
            if carry_cr:
                chunk = chunk[:-1]

            normalized = chunk.replace(b"\r\n", b"\n")
            if first_chunk:
                normalized = normalized.replace(b"\xef\xbb\xbf", b"", 1)
                first_chunk = False
            h.update(normalized)
    return h.hexdigest()


def backup_file(file_path: str) -> Optional[str]:
    """
    备份文件：在同目录下创建 .conflict.时间戳 副本。

    :param file_path: 要备份的文件路径
    :return: 备份文件路径，失败返回 None
    """
    if not os.path.exists(file_path):
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    base, ext = os.path.splitext(file_path)
    backup_path = f"{base}.conflict.{ts}{ext}"
    try:
        shutil.copy2(file_path, backup_path)
        logging.info(f"已备份: {os.path.basename(file_path)} → {os.path.basename(backup_path)}")
        return backup_path
    except Exception as e:
        logging.error(f"备份失败: {file_path} - {e}")
        return None
