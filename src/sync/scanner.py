"""
云端/本地文件扫描

提供 scan_cloud() / async_scan_cloud() / scan_local() 三个入口，
以及 map_cloud_name() 统一路径映射逻辑。
"""

import asyncio
import fnmatch
import os
import logging
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, TYPE_CHECKING

import httpx

from src.common import normalize_sep

if TYPE_CHECKING:
    from src.protocols import DirBrowser

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


def scan_cloud(api: "DirBrowser", dir_id: str, base: str = "",
               workers: int = DEFAULT_SCAN_WORKERS) -> Dict[str, Dict]:
    """并发获取云端文件列表（BFS + 线程池）。

    返回 {relative_path: info_dict}，relative_path 已经过 map_cloud_name 映射。
    """
    if not dir_id:
        raise ValueError("dir_id 不能为空")
    files: Dict[str, Dict] = {}
    files_lock = threading.Lock()

    def _fetch_dir(did: str, bpath: str) -> tuple:
        """获取一个目录的内容，返回 (子目录列表, 本目录文件 dict)"""
        subdirs = []
        local_batch: Dict[str, Dict] = {}
        try:
            entries = api.get_dir_info_by_id(did).get("entries", [])
        except Exception as e:
            logging.error(f"获取云端目录失败: {bpath} - {e}")
            return subdirs, local_batch

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
                local_batch[rel] = info
                subdirs.append((info["id"], rel))
            else:
                local_name = map_cloud_name(name)
                local_rel = f"{bpath}/{local_name}".lstrip("/") if bpath else local_name
                local_batch[local_rel] = info

        with files_lock:
            files.update(local_batch)
        return subdirs, local_batch

    # Queue-based BFS：worker 空闲时立即取下一个目录，无层级等待
    q: queue.Queue = queue.Queue()
    pending = threading.Semaphore(0)
    active = [1]  # 活跃任务计数（用 list 以便在闭包中修改）
    active_lock = threading.Lock()
    visited: set = {dir_id}

    def _worker():
        while True:
            pending.acquire()
            item = q.get()
            if item is None:
                q.task_done()
                break
            did, bpath = item
            try:
                subdirs, _ = _fetch_dir(did, bpath)
                new_dirs = []
                with active_lock:
                    for sd_id, sd_path in subdirs:
                        if sd_id not in visited:
                            visited.add(sd_id)
                            new_dirs.append((sd_id, sd_path))
                    active[0] += len(new_dirs)
                for sd in new_dirs:
                    q.put(sd)
                    pending.release()
            except Exception as e:
                logging.error(f"扫描目录异常: {bpath} - {e}")
            finally:
                with active_lock:
                    active[0] -= 1
                    done = active[0] == 0
                q.task_done()
                if done:
                    for _ in range(workers):
                        q.put(None)
                        pending.release()

    q.put((dir_id, base))
    pending.release()

    threads = []
    for _ in range(workers):
        t = threading.Thread(target=_worker, daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join()

    return files


async def async_scan_cloud(
    client: httpx.AsyncClient,
    dir_url_template: str,
    page_size: int,
    cstk: str,
    dir_id: str,
    base: str = "",
    max_concurrent: int = DEFAULT_SCAN_WORKERS,
) -> Dict[str, Dict]:
    """异步并发获取云端文件列表（BFS + asyncio.Semaphore）。

    与 scan_cloud() 返回格式完全一致，但使用 httpx.AsyncClient 实现真正的异步 I/O。

    :param client: httpx.AsyncClient 实例
    :param dir_url_template: 目录列表 URL 模板（含 {dir_id}, {page_size}, {cstk}）
    :param page_size: 每页条目数
    :param cstk: 认证 token
    :param dir_id: 根目录 ID
    :param base: 路径前缀
    :param max_concurrent: 最大并发数
    """
    if not dir_id:
        raise ValueError("dir_id 不能为空")

    files: Dict[str, Dict] = {}
    sem = asyncio.Semaphore(max_concurrent)
    max_pages = 50

    async def _fetch_dir(did: str, bpath: str) -> List[tuple]:
        """获取一个目录的全部内容（自动分页 + 去重），返回子目录列表。"""
        subdirs: List[tuple] = []
        seen_ids: set = set()
        offset = 0

        for _ in range(max_pages):
            async with sem:
                url = dir_url_template.format(dir_id=did, page_size=page_size, cstk=cstk)
                if offset > 0:
                    url += f"&startIndex={offset}"
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    data = resp.json()
                except Exception as e:
                    logging.error(f"获取云端目录失败: {bpath} - {e}")
                    break

            entries = data.get("entries", [])
            total = data.get("count", 0)
            if not entries:
                break

            new_count = 0
            for entry in entries:
                fe = entry.get("fileEntry", {})
                eid = fe.get("id", "")
                if not eid or eid in seen_ids:
                    continue
                seen_ids.add(eid)
                new_count += 1

                name = fe.get("name", "")
                if name.startswith("."):
                    continue

                rel = f"{bpath}/{name}".lstrip("/") if bpath else name
                info = {
                    "id": eid,
                    "parent_id": did,
                    "name": name,
                    "is_dir": fe.get("dir", False),
                    "mtime": fe.get("modifyTimeForSort", 0),
                    "ctime": fe.get("createTimeForSort", 0),
                    "domain": fe.get("domain", 1),
                }

                if info["is_dir"]:
                    files[rel] = info
                    subdirs.append((eid, rel))
                else:
                    local_name = map_cloud_name(name)
                    local_rel = f"{bpath}/{local_name}".lstrip("/") if bpath else local_name
                    files[local_rel] = info

            offset += len(entries)
            if new_count == 0 or len(seen_ids) >= total or len(entries) < page_size:
                break

        return subdirs

    # BFS: 逐层并发扫描（visited 防止循环引用导致死循环）
    visited: set = {dir_id}
    pending = [(dir_id, base)]
    while pending:
        tasks = [_fetch_dir(did, bp) for did, bp in pending]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        pending = []
        for result in results:
            if isinstance(result, BaseException):
                logging.error(f"扫描目录异常: {result}")
                continue
            for sub_id, sub_path in result:
                if sub_id not in visited:
                    visited.add(sub_id)
                    pending.append((sub_id, sub_path))

    return files


def matches_selective(rel_path: str, include: List[str], exclude: List[str]) -> bool:
    """检查路径是否通过选择性同步过滤。"""
    if exclude:
        for pat in exclude:
            if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(rel_path, f"**/{pat}"):
                return False
    if include:
        for pat in include:
            if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(rel_path, f"**/{pat}"):
                return True
        return False
    return True


def scan_local(local_dir: str, base_path: str = "",
               sync_include: List[str] = None,
               sync_exclude: List[str] = None) -> Dict[str, Dict]:
    """扫描本地目录（顶层子目录并行）。

    路径映射规则与 scan_cloud 保持一致：
    - .note/.clip/无扩展名 → 映射为 .md（这些格式下载后会转成 .md）
    - 当 .note 和 .md 同时存在时，.md 版本优先
    - images/ 和 attachments/ 目录是下载转换的产物，云端无对应路径，跳过
    """
    if not local_dir:
        raise ValueError("local_dir 不能为空")
    scan_dir = os.path.join(local_dir, base_path) if base_path else local_dir
    if not os.path.exists(scan_dir):
        return {}

    # 列出顶层条目
    try:
        top_entries = list(os.scandir(scan_dir))
    except OSError:
        return {}

    top_dirs = []
    root_files: Dict[str, Dict] = {}

    for entry in top_entries:
        if entry.name.startswith("."):
            continue
        if entry.is_dir(follow_symlinks=False):
            if entry.name in LOCAL_ARTIFACT_DIRS:
                continue
            rel = normalize_sep(os.path.relpath(entry.path, local_dir))
            root_files[rel] = {"path": entry.path, "is_dir": True,
                               "mtime": int(entry.stat().st_mtime)}
            top_dirs.append(entry.path)
        elif entry.is_file(follow_symlinks=False):
            if ".conflict." in entry.name:
                continue
            _add_local_file(entry.path, entry.name, local_dir, root_files)

    if not top_dirs:
        return root_files

    # 每个顶层子目录在独立线程中 os.walk
    results = [root_files]
    results_lock = threading.Lock()

    def _walk_subdir(subdir: str):
        partial: Dict[str, Dict] = {}
        _scandir_recursive(subdir, local_dir, partial)
        with results_lock:
            results.append(partial)

    workers = min(len(top_dirs), os.cpu_count() or 4, 8)
    if workers <= 1:
        for sd in top_dirs:
            _walk_subdir(sd)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(_walk_subdir, sd) for sd in top_dirs]
            for fut in futs:
                try:
                    fut.result()
                except Exception as e:
                    logging.error(f"本地扫描异常: {e}")

    files: Dict[str, Dict] = {}
    for partial in results:
        files.update(partial)

    if sync_include or sync_exclude:
        inc = sync_include or []
        exc = sync_exclude or []
        files = {k: v for k, v in files.items()
                 if matches_selective(k, inc, exc)}

    return files


