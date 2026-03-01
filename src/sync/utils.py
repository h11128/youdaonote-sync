"""
同步工具：枚举、数据类、纯函数

不依赖任何 src 内部模块，可被所有 sync_* 模块安全导入。
"""

import os
import re
import shutil
import logging
import time
from datetime import datetime
from enum import Enum
from dataclasses import dataclass
from typing import (
    Callable, Dict, List, Optional, Tuple, Type, TypeVar, Union,
    TYPE_CHECKING,
)

if TYPE_CHECKING:
    from typing import TypedDict
else:
    try:
        from typing import TypedDict
    except ImportError:
        from typing_extensions import TypedDict

import httpx
import xxhash

from src.common import NoteDomain, FileId, DirId, ContentHash, TreeHash

T = TypeVar("T")

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
    cloud_ctime: Optional[int] = None  # 云端创建时间


# ========== 纯函数 ==========

def decide_action(
    local_exists: bool,
    cloud_exists: bool,
    local_mtime: Optional[int],
    cloud_mtime: Optional[int],
    meta_local_mtime: Optional[int],
    meta_cloud_mtime: Optional[int],
    *,
    local_hash: Optional[ContentHash] = None,
    cloud_hash: Optional[ContentHash] = None,
    meta_hash: Optional[ContentHash] = None,
    previously_synced: bool = False,
) -> SyncAction:
    """
    根据本地/云端/元数据三方信息决定同步操作。

    决策优先级：
    1. 存在性判断（只有一侧存在 / 之前同步过又消失）
    2. mtime 粗筛（快速判断哪一侧可能变化）
    3. content hash 精确验证（消除 mtime 误报，识别内容收敛）
    4. mtime 比大小决定方向（hash 无法判定时的回退）
    """
    if not local_exists and not cloud_exists:
        return SyncAction.SKIP
    if local_exists and not cloud_exists:
        if previously_synced:
            # 云端已删除：如果本地在上次同步之后被修改过 → 重新上传；否则尊重删除
            local_modified_since = (
                local_mtime is not None
                and meta_local_mtime is not None
                and local_mtime > meta_local_mtime
            )
            if local_modified_since:
                return SyncAction.UPLOAD
            return SyncAction.SKIP
        return SyncAction.UPLOAD
    if not local_exists and cloud_exists:
        if previously_synced:
            # 本地已删除：如果云端在上次同步之后被修改过 → 重新下载；否则尊重删除
            cloud_modified_since = (
                cloud_mtime is not None
                and meta_cloud_mtime is not None
                and cloud_mtime > meta_cloud_mtime
            )
            if cloud_modified_since:
                return SyncAction.DOWNLOAD
            return SyncAction.SKIP
        return SyncAction.DOWNLOAD

    # --- 两边都存在 ---

    # Step 1: mtime 粗筛
    local_changed = meta_local_mtime is None or (local_mtime is not None and local_mtime > meta_local_mtime)
    cloud_changed = meta_cloud_mtime is None or (cloud_mtime is not None and cloud_mtime > meta_cloud_mtime)

    # Step 2: hash 精确验证 — mtime 说变了，但 hash 和上次同步时一样 → 没真正变
    if local_changed and local_hash and meta_hash and local_hash == meta_hash:
        local_changed = False
    if cloud_changed and cloud_hash and meta_hash and cloud_hash == meta_hash:
        cloud_changed = False

    # Step 3: 内容收敛 — 双方都改了但改成了相同内容 → 不需要同步
    if local_changed and cloud_changed and local_hash and cloud_hash:
        if local_hash == cloud_hash:
            return SyncAction.SKIP

    # Step 4: 标准决策
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
) -> Tuple[List[SyncItem], int]:
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


def empty_stats() -> SyncStats:
    """返回空的统计字典。"""
    return SyncStats(downloaded=0, uploaded=0, skipped=0,
                     conflicts=0, errors=0, dedup_deleted=0)


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


# ========== Retry ==========

