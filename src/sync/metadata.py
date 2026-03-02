"""
同步元数据管理模块

管理本地文件与云端文件 ID 的映射关系，用于双向同步。
使用 SQLite 后端持久化，单条写入 O(1)，查询通过 SQL 索引加速。
"""

import os
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from functools import lru_cache
from typing import Optional, Dict, List, Tuple

from src.common import get_config_directory, normalize_sep
from src.sync.utils import FileMetaInfo, VerifyIssueType, FileId, DirId, ContentHash
from src.sync.metadata_migrations import run_all_migrations

_FILE_META_COLS = (
    "file_id", "cloud_mtime", "local_mtime", "parent_id", "domain",
    "content_hash", "create_time", "last_sync_at", "cloud_content_hash",
    "original_domain",
)
_FILE_META_SQL = ", ".join(_FILE_META_COLS)


class SyncMetadata:
    """管理本地文件与云端 ID 的映射关系（线程安全，SQLite 后端）"""

    def __init__(self, metadata_path: Optional[str] = None):
        """
        初始化元数据管理器

        :param metadata_path: 元数据文件路径（可以是旧 .json 路径，会自动派生 .db）
        """
        default_path = os.path.join(get_config_directory(), "sync_metadata.json")
        self._json_path = metadata_path or default_path

        if self._json_path.endswith(".json"):
            self._db_path = self._json_path[:-5] + ".db"
        else:
            self._db_path = self._json_path + ".db"

        self._lock = threading.RLock()
        self._batch_depth = 0
        self._save_count = 0

        db_dir = os.path.dirname(self._db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        self._conn_impl: Optional[sqlite3.Connection] = sqlite3.connect(
            self._db_path, check_same_thread=False)
        self._conn_impl.row_factory = sqlite3.Row
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            run_all_migrations(self._conn, self._json_path,
                               self.get_state, self.set_state)
        except Exception:
            self._conn_impl.close()
            self._conn_impl = None
            raise

    @property
    def _conn(self) -> sqlite3.Connection:
        """Type-narrowing accessor; raises if already closed."""
        conn = self._conn_impl
        if conn is None:
            raise RuntimeError("SyncMetadata is already closed")
        return conn

    def load(self) -> None:
        """兼容接口。SQLite 模式下数据始终在 DB 中，无需显式加载。"""
        pass

    @contextmanager
    def batch(self):
        """批量操作模式：持锁期间共享事务，退出时自动提交。

        用法::

            with metadata.batch() as m:
                info = m.get_file_info(path)
                m.set_file_info(path, ...)
            # 退出时自动 commit；异常时 rollback
        """
        self._lock.acquire()
        self._batch_depth += 1
        exc_occurred = False
        try:
            yield self
        except BaseException:
            exc_occurred = True
            raise
        finally:
            self._batch_depth -= 1
            if self._batch_depth == 0:
                try:
                    if exc_occurred:
                        self._conn.rollback()
                    else:
                        self._conn.commit()
                except sqlite3.Error as e:
                    logging.error(f"批量{'回滚' if exc_occurred else '提交'}失败: {e}")
            self._lock.release()

    def save(self) -> bool:
        """
        提交当前事务到磁盘。

        :return: 是否保存成功
        """
        with self._lock:
            if self._batch_depth > 0:
                return True
            try:
                self._conn.commit()
                self._maybe_wal_checkpoint()
                return True
            except sqlite3.Error as e:
                logging.error(f"保存元数据失败: {e}")
                return False

    def _maybe_wal_checkpoint(self) -> None:
        """定期将 WAL 刷入主文件，防止 WAL 无限增长和断电丢数据。"""
        self._save_count += 1
        if self._save_count % 50 == 0:
            try:
                self._conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            except sqlite3.Error:
                pass

    def close(self) -> None:
        """关闭数据库连接。"""
        with self._lock:
            if self._conn_impl:
                try:
                    self._conn_impl.commit()
                except sqlite3.Error:
                    pass
                self._conn_impl.close()
                self._conn_impl = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    @staticmethod
    @lru_cache(maxsize=8192)
    def _normalize_path(local_path: str, base_dir: Optional[str] = None) -> str:
        """规范化路径（带 LRU 缓存，避免重复字符串操作）。"""
        path = normalize_sep(local_path)
        if base_dir:
            base = normalize_sep(base_dir)
            if path.startswith(base):
                path = path[len(base):].lstrip("/")
        return path

    # ========== 文件相关方法 ==========

    def get_file_id(self, local_path: str) -> Optional[FileId]:
        """
        获取本地文件对应的云端 ID

        :param local_path: 本地文件的相对路径
        :return: 云端文件 ID，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT file_id FROM files WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    def get_file_info(self, local_path: str) -> Optional[FileMetaInfo]:
        """
        获取本地文件的完整元数据

        :param local_path: 本地文件的相对路径
        :return: 文件元数据字典，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                f"SELECT {_FILE_META_SQL} FROM files WHERE path = ?",
                (path,),
            ).fetchone()
            if not row:
                return None
            return self._row_to_file_meta(row)

    @staticmethod
    def _row_to_file_meta(row: sqlite3.Row) -> FileMetaInfo:
        """将 SQL 行转换为 FileMetaInfo。

        可选字段只在有值时填入，保持 .get() 语义和 'key in info' 检查不变。
        """
        result = FileMetaInfo(
            file_id=row["file_id"],
            cloud_mtime=row["cloud_mtime"],
            local_mtime=row["local_mtime"],
        )
        if row["parent_id"] is not None:
            result["parent_id"] = row["parent_id"]
        if row["domain"] is not None:
            result["domain"] = row["domain"]
        if row["content_hash"] is not None:
            result["content_hash"] = row["content_hash"]
        ct = row["create_time"]
        if ct is not None and ct > 0:
            result["create_time"] = ct
        if row["last_sync_at"]:
            result["last_sync_at"] = row["last_sync_at"]
        if row["cloud_content_hash"]:
            result["cloud_content_hash"] = row["cloud_content_hash"]
        if row["original_domain"] is not None:
            result["original_domain"] = row["original_domain"]
        return result

    def mark_synced(self, local_path: str, ts: Optional[int] = None) -> None:
        """标记文件已成功同步（更新 last_sync_at）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            ts = ts or int(time.time())
            self._conn.execute(
                "UPDATE files SET last_sync_at = ? WHERE path = ?", (ts, path)
            )

    _UPSERT_SQL = (
        "INSERT INTO files "
        "(path, file_id, cloud_mtime, local_mtime, parent_id, domain, "
        " content_hash, create_time, last_sync_at, cloud_content_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET "
        "  file_id = excluded.file_id,"
        "  cloud_mtime = excluded.cloud_mtime,"
        "  local_mtime = excluded.local_mtime,"
        "  parent_id = COALESCE(excluded.parent_id, files.parent_id),"
        "  domain = COALESCE(excluded.domain, files.domain),"
        "  content_hash = COALESCE(excluded.content_hash, files.content_hash),"
        "  create_time = CASE WHEN excluded.create_time IS NOT NULL"
        "                      AND excluded.create_time > 0"
        "                THEN excluded.create_time ELSE files.create_time END,"
        "  last_sync_at = CASE WHEN excluded.last_sync_at > 0"
        "                 THEN excluded.last_sync_at"
        "                 ELSE files.last_sync_at END,"
        "  cloud_content_hash = COALESCE(excluded.cloud_content_hash,"
        "                                files.cloud_content_hash)"
    )

    def _upsert_file(
        self, path: str, *, file_id: str, cloud_mtime: int,
        local_mtime: int, parent_id: Optional[str] = None,
        domain: Optional[int] = None, content_hash: Optional[str] = None,
        create_time: Optional[int] = None, last_sync_at: Optional[int] = None,
        cloud_content_hash: Optional[str] = None,
    ) -> None:
        """内部 upsert，调用方必须已持有 self._lock。

        None 参数 → COALESCE 保留旧值；非 None → 覆盖。
        """
        self._conn.execute(
            self._UPSERT_SQL,
            (path, file_id or "", cloud_mtime, local_mtime,
             parent_id, domain, content_hash,
             create_time if create_time and create_time > 0 else None,
             last_sync_at or 0, cloud_content_hash),
        )

    @staticmethod
    def _resolve_local_mtime(
        local_path: str, cloud_mtime: int, base_dir: Optional[str] = None,
    ) -> int:
        """当 local_mtime 未指定时，尝试从文件系统读取，否则用 cloud_mtime。"""
        if os.path.isabs(local_path):
            full_path = local_path
        elif base_dir:
            full_path = os.path.join(base_dir, local_path)
        else:
            full_path = local_path
        if os.path.exists(full_path):
            return int(os.path.getmtime(full_path))
        return cloud_mtime

    def set_file_info(
        self,
        local_path: str,
        file_id: FileId,
        cloud_mtime: int,
        local_mtime: Optional[int] = None,
        parent_id: Optional[DirId] = None,
        domain: Optional[int] = None,
        content_hash: Optional[ContentHash] = None,
        create_time: Optional[int] = None,
        base_dir: Optional[str] = None,
    ) -> None:
        """
        设置本地文件的元数据

        :param local_path: 本地文件的相对路径（或绝对路径）
        :param file_id: 云端文件 ID
        :param cloud_mtime: 云端修改时间（秒级时间戳）
        :param local_mtime: 本地修改时间（秒级时间戳），默认使用当前文件时间
        :param parent_id: 父目录 ID
        :param domain: 笔记类型（0=普通笔记，1=Markdown）
        :param content_hash: 文件内容的 normalized xxhash (xxh3_128)
        :param create_time: 云端创建时间（秒级时间戳）
        :param base_dir: 基准目录，用于将相对路径转绝对路径以读取 mtime
        """
        if not local_path:
            raise ValueError("local_path 不能为空")
        with self._lock:
            path = self._normalize_path(local_path)
            if local_mtime is None:
                local_mtime = self._resolve_local_mtime(
                    local_path, cloud_mtime, base_dir)
            self._upsert_file(
                path, file_id=file_id, cloud_mtime=cloud_mtime,
                local_mtime=local_mtime, parent_id=parent_id,
                domain=domain, content_hash=content_hash,
                create_time=create_time)

    def record_sync(
        self,
        local_path: str,
        *,
        file_id: FileId,
        cloud_mtime: int,
        local_mtime: int,
        parent_id: Optional[DirId] = None,
        domain: Optional[int] = None,
        content_hash: Optional[ContentHash] = None,
        cloud_content_hash: Optional[ContentHash] = None,
        original_domain: Optional[int] = None,
        create_time: Optional[int] = None,
        action: Optional[str] = None,
        direction: Optional[str] = None,
        old_hash: Optional[ContentHash] = None,
        detail: Optional[str] = None,
    ) -> None:
        """Record a complete sync outcome atomically.

        Single entry point for all post-sync metadata updates.  In one
        transaction it: upserts the file row (core + optional fields), sets
        ``last_sync_at``, optionally writes ``original_domain`` (first-time
        only), and appends a ``sync_log`` entry.

        SOT rules enforced here:
        - ``local_mtime`` must be > 0 (snapshot of ``os.path.getmtime`` at
          sync time).
        - ``cloud_mtime`` should come from the API response
          (``modifyTimeForSort``) or from ``time.time()`` for moves.
        """
        if not local_path:
            raise ValueError("local_path must not be empty")
        if local_mtime <= 0:
            logging.warning(
                "record_sync: local_mtime <= 0 for %s (got %s), "
                "this will break future change detection",
                local_path, local_mtime,
            )
        if cloud_mtime <= 0:
            logging.warning(
                "record_sync: cloud_mtime <= 0 for %s (got %s), "
                "SOT requires API response or time.time()",
                local_path, cloud_mtime,
            )
        if not file_id:
            logging.warning(
                "record_sync: empty file_id for %s", local_path,
            )

        now = int(time.time())
        with self._lock:
            path = self._normalize_path(local_path)
            self._upsert_file(
                path, file_id=file_id, cloud_mtime=cloud_mtime,
                local_mtime=local_mtime, parent_id=parent_id,
                domain=domain, content_hash=content_hash,
                create_time=create_time, last_sync_at=now,
                cloud_content_hash=cloud_content_hash)

            if original_domain is not None:
                self._conn.execute(
                    "UPDATE files SET original_domain = ? "
                    "WHERE path = ? AND original_domain IS NULL",
                    (original_domain, path),
                )

            if action:
                self._conn.execute(
                    "INSERT INTO sync_log "
                    "(timestamp, path, action, direction, "
                    " old_hash, new_hash, cloud_id, detail) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (now, path, action, direction,
                     old_hash, content_hash, file_id, detail),
                )

    _CACHE_CLOUD_SQL = (
        "INSERT INTO files "
        "(path, file_id, cloud_mtime, local_mtime, parent_id, domain, create_time) "
        "VALUES (?, ?, ?, 0, ?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET "
        "  file_id = excluded.file_id,"
        "  parent_id = COALESCE(excluded.parent_id, files.parent_id),"
        "  domain = COALESCE(excluded.domain, files.domain),"
        "  create_time = CASE WHEN excluded.create_time IS NOT NULL"
        "                      AND excluded.create_time > 0"
        "                THEN excluded.create_time ELSE files.create_time END"
    )

    def cache_cloud_file_info(
        self,
        local_path: str,
        file_id: FileId,
        cloud_mtime: int,
        parent_id: Optional[DirId] = None,
        domain: Optional[int] = None,
        create_time: Optional[int] = None,
    ) -> None:
        """缓存云端扫描结果，只写入云端相关字段。

        - 新记录：写入 file_id / cloud_mtime / local_mtime=0
        - 已有记录：更新 file_id，但保留 cloud_mtime 和 local_mtime
          （cloud_mtime 代表"上次同步时的云端时间"，用于变更检测）
        """
        if not local_path:
            raise ValueError("local_path 不能为空")
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                self._CACHE_CLOUD_SQL,
                (path, file_id or "", cloud_mtime,
                 parent_id, domain,
                 create_time if create_time and create_time > 0 else None),
            )

    def set_original_domain(self, local_path: str, domain: int) -> None:
        """记录文件的云端原始 domain（仅在首次下载时设置，不覆盖已有值）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET original_domain = ? "
                "WHERE path = ? AND original_domain IS NULL",
                (domain, path),
            )

    def get_original_domain(self, local_path: str) -> Optional[int]:
        """获取文件的云端原始 domain。"""
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT original_domain FROM files WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] is not None else None

    def remove_file_info(self, local_path: str) -> None:
        """删除指定路径的文件元数据（用于文件移动后清理旧记录）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute("DELETE FROM files WHERE path = ?", (path,))

    def rename_path(self, old_path: str, new_path: str) -> bool:
        """将文件元数据从旧路径迁移到新路径（用于云端 move 后更新记录）。

        保留 file_id、content_hash、original_domain 等所有字段，只改 path。
        如果旧路径不存在则返回 False。
        """
        with self._lock:
            old_norm = self._normalize_path(old_path)
            new_norm = self._normalize_path(new_path)
            try:
                cur = self._conn.execute(
                    "UPDATE files SET path = ? WHERE path = ?",
                    (new_norm, old_norm))
                return cur.rowcount > 0
            except sqlite3.IntegrityError:
                self._conn.execute("DELETE FROM files WHERE path = ?", (old_norm,))
                return False

    def clear_cloud_id(self, local_path: str) -> None:
        """清除文件的云端 ID（标记为纯本地记录，不再视为云端文件）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET file_id = '' WHERE path = ?", (path,))

    def get_all_files(self) -> Dict[str, FileMetaInfo]:
        """获取所有文件元数据（返回独立副本，外部可安全修改）。"""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT path, {_FILE_META_SQL} FROM files"
            ).fetchall()
            return {row["path"]: self._row_to_file_meta(row) for row in rows}

    def get_cloud_file_summaries(self) -> Dict[str, FileMetaInfo]:
        """获取所有有 file_id 的文件的摘要信息（用于扫描缓存重建）。"""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT path, {_FILE_META_SQL} FROM files WHERE file_id != ''"
            ).fetchall()
            return {row["path"]: self._row_to_file_meta(row) for row in rows}

    def get_stale_cloud_paths(self, active_paths: set) -> List[str]:
        """返回有 file_id 但不在 active_paths 中的文件路径（用于清理过期缓存）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT path FROM files WHERE file_id != ''"
            ).fetchall()
            return [r[0] for r in rows if r[0] not in active_paths]

    # ========== 目录相关方法 ==========

    def get_dir_id(self, local_path: str) -> Optional[DirId]:
        """
        获取本地目录对应的云端 ID

        :param local_path: 本地目录的相对路径
        :return: 云端目录 ID，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT dir_id FROM directories WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    def set_dir_info(self, local_path: str, dir_id: DirId, parent_id: Optional[DirId] = None) -> None:
        """
        设置本地目录的元数据

        :param local_path: 本地目录的相对路径
        :param dir_id: 云端目录 ID
        :param parent_id: 父目录 ID
        """
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "INSERT OR REPLACE INTO directories (path, dir_id, parent_id) VALUES (?, ?, ?)",
                (path, dir_id or "", parent_id or ""),
            )

    def remove_dir(self, local_path: str) -> None:
        """
        删除目录的元数据记录

        :param local_path: 本地目录的相对路径
        """
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute("DELETE FROM directories WHERE path = ?", (path,))

    def get_all_dirs(self) -> Dict[str, Dict[str, str]]:
        """获取所有目录元数据（返回独立副本，外部可安全修改）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT path, dir_id, parent_id FROM directories"
            ).fetchall()
            result: Dict[str, Dict[str, str]] = {}
            for row in rows:
                info: Dict[str, str] = {"dir_id": row[1]}
                if row[2]:
                    info["parent_id"] = row[2]
                result[row[0]] = info
            return result

    # ========== 查询方法 ==========

    def find_by_file_id(self, file_id: FileId) -> Optional[str]:
        """
        根据云端文件 ID 查找本地路径（O(1) 索引查询）

        :param file_id: 云端文件 ID
        :return: 本地文件路径，不存在则返回 None
        """
        with self._lock:
            if not file_id:
                return None
            row = self._conn.execute(
                "SELECT path FROM files WHERE file_id = ?", (file_id,)
            ).fetchone()
            return row[0] if row else None

    def find_by_dir_id(self, dir_id: DirId) -> Optional[str]:
        """
        根据云端目录 ID 查找本地路径（O(1) 索引查询）

        :param dir_id: 云端目录 ID
        :return: 本地目录路径，不存在则返回 None
        """
        with self._lock:
            if not dir_id:
                return None
            row = self._conn.execute(
                "SELECT path FROM directories WHERE dir_id = ?", (dir_id,)
            ).fetchone()
            return row[0] if row else None

    # ========== 内容 Hash 相关 ==========

    def update_content_hash(self, local_path: str, content_hash: ContentHash) -> None:
        """更新文件的 content_hash"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET content_hash = ? WHERE path = ?",
                (content_hash or "", path),
            )

    def get_content_hash(self, local_path: str) -> Optional[ContentHash]:
        """获取文件的 content_hash"""
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT content_hash FROM files WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    def find_cloud_file_by_hash(self, content_hash: ContentHash, exclude_path: Optional[str] = None) -> Optional[str]:
        """
        查找是否已有相同 content_hash 的云端文件（有 file_id 的）。

        :param content_hash: 要查找的 hash
        :param exclude_path: 排除的路径（避免匹配自己）
        :return: 已存在的云端文件相对路径，没找到返回 None
        """
        with self._lock:
            if not content_hash:
                return None
            exclude = self._normalize_path(exclude_path) if exclude_path else ""
            row = self._conn.execute(
                "SELECT path FROM files "
                "WHERE content_hash = ? AND file_id != '' AND path != ? LIMIT 1",
                (content_hash, exclude),
            ).fetchone()
            return row[0] if row else None

    def find_duplicates_by_hash(self) -> Dict[str, List[str]]:
        """
        按 content_hash 分组，找出内容完全一致的文件。

        :return: {hash: [path1, path2, ...]} 只包含 2 个以上路径的组
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT content_hash, path FROM files "
                "WHERE content_hash != '' AND file_id != '' "
                "ORDER BY content_hash"
            ).fetchall()

            groups: Dict[str, List[str]] = {}
            for hash_val, path in rows:
                groups.setdefault(hash_val, []).append(path)

            return {h: paths for h, paths in groups.items() if len(paths) > 1}

    # ========== 云端 Hash 缓存 (Phase 2b) ==========

    def set_cloud_content_hash(self, local_path: str, cloud_hash: ContentHash) -> None:
        """记录云端文件的 content_hash（上传/下载成功后调用）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET cloud_content_hash = ? WHERE path = ?",
                (cloud_hash, path),
            )

    def get_cloud_content_hash(self, local_path: str) -> Optional[ContentHash]:
        """获取缓存的云端 content_hash。"""
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT cloud_content_hash FROM files WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    # ========== 辅助表（委托至 metadata_aux.py）==========

    def log_sync_action(self, path, action, **kw):
        from src.sync.metadata_aux import log_sync_action as _f
        return _f(self, path, action, **kw)

    def get_sync_log(self, limit=100, path=None):
        from src.sync.metadata_aux import get_sync_log as _f
        return _f(self, limit, path)

    def get_file_refs(self, source_path):
        from src.sync.metadata_aux import get_file_refs as _f
        return _f(self, source_path)

    def set_file_refs(self, source_path, refs):
        from src.sync.metadata_aux import set_file_refs as _f
        return _f(self, source_path, refs)

    def get_all_cached_refs(self):
        from src.sync.metadata_aux import get_all_cached_refs as _f
        return _f(self)

    def save_base_content(self, rel_path, content, content_hash):
        from src.sync.metadata_aux import save_base_content as _f
        return _f(self, rel_path, content, content_hash)

    def get_base_content(self, rel_path):
        from src.sync.metadata_aux import get_base_content as _f
        return _f(self, rel_path)

    def get_tree_hash(self, dir_path):
        from src.sync.metadata_aux import get_tree_hash as _f
        return _f(self, dir_path)

    def set_tree_hash(self, dir_path, tree_hash):
        from src.sync.metadata_aux import set_tree_hash as _f
        return _f(self, dir_path, tree_hash)

    def get_all_tree_hashes(self):
        from src.sync.metadata_aux import get_all_tree_hashes as _f
        return _f(self)

    # ========== 全局同步状态 (scan-cache) ==========

    def get_state(self, key: str) -> Optional[str]:
        """读取全局同步状态值。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM sync_state WHERE key = ?", (key,)
            ).fetchone()
            return row[0] if row else None

    def set_state(self, key: str, value: str) -> None:
        """写入全局同步状态值（upsert）。"""
        with self._lock:
            self._conn.execute(
                "INSERT INTO sync_state (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)),
            )

    def get_state_int(self, key: str, default: int = 0) -> int:
        """读取整数型全局同步状态值。"""
        val = self.get_state(key)
        if val is None:
            return default
        try:
            return int(val)
        except (ValueError, TypeError):
            return default

    # ========== 健康检查（委托至 metadata_health.py）==========

    def gc(self, local_dir: str, max_log_age_days: int = 90) -> Dict[str, int]:
        """清理过期和孤儿元数据记录。"""
        from src.sync.metadata_health import gc as _gc
        return _gc(self, local_dir, max_log_age_days)

    def verify(self, local_dir: str, auto_fix: bool = False,
               ) -> List[Tuple[str, VerifyIssueType, str]]:
        """校验元数据与本地文件的一致性。"""
        from src.sync.metadata_health import verify as _verify
        return _verify(self, local_dir, auto_fix)

    def heal(self, local_dir: str, auto_fix: bool = False) -> Dict[str, int]:
        """Lightweight self-healing pass run before each sync."""
        from src.sync.metadata_health import heal as _heal
        return _heal(self, local_dir, auto_fix)
