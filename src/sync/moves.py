"""
移动/重命名检测

normalize_filename()   — 将文件名净化为本地存储时的规范形式
reconcile_moves()      — 检测并处理文件移动/重命名（含跨目录重复检测）
"""

import os
import re
import shutil
import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union

from src.sync.metadata import SyncMetadata
from src.sync.utils import CloudFileInfo, LocalFileInfo, FileId, DirId, ContentHash, compute_content_hash, sanitize_filename


@dataclass
class PendingMove:
    """跨目录移动：保留 file_id 在云端直接 move，而非 upload+delete。"""
    file_id: FileId
    old_cloud_path: str
    new_local_path: str
    domain: int = 1


def normalize_filename(name: str) -> str:
    """将文件名净化为本地存储时的规范形式（与下载时一致）。

    委托给 ``sanitize_filename``，保证与 scanner / downloader 行为统一。
    """
    return sanitize_filename(name)


def _detect_cloud_moves(
    only_local: set,
    only_cloud: set,
    cloud_id_to_path: Dict[Union[FileId, DirId], str],
    cloud_files: Dict[str, CloudFileInfo],
    local_files: Dict[str, LocalFileInfo],
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool,
) -> int:
    """场景 1 & 3：通过 file_id 匹配检测云端/本地移动。"""
    count = 0
    for local_rel in list(only_local):
        if local_files[local_rel]["is_dir"]:
            continue
        fmeta = metadata.get_file_info(local_rel)
        if not fmeta or not fmeta["file_id"]:
            continue
        fid = fmeta["file_id"]

        cloud_new = cloud_id_to_path.get(fid)
        if not cloud_new or cloud_new not in only_cloud:
            continue

        logging.info(f"检测到云端移动: {local_rel} → {cloud_new}")
        local_files[cloud_new] = local_files.pop(local_rel)
        only_local.discard(local_rel)
        only_cloud.discard(cloud_new)

        if not _move_local_file(local_dir, local_rel, cloud_new,
                                local_files, only_local, only_cloud, dry_run):
            continue

        if not dry_run:
            ci = cloud_files[cloud_new]
            metadata.record_sync(
                cloud_new,
                file_id=fid,
                cloud_mtime=ci["mtime"],
                local_mtime=local_files[cloud_new]["mtime"],
                parent_id=ci["parent_id"],
                domain=ci["domain"],
                content_hash=fmeta.get("content_hash"),
                create_time=ci["ctime"],
                action="moved",
                direction="pull",
            )
            if local_rel != cloud_new:
                metadata.remove_file_info(local_rel)
        count += 1
    return count


def _detect_name_mismatches(
    only_local: set,
    only_cloud: set,
    cloud_files: Dict[str, CloudFileInfo],
    local_files: Dict[str, LocalFileInfo],
) -> int:
    """场景 2：文件名净化差异——同一目录下名字几乎一样。"""
    norm_index = {}
    for cp in only_cloud:
        if cloud_files[cp]["is_dir"]:
            continue
        d, b = os.path.dirname(cp), os.path.basename(cp)
        norm_index[(d, normalize_filename(b))] = cp

    count = 0
    for lr in list(only_local):
        if local_files[lr]["is_dir"]:
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


def _move_local_file(
    local_dir: str, old_rel: str, new_rel: str,
    local_files: Dict[str, LocalFileInfo], only_local: set, only_cloud: set,
    dry_run: bool,
) -> bool:
    """执行本地文件移动，失败时完整回退。返回 True 表示成功。"""
    if dry_run:
        local_files[new_rel]["path"] = os.path.join(local_dir, new_rel)
        return True

    old_abs = os.path.join(local_dir, old_rel)
    new_abs = os.path.join(local_dir, new_rel)
    if os.path.exists(old_abs):
        try:
            os.makedirs(os.path.dirname(new_abs), exist_ok=True)
            shutil.move(old_abs, new_abs)
        except OSError as e:
            logging.error(f"移动文件失败: {old_abs} → {new_abs} - {e}")
            local_files[old_rel] = local_files.pop(new_rel)
            only_local.add(old_rel)
            only_cloud.add(new_rel)
            return False
    else:
        logging.warning(f"源文件不存在，跳过移动: {old_abs}")
        local_files[old_rel] = local_files.pop(new_rel)
        only_local.add(old_rel)
        only_cloud.add(new_rel)
        return False

    local_files[new_rel]["path"] = new_abs
    return True


