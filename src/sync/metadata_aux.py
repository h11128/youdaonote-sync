"""
辅助表操作：sync_log / file_refs / file_base / tree_hash

这些表与 files 主表无 SQL 依赖，独立存储辅助数据。
通过 meta._conn / meta._lock / meta._normalize_path 访问数据库。
SyncMetadata 保留同名委托方法，保持公共 API 不变。
"""

import time
from typing import Optional, Dict, List, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from src.sync.metadata import SyncMetadata
    from src.sync.utils import ContentHash, TreeHash


# ========== 操作日志 (sync_log) ==========

_SYNC_LOG_COLS = ("id", "timestamp", "path", "action", "direction",
                  "old_hash", "new_hash", "cloud_id", "detail")
_SYNC_LOG_SQL = ", ".join(_SYNC_LOG_COLS)


def log_sync_action(
    meta: "SyncMetadata", path: str, action: str,
    direction: Optional[str] = None,
    old_hash: Optional["ContentHash"] = None,
    new_hash: Optional["ContentHash"] = None,
    cloud_id: Optional[str] = None,
    detail: Optional[str] = None,
    timestamp_override: Optional[int] = None,
) -> None:
    """记录一条同步操作日志。"""
    ts = timestamp_override if timestamp_override is not None else int(time.time())
    with meta._lock:
        meta._conn.execute(
            "INSERT INTO sync_log (timestamp, path, action, direction, "
            "old_hash, new_hash, cloud_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ts, path, action, direction,
             old_hash, new_hash, cloud_id, detail),
        )


def get_sync_log(
    meta: "SyncMetadata", limit: int = 100, path: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """查询同步操作日志。"""
    with meta._lock:
        if path:
            rows = meta._conn.execute(
                f"SELECT {_SYNC_LOG_SQL} FROM sync_log "
                "WHERE path = ? ORDER BY id DESC LIMIT ?", (path, limit)
            ).fetchall()
        else:
            rows = meta._conn.execute(
                f"SELECT {_SYNC_LOG_SQL} FROM sync_log "
                "ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [{col: r[col] for col in _SYNC_LOG_COLS} for r in rows]


# ========== 引用索引缓存 (file_refs) ==========

def get_file_refs(meta: "SyncMetadata", source_path: str) -> List[str]:
    """获取缓存的文件引用列表。"""
    with meta._lock:
        path = meta._normalize_path(source_path)
        rows = meta._conn.execute(
            "SELECT ref_path FROM file_refs WHERE source_path = ?", (path,)
        ).fetchall()
        return [r[0] for r in rows]


def set_file_refs(meta: "SyncMetadata", source_path: str, refs: List[str]) -> None:
    """更新文件的引用列表（先删后插）。"""
    with meta._lock:
        path = meta._normalize_path(source_path)
        meta._conn.execute(
            "DELETE FROM file_refs WHERE source_path = ?", (path,))
        if refs:
            meta._conn.executemany(
                "INSERT OR IGNORE INTO file_refs (source_path, ref_path) VALUES (?, ?)",
                [(path, r) for r in refs],
            )


def get_all_cached_refs(meta: "SyncMetadata") -> Dict[str, List[str]]:
    """获取所有缓存的引用（用于增量构建引用索引）。"""
    with meta._lock:
        rows = meta._conn.execute(
            "SELECT source_path, ref_path FROM file_refs"
        ).fetchall()
        result: Dict[str, List[str]] = {}
        for src, ref in rows:
            result.setdefault(src, []).append(ref)
        return result


# ========== Base 版本存储 (file_base) ==========

def save_base_content(
    meta: "SyncMetadata", rel_path: str, content: bytes,
    content_hash: "ContentHash",
) -> None:
    """保存文件的 base 版本（用于 diff3 三路合并）。"""
    with meta._lock:
        path = meta._normalize_path(rel_path)
        meta._conn.execute(
            "INSERT OR REPLACE INTO file_base (path, content, hash, saved_at) "
            "VALUES (?, ?, ?, ?)",
            (path, content, content_hash, int(time.time())),
        )


def get_base_content(meta: "SyncMetadata", rel_path: str) -> Optional[bytes]:
    """获取文件的 base 版本内容。"""
    with meta._lock:
        path = meta._normalize_path(rel_path)
        row = meta._conn.execute(
            "SELECT content FROM file_base WHERE path = ?", (path,)
        ).fetchone()
        return row[0] if row else None


# ========== Merkle Tree (directories.tree_hash) ==========

def get_tree_hash(meta: "SyncMetadata", dir_path: str) -> Optional["TreeHash"]:
    """获取目录的 tree_hash。"""
    with meta._lock:
        path = meta._normalize_path(dir_path)
        row = meta._conn.execute(
            "SELECT tree_hash FROM directories WHERE path = ?", (path,)
        ).fetchone()
        return row[0] if row and row[0] else None


def set_tree_hash(meta: "SyncMetadata", dir_path: str, tree_hash: "TreeHash") -> None:
    """更新目录的 tree_hash（目录行不存在时自动创建）。"""
    with meta._lock:
        path = meta._normalize_path(dir_path)
        meta._conn.execute(
            "INSERT INTO directories (path, dir_id, parent_id, tree_hash) "
            "VALUES (?, '', '', ?) "
            "ON CONFLICT(path) DO UPDATE SET tree_hash = excluded.tree_hash",
            (path, tree_hash),
        )


def get_all_tree_hashes(meta: "SyncMetadata") -> Dict[str, "TreeHash"]:
    """获取所有目录的 tree_hash。"""
    with meta._lock:
        rows = meta._conn.execute(
            "SELECT path, tree_hash FROM directories WHERE tree_hash IS NOT NULL"
        ).fetchall()
        return {r[0]: r[1] for r in rows}
