"""
笔记内容级去重模块

处理两种重复：
1. 「云端 vs 本地」：同一内容既有云端版本（有 file_id），又有本地旧副本（无 file_id）
   → 删掉本地旧副本，保留云端版本
2. 「云端自身重复」：同一内容有多个云端版本（都有 file_id，是之前误上传的）
   → 保留一个云端版本（路径更深 / 更合理的），删掉其余（本地 + 云端都删）

本地自身的重复（都没有 file_id）不动。
对于图片/附件，额外检查引用关系：被 md 引用的不删。
"""

import os
import re
import logging
from collections import defaultdict
from typing import Dict, List, Set, Tuple, Optional

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.protocols import FileDeleter

from src.common import safe_long_path, normalize_sep
from src.sync.metadata import SyncMetadata
from src.sync.utils import compute_content_hash

# 空文件的 MD5
_EMPTY_MD5 = "d41d8cd98f00b204e9800998ecf8427e"

# 图片/附件扩展名
_ASSET_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico",
    ".pdf", ".amr", ".mp3", ".mp4", ".wav",
})

# md 中引用图片/附件的正则
_MD_REF_RE = re.compile(
    r'!?\[[^\]]*\]\(([^)]+)\)'
    r'|'
    r'src="([^"]+)"'
)


# ========== 索引构建 ==========

def build_hash_index(
    root: str,
    metadata: SyncMetadata = None,
) -> Dict[str, List[str]]:
    """
    扫描本地目录，按 normalized MD5 分组。
    缓存命中（mtime 没变）就不重新读文件。
    """
    hash_index, _ = _build_indexes(root, metadata, need_refs=False)
    return hash_index


def build_ref_index(root: str) -> Set[str]:
    """
    扫描所有 md 文件中的 ![](path) 和 src="path" 引用，
    返回被引用的资源相对路径集合。
    """
    _, referenced = _build_indexes(root, metadata=None, need_refs=True)
    return referenced


def build_all_indexes(
    root: str,
    metadata: SyncMetadata = None,
    hash_cache: Dict[str, str] = None,
    local_files: Dict[str, Dict] = None,
) -> Tuple[Dict[str, List[str]], Set[str]]:
    """构建 hash 索引和引用索引。

    如果提供了 local_files（scan_local 的结果），直接基于已知文件列表构建，
    避免重复 os.walk。否则回退到文件系统遍历。
    """
    if local_files is not None:
        return _build_indexes_from_scan(root, local_files, metadata,
                                        hash_cache=hash_cache)
    return _build_indexes(root, metadata, need_refs=True, hash_cache=hash_cache)


def _build_indexes(
    root: str,
    metadata: SyncMetadata = None,
    need_refs: bool = True,
    hash_cache: Dict[str, str] = None,
) -> Tuple[Dict[str, List[str]], Set[str]]:
    """
    内部实现：一次文件系统遍历同时构建 hash 分组和资源引用集合。
    当 need_refs=False 时跳过 Markdown 解析，节省 I/O。
    hash_cache: sync 阶段已计算的 abs_path → hash 缓存，命中则跳过重算。
    """
    hash_index: Dict[str, List[str]] = defaultdict(list)
    referenced: Set[str] = set()
    updated = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if f.startswith(".") or ".conflict." in f:
                continue

            full = safe_long_path(os.path.join(dirpath, f))
            rel = normalize_sep(os.path.relpath(full, root))

            # ---- hash 索引（优先级：hash_cache > metadata cache > 重新计算）----
            h = None
            if hash_cache:
                h = hash_cache.get(full)
            if not h and metadata:
                info = metadata.get_file_info(rel)
                if info and "content_hash" in info:
                    cached_mtime = info.get("local_mtime", 0)
                    try:
                        current_mtime = int(os.path.getmtime(full))
                    except OSError:
                        continue
                    if current_mtime == cached_mtime:
                        h = info["content_hash"]
            if not h:
                h = compute_content_hash(full)
                if h:
                    if hash_cache is not None:
                        hash_cache[full] = h
                    if metadata and metadata.get_file_info(rel):
                        metadata.update_content_hash(rel, h)
                        updated += 1

            if h:
                hash_index[h].append(rel)

            # ---- 引用索引（仅 .md 文件） ----
            if need_refs and f.endswith(".md"):
                md_dir = os.path.dirname(full)
                try:
                    with open(full, "r", encoding="utf-8", errors="replace") as fh:
                        content = fh.read()
                except Exception:
                    continue

                for m in _MD_REF_RE.finditer(content):
                    ref_path = m.group(1) or m.group(2)
                    if not ref_path:
                        continue
                    if ref_path.startswith(("http://", "https://", "data:", "note://",
                                            "ftp://", "mailto:", "//", "\\\\")):
                        continue
                    if "://" in ref_path or (len(ref_path) > 2 and ":" in ref_path[2:]):
                        continue
                    abs_ref = os.path.normpath(os.path.join(md_dir, ref_path))
                    rel_ref = normalize_sep(os.path.relpath(abs_ref, root))
                    referenced.add(rel_ref)

    if updated > 0 and metadata:
        metadata.save()

    return hash_index, referenced


