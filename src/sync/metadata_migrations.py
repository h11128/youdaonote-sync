"""
元数据 schema 迁移和数据修正

从 metadata.py 提取，减少主类体积。所有函数接受 sqlite3.Connection
作为参数，不依赖 SyncMetadata 实例。
"""

import json
import logging
import os
import sqlite3
import time
from typing import Callable, Optional

from src.sync.utils import sanitize_filename


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
    "ALTER TABLE files ADD COLUMN cloud_content_hash TEXT",
    "ALTER TABLE directories ADD COLUMN tree_hash TEXT",
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
    """CREATE TABLE IF NOT EXISTS file_refs (
        source_path TEXT NOT NULL,
        ref_path TEXT NOT NULL,
        PRIMARY KEY (source_path, ref_path)
    )""",
    """CREATE TABLE IF NOT EXISTS file_base (
        path TEXT PRIMARY KEY,
        content BLOB NOT NULL,
        hash TEXT NOT NULL,
        saved_at INTEGER NOT NULL
    )""",
    "UPDATE files SET content_hash = NULL WHERE content_hash IS NOT NULL",
    """CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )""",
    "ALTER TABLE files ADD COLUMN original_domain INTEGER",
]


def init_schema(conn: sqlite3.Connection) -> None:
    """创建初始表结构。"""
    conn.executescript(_SCHEMA_SQL)
    conn.commit()


def run_migrations(conn: sqlite3.Connection) -> None:
    """运行增量 schema 迁移（幂等，已有列/表时自动跳过）。"""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _migrations "
        "(idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
    applied = {r[0] for r in conn.execute(
        "SELECT idx FROM _migrations").fetchall()}

    _EXPECTED_ERRORS = ("duplicate column", "already exists")

    for i, sql in enumerate(_MIGRATION_SQL):
        if i in applied:
            continue
        try:
            conn.execute(sql)
        except sqlite3.OperationalError as e:
            err_msg = str(e).lower()
            if not any(phrase in err_msg for phrase in _EXPECTED_ERRORS):
                logging.error(f"迁移 #{i} 失败(非预期错误): {e}")
                raise
        conn.execute(
            "INSERT OR IGNORE INTO _migrations (idx, applied_at) VALUES (?, ?)",
            (i, int(time.time())))
    conn.commit()


def migrate_json_if_needed(conn: sqlite3.Connection,
                           json_path: str) -> None:
    """检测旧 JSON 文件并自动导入到 SQLite。"""
    if not os.path.exists(json_path):
        return
    row = conn.execute("SELECT COUNT(*) FROM files").fetchone()
    if row and row[0] > 0:
        return

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logging.warning(f"迁移 JSON 元数据失败: {e}")
        return

    files = data.get("files", {})
    dirs = data.get("directories", {})

    for path, info in files.items():
        conn.execute(
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
        conn.execute(
            "INSERT OR IGNORE INTO directories (path, dir_id, parent_id) VALUES (?, ?, ?)",
            (path, info.get("dir_id", ""), info.get("parent_id", "")),
        )

    conn.commit()

    backup = json_path + ".bak"
    try:
        os.replace(json_path, backup)
        logging.info(f"JSON 元数据已迁移到 SQLite，旧文件: {backup}")
    except OSError:
        pass


_NORM_PATHS_FLAG = "paths_normalized_v1"


def normalize_stored_paths(conn: sqlite3.Connection,
                           get_state: Callable[[str], Optional[str]],
                           set_state: Callable[[str, str], None]) -> None:
    """One-time migration: strip trailing whitespace from path stems."""
    if get_state(_NORM_PATHS_FLAG):
        return

    renamed = 0
    for table in ("files", "directories"):
        rows = conn.execute(f"SELECT path FROM {table}").fetchall()
        for (old_path,) in rows:
            parts = old_path.rsplit("/", 1)
            basename = parts[-1] if len(parts) > 1 else parts[0]
            prefix = parts[0] + "/" if len(parts) > 1 else ""
            stem, ext = os.path.splitext(basename)
            new_stem = stem.rstrip()
            if new_stem == stem:
                continue
            new_path = prefix + new_stem + ext
            existing = conn.execute(
                f"SELECT 1 FROM {table} WHERE path = ?", (new_path,)
            ).fetchone()
            if existing:
                conn.execute(
                    f"DELETE FROM {table} WHERE path = ?", (old_path,))
            else:
                conn.execute(
                    f"UPDATE {table} SET path = ? WHERE path = ?",
                    (new_path, old_path))
            renamed += 1

    set_state(_NORM_PATHS_FLAG, "1")
    if renamed > 0:
        set_state("last_cloud_version", "0")
        logging.info(
            f"路径规范化迁移: 修正了 {renamed} 条路径，已失效扫描缓存")
    conn.commit()


_NORM_CHARS_FLAG = "paths_normalized_v2"


def normalize_stored_chars(conn: sqlite3.Connection,
                           get_state: Callable[[str], Optional[str]],
                           set_state: Callable[[str, str], None]) -> None:
    """One-time migration: sanitize forbidden characters in stored path basenames."""
    if get_state(_NORM_CHARS_FLAG):
        return

    renamed = 0
    for table in ("files", "directories"):
        rows = conn.execute(f"SELECT path FROM {table}").fetchall()
        for (old_path,) in rows:
            parts = old_path.rsplit("/", 1)
            basename = parts[-1] if len(parts) > 1 else parts[0]
            prefix = parts[0] + "/" if len(parts) > 1 else ""
            new_basename = sanitize_filename(basename)
            if new_basename == basename:
                continue
            new_path = prefix + new_basename
            existing = conn.execute(
                f"SELECT 1 FROM {table} WHERE path = ?", (new_path,)
            ).fetchone()
            if existing:
                conn.execute(
                    f"DELETE FROM {table} WHERE path = ?", (old_path,))
            else:
                conn.execute(
                    f"UPDATE {table} SET path = ? WHERE path = ?",
                    (new_path, old_path))
            renamed += 1

    set_state(_NORM_CHARS_FLAG, "1")
    if renamed > 0:
        set_state("last_cloud_version", "0")
        logging.info(
            f"路径字符规范化: 修正了 {renamed} 条路径，已失效扫描缓存")
    conn.commit()


def run_all_migrations(conn: sqlite3.Connection,
                       json_path: str,
                       get_state: Callable[[str], Optional[str]],
                       set_state: Callable[[str, str], None]) -> None:
    """按顺序执行所有迁移步骤（供 SyncMetadata.__init__ 调用）。"""
    init_schema(conn)
    run_migrations(conn)
    migrate_json_if_needed(conn, json_path)
    normalize_stored_paths(conn, get_state, set_state)
    normalize_stored_chars(conn, get_state, set_state)
