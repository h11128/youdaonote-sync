"""
同步元数据管理模块

管理本地文件与云端文件 ID 的映射关系，用于双向同步。
使用 SQLite 后端持久化，单条写入 O(1)，查询通过 SQL 索引加速。
"""

import json
import os
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from functools import lru_cache
from typing import Optional, Dict, Any, List

from src.common import get_config_directory, normalize_sep


_SCHEMA_SQL = """\
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    file_id TEXT NOT NULL DEFAULT '',
    cloud_mtime INTEGER NOT NULL DEFAULT 0,
    local_mtime INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    domain INTEGER,
    content_hash TEXT,
    create_time INTEGER,
    last_sync_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS directories (
    path TEXT PRIMARY KEY,
    dir_id TEXT NOT NULL DEFAULT '',
    parent_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_file_id ON files(file_id) WHERE file_id != '';
CREATE INDEX IF NOT EXISTS idx_content_hash ON files(content_hash) WHERE content_hash IS NOT NULL AND content_hash != '';
CREATE INDEX IF NOT EXISTS idx_dir_id ON directories(dir_id) WHERE dir_id != '';
"""

_MIGRATION_SQL = [
    "ALTER TABLE files ADD COLUMN last_sync_at INTEGER NOT NULL DEFAULT 0",
    # Phase 1b: cloud hash cache
    "ALTER TABLE files ADD COLUMN cloud_content_hash TEXT",
    # Phase 4a: Merkle tree
    "ALTER TABLE directories ADD COLUMN tree_hash TEXT",
    # Phase 1b: sync_log table
    """CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        path TEXT NOT NULL,
        action TEXT NOT NULL,
        direction TEXT,
        old_hash TEXT,
        new_hash TEXT,
        cloud_id TEXT,
        detail TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_sync_log_ts ON sync_log(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_sync_log_path ON sync_log(path)",
    # Phase 1b: file refs cache
    """CREATE TABLE IF NOT EXISTS file_refs (
        source_path TEXT NOT NULL,
        ref_path TEXT NOT NULL,
        PRIMARY KEY (source_path, ref_path)
    )""",
    # Phase 3d: base version storage for diff3
    """CREATE TABLE IF NOT EXISTS file_base (
        path TEXT PRIMARY KEY,
        content BLOB NOT NULL,
        hash TEXT NOT NULL,
        saved_at INTEGER NOT NULL
    )""",
    # Phase 1a: invalidate MD5 hashes after switching to xxhash
    "UPDATE files SET content_hash = NULL WHERE content_hash IS NOT NULL",
    # scan-cache: key-value store for global sync state
    """CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    # Phase 3: original cloud domain (0=XML, 1=MD) for format preservation
    "ALTER TABLE files ADD COLUMN original_domain INTEGER",
]