def _build_indexes_from_scan(
    root: str,
    local_files: Dict[str, Dict],
    metadata: SyncMetadata = None,
    hash_cache: Dict[str, str] = None,
) -> Tuple[Dict[str, List[str]], Set[str]]:
    """基于 scan_local 已有的文件列表构建索引，跳过 os.walk。"""
    hash_index: Dict[str, List[str]] = defaultdict(list)
    referenced: Set[str] = set()
    updated = 0

    for rel, info in local_files.items():
        if info.get("is_dir"):
            continue
        full = info.get("path") or os.path.join(root, rel)
        f = os.path.basename(rel)
        if f.startswith(".") or ".conflict." in f:
            continue

        h = None
        if hash_cache:
            h = hash_cache.get(full)
        if not h and metadata:
            meta_info = metadata.get_file_info(rel)
            if meta_info and "content_hash" in meta_info:
                cached_mtime = meta_info.get("local_mtime", 0)
                current_mtime = info.get("mtime", 0)
                if current_mtime == cached_mtime:
                    h = meta_info["content_hash"]
        if not h:
            h = compute_content_hash(full)
            if h:
                if hash_cache is not None:
                    hash_cache[full] = h
                if metadata and metadata.get_file_info(rel):
                    metadata.update_content_hash(rel, h)
                    updated += 1
        if h:
            hash_index[h].append(rel)

        if f.endswith(".md"):
            md_dir = os.path.dirname(full)
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
            except Exception:
                continue
            for m in _MD_REF_RE.finditer(content):
                ref_path = m.group(1) or m.group(2)
                if not ref_path:
                    continue
                if ref_path.startswith(("http://", "https://", "data:", "note://",
                                        "ftp://", "mailto:", "//", "\\\\")):
                    continue
                if "://" in ref_path or (len(ref_path) > 2 and ":" in ref_path[2:]):
                    continue
                abs_ref = os.path.normpath(os.path.join(md_dir, ref_path))
                rel_ref = normalize_sep(os.path.relpath(abs_ref, root))
                referenced.add(rel_ref)

    if updated > 0 and metadata:
        metadata.save()
    return hash_index, referenced


# ========== 去重核心 ==========

def _is_asset(path: str) -> bool:
    _, ext = os.path.splitext(path)
    return ext.lower() in _ASSET_EXTS


def _cloud_score(path: str, metadata: SyncMetadata, root: str) -> tuple:
    """
    给云端文件打分，用于决定保留哪个。
    返回元组 (路径深度, 文件名干净度, 创建时间越早越好)，越大越优先保留。

    优先级（从高到低）：
    1. 路径深度：越深越好（说明组织结构更完整）
    2. 文件名干净度：名字越短越好（没有 (1) 之类的冲突后缀）
    3. 创建时间：越早越好（原始版本，用负值取反：ctime 越小 → -ctime 越大）
    """
    depth = path.count("/")
    # 文件名越短越"干净"——取负值，使得短名字分数更高
    basename = os.path.basename(path)
    name_clean = -len(basename)
    # 创建时间：越早 → 越可能是原始版本 → 应该保留
    # 用 -ctime，这样 ctime 小的得分大
    ctime = 0
    info = metadata.get_file_info(path) if metadata else None
    if info:
        ctime = info.get("create_time", 0) or 0
        # 如果没有 create_time，退而用 mtime（较早的也优先）
        if ctime == 0:
            ctime = info.get("cloud_mtime", 0) or info.get("local_mtime", 0) or 0
    if ctime == 0:
        try:
            ctime = int(os.path.getmtime(os.path.join(root, path)))
        except OSError:
            pass
    return (depth, name_clean, -ctime)


