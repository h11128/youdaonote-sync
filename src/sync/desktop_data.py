"""有道云笔记桌面客户端本地数据读取。

提供两个可选能力：
1. 冷启动种子 — 首次运行时从桌面 DB 导入文件元数据到 sync_metadata.db
2. domain=0 文件本地读取 — 省一次 HTTP 下载
"""

import logging
import os
import platform
import sqlite3
from typing import Optional, Dict, Tuple

from src.common import FileId
from src.sync.scanner import map_cloud_name

logger = logging.getLogger(__name__)


def find_desktop_data_dir() -> Optional[str]:
    """定位桌面客户端的 ynote-data 目录。

    桌面客户端的数据目录结构：
      %APPDATA%/ynote-desktop/<user>/ynote-data/
    其中 <user> 是邮箱地址，通过遍历 ynote-desktop 下的子目录来发现。
    """
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA", "")
    elif system == "Darwin":
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.path.expanduser("~/.config")

    ynote_dir = os.path.join(base, "ynote-desktop")
    if not os.path.isdir(ynote_dir):
        return None

    for entry in os.listdir(ynote_dir):
        data_dir = os.path.join(ynote_dir, entry, "ynote-data")
        if os.path.isdir(data_dir):
            db_candidates = [f for f in os.listdir(data_dir)
                             if f.endswith(".db") and not f.endswith("-content.db")
                             and not f.endswith("-search.db")]
            if db_candidates:
                return data_dir
    return None


def find_desktop_db(data_dir: str) -> Optional[str]:
    """在 ynote-data 目录中找到主 SQLite 数据库文件。"""
    if not data_dir or not os.path.isdir(data_dir):
        return None
    for f in os.listdir(data_dir):
        if f.endswith(".db") and not f.endswith("-content.db") \
                and not f.endswith("-search.db"):
            path = os.path.join(data_dir, f)
            if os.path.isfile(path):
                return path
    return None


def _build_path_map(conn: sqlite3.Connection) -> Dict[str, str]:
    """从 note_book 表构建 folder_id → 路径 映射。

    note_book 表的 parentId 形成一棵树，根节点的 parentId 是空或指向自身。
    """
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='note_book'")
    if not cur.fetchone():
        return {}

    cur.execute("""SELECT fileId, title, parentId FROM note_book
                   WHERE del = 0 OR del IS NULL""")
    folders = {}
    for fid, title, pid in cur.fetchall():
        folders[fid] = {"title": title or "", "parent_id": pid or ""}

    path_cache: Dict[str, str] = {}

    def resolve(fid: str, depth: int = 0) -> str:
        if fid in path_cache:
            return path_cache[fid]
        if depth > 50 or fid not in folders:
            return ""
        info = folders[fid]
        pid = info["parent_id"]
        if not pid or pid == fid:
            path_cache[fid] = ""
            return ""
        parent_path = resolve(pid, depth + 1)
        path = f"{parent_path}/{info['title']}" if parent_path else info["title"]
        path_cache[fid] = path
        return path

    for fid in folders:
        resolve(fid)

    return path_cache


def seed_metadata_from_desktop(metadata, data_dir: str = None) -> int:
    """从桌面客户端 DB 导入文件和目录元数据（冷启动种子）。

    :param metadata: SyncMetadata 实例
    :param data_dir: ynote-data 目录，为 None 时自动发现
    :return: 导入的条目数
    """
    if not data_dir:
        data_dir = find_desktop_data_dir()
    if not data_dir:
        logger.debug("桌面客户端数据目录未找到")
        return 0

    db_path = find_desktop_db(data_dir)
    if not db_path:
        logger.debug("桌面客户端数据库未找到")
        return 0

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error as e:
        logger.warning(f"打开桌面数据库失败: {e}")
        return 0

    try:
        folder_paths = _build_path_map(conn)
        cur = conn.cursor()
        count = 0

        with metadata.batch():
            for fid, path in folder_paths.items():
                if path:
                    cur.execute(
                        "SELECT parentId FROM note_book WHERE fileId = ?", (fid,))
                    row = cur.fetchone()
                    parent_id = row["parentId"] if row else ""
                    metadata.set_dir_info(path, fid, parent_id)
                    count += 1

            cur.execute("""SELECT fileId, title, parentId, modifyTime,
                                  createTime, domain, version
                           FROM note WHERE del = 0 AND dir = 0""")
            for row in cur.fetchall():
                fid = row["fileId"]
                parent_id = row["parentId"] or ""
                folder_path = folder_paths.get(parent_id, "")
                title = row["title"] or ""

                local_name = map_cloud_name(title)
                rel_path = f"{folder_path}/{local_name}" if folder_path else local_name

                mtime = row["modifyTime"] or 0
                if mtime > 1_000_000_000_000:
                    mtime = mtime // 1000

                ctime = row["createTime"] or 0
                if ctime > 1_000_000_000_000:
                    ctime = ctime // 1000

                metadata.set_file_info(
                    local_path=rel_path,
                    file_id=fid,
                    cloud_mtime=mtime,
                    parent_id=parent_id,
                    domain=row["domain"],
                    create_time=ctime,
                )
                count += 1

            if count > 0:
                max_version = 0
                cur.execute("SELECT MAX(version) FROM note WHERE del = 0")
                r = cur.fetchone()
                if r and r[0]:
                    max_version = r[0]
                metadata.set_state("last_cloud_version", str(max_version))

        metadata.save()
        logger.info(f"从桌面客户端导入 {count} 条元数据 (种子)")
        return count

    except sqlite3.Error as e:
        logger.warning(f"读取桌面数据库失败: {e}")
        return 0
    finally:
        conn.close()


def read_desktop_file(file_id: FileId, data_dir: str = None) -> Optional[bytes]:
    """从桌面客户端本地缓存读取 domain=0 文件内容。

    桌面客户端将 domain=0 文件的 XML 存储在 file/<bucket>/<fileId>。
    bucket 是 fileId 首字符的小写。

    :return: 文件字节内容，未找到时返回 None
    """
    if not file_id:
        return None

    if not data_dir:
        data_dir = find_desktop_data_dir()
    if not data_dir:
        return None

    bucket = file_id[0].lower()
    path = os.path.join(data_dir, "file", bucket, file_id)
    if not os.path.isfile(path):
        return None

    try:
        with open(path, "rb") as f:
            content = f.read()
        if content:
            logger.debug(f"从桌面缓存读取: {file_id} ({len(content)} bytes)")
        return content
    except OSError as e:
        logger.debug(f"读取桌面缓存文件失败: {file_id} - {e}")
        return None
