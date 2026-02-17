"""
云端/本地文件扫描

提供 scan_cloud() 和 scan_local() 两个入口，
以及 map_cloud_name() 统一路径映射逻辑。
"""

import os
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List

from src.api import YoudaoNoteApi

# 本地下载转换过程中产生的资源目录，云端不存在对应路径
LOCAL_ARTIFACT_DIRS = {"images", "attachments"}

# 默认扫描并发数
DEFAULT_SCAN_WORKERS = 8


def map_cloud_name(name: str) -> str:
    """将云端文件名映射为本地文件名。

    .note/.clip/无扩展名 → 加 .md 后缀（下载后会转成 markdown）。
    其他扩展名保持不变。
    """
    _, ext = os.path.splitext(name)
    if ext in (".note", ".clip") or ext == "":
        return (name[:-len(ext)] if ext else name) + ".md"
    return name


def scan_cloud(api: YoudaoNoteApi, dir_id: str, base: str = "",
               workers: int = DEFAULT_SCAN_WORKERS) -> Dict[str, Dict]:
    """并发获取云端文件列表（BFS + 线程池）。

    返回 {relative_path: info_dict}，relative_path 已经过 map_cloud_name 映射。
    """
    if not dir_id:
        raise ValueError("dir_id 不能为空")
    files: Dict[str, Dict] = {}
    files_lock = threading.Lock()

    def _fetch_dir(did: str, bpath: str) -> List[tuple]:
        """获取一个目录的内容，返回子目录列表 [(dir_id, rel_path)]"""
        subdirs = []
        try:
            entries = api.get_dir_info_by_id(did).get("entries", [])
        except Exception as e:
            logging.error(f"获取云端目录失败: {bpath} - {e}")
            return subdirs

        for entry in entries:
            fe = entry.get("fileEntry", {})
            name = fe.get("name", "")
            if name.startswith("."):
                continue

            rel = f"{bpath}/{name}".lstrip("/") if bpath else name
            info = {
                "id": fe.get("id", ""),
                "parent_id": did,
                "name": name,
                "is_dir": fe.get("dir", False),
                "mtime": fe.get("modifyTimeForSort", 0),
                "ctime": fe.get("createTimeForSort", 0),
                "domain": fe.get("domain", 1),
            }

            if info["is_dir"]:
                with files_lock:
                    files[rel] = info
                subdirs.append((info["id"], rel))
            else:
                local_name = map_cloud_name(name)
                local_rel = f"{bpath}/{local_name}".lstrip("/") if bpath else local_name
                with files_lock:
                    files[local_rel] = info

        return subdirs

    # BFS：用线程池并行展开每一层目录
    current_level = [(dir_id, base)]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        while current_level:
            futures = {pool.submit(_fetch_dir, did, bp): (did, bp)
                       for did, bp in current_level}
            next_level = []
            for fut in as_completed(futures):
                try:
                    next_level.extend(fut.result())
                except Exception as e:
                    did, bp = futures[fut]
                    logging.error(f"扫描目录异常: {bp} - {e}")
            current_level = next_level

    return files


def scan_local(local_dir: str, base_path: str = "") -> Dict[str, Dict]:
    """扫描本地目录。

    路径映射规则与 scan_cloud 保持一致：
    - .note/.clip/无扩展名 → 映射为 .md（这些格式下载后会转成 .md）
    - 当 .note 和 .md 同时存在时，.md 版本优先
    - images/ 和 attachments/ 目录是下载转换的产物，云端无对应路径，跳过
    """
    if not local_dir:
        raise ValueError("local_dir 不能为空")
    files: Dict[str, Dict] = {}
    scan_dir = os.path.join(local_dir, base_path) if base_path else local_dir
    if not os.path.exists(scan_dir):
        return files

    for root, dirs, filenames in os.walk(scan_dir):
        dirs[:] = [d for d in dirs
                   if not d.startswith(".")
                   and d not in LOCAL_ARTIFACT_DIRS]
        for d in dirs:
            p = os.path.join(root, d)
            rel = os.path.relpath(p, local_dir).replace("\\", "/")
            files[rel] = {"path": p, "is_dir": True,
                          "mtime": int(os.path.getmtime(p))}
        for f in filenames:
            if f.startswith(".") or ".conflict." in f:
                continue
            p = os.path.join(root, f)
            _, ext = os.path.splitext(f)

            # 与 scan_cloud 相同的路径映射
            mapped_name = map_cloud_name(f)

            rel = os.path.relpath(
                os.path.join(root, mapped_name), local_dir
            ).replace("\\", "/")

            # .md 文件优先于 .note/.clip 原始文件
            if rel in files and ext in (".note", ".clip"):
                continue

            files[rel] = {"path": p, "is_dir": False,
                          "mtime": int(os.path.getmtime(p))}
    return files