def _classify_duplicates(
    raw_dup_groups: Dict[str, List[str]],
    root: str,
    stats: Dict,
) -> Dict[str, List[str]]:
    """碰撞防护：按文件大小再分组，大小不同说明 MD5 碰撞。"""
    dup_groups: Dict[str, List[str]] = {}
    for h, paths in raw_dup_groups.items():
        size_groups: Dict[int, List[str]] = defaultdict(list)
        for p in paths:
            try:
                sz = os.path.getsize(os.path.join(root, p))
            except OSError:
                sz = -1
            size_groups[sz].append(p)
        for sz, sub_paths in size_groups.items():
            if len(sub_paths) > 1:
                dup_groups[f"{h}_{sz}"] = sub_paths
            elif len(sub_paths) == 1 and len(size_groups) > 1:
                logging.warning(
                    f"MD5 碰撞检测：{sub_paths[0]} (大小={sz}) 与同 hash 的其他文件大小不同，跳过去重")
                stats["skipped"] += 1
    return dup_groups


def _resolve_group(
    paths: List[str],
    metadata: SyncMetadata,
    referenced: Set[str],
    root: str,
    stats: Dict,
    score_func=None,
) -> List[Tuple[str, Optional[str], str, str]]:
    """
    处理单个重复组，返回删除动作列表。
    每个动作 = (待删本地路径, 待删云端 file_id 或 None, 保留路径, 原因)。
    """
    cloud_paths, local_paths = [], []
    for p in paths:
        if metadata:
            info = metadata.get_file_info(p)
            if info and info.get("file_id"):
                cloud_paths.append(p)
                continue
        local_paths.append(p)

    actions: List[Tuple[str, Optional[str], str, str]] = []

    # 情况 A: 混合组（云端+本地）→ 删本地旧副本
    if cloud_paths and local_paths:
        to_remove = []
        for lp in local_paths:
            if _is_asset(lp) and lp in referenced:
                stats["protected_refs"] += 1
                continue
            to_remove.append(lp)
        if not to_remove:
            stats["skipped"] += 1
            return actions
        keep = cloud_paths[0]
        for r in to_remove:
            actions.append((r, None, keep, f"云端版本在 {keep}"))
        stats["kept"] += len(cloud_paths)
        stats["deleted"] += len(to_remove)
        return actions

    # 情况 B: 全云端组 → 保留一个，删其余
    if len(cloud_paths) > 1 and not local_paths:
        keep_paths, remove_paths = _resolve_cloud_group(
            cloud_paths, metadata, referenced, root, stats, score_func)
        if remove_paths is None:
            return actions
        for r in remove_paths:
            info = metadata.get_file_info(r) if metadata else None
            fid = info.get("file_id") if info else None
            actions.append((r, fid, keep_paths[0],
                            f"保留 {keep_paths[0]}，删除云端副本"))
        stats["kept"] += len(keep_paths)
        stats["deleted"] += len(remove_paths)
        stats["cloud_deleted"] += len(remove_paths)
        return actions

    # 情况 C: 全本地组 → 不处理
    stats["skipped"] += 1
    return actions


def _resolve_cloud_group(
    cloud_paths: List[str],
    metadata: SyncMetadata,
    referenced: Set[str],
    root: str,
    stats: Dict,
    score_func=None,
) -> Tuple[List[str], Optional[List[str]]]:
    """全云端重复组：决定保留哪些、删除哪些。返回 (keep, remove)。"""
    _score = score_func or _cloud_score
    if any(_is_asset(p) for p in cloud_paths):
        ref = [p for p in cloud_paths if p in referenced]
        unref = [p for p in cloud_paths if p not in referenced]
        if ref and unref:
            return ref, unref
        elif not ref:
            s = sorted(cloud_paths,
                       key=lambda p: _score(p, metadata, root), reverse=True)
            return [s[0]], s[1:]
        else:
            stats["skipped"] += 1
            return cloud_paths, None

    s = sorted(cloud_paths,
               key=lambda p: _score(p, metadata, root), reverse=True)
    return [s[0]], s[1:]