def _common_ancestor_depth(path_a: str, path_b: str) -> int:
    """返回两个路径共享的目录层级数。"""
    parts_a = path_a.replace("\\", "/").split("/")[:-1]
    parts_b = path_b.replace("\\", "/").split("/")[:-1]
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
    cloud_files: Dict[str, CloudFileInfo],
    local_files: Dict[str, LocalFileInfo],
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool,
    hash_cache: Optional[Dict[str, ContentHash]] = None,
) -> Tuple[int, List[PendingMove]]:
    """跨目录重复检测：上传候选和下载候选中同名或同内容的文件。

    检测策略（按优先级）：
    1. 内容 hash 匹配：本地文件 hash == metadata 中云端文件的 hash → 确认是同一文件
    2. 文件名匹配：normalized 文件名相同 + 共享路径前缀 → 很可能是目录重组

    匹配后根据时间戳决定方向：
    - 本地更新 → 保留本地路径，标记旧云端文件待删除
    - 云端更新 → 本地跟随云端路径

    :return: (处理数, [(old_file_id, old_cloud_path, new_local_path), ...] 待删除列表)
    """

    local_candidates = {p for p in only_local if not local_files[p]["is_dir"]}
    cloud_candidates = {p for p in only_cloud if not cloud_files[p]["is_dir"]}

    if not local_candidates or not cloud_candidates:
        return 0, []

    # ── 第 1 步：从 metadata 获取云端候选的 content hash ──
    cloud_hash_map: Dict[str, str] = {}  # cloud_path → hash
    for cp in cloud_candidates:
        meta = metadata.get_file_info(cp)
        if meta and meta.get("content_hash"):
            cloud_hash_map[cp] = meta["content_hash"]

    # ── 第 2 步：为本地候选计算 content hash ──
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
    matched_local: set = set()
    matched_cloud: set = set()

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

        _MAX_NAME_CANDIDATES = 10
        for lp in list(remaining_local):
            norm = normalize_filename(os.path.basename(lp)).lower()
            if norm in _GENERIC_NAMES:
                continue
            candidates = cloud_name_index.get(norm, [])
            if not candidates or len(candidates) > _MAX_NAME_CANDIDATES:
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
                lp_hash = local_hash_map.get(lp)
                cp_meta = metadata.get_file_info(best_cp)
                cp_hash = cp_meta.get("content_hash") if cp_meta else None
                if lp_hash and cp_hash and lp_hash != cp_hash:
                    # 内容不同 — 只有当云端文件有已知元数据（之前同步过）时才配对，
                    # 说明是"同一文件被移动 + 编辑"而不是两个碰巧同名的不同文件
                    if not (cp_meta and cp_meta["file_id"]):
                        continue
                    reason_tag = f"filename+ancestor(depth={best_depth},content_changed)"
                else:
                    reason_tag = f"filename+ancestor(depth={best_depth})"
                matched.append((lp, best_cp, reason_tag))
                matched_local.add(lp)
                matched_cloud.add(best_cp)

    if not matched:
        return 0, []

    # ── 第 5 步：根据时间戳决定方向 ──
    count = 0
    pending_deletes: List[PendingMove] = []

    for local_path, cloud_path, reason in matched:
        local_mtime = local_files[local_path]["mtime"]
        cloud_mtime = cloud_files[cloud_path]["mtime"]
        local_wins = local_mtime >= cloud_mtime

        if local_wins:
            # 本地路径更新 → engine 会先尝试 API move，失败再 fallback 到 upload+delete
            logging.info(f"跨目录移动(本地新): {cloud_path} → {local_path} ({reason})")
            ci = cloud_files[cloud_path]
            old_fid = FileId(ci["id"])
            domain = ci["domain"]
            if old_fid:
                pending_deletes.append(PendingMove(old_fid, cloud_path, local_path, domain))
            cloud_files.pop(cloud_path)
            only_cloud.discard(cloud_path)
            # local_path 留在 only_local → engine fallback 时用作 UPLOAD
        else:
            # 云端路径更新 → 本地跟随云端（移动本地文件到云端路径）
            logging.info(f"跨目录移动(云端新): {local_path} → {cloud_path} ({reason})")
            local_info = local_files.pop(local_path)
            local_files[cloud_path] = local_info
            only_local.discard(local_path)
            only_cloud.discard(cloud_path)

            if not _move_local_file(local_dir, local_path, cloud_path,
                                    local_files, only_local, only_cloud, dry_run):
                continue

            if not dry_run:
                ci = cloud_files[cloud_path]
                metadata.record_sync(
                    cloud_path,
                    file_id=FileId(ci["id"]),
                    cloud_mtime=ci["mtime"],
                    local_mtime=local_info["mtime"],
                    parent_id=ci["parent_id"],
                    domain=ci["domain"],
                    content_hash=local_hash_map.get(local_path),
                    create_time=ci["ctime"],
                    action="moved",
                    direction="pull",
                )

        count += 1

    return count, pending_deletes


