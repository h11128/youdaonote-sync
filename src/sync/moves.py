"""
移动/重命名检测

normalize_filename()   — 将文件名净化为本地存储时的规范形式
reconcile_moves()      — 检测并处理文件移动/重命名（含跨目录重复检测）
"""

import os
import shutil
import logging
from collections import defaultdict
from typing import Dict, List, Tuple

from src.sync.metadata import SyncMetadata
from src.sync.utils import compute_content_hash


def normalize_filename(name: str) -> str:
    """将文件名净化为本地存储时的规范形式（与下载时一致）。

    有道云文件名可能含 Windows 不允许的字符或多余空白，
    下载时会被清理，导致云端名字和本地名字不匹配。
    """
    for ch in ('\\', '/', ':', '*', '?', '"', '<', '>', '|'):
        name = name.replace(ch, '')
    name = name.replace('\n', '').replace('\r', '')
    name = name.lstrip('\u3000')  # 全角空格
    name = name.strip()
    return name


def _detect_cloud_moves(
    only_local: set,
    only_cloud: set,
    cloud_id_to_path: Dict[str, str],
    cloud_files: Dict,
    local_files: Dict,
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool,
) -> int:
    """场景 1 & 3：通过 file_id 匹配检测云端/本地移动。"""
    count = 0
    for local_rel in list(only_local):
        if local_files[local_rel].get("is_dir"):
            continue
        fmeta = metadata.get_file_info(local_rel)
        if not fmeta or not fmeta.get("file_id"):
            continue
        fid = fmeta["file_id"]

        cloud_new = cloud_id_to_path.get(fid)
        if not cloud_new or cloud_new not in only_cloud:
            continue

        logging.info(f"检测到云端移动: {local_rel} → {cloud_new}")
        local_files[cloud_new] = local_files.pop(local_rel)
        only_local.discard(local_rel)
        only_cloud.discard(cloud_new)

        if not dry_run:
            old_abs = os.path.join(local_dir, local_rel)
            new_abs = os.path.join(local_dir, cloud_new)
            if os.path.exists(old_abs):
                os.makedirs(os.path.dirname(new_abs), exist_ok=True)
                shutil.move(old_abs, new_abs)
            local_files[cloud_new]["path"] = new_abs

            ci = cloud_files[cloud_new]
            metadata.set_file_info(
                local_path=cloud_new,
                file_id=fid,
                cloud_mtime=ci["mtime"],
                local_mtime=local_files[cloud_new]["mtime"],
                parent_id=ci.get("parent_id"),
                domain=ci.get("domain", 1),
                content_hash=fmeta.get("content_hash"),
                create_time=ci.get("ctime", 0),
            )
            if local_rel != cloud_new:
                metadata.remove_file_info(local_rel)
        else:
            local_files[cloud_new]["path"] = os.path.join(local_dir, cloud_new)
        count += 1
    return count


def _detect_name_mismatches(
    only_local: set,
    only_cloud: set,
    cloud_files: Dict,
    local_files: Dict,
) -> int:
    """场景 2：文件名净化差异——同一目录下名字几乎一样。"""
    norm_index = {}
    for cp in only_cloud:
        if cloud_files[cp].get("is_dir"):
            continue
        d, b = os.path.dirname(cp), os.path.basename(cp)
        norm_index[(d, normalize_filename(b))] = cp

    count = 0
    for lr in list(only_local):
        if local_files[lr].get("is_dir"):
            continue
        d, b = os.path.dirname(lr), os.path.basename(lr)
        match = norm_index.get((d, normalize_filename(b)))
        if match and match in only_cloud:
            logging.info(f"文件名净化匹配: 本地[{lr}] ↔ 云端[{match}]")
            cloud_files[lr] = cloud_files.pop(match)
            only_local.discard(lr)
            only_cloud.discard(match)
            count += 1
    return count