_RETRYABLE_EXCEPTIONS: Tuple[Type[BaseException], ...] = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
    httpx.HTTPStatusError,
    ConnectionError,
    OSError,
)


def retry_with_backoff(
    fn: Callable[[], T],
    max_retries: int = 3,
    base_delay: float = 1.0,
    retryable: Tuple[Type[BaseException], ...] = _RETRYABLE_EXCEPTIONS,
) -> T:
    """带指数退避的重试。仅对网络/IO 类异常重试，业务错误（4xx）直接抛出。"""
    last_err: BaseException = RuntimeError("unreachable")
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except retryable as e:
            last_err = e
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500:
                raise
            if attempt < max_retries:
                delay = base_delay * (2 ** attempt)
                logging.warning(f"重试 {attempt + 1}/{max_retries}: {e} (等待 {delay:.1f}s)")
                time.sleep(delay)
    raise last_err


# ========== Hashing ==========

def compute_hash_from_bytes(data: bytes, file_path: str) -> Optional[ContentHash]:
    """从原始字节计算 content hash（与 compute_content_hash 相同的规范化逻辑）。

    用于对云端下载的内容直接计算 hash，无需先写入磁盘。
    文本文件做 CRLF→LF + BOM 去除；.md/.txt 额外做格式归一化。
    二进制文件直接 hash。
    """
    if data is None:
        return None
    if not _is_text_file(file_path):
        return ContentHash(xxhash.xxh3_128(data).hexdigest())
    normalized = _normalize_md_bytes(data, file_path)
    return ContentHash(xxhash.xxh3_128(normalized).hexdigest())


_CHUNKED_HASH_THRESHOLD = 1024 * 1024  # 1MB 以上用分块读取

_BINARY_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
    ".pdf", ".amr", ".mp3", ".mp4", ".wav", ".zip", ".rar", ".7z",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
})


def _is_text_file(file_path: str) -> bool:
    _, ext = os.path.splitext(file_path)
    return ext.lower() not in _BINARY_EXTS


_MD_NORM_EXTS = frozenset({".md", ".txt"})


def _is_md_normalizable(file_path: str) -> bool:
    _, ext = os.path.splitext(file_path)
    return ext.lower() in _MD_NORM_EXTS


def normalize_md_formatting(text: str) -> str:
    r"""归一化 Markdown 格式，消除编辑器造成的无意义差异。

    用于 content hash 计算和文件比较，确保同一篇文档在不同编辑器
    保存后（Youdao 会重新格式化 Markdown）仍能产生相同的 hash。

    规则：
    - 去除每行尾部空白，跳过所有空行
    - 统一分隔线 ``***`` → ``---``
    - 统一无序列表标记 ``*`` → ``-``
    - 去除列表标记后多余空格
    - 折叠行内连续空格（消除表格对齐填充）
    - 去除反斜杠转义 ``\_`` → ``_``
    """
    _bq = r'(?:>\s*)*'  # optional nested blockquote prefix
    result = []
    for line in text.splitlines():
        s = line.rstrip()
        if not s:
            continue
        # 空引用行 (只有 > 和空白) → 跳过
        if re.match(r'^\s*>[\s>]*$', s):
            continue
        # 代码围栏行 → 跳过 (只影响展示，不改内容)
        if re.match(r'^\s*```\w*\s*$', s):
            continue
        # 水平分隔线
        if re.match(r'^[\s]*(\*\s*\*\s*\*[\s*]*|-\s*-\s*-[\s-]*)$', s):
            s = "---"
        # 表格分隔行: | --- | --- | → 统一每个 cell 为 ---
        if re.match(r'^\|[\s:|-]+\|$', s):
            cells = s.split('|')
            s = '|'.join(
                '---' if c.strip() and all(ch in '-: ' for ch in c.strip())
                else c.strip()
                for c in cells
            )
        # 无序列表标记: > * / * → > - / -
        s = re.sub(rf'^(\s*{_bq})\*(\s+)', r'\1-\2', s)
        # 列表标记后多余空格
        s = re.sub(rf'^(\s*{_bq}\d+\.)\s{{2,}}', r'\1 ', s)
        s = re.sub(rf'^(\s*{_bq}-)\s{{2,}}', r'\1 ', s)
        # 去除前导空格 (代码围栏/缩进差异)
        s = s.lstrip()
        # 表格行单元格 padding 归一化
        if s.startswith('|'):
            s = re.sub(r'\s*\|\s*', '|', s)
        # 折叠内部连续空格
        s = re.sub(r' {2,}', ' ', s)
        # Markdown 反斜杠转义
        s = re.sub(r'\\([_$~&*#{}|.!\[\]()])', r'\1', s)
        # 尖括号链接: <https://...> → https://...
        s = re.sub(r'<(https?://[^>]+)>', r'\1', s)
        # 去除单反引号 (内联代码格式)
        s = s.replace('`', '')
        result.append(s)
    return "\n".join(result)


