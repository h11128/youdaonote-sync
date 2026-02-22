"""精确定位：手动运行三步检测，追踪 only_cloud 变化"""
import os
import sys
import asyncio
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.metadata import SyncMetadata
from src.sync.scanner import async_scan_cloud, scan_local
from src.sync.decision import calibrate_metadata
from src.sync.moves import (
    _detect_cloud_moves, _detect_name_mismatches, _detect_cross_dir_duplicates,
    normalize_filename, _common_ancestor_depth,
)

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

# 准备输入
cloud_id_to_path = {
    ci["id"]: cp
    for cp, ci in cloud_files.items()
    if not ci.get("is_dir") and ci.get("id")
}

only_local = set(local_files.keys()) - set(cloud_files.keys())
only_cloud = set(cloud_files.keys()) - set(local_files.keys())

targets = {
    "内在世界/计划和总结/中期计划/2025年H2总结.md",
    "内在世界/计划和总结/阶段总结/2025年年终总结.md",
}

print(f"[初始] targets 在 only_cloud: {targets & only_cloud}")
print(f"[初始] only_local 数量: {len(only_local)}, only_cloud 数量: {len(only_cloud)}")

# === Step 1 ===
count1 = _detect_cloud_moves(
    only_local, only_cloud, cloud_id_to_path,
    cloud_files, local_files, meta, LOCAL_DIR, dry_run=True)
print(f"\n[Step 1 后] cloud_moves 匹配了 {count1} 个")
print(f"[Step 1 后] targets 在 only_cloud: {targets & only_cloud}")
print(f"[Step 1 后] only_local: {len(only_local)}, only_cloud: {len(only_cloud)}")

# 检查 target 被谁消耗了
for t in targets:
    if t not in only_cloud:
        print(f"  *** {t} 在 step 1 后已不在 only_cloud!")
        # 找谁把它匹配走了
        if t in cloud_files:
            cid = cloud_files[t].get("id")
            # 找 metadata 中哪个 local 文件有这个 file_id
            matched_local = meta.find_by_file_id(cid) if hasattr(meta, 'find_by_file_id') else None
            print(f"    cloud_id={cid}")
            print(f"    metadata find_by_file_id: {matched_local}")

# === Step 2 ===
count2 = _detect_name_mismatches(only_local, only_cloud, cloud_files, local_files)
print(f"\n[Step 2 后] name_mismatches 匹配了 {count2} 个")
print(f"[Step 2 后] targets 在 only_cloud: {targets & only_cloud}")

for t in targets:
    if t not in only_cloud:
        print(f"  *** {t} 在 step 2 后已不在 only_cloud!")

# === Step 3 ===
print(f"\n[Step 3 前] 检查输入条件:")
local_cands = {p for p in only_local if not local_files[p].get("is_dir")}
cloud_cands = {p for p in only_cloud if not cloud_files[p].get("is_dir")}
print(f"  local_candidates: {len(local_cands)}")
print(f"  cloud_candidates: {len(cloud_cands)}")

# 手动检查 step 3 的 filename 匹配
from collections import defaultdict
cloud_name_index = defaultdict(list)
for cp in cloud_cands:
    norm = normalize_filename(os.path.basename(cp)).lower()
    cloud_name_index[norm].append(cp)

test_locals = [
    "内在世界/计划和总结/2025/2025年H2总结.md",
    "内在世界/计划和总结/2025/2025年年终总结.md",
]
for lp in test_locals:
    if lp not in local_cands:
        print(f"  {lp}: 不在 local_candidates!")
        continue
    norm = normalize_filename(os.path.basename(lp)).lower()
    matches = cloud_name_index.get(norm, [])
    print(f"  {lp}: norm='{norm}', cloud matches={matches}")
    for cp in matches:
        depth = _common_ancestor_depth(lp, cp)
        print(f"    → {cp}, depth={depth}")

count3, pending = _detect_cross_dir_duplicates(
    only_local, only_cloud,
    cloud_files, local_files, meta, LOCAL_DIR, dry_run=True,
    hash_cache=hash_cache)
print(f"\n[Step 3 后] cross_dir 匹配了 {count3} 个, pending_deletes={len(pending)}")

# 最终上传候选
final_only_local = {p for p in only_local if not local_files[p].get("is_dir")}
print(f"\n最终上传候选 (非目录): {len(final_only_local)}")
for p in sorted(final_only_local):
    print(f"  {p}")