class SyncMetadata:
    """管理本地文件与云端 ID 的映射关系（线程安全，SQLite 后端）"""

    def __init__(self, metadata_path: str = None):
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
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(_SCHEMA_SQL)
            self._conn.commit()
            self._run_migrations()
            self._migrate_json_if_needed()
        except Exception:
            self._conn.close()
            self._conn = None
            raise

    def _run_migrations(self) -> None:
        """运行增量 schema 迁移（幂等，已有列/表时自动跳过）。"""
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS _migrations "
            "(idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
        applied = {r[0] for r in self._conn.execute(
            "SELECT idx FROM _migrations").fetchall()}

        _EXPECTED_ERRORS = ("duplicate column", "already exists")

        for i, sql in enumerate(_MIGRATION_SQL):
            if i in applied:
                continue
            try:
                self._conn.execute(sql)
            except sqlite3.OperationalError as e:
                err_msg = str(e).lower()
                if not any(phrase in err_msg for phrase in _EXPECTED_ERRORS):
                    logging.error(f"迁移 #{i} 失败(非预期错误): {e}")
                    raise
            self._conn.execute(
                "INSERT OR IGNORE INTO _migrations (idx, applied_at) VALUES (?, ?)",
                (i, int(time.time())))
        self._conn.commit()

    def _migrate_json_if_needed(self) -> None:
        """检测旧 JSON 文件并自动导入到 SQLite。"""
        if not os.path.exists(self._json_path):
            return
        row = self._conn.execute("SELECT COUNT(*) FROM files").fetchone()
        if row and row[0] > 0:
            return

        try:
            with open(self._json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logging.warning(f"迁移 JSON 元数据失败: {e}")
            return

        files = data.get("files", {})
        dirs = data.get("directories", {})

        for path, info in files.items():
            self._conn.execute(
                "INSERT OR IGNORE INTO files "
                "(path, file_id, cloud_mtime, local_mtime, parent_id, domain, content_hash, create_time) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    path,
                    info.get("file_id", ""),
                    info.get("cloud_mtime", 0),
                    info.get("local_mtime", 0),
                    info.get("parent_id", ""),
                    info.get("domain", 0),
                    info.get("content_hash", ""),
                    info.get("create_time", 0),
                ),
            )

        for path, info in dirs.items():
            self._conn.execute(
                "INSERT OR IGNORE INTO directories (path, dir_id, parent_id) VALUES (?, ?, ?)",
                (path, info.get("dir_id", ""), info.get("parent_id", "")),
            )

        self._conn.commit()

        backup = self._json_path + ".bak"
        try:
            os.replace(self._json_path, backup)
            logging.info(f"JSON 元数据已迁移到 SQLite，旧文件: {backup}")
        except OSError:
            pass

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
            if self._conn:
                try:
                    self._conn.commit()
                except sqlite3.Error:
                    pass
                self._conn.close()
                self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    @staticmethod
    @lru_cache(maxsize=8192)
    def _normalize_path(local_path: str, base_dir: str = None) -> str:
        """规范化路径（带 LRU 缓存，避免重复字符串操作）。"""
        path = normalize_sep(local_path)
        if base_dir:
            base = normalize_sep(base_dir)
            if path.startswith(base):
                path = path[len(base):].lstrip("/")
        return path

    # ========== 文件相关方法 ==========

    def get_file_id(self, local_path: str) -> Optional[str]:
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

    def get_file_info(self, local_path: str) -> Optional[Dict[str, Any]]:
        """
        获取本地文件的完整元数据

        :param local_path: 本地文件的相对路径
        :return: 文件元数据字典，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT file_id, cloud_mtime, local_mtime, parent_id, domain, "
                "content_hash, create_time, last_sync_at, cloud_content_hash, "
                "original_domain "
                "FROM files WHERE path = ?",
                (path,),
            ).fetchone()
            if not row:
                return None
            return self._row_to_file_dict(row)

    @staticmethod
    def _row_to_file_dict(row) -> Dict[str, Any]:
        """将 SQL 行转换为文件信息字典（只包含非 NULL 字段，保持旧 API 兼容）。"""
        result: Dict[str, Any] = {
            "file_id": row[0],
            "cloud_mtime": row[1],
            "local_mtime": row[2],
        }
        if row[3] is not None:
            result["parent_id"] = row[3]
        if row[4] is not None:
            result["domain"] = row[4]
        if row[5] is not None:
            result["content_hash"] = row[5]
        if row[6] is not None and row[6] > 0:
            result["create_time"] = row[6]
        if len(row) > 7 and row[7]:
            result["last_sync_at"] = row[7]
        if len(row) > 8 and row[8]:
            result["cloud_content_hash"] = row[8]
        if len(row) > 9 and row[9] is not None:
            result["original_domain"] = row[9]
        return result

    def mark_synced(self, local_path: str, ts: int = None) -> None:
        """标记文件已成功同步（更新 last_sync_at）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            ts = ts or int(time.time())
            self._conn.execute(
                "UPDATE files SET last_sync_at = ? WHERE path = ?", (ts, path)
            )

    def set_file_info(
        self,
        local_path: str,
        file_id: str,
        cloud_mtime: int,
        local_mtime: Optional[int] = None,
        parent_id: Optional[str] = None,
        domain: Optional[int] = None,
        content_hash: Optional[str] = None,
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
                if os.path.isabs(local_path):
                    full_path = local_path
                elif base_dir:
                    full_path = os.path.join(base_dir, local_path)
                else:
                    full_path = local_path
                if os.path.exists(full_path):
                    local_mtime = int(os.path.getmtime(full_path))
                else:
                    local_mtime = cloud_mtime

            upsert_sets = [
                "file_id = excluded.file_id",
                "cloud_mtime = excluded.cloud_mtime",
                "local_mtime = excluded.local_mtime",
            ]
            if parent_id is not None:
                upsert_sets.append("parent_id = excluded.parent_id")
            if domain is not None:
                upsert_sets.append("domain = excluded.domain")
            if content_hash is not None:
                upsert_sets.append("content_hash = excluded.content_hash")
            if create_time is not None and create_time > 0:
                upsert_sets.append("create_time = excluded.create_time")

            self._conn.execute(
                "INSERT INTO files "
                "(path, file_id, cloud_mtime, local_mtime, parent_id, domain, content_hash, create_time) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET " + ", ".join(upsert_sets),
                (
                    path,
                    file_id or "",
                    cloud_mtime,
                    local_mtime,
                    parent_id,
                    domain,
                    content_hash,
                    create_time if create_time and create_time > 0 else None,
                ),
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

    def clear_cloud_id(self, local_path: str) -> None:
        """清除文件的云端 ID（标记为纯本地记录，不再视为云端文件）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET file_id = '' WHERE path = ?", (path,))

    def update_local_mtime(self, local_path: str, mtime: int) -> None:
        """
        更新本地文件的修改时间记录

        :param local_path: 本地文件的相对路径
        :param mtime: 新的修改时间
        """
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET local_mtime = ? WHERE path = ?", (mtime, path)
            )

    def update_cloud_mtime(self, local_path: str, mtime: int) -> None:
        """
        更新云端文件的修改时间记录

        :param local_path: 本地文件的相对路径
        :param mtime: 新的修改时间
        """
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET cloud_mtime = ? WHERE path = ?", (mtime, path)
            )

    def remove_file(self, local_path: str) -> None:
        """删除文件的元数据记录（remove_file_info 的别名）。"""
        self.remove_file_info(local_path)

    def get_all_files(self) -> Dict[str, Dict[str, Any]]:
        """获取所有文件元数据（返回独立副本，外部可安全修改）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT path, file_id, cloud_mtime, local_mtime, parent_id, "
                "domain, content_hash, create_time, last_sync_at, cloud_content_hash, "
                "original_domain FROM files"
            ).fetchall()
            return {
                row[0]: self._row_to_file_dict(row[1:])
                for row in rows
            }

    # ========== 目录相关方法 ==========

    def get_dir_id(self, local_path: str) -> Optional[str]:
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

    def set_dir_info(self, local_path: str, dir_id: str, parent_id: str = None) -> None:
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

    def get_all_dirs(self) -> Dict[str, Dict[str, Any]]:
        """获取所有目录元数据（返回独立副本，外部可安全修改）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT path, dir_id, parent_id FROM directories"
            ).fetchall()
            result = {}
            for row in rows:
                info: Dict[str, Any] = {"dir_id": row[1]}
                if row[2]:
                    info["parent_id"] = row[2]
                result[row[0]] = info
            return result

    # ========== 查询方法 ==========

    def find_by_file_id(self, file_id: str) -> Optional[str]:
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

    def find_by_dir_id(self, dir_id: str) -> Optional[str]:
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

    @staticmethod
    def compute_content_hash(file_path: str) -> Optional[str]:
        """deprecated: 计划在 v4.0 移除，请使用 src.sync.utils.compute_content_hash"""
        from src.sync.utils import compute_content_hash
        return compute_content_hash(file_path)

    def update_content_hash(self, local_path: str, content_hash: str) -> None:
        """更新文件的 content_hash"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET content_hash = ? WHERE path = ?",
                (content_hash or "", path),
            )

    def get_content_hash(self, local_path: str) -> Optional[str]:
        """获取文件的 content_hash"""
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT content_hash FROM files WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    def find_cloud_file_by_hash(self, content_hash: str, exclude_path: str = None) -> Optional[str]:
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

    def set_cloud_content_hash(self, local_path: str, cloud_hash: str) -> None:
        """记录云端文件的 content_hash（上传/下载成功后调用）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            self._conn.execute(
                "UPDATE files SET cloud_content_hash = ? WHERE path = ?",
                (cloud_hash, path),
            )

    def get_cloud_content_hash(self, local_path: str) -> Optional[str]:
        """获取缓存的云端 content_hash。"""
        with self._lock:
            path = self._normalize_path(local_path)
            row = self._conn.execute(
                "SELECT cloud_content_hash FROM files WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    # ========== 操作日志 (Phase 2d) ==========

    def log_sync_action(
        self, path: str, action: str, direction: str = None,
        old_hash: str = None, new_hash: str = None,
        cloud_id: str = None, detail: str = None,
        timestamp_override: int = None,
    ) -> None:
        """记录一条同步操作日志。"""
        ts = timestamp_override if timestamp_override is not None else int(time.time())
        with self._lock:
            self._conn.execute(
                "INSERT INTO sync_log (timestamp, path, action, direction, "
                "old_hash, new_hash, cloud_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (ts, path, action, direction,
                 old_hash, new_hash, cloud_id, detail),
            )

    def get_sync_log(self, limit: int = 100, path: str = None) -> List[Dict[str, Any]]:
        """查询同步操作日志。"""
        with self._lock:
            if path:
                rows = self._conn.execute(
                    "SELECT id, timestamp, path, action, direction, old_hash, "
                    "new_hash, cloud_id, detail FROM sync_log "
                    "WHERE path = ? ORDER BY id DESC LIMIT ?", (path, limit)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, timestamp, path, action, direction, old_hash, "
                    "new_hash, cloud_id, detail FROM sync_log "
                    "ORDER BY id DESC LIMIT ?", (limit,)
                ).fetchall()
            return [
                {"id": r[0], "timestamp": r[1], "path": r[2], "action": r[3],
                 "direction": r[4], "old_hash": r[5], "new_hash": r[6],
                 "cloud_id": r[7], "detail": r[8]}
                for r in rows
            ]

    # ========== 引用索引缓存 (Phase 2c) ==========

    def get_file_refs(self, source_path: str) -> List[str]:
        """获取缓存的文件引用列表。"""
        with self._lock:
            path = self._normalize_path(source_path)
            rows = self._conn.execute(
                "SELECT ref_path FROM file_refs WHERE source_path = ?", (path,)
            ).fetchall()
            return [r[0] for r in rows]

    def set_file_refs(self, source_path: str, refs: List[str]) -> None:
        """更新文件的引用列表（先删后插）。"""
        with self._lock:
            path = self._normalize_path(source_path)
            self._conn.execute(
                "DELETE FROM file_refs WHERE source_path = ?", (path,))
            if refs:
                self._conn.executemany(
                    "INSERT OR IGNORE INTO file_refs (source_path, ref_path) VALUES (?, ?)",
                    [(path, r) for r in refs],
                )

    def get_all_cached_refs(self) -> Dict[str, List[str]]:
        """获取所有缓存的引用（用于增量构建引用索引）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT source_path, ref_path FROM file_refs"
            ).fetchall()
            result: Dict[str, List[str]] = {}
            for src, ref in rows:
                result.setdefault(src, []).append(ref)
            return result

    # ========== Base 版本存储 (Phase 3d) ==========

    def save_base_content(self, rel_path: str, content: bytes, content_hash: str) -> None:
        """保存文件的 base 版本（用于 diff3 三路合并）。"""
        with self._lock:
            path = self._normalize_path(rel_path)
            self._conn.execute(
                "INSERT OR REPLACE INTO file_base (path, content, hash, saved_at) "
                "VALUES (?, ?, ?, ?)",
                (path, content, content_hash, int(time.time())),
            )

    def get_base_content(self, rel_path: str) -> Optional[bytes]:
        """获取文件的 base 版本内容。"""
        with self._lock:
            path = self._normalize_path(rel_path)
            row = self._conn.execute(
                "SELECT content FROM file_base WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row else None

    # ========== Merkle Tree (Phase 4a) ==========

    def get_tree_hash(self, dir_path: str) -> Optional[str]:
        """获取目录的 tree_hash。"""
        with self._lock:
            path = self._normalize_path(dir_path)
            row = self._conn.execute(
                "SELECT tree_hash FROM directories WHERE path = ?", (path,)
            ).fetchone()
            return row[0] if row and row[0] else None

    def set_tree_hash(self, dir_path: str, tree_hash: str) -> None:
        """更新目录的 tree_hash（目录行不存在时自动创建）。"""
        with self._lock:
            path = self._normalize_path(dir_path)
            self._conn.execute(
                "INSERT INTO directories (path, dir_id, parent_id, tree_hash) "
                "VALUES (?, '', '', ?) "
                "ON CONFLICT(path) DO UPDATE SET tree_hash = excluded.tree_hash",
                (path, tree_hash),
            )

    def get_all_tree_hashes(self) -> Dict[str, str]:
        """获取所有目录的 tree_hash。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT path, tree_hash FROM directories WHERE tree_hash IS NOT NULL"
            ).fetchall()
            return {r[0]: r[1] for r in rows}

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

    # ========== 垃圾回收 (Phase 3a) ==========

    def gc(self, local_dir: str, max_log_age_days: int = 90) -> Dict[str, int]:
        """清理过期和孤儿元数据记录。

        :return: {"files": n, "dirs": n, "logs": n, "bases": n}
        """
        stats = {"files": 0, "dirs": 0, "logs": 0, "bases": 0}
        cutoff = int(time.time()) - 30 * 86400
        log_cutoff = int(time.time()) - max_log_age_days * 86400

        with self._lock:
            # 清理 files 表：last_sync_at 过期且本地不存在
            rows = self._conn.execute(
                "SELECT path FROM files WHERE last_sync_at > 0 AND last_sync_at < ?",
                (cutoff,),
            ).fetchall()
            for (path,) in rows:
                full = os.path.join(local_dir, path)
                if not os.path.exists(full):
                    self._conn.execute("DELETE FROM files WHERE path = ?", (path,))
                    stats["files"] += 1

            # 清理 directories 表：本地不存在的目录
            rows = self._conn.execute("SELECT path FROM directories").fetchall()
            for (path,) in rows:
                full = os.path.join(local_dir, path)
                if not os.path.exists(full):
                    self._conn.execute("DELETE FROM directories WHERE path = ?", (path,))
                    stats["dirs"] += 1

            # 清理过期的 sync_log
            cur = self._conn.execute(
                "DELETE FROM sync_log WHERE timestamp < ?", (log_cutoff,))
            stats["logs"] = cur.rowcount

            # 清理 file_base 中不存在的文件
            rows = self._conn.execute("SELECT path FROM file_base").fetchall()
            for (path,) in rows:
                full = os.path.join(local_dir, path)
                if not os.path.exists(full):
                    self._conn.execute("DELETE FROM file_base WHERE path = ?", (path,))
                    stats["bases"] += 1

            # 清理 file_refs 中不存在的 source
            rows = self._conn.execute(
                "SELECT DISTINCT source_path FROM file_refs").fetchall()
            for (path,) in rows:
                full = os.path.join(local_dir, path)
                if not os.path.exists(full):
                    self._conn.execute(
                        "DELETE FROM file_refs WHERE source_path = ?", (path,))

            self._conn.commit()

        if any(v > 0 for v in stats.values()):
            logging.info(
                f"GC 清理: files={stats['files']}, dirs={stats['dirs']}, "
                f"logs={stats['logs']}, bases={stats['bases']}")
        return stats

    # ========== 完整性校验 (Phase 3b) ==========

    def verify(self, local_dir: str, auto_fix: bool = False) -> List[tuple]:
        """校验元数据与本地文件的一致性。

        :return: [(path, issue_type, detail), ...]
        """
        from src.sync.utils import compute_content_hash
        issues: List[tuple] = []

        with self._lock:
            rows = self._conn.execute(
                "SELECT path, file_id, content_hash FROM files"
            ).fetchall()

        for path, file_id, meta_hash in rows:
            full = os.path.join(local_dir, path)
            if not os.path.exists(full):
                if file_id:
                    issues.append((path, "orphan", "本地文件不存在但有 file_id"))
                continue
            if meta_hash:
                actual = compute_content_hash(full)
                if actual and actual != meta_hash:
                    issues.append((path, "hash_mismatch",
                                   f"记录={meta_hash[:16]}.. 实际={actual[:16]}.."))
                    if auto_fix:
                        self.update_content_hash(path, actual)

        with self._lock:
            dir_rows = self._conn.execute(
                "SELECT path FROM directories").fetchall()
        for (path,) in dir_rows:
            full = os.path.join(local_dir, path)
            if not os.path.exists(full):
                issues.append((path, "orphan_dir", "本地目录不存在"))
                if auto_fix:
                    self.remove_dir(path)

        if auto_fix and issues:
            self.save()
        return issues