def discard_orphan_duplicates(
    cloud_files: Dict[str, CloudFileInfo],
    local_files: Dict[str, LocalFileInfo],
    local_dir: str,
    hash_cache: Optional[Dict[str, ContentHash]] = None,
) -> int:
    """清理孤儿本地副本：only_local 中与 both 集合内容相同的文件不需要上传。

    场景：云端移动了文件 A→B，同步把 B 下载到本地，但旧路径 A 的本地副本未清理。
    此时 B 在 both 集合（两端都有），A 在 only_local。如果 A 和 B 文件名相同且
    内容一致，则 A 是孤儿副本，从 local_files 移除以阻止上传。

    content hash 已在 compute_content_hash 层面对 .md/.txt 做了格式归一化，
    因此 hash 匹配能自动识别仅有 Markdown 格式差异的等价文件。

    :return: 跳过的文件数
    """
    only_local_paths = set(local_files.keys()) - set(cloud_files.keys())
    both_paths = set(local_files.keys()) & set(cloud_files.keys())

    local_candidates = [p for p in only_local_paths
                        if not local_files[p]["is_dir"]]
    both_files = {p for p in both_paths
                  if not local_files[p]["is_dir"]
                  and not cloud_files[p]["is_dir"]}

    if not local_candidates or not both_files:
        return 0

    both_name_index: Dict[str, List[str]] = defaultdict(list)
    for bp in both_files:
        norm = normalize_filename(os.path.basename(bp)).lower()
        both_name_index[norm].append(bp)

    count = 0
    for lp in local_candidates:
        norm = normalize_filename(os.path.basename(lp)).lower()
        candidates = both_name_index.get(norm)
        if not candidates:
            continue

        lp_abs = local_files[lp]["path"]
        lp_hash = (hash_cache.get(lp_abs) if hash_cache else None) \
            or compute_content_hash(lp_abs)
        if not lp_hash:
            continue
        if hash_cache is not None:
            hash_cache[lp_abs] = lp_hash

        for bp in candidates:
            bp_abs = local_files[bp]["path"]
            bp_hash = (hash_cache.get(bp_abs) if hash_cache else None) \
                or compute_content_hash(bp_abs)
            if bp_hash and hash_cache is not None:
                hash_cache[bp_abs] = bp_hash

            if lp_hash == bp_hash:
                logging.info(f"跳过孤儿副本: {lp} (内容与 {bp} 相同)")
                local_files.pop(lp)
                count += 1
                break

    if count > 0:
        logging.info(f"孤儿副本清理: 跳过了 {count} 个重复文件的上传")
    return count


def reconcile_moves(
    cloud_files: Dict[str, CloudFileInfo],
    local_files: Dict[str, LocalFileInfo],
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool = False,
    hash_cache: Optional[Dict[str, ContentHash]] = None,
) -> List[PendingMove]:
    """检测并处理文件移动/重命名（编排层）。

    三阶段检测：
    1. file_id 匹配 — 精确检测云端/本地文件移动
    2. 文件名净化匹配 — 同目录下特殊字符差异
    3. 跨目录重复检测 — content hash + 文件名匹配不同目录的同一文件
       本地更新 → 保留本地路径，旧云端文件排队删除
       云端更新 → 本地跟随云端路径

    :param hash_cache: 可选的 abs_path → hash 缓存，避免重复计算
    :return: [(file_id, old_cloud_path, new_local_path, domain), ...] 待移动的云端文件
    """
    cloud_id_to_path = {
        ci["id"]: cp
        for cp, ci in cloud_files.items()
        if not ci["is_dir"] and ci["id"]
    }

    only_local = set(local_files.keys()) - set(cloud_files.keys())
    only_cloud = set(cloud_files.keys()) - set(local_files.keys())

    reconciled = _detect_cloud_moves(
        only_local, only_cloud, cloud_id_to_path,
        cloud_files, local_files, metadata, local_dir, dry_run)

    reconciled += _detect_name_mismatches(
        only_local, only_cloud, cloud_files, local_files)

    cross_count, pending_deletes = _detect_cross_dir_duplicates(
        only_local, only_cloud,
        cloud_files, local_files, metadata, local_dir, dry_run,
        hash_cache=hash_cache)
    reconciled += cross_count

    if reconciled > 0:
        if not dry_run:
            metadata.save()
        logging.info(f"移动/重命名处理: {'(dry-run) ' if dry_run else ''}"
                     f"处理了 {reconciled} 个文件"
                     f"{f'，{len(pending_deletes)} 个旧云端文件待删除' if pending_deletes else ''}")
    return pending_deletes