# 泛用文件名：这些名字在不同目录下出现并不意味着同一文件，
# 仅按文件名匹配时跳过，必须有 hash 证据才关联。
_GENERIC_NAMES = frozenset({
    "readme.md", "index.md", "index.html", "todo.md", "notes.md",
    "changelog.md", "license.md", "config.json", "package.json",
    ".gitignore", "makefile", "dockerfile",
})


def _common_ancestor_depth(path_a: str, path_b: str) -> int:
    """返回两个路径共享的目录层级数。"""
    parts_a = path_a.split("/")[:-1]
    parts_b = path_b.split("/")[:-1]
    depth = 0
    for a, b in zip(parts_a, parts_b):
        if a == b:
            depth += 1
        else:
            break
    return depth


def _detect_cross_dir_duplicates(
    only_local: set,
    only_cloud: set,
    cloud_files: Dict,
    local_files: Dict,
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool,
    hash_cache: Dict[str, str] = None,
) -> int:
    """跨目录重复检测：上传候选和下载候选中同名或同内容的文件。

    检测策略（按优先级）：
    1. 内容 hash 匹配：本地文件 hash == metadata 中云端文件的 hash → 确认是同一文件
    2. 文件名匹配：normalized 文件名相同 + 共享路径前缀 → 很可能是目录重组

    匹配后的处理：将本地文件移到云端路径（跟随云端的目录结构），
    两边都不再需要单独的上传/下载。
    """

    # 只看文件，不看目录
    local_candidates = {p for p in only_local if not local_files[p].get("is_dir")}
    cloud_candidates = {p for p in only_cloud if not cloud_files[p].get("is_dir")}

    if not local_candidates or not cloud_candidates:
        return 0

    # ── 第 1 步：从 metadata 获取云端候选的 content hash ──
    cloud_hash_map: Dict[str, str] = {}  # cloud_path → hash
    for cp in cloud_candidates:
        meta = metadata.get_file_info(cp)
        if meta and meta.get("content_hash"):
            cloud_hash_map[cp] = meta["content_hash"]

    # ── 第 2 步：为本地候选计算 content hash ──
    # 优化：只 hash 与云端候选有同名关系的本地文件（同名文件才可能是跨目录移动）
    cloud_names = {normalize_filename(os.path.basename(cp)).lower()
                   for cp in cloud_candidates}
    local_hash_map: Dict[str, str] = {}  # local_path → hash
    hash_to_local: Dict[str, List[str]] = defaultdict(list)  # hash → [local_paths]

    for lp in local_candidates:
        norm_name = normalize_filename(os.path.basename(lp)).lower()
        if norm_name not in cloud_names:
            continue
        local_info = local_files[lp]
        abs_path = local_info["path"]
        h = (hash_cache.get(abs_path) if hash_cache else None) \
            or compute_content_hash(abs_path)
        if h:
            local_hash_map[lp] = h
            hash_to_local[h].append(lp)
            if hash_cache is not None:
                hash_cache[abs_path] = h

    # ── 第 3 步：按 hash 匹配（强信号）──
    matched: List[Tuple[str, str, str]] = []  # (local_path, cloud_path, reason)
    matched_local = set()
    matched_cloud = set()

    for cp, cloud_hash in cloud_hash_map.items():
        if cp in matched_cloud:
            continue
        candidates = hash_to_local.get(cloud_hash, [])
        for lp in candidates:
            if lp in matched_local:
                continue
            matched.append((lp, cp, "content_hash"))
            matched_local.add(lp)
            matched_cloud.add(cp)
            break

    # ── 第 4 步：按文件名匹配（弱信号，需要路径相关性佐证）──
    remaining_local = local_candidates - matched_local
    remaining_cloud = cloud_candidates - matched_cloud

    if remaining_local and remaining_cloud:
        cloud_name_index: Dict[str, List[str]] = defaultdict(list)
        for cp in remaining_cloud:
            norm = normalize_filename(os.path.basename(cp)).lower()
            cloud_name_index[norm].append(cp)

        for lp in list(remaining_local):
            norm = normalize_filename(os.path.basename(lp)).lower()
            if norm in _GENERIC_NAMES:
                continue
            candidates = cloud_name_index.get(norm, [])
            if not candidates:
                continue

            best_cp = None
            best_depth = -1
            for cp in candidates:
                if cp in matched_cloud:
                    continue
                depth = _common_ancestor_depth(lp, cp)
                if depth > best_depth:
                    best_depth = depth
                    best_cp = cp

            if best_cp and best_depth >= 1:
                # 双方都有 hash 时做最终验证，防止误匹配
                lp_hash = local_hash_map.get(lp)
                cp_meta = metadata.get_file_info(best_cp)
                cp_hash = cp_meta.get("content_hash") if cp_meta else None
                if lp_hash and cp_hash and lp_hash != cp_hash:
                    continue
                matched.append((lp, best_cp, f"filename+ancestor(depth={best_depth})"))
                matched_local.add(lp)
                matched_cloud.add(best_cp)

    if not matched:
        return 0

    # ── 第 5 步：执行重定向（本地文件跟随云端路径）──
    count = 0
    for local_path, cloud_path, reason in matched:
        logging.info(f"跨目录重复: {local_path} → {cloud_path} ({reason})")

        local_info = local_files.pop(local_path)
        local_files[cloud_path] = local_info
        only_local.discard(local_path)
        only_cloud.discard(cloud_path)

        if not dry_run:
            old_abs = os.path.join(local_dir, local_path)
            new_abs = os.path.join(local_dir, cloud_path)
            if os.path.exists(old_abs):
                os.makedirs(os.path.dirname(new_abs), exist_ok=True)
                shutil.move(old_abs, new_abs)
            local_files[cloud_path]["path"] = new_abs

            ci = cloud_files[cloud_path]
            metadata.set_file_info(
                local_path=cloud_path,
                file_id=ci.get("id", ""),
                cloud_mtime=ci.get("mtime", 0),
                local_mtime=local_info.get("mtime", 0),
                parent_id=ci.get("parent_id"),
                domain=ci.get("domain", 1),
                content_hash=local_hash_map.get(local_path),
                create_time=ci.get("ctime", 0),
            )
        else:
            local_files[cloud_path]["path"] = os.path.join(local_dir, cloud_path)

        count += 1

    return count