def _scandir_recursive(dirpath: str, local_dir: str,
                       target: Dict[str, Dict]) -> None:
    """用 os.scandir 递归遍历目录，利用 DirEntry stat 缓存减少系统调用。"""
    try:
        entries = list(os.scandir(dirpath))
    except OSError:
        return
    for entry in entries:
        if entry.name.startswith("."):
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                if entry.name in LOCAL_ARTIFACT_DIRS:
                    continue
                rel = normalize_sep(os.path.relpath(entry.path, local_dir))
                st = entry.stat(follow_symlinks=False)
                target[rel] = {"path": entry.path, "is_dir": True,
                               "mtime": int(st.st_mtime)}
                _scandir_recursive(entry.path, local_dir, target)
            elif entry.is_file(follow_symlinks=False):
                if ".conflict." in entry.name:
                    continue
                _add_local_file_from_entry(entry, local_dir, target)
        except OSError:
            continue


def _add_local_file_from_entry(entry: os.DirEntry, local_dir: str,
                               target: Dict[str, Dict]) -> None:
    """将一个 DirEntry 文件加入扫描结果（利用缓存的 stat）。"""
    name = entry.name
    _, ext = os.path.splitext(name)
    mapped_name = map_cloud_name(name)
    rel = normalize_sep(os.path.relpath(
        os.path.join(os.path.dirname(entry.path), mapped_name), local_dir
    ))
    if rel in target and ext in (".note", ".clip"):
        return
    try:
        st = entry.stat(follow_symlinks=False)
    except OSError:
        return
    target[rel] = {"path": entry.path, "is_dir": False,
                   "mtime": int(st.st_mtime), "size": st.st_size}


def _add_local_file(path: str, name: str, local_dir: str,
                    target: Dict[str, Dict]) -> None:
    """将一个本地文件加入扫描结果 dict。"""
    _, ext = os.path.splitext(name)
    mapped_name = map_cloud_name(name)
    rel = normalize_sep(os.path.relpath(
        os.path.join(os.path.dirname(path), mapped_name), local_dir
    ))
    if rel in target and ext in (".note", ".clip"):
        return
    try:
        st = os.stat(path)
    except OSError:
        return
    target[rel] = {"path": path, "is_dir": False,
                   "mtime": int(st.st_mtime), "size": st.st_size}
