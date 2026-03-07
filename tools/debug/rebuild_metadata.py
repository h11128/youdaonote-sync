"""
补全同步元数据

逻辑：
1. 扫描云端完整目录树，拿到 path → {file_id, mtime, ctime, parent_id, domain}
2. 扫描本地文件，拿到 path → {mtime, content_hash}
3. 按路径匹配：
   - 云端+本地都有 → 更新/补全元数据
   - 只有云端 → 记录 file_id 和 cloud_mtime（方便下次 sync 判断）
   - 只有本地 → 记录 local_mtime（方便下次 sync 判断）
   - .conflict 文件 → 跳过，不写入元数据
4. 补全目录元数据

用法: python .local-scripts/rebuild_metadata.py [--dry-run]
"""

import os
import sys
import logging
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.metadata import SyncMetadata
from src.sync.utils import compute_content_hash

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

LOCAL_DIR = "E:/Projects/notes"
SCAN_WORKERS = 8


def scan_cloud(api: YoudaoNoteApi) -> dict:
    """BFS 扫描云端目录树，返回 {rel_path: info_dict}"""
    cloud_files = {}
    cloud_dirs = {}

    root_id = api.get_root_id()

    def fetch_dir(dir_id, base_path):
        subdirs = []
        try:
            entries = api.get_dir_info_by_id(dir_id).get("entries", [])
        except Exception as e:
            logging.error(f"获取目录失败 {base_path}: {e}")
            return subdirs

        for entry in entries:
            fe = entry.get("fileEntry", {})
            name = fe.get("name", "")
            if not name or name.startswith("."):
                continue

            rel = f"{base_path}/{name}".lstrip("/") if base_path else name
            info = {
                "id": fe.get("id", ""),
                "parent_id": dir_id,
                "name": name,
                "mtime": fe.get("modifyTimeForSort", 0),
                "ctime": fe.get("createTimeForSort", 0),
                "domain": fe.get("domain", 1),
                "is_dir": fe.get("dir", False),
            }

            if info["is_dir"]:
                cloud_dirs[rel] = info
                subdirs.append((info["id"], rel))
            else:
                # .note → .md 路径映射（和 sync.py 一致）
                local_name = name[:-5] + ".md" if name.endswith(".note") else name
                local_rel = f"{base_path}/{local_name}".lstrip("/") if base_path else local_name
                cloud_files[local_rel] = info

        return subdirs

    # BFS
    current_level = [(root_id, "")]
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        while current_level:
            futures = {pool.submit(fetch_dir, did, bp): (did, bp) for did, bp in current_level}
            next_level = []
            for fut in as_completed(futures):
                try:
                    next_level.extend(fut.result())
                except Exception as e:
                    logging.error(f"扫描异常: {e}")
            current_level = next_level

    return cloud_files, cloud_dirs


def scan_local(local_dir: str) -> dict:
    """扫描本地文件，返回 {rel_path: {mtime, is_dir}}"""
    local_files = {}
    local_dirs = {}

    for root, dirs, files in os.walk(local_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for d in dirs:
            p = os.path.join(root, d)
            rel = os.path.relpath(p, local_dir).replace("\\", "/")
            local_dirs[rel] = {"mtime": int(os.path.getmtime(p))}
        for f in files:
            if f.startswith("."):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, local_dir).replace("\\", "/")
            local_files[rel] = {
                "path": p,
                "mtime": int(os.path.getmtime(p)),
                "is_conflict": ".conflict." in f,
            }

    return local_files, local_dirs


