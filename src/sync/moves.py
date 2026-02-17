"""
移动/重命名检测

normalize_filename()   — 将文件名净化为本地存储时的规范形式
reconcile_moves()      — 检测并处理文件移动/重命名
"""

import os
import shutil
import logging
from typing import Dict

from youdaonote_sync.sync.metadata import SyncMetadata


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
    cloud_files: Dict,
    local_files: Dict,
) -> int:
    """场景 2：文件名净化差异——同一目录下名字几乎一样。"""
    still_local = set(local_files.keys()) - set(cloud_files.keys())
    still_cloud = set(cloud_files.keys()) - set(local_files.keys())

    norm_index = {}
    for cp in still_cloud:
        if cloud_files[cp].get("is_dir"):
            continue
        d, b = os.path.dirname(cp), os.path.basename(cp)
        norm_index[(d, normalize_filename(b))] = cp

    count = 0
    for lr in list(still_local):
        if local_files[lr].get("is_dir"):
            continue
        d, b = os.path.dirname(lr), os.path.basename(lr)
        match = norm_index.get((d, normalize_filename(b)))
        if match and match in still_cloud:
            logging.info(f"文件名净化匹配: 本地[{lr}] ↔ 云端[{match}]")
            cloud_files[lr] = cloud_files.pop(match)
            still_cloud.discard(match)
            count += 1
    return count


def reconcile_moves(
    cloud_files: Dict,
    local_files: Dict,
    metadata: SyncMetadata,
    local_dir: str,
    dry_run: bool = False,
) -> int:
    """检测并处理文件移动/重命名（编排层）。"""

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

    reconciled += _detect_name_mismatches(cloud_files, local_files)

    if reconciled > 0:
        if not dry_run:
            metadata.save()
        logging.info(f"移动/重命名处理: {'(dry-run) ' if dry_run else ''}"
                     f"处理了 {reconciled} 个文件")
    return reconciled