def _normalize_md_bytes(data: bytes, file_path: str) -> bytes:
    """对 Markdown 文件的原始字节做完整归一化（CRLF + BOM + 格式），返回用于 hash 的字节。"""
    normalized = data.replace(b"\r\n", b"\n")
    if normalized.startswith(b"\xef\xbb\xbf"):
        normalized = normalized[3:]
    if _is_md_normalizable(file_path):
        text = normalized.decode("utf-8", errors="replace")
        text = normalize_md_formatting(text)
        normalized = text.encode("utf-8")
    return normalized


def compute_content_hash(file_path: str) -> Optional[ContentHash]:
    """
    计算文件内容的 xxhash (xxh3_128) hash。

    文本文件：去掉 CRLF → LF、BOM 差异后计算（同内容不同换行符 → 相同 hash）。
    二进制文件：直接计算原始字节的 hash（避免错误修改二进制内容）。

    小文件（≤ 1MB）全量读取；大文件分块读取以避免内存峰值。

    :param file_path: 文件绝对路径（不能为空）
    :return: hex string，文件不存在或读取失败返回 None
    """
    if not file_path:
        raise ValueError("file_path 不能为空")
    from src.common import safe_long_path
    file_path = safe_long_path(file_path)
    try:
        size = os.path.getsize(file_path)
        if not _is_text_file(file_path):
            return _hash_binary_file(file_path, size)
        # .md/.txt 需要格式归一化，始终全量读取（这些文件极少超过 1MB）
        if _is_md_normalizable(file_path) or size <= _CHUNKED_HASH_THRESHOLD:
            return _hash_small_text_file(file_path)
        return _hash_large_text_file(file_path)
    except (OSError, PermissionError):
        return None


def _hash_binary_file(file_path: str, size: int,
                      chunk_size: int = 256 * 1024) -> ContentHash:
    """二进制文件 hash：小文件全量读，大文件用 mmap 零拷贝。"""
    import mmap
    h = xxhash.xxh3_128()
    with open(file_path, "rb") as f:
        if size <= _CHUNKED_HASH_THRESHOLD:
            h.update(f.read())
        elif size > 0:
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                h.update(mm)
    return ContentHash(h.hexdigest())


def _hash_small_text_file(file_path: str) -> ContentHash:
    with open(file_path, "rb") as f:
        data = f.read()
    normalized = _normalize_md_bytes(data, file_path)
    return ContentHash(xxhash.xxh3_128(normalized).hexdigest())


def _hash_large_text_file(file_path: str,
                          chunk_size: int = 8 * 1024 * 1024) -> ContentHash:
    """大文本文件 hash：分块读取 + 流式 CRLF/BOM 规范化。

    不使用 mmap（CRLF 规范化需要内容感知，无法零拷贝）。
    分块处理时需要特殊处理 chunk 边界处被拆开的 \\r\\n 和文件头的 BOM。
    """
    h = xxhash.xxh3_128()
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
    return ContentHash(h.hexdigest())


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
