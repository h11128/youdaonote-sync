"""
同步类型定义：枚举、TypedDict、数据类

所有跨模块共享的类型集中在此，避免循环导入。
不依赖任何 src 内部模块（仅依赖 src.common 的 NewType）。
"""

from enum import Enum
from dataclasses import dataclass
from typing import List, Optional, Union, TYPE_CHECKING

if TYPE_CHECKING:
    from typing import TypedDict
else:
    try:
        from typing import TypedDict
    except ImportError:
        from typing_extensions import TypedDict

from src.common import NoteDomain, FileId, DirId, ContentHash


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


class VerifyIssueType(Enum):
    """metadata.verify() 返回的问题类型"""
    ORPHAN = "orphan"
    HASH_MISMATCH = "hash_mismatch"
    ORPHAN_DIR = "orphan_dir"


# ========== TypedDict — 跨模块传递的数据结构 ==========

class CloudFileInfo(TypedDict):
    """云端文件/目录信息（scanner 输出格式）"""
    id: Union[FileId, DirId]
    parent_id: DirId
    name: str
    is_dir: bool
    mtime: int
    ctime: int
    domain: int


class _LocalFileInfoBase(TypedDict):
    path: str
    is_dir: bool
    mtime: int


class LocalFileInfo(_LocalFileInfoBase, total=False):
    """本地文件/目录信息（scanner 输出格式）

    目录只有 path/is_dir/mtime；文件额外有 size。
    """
    size: int


class _FileMetaBase(TypedDict):
    file_id: FileId
    cloud_mtime: int
    local_mtime: int


class FileMetaInfo(_FileMetaBase, total=False):
    """metadata.db 中的文件元数据记录"""
    parent_id: DirId
    domain: int
    content_hash: ContentHash
    create_time: int
    last_sync_at: int
    cloud_content_hash: ContentHash
    original_domain: int


@dataclass(frozen=True)
class UploadResult:
    """Returned by upload methods so that the caller can record metadata."""
    file_id: FileId
    cloud_mtime: int
    local_mtime: int
    parent_id: DirId
    domain: int


class SyncStats(TypedDict):
    """同步统计信息"""
    downloaded: int
    uploaded: int
    skipped: int
    conflicts: int
    errors: int
    dedup_deleted: int


class _DedupStatsBase(TypedDict):
    deleted: int
    cloud_deleted: int
    kept: int
    skipped: int
    groups: int
    protected_refs: int


class DedupStats(_DedupStatsBase, total=False):
    """去重统计信息"""
    deleted_paths: List[str]


# ========== 数据类 ==========

@dataclass(frozen=True)
class SyncItem:
    """同步项（不可变快照）"""
    relative_path: str
    local_path: Optional[str]
    cloud_id: Optional[Union[FileId, DirId]]
    cloud_parent_id: Optional[DirId]
    local_mtime: Optional[int]
    cloud_mtime: Optional[int]
    is_dir: bool
    action: SyncAction
    cloud_name: Optional[str] = None
    domain: NoteDomain = NoteDomain.MARKDOWN
    cloud_ctime: Optional[int] = None
