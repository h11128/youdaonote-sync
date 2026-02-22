"""确认：cross-dir 匹配了哪些文件"""
import os
import sys
import asyncio
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from collections import defaultdict
from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.metadata import SyncMetadata
from src.sync.scanner import async_scan_cloud, scan_local
from src.sync.decision import calibrate_metadata
from src.sync.moves import (
    _detect_cloud_moves, _detect_name_mismatches,
    normalize_filename, _common_ancestor_depth,
    _GENERIC_NAMES,
)
from src.sync.utils import compute_content_hash

LOCAL_DIR = "E:/Projects/notes"

api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
error = api.login_by_cookies()
if error:
    print(f"登录失败: {error}")
    sys.exit(1)

meta = SyncMetadata()
cloud_dir_id = api.get_root_id()

async def scan():
    async with api.create_async_client() as aclient:
        cloud_files = await async_scan_cloud(
            aclient, api.DIR_MES_URL, api.DIR_PAGE_SIZE,
            api.cstk, cloud_dir_id, "", 8)
    local_files = scan_local(LOCAL_DIR, "", [], [])
    return cloud_files, local_files

cloud_files, local_files = asyncio.run(scan())
hash_cache = {}
calibrate_metadata(meta, cloud_files, local_files, hash_cache=hash_cache)

cloud_id_to_path = {
    ci["id"]: cp
    for cp, ci in cloud_files.items()
    if not ci.get("is_dir") and ci.get("id")
}

only_local = set(local_files.keys()) - set(cloud_files.keys())
only_cloud = set(cloud_files.keys()) - set(local_files.keys())

# Run steps 1 and 2 first (modifies sets in place)
_detect_cloud_moves(only_local, only_cloud, cloud_id_to_path,
                    cloud_files, local_files, meta, LOCAL_DIR, dry_run=True)
_detect_name_mismatches(only_local, only_cloud, cloud_files, local_files)

# Now manually replicate step 3 logic with full output
local_candidates = {p for p in only_local if not local_files[p].get("is_dir")}
cloud_candidates = {p for p in only_cloud if not cloud_files[p].get("is_dir")}

cloud_hash_map = {}
for cp in cloud_candidates:
    m = meta.get_file_info(cp)
    if m and m.get("content_hash"):
        cloud_hash_map[cp] = m["content_hash"]

cloud_names = {normalize_filename(os.path.basename(cp)).lower() for cp in cloud_candidates}
local_hash_map = {}
hash_to_local = defaultdict(list)

for lp in local_candidates:
    norm_name = normalize_filename(os.path.basename(lp)).lower()
    if norm_name not in cloud_names:
        continue
    abs_path = local_files[lp]["path"]
    h = hash_cache.get(abs_path) or compute_content_hash(abs_path)
    if h:
        local_hash_map[lp] = h
        hash_to_local[h].append(lp)

# Step 3: hash matching
matched = []
matched_local = set()
matched_cloud = set()
for cp, cloud_hash in cloud_hash_map.items():
    if cp in matched_cloud:
        continue
    cands = hash_to_local.get(cloud_hash, [])
    for lp in cands:
        if lp in matched_local:
            continue
        matched.append((lp, cp, "content_hash"))
        matched_local.add(lp)
        matched_cloud.add(cp)
        break

print(f"Hash 匹配: {len(matched)} 个")
for lp, cp, reason in matched:
    print(f"  {lp} ↔ {cp}")

# Step 4: filename matching
remaining_local = local_candidates - matched_local
remaining_cloud = cloud_candidates - matched_cloud

cloud_name_index = defaultdict(list)
for cp in remaining_cloud:
    norm = normalize_filename(os.path.basename(cp)).lower()
    cloud_name_index[norm].append(cp)

_MAX_NAME_CANDIDATES = 10
name_matches = []
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
        cp_meta = meta.get_file_info(best_cp)
        cp_hash = cp_meta.get("content_hash") if cp_meta else None
        if lp_hash and cp_hash and lp_hash != cp_hash:
            if not (cp_meta and cp_meta.get("file_id")):
                print(f"  SKIPPED (content_changed, no file_id): {lp} ↔ {best_cp}")
                continue
            reason = f"filename+ancestor(depth={best_depth},content_changed)"
        else:
            reason = f"filename+ancestor(depth={best_depth})"
        name_matches.append((lp, best_cp, reason))
        matched_local.add(lp)
        matched_cloud.add(best_cp)

print(f"\nFilename 匹配: {len(name_matches)} 个")
for lp, cp, reason in name_matches:
    local_mtime = local_files[lp].get("mtime", 0)
    cloud_mtime = cloud_files[cp].get("mtime", 0)
    local_wins = local_mtime >= cloud_mtime
    direction = "本地更新→上传" if local_wins else "云端更新→本地跟随"
    print(f"  {lp} ↔ {cp}")
    print(f"    {reason}, local_mtime={local_mtime}, cloud_mtime={cloud_mtime}")
    print(f"    方向: {direction}")

# Show remaining unmatched
print(f"\n未匹配的 only_local (仍需上传):")
unmatched_local = local_candidates - matched_local
for p in sorted(unmatched_local):
    print(f"  {p}")

print(f"\n未匹配的 only_cloud (仍需下载):")
unmatched_cloud = cloud_candidates - matched_cloud
for p in sorted(unmatched_cloud):
    print(f"  {p}")
