"""
同步决策：元数据校准 + 构建 SyncItem

calibrate_metadata() — 自动填补两端都有但元数据缺失的条目
build_item()          — 根据 cloud/local/metadata 生成 SyncItem
"""

import os
import logging
import time
from typing import Dict, Optional

from src.common import NoteDomain
from src.sync.utils import SyncAction, SyncItem, decide_action, compute_content_hash
from src.sync.metadata import SyncMetadata


def calibrate_metadata(
    metadata: SyncMetadata,
    cloud_files: Dict,
    local_files: Dict,
    hash_cache: Optional[Dict[str, str]] = None,
) -> int:
    """
    自动校准元数据：对于云端和本地都存在但元数据缺失的文件/目录，
    以当前状态建立基线（视为已同步），避免产生大量误操作。

    只处理"两端都存在 + 无元数据"的情况，"只有一端"的仍走正常同步逻辑。

    :param hash_cache: 可选的 abs_path → hash 缓存，计算后写入以供后续模块复用
    :return: 校准的条目数
    """
    calibrated = 0

    with metadata.batch():
        for rel in cloud_files:
            cloud = cloud_files[rel]
            local = local_files.get(rel)

            if cloud.get("is_dir"):
                if not metadata.get_dir_id(rel) and cloud.get("id"):
                    metadata.set_dir_info(rel, cloud["id"], cloud.get("parent_id"))
                    calibrated += 1
                continue

            if local is None:
                continue
            meta = metadata.get_file_info(rel)

            # 旧 JSON 元数据迁移后 cloud_mtime=0：补填当前云端时间戳
            if (meta is not None
                    and meta.get("file_id")
                    and meta.get("local_mtime", 0) > 0):
                if meta.get("cloud_mtime", 0) == 0 and cloud.get("mtime", 0) > 0:
                    metadata.set_file_info(
                        local_path=rel,
                        file_id=meta["file_id"],
                        cloud_mtime=cloud["mtime"],
                    )
                    calibrated += 1
                if meta.get("content_hash") or meta.get("last_sync_at", 0) > 0:
                    continue
                # 不完整记录（从云端扫描/桌面导入但未真正同步）→ 落入完整校准

            local_path = local["path"]
            content_hash = (hash_cache.get(local_path) if hash_cache else None) \
                           or compute_content_hash(local_path)
            if not content_hash:
                continue
            if hash_cache is not None:
                hash_cache[local_path] = content_hash
            metadata.set_file_info(
                local_path=rel,
                file_id=cloud["id"],
                cloud_mtime=cloud["mtime"],
                local_mtime=local["mtime"],
                parent_id=cloud.get("parent_id"),
                domain=cloud.get("domain", NoteDomain.MARKDOWN),
                content_hash=content_hash,
                create_time=cloud.get("ctime", 0),
            )
            metadata.mark_synced(rel, ts=int(time.time()))
            calibrated += 1

    if calibrated > 0:
        logging.info(f"元数据校准: 建立了 {calibrated} 条基线记录")

    return calibrated


def build_item(
    rel: str,
    cloud: Optional[Dict],
    local: Optional[Dict],
    metadata: SyncMetadata,
    local_dir: str,
    hash_cache: Optional[Dict[str, str]] = None,
) -> SyncItem:
    """根据 cloud/local/metadata 三方信息构建一个 SyncItem。"""
    is_dir = (cloud or {}).get("is_dir", False) or (local or {}).get("is_dir", False)
    meta = metadata.get_file_info(rel)

    if is_dir:
        dir_id = metadata.get_dir_id(rel)
        if cloud and local:
            action = SyncAction.SKIP
        elif local and not cloud:
            action = SyncAction.UPLOAD if not dir_id else SyncAction.SKIP
        elif cloud and not local:
            action = SyncAction.DOWNLOAD
        else:
            action = SyncAction.SKIP
    else:
        local_hash = None
        if local and hash_cache is not None:
            abs_path = local["path"]
            local_hash = hash_cache.get(abs_path) or compute_content_hash(abs_path)
            if local_hash:
                hash_cache[abs_path] = local_hash

        previously_synced = (
            meta is not None
            and bool(meta.get("file_id"))
            and meta.get("last_sync_at", 0) > 0
        )

        action = decide_action(
            local_exists=local is not None,
            cloud_exists=cloud is not None,
            local_mtime=local["mtime"] if local else None,
            cloud_mtime=cloud["mtime"] if cloud else None,
            meta_local_mtime=meta.get("local_mtime") if meta else None,
            meta_cloud_mtime=meta.get("cloud_mtime") if meta else None,
            local_hash=local_hash,
            meta_hash=meta.get("content_hash") if meta else None,
            previously_synced=previously_synced,
        )

    return SyncItem(
        relative_path=rel,
        local_path=local["path"] if local else os.path.join(local_dir, rel),
        cloud_id=cloud["id"] if cloud else (meta["file_id"] if meta else None),
        cloud_parent_id=cloud["parent_id"] if cloud else (meta.get("parent_id") if meta else None),
        local_mtime=local["mtime"] if local else None,
        cloud_mtime=cloud["mtime"] if cloud else (meta.get("cloud_mtime") if meta else None),
        is_dir=is_dir,
        action=action,
        cloud_name=cloud["name"] if cloud else None,
        domain=NoteDomain(cloud.get("domain", NoteDomain.MARKDOWN)) if cloud else NoteDomain.MARKDOWN,
        cloud_ctime=cloud.get("ctime", 0) if cloud else (meta.get("create_time") if meta else None),
    )