def reconcile_moves(
    cloud_files: Dict,
    local_files: Dict,
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool = False,
    hash_cache: Dict[str, str] = None,
) -> int:
    """检测并处理文件移动/重命名（编排层）。

    三阶段检测：
    1. file_id 匹配 — 精确检测云端/本地文件移动
    2. 文件名净化匹配 — 同目录下特殊字符差异
    3. 跨目录重复检测 — content hash + 文件名匹配不同目录的同一文件

    :param hash_cache: 可选的 abs_path → hash 缓存，避免重复计算
    """
    cloud_id_to_path = {
        ci["id"]: cp
        for cp, ci in cloud_files.items()
        if not ci.get("is_dir") and ci.get("id")
    }

    only_local = set(local_files.keys()) - set(cloud_files.keys())
    only_cloud = set(cloud_files.keys()) - set(local_files.keys())

    reconciled = _detect_cloud_moves(
        only_local, only_cloud, cloud_id_to_path,
        cloud_files, local_files, metadata, local_dir, dry_run)

    reconciled += _detect_name_mismatches(
        only_local, only_cloud, cloud_files, local_files)

    reconciled += _detect_cross_dir_duplicates(
        only_local, only_cloud,
        cloud_files, local_files, metadata, local_dir, dry_run,
        hash_cache=hash_cache)

    if reconciled > 0:
        if not dry_run:
            metadata.save()
        logging.info(f"移动/重命名处理: {'(dry-run) ' if dry_run else ''}"
                     f"处理了 {reconciled} 个文件")
    return reconciled
