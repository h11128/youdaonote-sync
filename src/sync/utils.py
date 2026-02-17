"""
同步工具：枚举、数据类、纯函数

不依赖任何 youdaonote_sync 内部模块，可被所有 sync_* 模块安全导入。
"""

import hashlib
import os
import shutil
import logging
from datetime import datetime
from enum import Enum
from dataclasses import dataclass
from typing import List, Dict, Optional


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

@dataclass
class SyncItem:
    """同步项"""
    relative_path: str
    local_path: Optional[str]
    cloud_id: Optional[str]
    cloud_parent_id: Optional[str]
    local_mtime: Optional[int]
    cloud_mtime: Optional[int]
    is_dir: bool
    action: SyncAction
    cloud_name: Optional[str] = None
    domain: int = 1  # 0=普通笔记, 1=Markdown
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

    local_changed = meta_local_mtime is None or (local_mtime and local_mtime > meta_local_mtime)
    cloud_changed = meta_cloud_mtime is None or (cloud_mtime and cloud_mtime > meta_cloud_mtime)

    if local_changed and cloud_changed:
        if local_mtime and cloud_mtime:
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


def filter_by_direction(items: List[SyncItem], direction: SyncDirection) -> List[SyncItem]:
    """按同步方向过滤 items。"""
    if direction == SyncDirection.PULL:
        return [i for i in items if i.action in (SyncAction.DOWNLOAD, SyncAction.SKIP)]
    if direction == SyncDirection.PUSH:
        return [i for i in items if i.action in (SyncAction.UPLOAD, SyncAction.SKIP)]
    return items


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
    """输出 dry-run 的分组统计摘要。"""
    from collections import Counter

    upload_files = [i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir]
    upload_dirs = [i for i in items if i.action == SyncAction.UPLOAD and i.is_dir]
    download_files = [i for i in items if i.action == SyncAction.DOWNLOAD and not i.is_dir]
    download_dirs = [i for i in items if i.action == SyncAction.DOWNLOAD and i.is_dir]
    conflicts = [i for i in items if i.action == SyncAction.CONFLICT]
    skip_count = sum(1 for i in items if i.action == SyncAction.SKIP)

    print()
    print("=" * 60)
    print("  Dry-Run 统计")
    print("=" * 60)
    print(f"  上传: {len(upload_files)} 文件 + {len(upload_dirs)} 目录")
    print(f"  下载: {len(download_files)} 文件 + {len(download_dirs)} 目录")
    print(f"  冲突: {len(conflicts)}")
    print(f"  跳过: {skip_count}")
    print(f"  总计: {len(items)}")

    # 上传文件按顶层目录聚合
    if upload_files:
        print()
        print(f"  上传文件按目录:")
        by_top = Counter()
        for i in upload_files:
            by_top[i.relative_path.split("/")[0]] += 1
        for top, cnt in sorted(by_top.items(), key=lambda x: -x[1]):
            print(f"    {top}: {cnt}")

    # 下载文件按顶层目录聚合
    if download_files:
        print()
        print(f"  下载文件按目录:")
        by_top = Counter()
        for i in download_files:
            by_top[i.relative_path.split("/")[0]] += 1
        for top, cnt in sorted(by_top.items(), key=lambda x: -x[1]):
            print(f"    {top}: {cnt}")

    if conflicts:
        print()
        print(f"  冲突文件:")
        for i in conflicts:
            print(f"    {i.relative_path}")


def compute_content_hash(file_path: str) -> Optional[str]:
    """
    计算文件的 normalized content hash（MD5）。
    去掉 CRLF → LF、BOM 差异后计算，这样同内容不同换行符的文件 hash 一致。

    :param file_path: 文件绝对路径（不能为空）
    :return: MD5 hex string，文件不存在或读取失败返回 None
    """
    if not file_path:
        raise ValueError("file_path 不能为空")
    try:
        with open(file_path, "rb") as f:
            data = f.read()
        normalized = data.replace(b"\r\n", b"\n").replace(b"\xef\xbb\xbf", b"")
        return hashlib.md5(normalized).hexdigest()
    except Exception:
        return None


def backup_file(file_path: str) -> Optional[str]:
    """
    备份文件：在同目录下创建 .conflict.时间戳 副本。

    :param file_path: 要备份的文件路径
    :return: 备份文件路径，失败返回 None
    """
    if not os.path.exists(file_path):
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    base, ext = os.path.splitext(file_path)
    backup_path = f"{base}.conflict.{ts}{ext}"
    try:
        shutil.copy2(file_path, backup_path)
        logging.info(f"已备份: {os.path.basename(file_path)} → {os.path.basename(backup_path)}")
        return backup_path
    except Exception as e:
        logging.error(f"备份失败: {file_path} - {e}")
        return None
