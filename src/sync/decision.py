"""
同步决策：元数据校准 + 构建 SyncItem

calibrate_metadata() — 自动填补两端都有但元数据缺失的条目
build_item()          — 根据 cloud/local/metadata 生成 SyncItem
"""

import os
import logging
from typing import Dict, Optional

from src.common import NoteDomain
from src.sync.utils import SyncAction, SyncItem, decide_action, compute_content_hash
from src.sync.metadata import SyncMetadata


def calibrate_metadata(
    metadata: SyncMetadata,
    cloud_files: Dict,
    local_files: Dict,
) -> int:
    """
    自动校准元数据：对于云端和本地都存在但元数据缺失的文件/目录，
    以当前状态建立基线（视为已同步），避免产生大量误操作。

    只处理"两端都存在 + 无元数据"的情况，"只有一端"的仍走正常同步逻辑。

    :return: 校准的条目数
    """
    calibrated = 0

    for rel in cloud_files:
        cloud = cloud_files[rel]
        local = local_files.get(rel)

        if cloud.get("is_dir"):
            # 目录：只要云端有且元数据缺失就记录
            if not metadata.get_dir_id(rel) and cloud.get("id"):
                metadata.set_dir_info(rel, cloud["id"], cloud.get("parent_id"))
                calibrated += 1
            continue

        # 文件：两端都有但元数据缺失或不完整时建立基线
        if local is None:
            continue
        meta = metadata.get_file_info(rel)
        # 元数据完整（file_id 非空且 local_mtime 非零）时跳过
        if (meta is not None
                and meta.get("file_id")
                and meta.get("local_mtime", 0) > 0):
            continue

        content_hash = compute_content_hash(local["path"])
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
        calibrated += 1

    if calibrated > 0:
        metadata.save()
        logging.info(f"元数据校准: 建立了 {calibrated} 条基线记录")

    return calibrated


def build_item(
    rel: str,
    cloud: Optional[Dict],
    local: Optional[Dict],
    metadata: SyncMetadata,
    local_dir: str,
) -> SyncItem:
    """根据 cloud/local/metadata 三方信息构建一个 SyncItem。"""
    is_dir = (cloud or {}).get("is_dir", False) or (local or {}).get("is_dir", False)
    meta = metadata.get_file_info(rel)

    # 目录的决策逻辑：元数据存储在 directories 表而非 files 表，
    # 如果 dir_id 已记录或两端都存在，视为已同步
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
        action = decide_action(
            local_exists=local is not None,
            cloud_exists=cloud is not None,
            local_mtime=local["mtime"] if local else None,
            cloud_mtime=cloud["mtime"] if cloud else None,
            meta_local_mtime=meta.get("local_mtime") if meta else None,
            meta_cloud_mtime=meta.get("cloud_mtime") if meta else None,
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
