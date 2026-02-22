"""诊断第二轮：跟踪 reconcile_moves 内部流程"""
import os
import sys
import asyncio
import logging
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

logging.basicConfig(level=logging.DEBUG, format='%(message)s')

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.metadata import SyncMetadata
from src.sync.scanner import async_scan_cloud, scan_local
from src.sync.decision import calibrate_metadata
from src.sync.moves import (
    reconcile_moves, normalize_filename, _common_ancestor_depth,
    _detect_cloud_moves, _detect_name_mismatches, _detect_cross_dir_duplicates,
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

# 在 calibrate 之前先记录状态
hash_cache = {}
calibrate_metadata(meta, cloud_files, local_files, hash_cache=hash_cache)

only_local = set(local_files.keys()) - set(cloud_files.keys())
only_cloud = set(cloud_files.keys()) - set(local_files.keys())

print("\n" + "=" * 80)
print("  类型 B 诊断: 两端都在 only 集合，为什么跨目录检测没捕获？")
print("=" * 80)

# 手动检查 _detect_cross_dir_duplicates 的输入
target_locals = [
    "内在世界/计划和总结/2025/2025年H2总结.md",
    "内在世界/计划和总结/2025/2025年年终总结.md",
]

target_clouds = [
    "内在世界/计划和总结/中期计划/2025年H2总结.md",
    "内在世界/计划和总结/阶段总结/2025年年终总结.md",
]

for lp, expected_cp in zip(target_locals, target_clouds):
    basename = os.path.basename(lp)
    norm = normalize_filename(basename).lower()
    print(f"\n--- {lp} ---")
    print(f"  在 only_local: {lp in only_local}")
    print(f"  is_dir: {local_files.get(lp, {}).get('is_dir', 'N/A')}")

    print(f"\n  期望匹配的云端文件: {expected_cp}")
    print(f"  在 only_cloud: {expected_cp in only_cloud}")
    print(f"  is_dir: {cloud_files.get(expected_cp, {}).get('is_dir', 'N/A')}")

    depth = _common_ancestor_depth(lp, expected_cp)
    print(f"  共同祖先深度: {depth}")

    # 检查 cloud_name_index 是否会包含这个文件
    local_candidates = {p for p in only_local if not local_files[p].get("is_dir")}
    cloud_candidates = {p for p in only_cloud if not cloud_files[p].get("is_dir")}
    print(f"\n  local_candidates 包含此文件: {lp in local_candidates}")
    print(f"  cloud_candidates 包含期望云端: {expected_cp in cloud_candidates}")

    cloud_norm = normalize_filename(os.path.basename(expected_cp)).lower()
    print(f"  本地 norm name: '{norm}'")
    print(f"  云端 norm name: '{cloud_norm}'")
    print(f"  名字匹配: {norm == cloud_norm}")

    # 检查是不是在 step 1/2 中被消耗了
    cloud_id_to_path = {
        ci["id"]: cp
        for cp, ci in cloud_files.items()
        if not ci.get("is_dir") and ci.get("id")
    }

    # step 1 会消耗哪些？
    lp_meta = meta.get_file_info(lp)
    lp_fid = lp_meta.get("file_id") if lp_meta else None
    print(f"\n  step 1 (file_id): lp file_id='{lp_fid}'")
    if lp_fid:
        mapped = cloud_id_to_path.get(lp_fid)
        print(f"    file_id 在 cloud_id_to_path: {mapped}")

print("\n" + "=" * 80)
print("  类型 A 诊断: 云端文件不在 only_cloud（两端都有）")
print("=" * 80)

type_a_cases = [
    ("内在世界/日记/2025/关于Cindy的观察和感想.md",
     "存档记录/已完成项目/self-review/关于Cindy的观察和感想.md"),
    ("内在世界/日记/2025/安卓手机与录音设备购买推荐.md",
     "当前事项/新手机和录音/安卓手机与录音设备购买推荐.md"),
    ("内在世界/日记/2025/给Cindy的反馈-2025年度.md",
     "存档记录/已完成项目/self-review/给Cindy的反馈-2025年度.md"),
]

for new_local, old_cloud in type_a_cases:
    print(f"\n--- 本地新路径: {new_local} ---")
    print(f"    云端旧路径: {old_cloud}")
    local_at_old = old_cloud in local_files
    cloud_at_old = old_cloud in cloud_files
    local_at_new = new_local in local_files
    cloud_at_new = new_local in cloud_files
    print(f"    旧路径: local={local_at_old}, cloud={cloud_at_old} → {'both' if local_at_old and cloud_at_old else 'mismatch'}")
    print(f"    新路径: local={local_at_new}, cloud={cloud_at_new} → {'only_local' if local_at_new and not cloud_at_new else 'both' if local_at_new and cloud_at_new else '?'}")

    if local_at_old:
        old_local_info = local_files[old_cloud]
        print(f"    旧路径本地文件 mtime: {old_local_info.get('mtime', 'N/A')}")
        old_local_path = old_local_info.get("path", "")
        print(f"    旧路径本地文件存在: {os.path.exists(old_local_path)}")
    if local_at_new:
        new_local_info = local_files[new_local]
        print(f"    新路径本地文件 mtime: {new_local_info.get('mtime', 'N/A')}")