def main():
    parser = argparse.ArgumentParser(description="补全同步元数据")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    args = parser.parse_args()

    # 初始化 API
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        return 1

    meta = SyncMetadata()
    existing_files = meta.get_all_files()
    existing_dirs = meta.get_all_dirs()

    # 扫描
    print("扫描云端...")
    cloud_files, cloud_dirs = scan_cloud(api)
    print(f"  云端文件: {len(cloud_files)}, 目录: {len(cloud_dirs)}")

    print("扫描本地...")
    local_files, local_dirs = scan_local(LOCAL_DIR)
    print(f"  本地文件: {len(local_files)}, 目录: {len(local_dirs)}")

    # 统计
    all_file_paths = set(cloud_files.keys()) | set(local_files.keys())
    all_dir_paths = set(cloud_dirs.keys()) | set(local_dirs.keys())

    stats = {
        "updated": 0,      # 已有记录但补全了信息
        "new_matched": 0,   # 新增：云端+本地匹配
        "new_cloud_only": 0,  # 新增：只有云端
        "new_local_only": 0,  # 新增：只有本地
        "skipped_conflict": 0,  # 跳过的 .conflict 文件
        "dirs_added": 0,
    }

    for rel in sorted(all_file_paths):
        cloud = cloud_files.get(rel)
        local = local_files.get(rel)

        # 跳过 .conflict 文件
        if local and local["is_conflict"]:
            stats["skipped_conflict"] += 1
            continue

        existing = existing_files.get(rel)

        if cloud and local:
            # 两端都有 → 写入完整信息
            if not args.dry_run:
                content_hash = None
                if existing and existing.get("content_hash"):
                    # 如果 mtime 没变，复用旧 hash
                    if existing.get("local_mtime") == local["mtime"]:
                        content_hash = existing["content_hash"]
                if content_hash is None:
                    content_hash = compute_content_hash(local["path"])

                meta.set_file_info(
                    local_path=rel,
                    file_id=cloud["id"],
                    cloud_mtime=cloud["mtime"],
                    local_mtime=local["mtime"],
                    parent_id=cloud["parent_id"],
                    domain=cloud["domain"],
                    content_hash=content_hash,
                    create_time=cloud["ctime"],
                )
            if existing:
                stats["updated"] += 1
            else:
                stats["new_matched"] += 1

        elif cloud and not local:
            # 只有云端 → 记录 file_id + cloud_mtime，local_mtime=0
            if not args.dry_run:
                meta.set_file_info(
                    local_path=rel,
                    file_id=cloud["id"],
                    cloud_mtime=cloud["mtime"],
                    local_mtime=0,
                    parent_id=cloud["parent_id"],
                    domain=cloud["domain"],
                    create_time=cloud["ctime"],
                )
            stats["new_cloud_only"] += 1

        elif local and not cloud:
            # 只有本地（非 conflict）→ 记录 local_mtime，file_id=""
            if not args.dry_run:
                content_hash = compute_content_hash(local["path"])
                meta.set_file_info(
                    local_path=rel,
                    file_id="",
                    cloud_mtime=0,
                    local_mtime=local["mtime"],
                    content_hash=content_hash,
                )
            stats["new_local_only"] += 1

    # 补全目录
    for rel in sorted(all_dir_paths):
        if rel in existing_dirs:
            continue
        cloud_dir = cloud_dirs.get(rel)
        if cloud_dir and not args.dry_run:
            meta.set_dir_info(rel, cloud_dir["id"], cloud_dir["parent_id"])
        stats["dirs_added"] += 1

    if not args.dry_run:
        meta.save()

    # 打印结果
    mode = "DRY-RUN" if args.dry_run else "已写入"
    print(f"\n{'=' * 50}")
    print(f"  元数据补全结果 ({mode})")
    print(f"{'=' * 50}")
    print(f"  更新已有记录:       {stats['updated']}")
    print(f"  新增（云端+本地）:  {stats['new_matched']}")
    print(f"  新增（只有云端）:   {stats['new_cloud_only']}")
    print(f"  新增（只有本地）:   {stats['new_local_only']}")
    print(f"  跳过 .conflict:     {stats['skipped_conflict']}")
    print(f"  补全目录:           {stats['dirs_added']}")
    print(f"{'=' * 50}")
    total = stats['updated'] + stats['new_matched'] + stats['new_cloud_only'] + stats['new_local_only']
    print(f"  文件记录总计:       {total}")
    print(f"  目录记录总计:       {len(existing_dirs) + stats['dirs_added']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