def _execute_removals(
    actions: List[Tuple[str, Optional[str], str, str]],
    root: str,
    metadata: SyncMetadata,
    api,
    dry_run: bool,
    stats: Dict,
) -> None:
    """执行删除动作（本地 + 可选云端）。"""
    for remove_path, cloud_file_id, keep_path, reason in actions:
        if dry_run:
            cloud_tag = " + 云端" if cloud_file_id else ""
            print(f"  [去重] 删除{cloud_tag} {remove_path}")
            print(f"         {reason}")
        else:
            full = safe_long_path(os.path.join(root, remove_path))
            try:
                os.remove(full)
                logging.info(f"去重删除本地: {remove_path} ({reason})")
                if metadata:
                    metadata.remove_file(remove_path)
                _remove_empty_parents(full, root)
            except Exception as e:
                logging.error(f"去重删除本地失败: {remove_path} - {e}")
                stats["deleted"] -= 1
                continue

            if cloud_file_id and api:
                try:
                    api.delete_file(cloud_file_id)
                    logging.info(f"去重删除云端: {remove_path} (file_id={cloud_file_id})")
                except Exception as e:
                    logging.error(
                        f"去重删除云端失败: {remove_path} (file_id={cloud_file_id}) - {e}")
                    stats["cloud_deleted"] -= 1


def auto_dedup(
    root: str,
    metadata: SyncMetadata = None,
    api: "FileDeleter" = None,
    dry_run: bool = False,
    score_func=None,
    hash_cache: Dict[str, str] = None,
    local_files: Dict[str, Dict] = None,
) -> Dict:
    """
    自动去重（编排层）。

    A) 混合组（有云端 + 有本地）：删本地旧副本
    B) 全云端组（都有 file_id）：保留得分最高的一个，删其余（本地+云端）
    本地自身重复不处理。空文件不处理。

    :param api: 用于删除云端文件。不传则只删本地。
    :param hash_cache: sync 阶段积累的 abs_path → hash 缓存
    :param local_files: scan_local 的结果（可选），避免重复遍历文件系统
    """
    stats = {
        "deleted": 0, "cloud_deleted": 0, "kept": 0,
        "skipped": 0, "groups": 0, "protected_refs": 0,
    }

    hash_index, referenced = build_all_indexes(root, metadata,
                                               hash_cache=hash_cache,
                                               local_files=local_files)
    raw_dups = {h: ps for h, ps in hash_index.items() if len(ps) > 1}
    if not raw_dups:
        return stats

    dup_groups = _classify_duplicates(raw_dups, root, stats)

    all_actions: List[Tuple[str, Optional[str], str, str]] = []
    for h, paths in sorted(dup_groups.items(), key=lambda x: x[0]):
        stats["groups"] += 1
        if h.startswith(_EMPTY_MD5):
            stats["skipped"] += 1
            continue
        try:
            if os.path.getsize(os.path.join(root, paths[0])) == 0:
                stats["skipped"] += 1
                continue
        except OSError:
            stats["skipped"] += 1
            continue

        all_actions.extend(
            _resolve_group(paths, metadata, referenced, root, stats, score_func))

    if not all_actions:
        return stats

    logging.info(
        f"去重: {stats['groups']} 组重复，"
        f"删除 {stats['deleted']} 个文件（其中 {stats['cloud_deleted']} 个同时删除云端），"
        f"保护 {stats['protected_refs']} 个被引用的资源"
    )

    _execute_removals(all_actions, root, metadata, api, dry_run, stats)

    if not dry_run and metadata:
        metadata.save()

    return stats


def _remove_empty_parents(file_path: str, root: str):
    """向上删除空目录，直到 root"""
    root = os.path.abspath(root)
    parent = os.path.dirname(os.path.abspath(file_path))
    while parent != root and os.path.isdir(parent):
        if not os.listdir(parent):
            os.rmdir(parent)
            parent = os.path.dirname(parent)
        else:
            break
