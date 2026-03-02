"""
元数据健康检查：gc / verify / heal

从 SyncMetadata 提取的独立函数，通过 meta._conn / meta._lock 访问数据库。
SyncMetadata 保留同名委托方法，保持公共 API 不变。
"""

import logging
import os
import time
from typing import Dict, List, Tuple, TYPE_CHECKING

from src.sync.utils import VerifyIssueType

if TYPE_CHECKING:
    from src.sync.metadata import SyncMetadata


def gc(meta: "SyncMetadata", local_dir: str,
       max_log_age_days: int = 90) -> Dict[str, int]:
    """清理过期和孤儿元数据记录。

    :return: {"files": n, "dirs": n, "logs": n, "bases": n}
    """
    stats = {"files": 0, "dirs": 0, "logs": 0, "bases": 0}
    cutoff = int(time.time()) - 30 * 86400
    log_cutoff = int(time.time()) - max_log_age_days * 86400

    with meta._lock:
        conn = meta._conn

        rows = conn.execute(
            "SELECT path FROM files WHERE last_sync_at > 0 AND last_sync_at < ?",
            (cutoff,),
        ).fetchall()
        for row in rows:
            if not os.path.exists(os.path.join(local_dir, row["path"])):
                conn.execute("DELETE FROM files WHERE path = ?", (row["path"],))
                stats["files"] += 1

        rows = conn.execute("SELECT path FROM directories").fetchall()
        for row in rows:
            if not os.path.exists(os.path.join(local_dir, row["path"])):
                conn.execute("DELETE FROM directories WHERE path = ?", (row["path"],))
                stats["dirs"] += 1

        cur = conn.execute(
            "DELETE FROM sync_log WHERE timestamp < ?", (log_cutoff,))
        stats["logs"] = cur.rowcount

        rows = conn.execute("SELECT path FROM file_base").fetchall()
        for row in rows:
            if not os.path.exists(os.path.join(local_dir, row["path"])):
                conn.execute("DELETE FROM file_base WHERE path = ?", (row["path"],))
                stats["bases"] += 1

        rows = conn.execute(
            "SELECT DISTINCT source_path FROM file_refs").fetchall()
        for row in rows:
            if not os.path.exists(os.path.join(local_dir, row["source_path"])):
                conn.execute(
                    "DELETE FROM file_refs WHERE source_path = ?",
                    (row["source_path"],))

        conn.commit()

    if any(v > 0 for v in stats.values()):
        logging.info(
            "GC 清理: files=%d, dirs=%d, logs=%d, bases=%d",
            stats["files"], stats["dirs"], stats["logs"], stats["bases"])
    return stats


def verify(meta: "SyncMetadata", local_dir: str,
           auto_fix: bool = False) -> List[Tuple[str, VerifyIssueType, str]]:
    """校验元数据与本地文件的一致性。

    :return: [(path, issue_type, detail), ...]
    """
    from src.sync.utils import compute_content_hash
    issues: List[Tuple[str, VerifyIssueType, str]] = []

    with meta._lock:
        rows = meta._conn.execute(
            "SELECT path, file_id, content_hash FROM files"
        ).fetchall()

    for row in rows:
        path, file_id, meta_hash = row["path"], row["file_id"], row["content_hash"]
        full = os.path.join(local_dir, path)
        if not os.path.exists(full):
            if file_id:
                issues.append((path, VerifyIssueType.ORPHAN,
                               "本地文件不存在但有 file_id"))
            continue
        if meta_hash:
            actual = compute_content_hash(full)
            if actual and actual != meta_hash:
                issues.append((path, VerifyIssueType.HASH_MISMATCH,
                               f"记录={meta_hash[:16]}.. 实际={actual[:16]}.."))
                if auto_fix:
                    meta.update_content_hash(path, actual)

    with meta._lock:
        dir_rows = meta._conn.execute(
            "SELECT path FROM directories").fetchall()
    for row in dir_rows:
        path = row["path"]
        full = os.path.join(local_dir, path)
        if not os.path.exists(full):
            issues.append((path, VerifyIssueType.ORPHAN_DIR,
                           "本地目录不存在"))
            if auto_fix:
                meta.remove_dir(path)

    if auto_fix and issues:
        meta.save()
    return issues


def heal(meta: "SyncMetadata", local_dir: str,
         auto_fix: bool = False) -> Dict[str, int]:
    """Lightweight self-healing pass run before each sync.

    Detects and optionally repairs common metadata inconsistencies:

    1. **local_mtime drift** -- os.path.getmtime differs from metadata
       but content_hash is unchanged -> silently update local_mtime.
    2. **orphan records** -- metadata row exists but local file is missing
       and there is no file_id (pure local stub) -> delete row.
    3. **cloud_mtime = 0** -- legacy migration leftover -> log warning.
    4. **content_hash missing** -- has file_id and local_mtime > 0
       but no hash -> compute and backfill.

    :param auto_fix: When False only reports; when True writes fixes.
    :return: {"mtime_drift": n, "orphan": n, "zero_cloud": n, "hash_backfill": n}
    """
    from src.sync.utils import compute_content_hash

    stats = {"mtime_drift": 0, "orphan": 0, "zero_cloud": 0, "hash_backfill": 0}

    with meta._lock:
        rows = meta._conn.execute(
            "SELECT path, file_id, cloud_mtime, local_mtime, content_hash "
            "FROM files"
        ).fetchall()

    for row in rows:
        path = row["path"]
        file_id = row["file_id"]
        cloud_mtime = row["cloud_mtime"]
        local_mtime = row["local_mtime"]
        meta_hash = row["content_hash"]

        full = os.path.join(local_dir, path)
        exists = os.path.exists(full)

        if not exists and not file_id:
            stats["orphan"] += 1
            if auto_fix:
                meta.remove_file_info(path)
            continue

        if not exists:
            continue

        actual_mtime = int(os.path.getmtime(full))

        if local_mtime and actual_mtime != local_mtime and meta_hash:
            actual_hash = compute_content_hash(full)
            if actual_hash and actual_hash == meta_hash:
                stats["mtime_drift"] += 1
                if auto_fix:
                    with meta._lock:
                        meta._conn.execute(
                            "UPDATE files SET local_mtime = ? WHERE path = ?",
                            (actual_mtime, path),
                        )

        if cloud_mtime == 0 and file_id:
            stats["zero_cloud"] += 1
            if not auto_fix:
                logging.debug("heal: cloud_mtime=0 for %s", path)

        if (not meta_hash and file_id and local_mtime > 0
                and actual_mtime == local_mtime):
            actual_hash = compute_content_hash(full)
            if actual_hash:
                stats["hash_backfill"] += 1
                if auto_fix:
                    meta.update_content_hash(path, actual_hash)

    if auto_fix:
        meta.save()

    total = sum(stats.values())
    if total > 0:
        logging.info(
            "heal(%s): mtime_drift=%d, orphan=%d, zero_cloud=%d, hash_backfill=%d",
            "fix" if auto_fix else "check",
            stats["mtime_drift"], stats["orphan"],
            stats["zero_cloud"], stats["hash_backfill"],
        )
    return stats
