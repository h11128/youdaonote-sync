"""诊断：为什么这些上传候选没有被移动检测捕获？"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.engine import SyncManager
from src.sync.utils import SyncDirection, SyncAction, filter_by_direction
from src.sync.metadata import SyncMetadata
from src.sync.moves import normalize_filename

LOCAL_DIR = "E:/Projects/notes"

api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
error = api.login_by_cookies()
if error:
    print(f"登录失败: {error}")
    sys.exit(1)

meta = SyncMetadata()
mgr = SyncManager(api, LOCAL_DIR, meta)
cloud_dir_id = api.get_root_id()

# 复现 collect_items 的前几步（手动做，方便调试）
import asyncio
from src.sync.scanner import async_scan_cloud, scan_local, matches_selective
from src.sync.decision import calibrate_metadata
from src.sync.moves import reconcile_moves

async def scan():
    async with api.create_async_client() as aclient:
        cloud_files = await async_scan_cloud(
            aclient, api.DIR_MES_URL, api.DIR_PAGE_SIZE,
            api.cstk, cloud_dir_id, "", mgr.SCAN_WORKERS)
    local_files = scan_local(LOCAL_DIR, "", [], [])
    return cloud_files, local_files

cloud_files, local_files = asyncio.run(scan())

print(f"云端文件数: {len(cloud_files)}")
print(f"本地文件数: {len(local_files)}")

# 找到上传候选（只在本地有的文件）
only_local = set(local_files.keys()) - set(cloud_files.keys())
only_cloud = set(cloud_files.keys()) - set(local_files.keys())
both = set(local_files.keys()) & set(cloud_files.keys())

print(f"\n只在本地: {len(only_local)}")
print(f"只在云端: {len(only_cloud)}")
print(f"两端都有: {len(both)}")

# 这些文件是上传候选
upload_candidates = [
    "内在世界/日记/2025/关于Cindy的观察和感想.md",
    "内在世界/日记/2025/安卓手机与录音设备购买推荐.md",
    "内在世界/日记/2025/手机与录音设备需求提取.md",
    "内在世界/日记/2025/无标题笔记.md",
    "内在世界/日记/2025/硬件采购清单.md",
    "内在世界/日记/2025/给Cindy的反馈-2025年度-v2.md",
    "内在世界/日记/2025/给Cindy的反馈-2025年度.md",
    "内在世界/日记/2025/设备购买需求总结.md",
    "内在世界/日记/2025/语音日志系统设计文档.md",
    "内在世界/计划和总结/2025/2025年H2总结.md",
    "内在世界/计划和总结/2025/2025年年终总结.md",
]

print("\n" + "=" * 80)
print("  诊断上传候选：为什么没被移动检测捕获？")
print("=" * 80)

for lp in upload_candidates:
    basename = os.path.basename(lp)
    norm_name = normalize_filename(basename).lower()

    print(f"\n--- {lp} ---")
    print(f"  在 only_local: {lp in only_local}")
    print(f"  在 cloud_files: {lp in cloud_files}")
    print(f"  在 local_files: {lp in local_files}")

    # 检查 metadata 中的 file_id
    info = meta.get_file_info(lp)
    if info:
        print(f"  metadata: file_id={info.get('file_id', 'N/A')}, "
              f"cloud_mtime={info.get('cloud_mtime', 0)}, "
              f"content_hash={info.get('content_hash', 'N/A')[:20] if info.get('content_hash') else 'N/A'}")
    else:
        print(f"  metadata: 无")

    # 在云端查找同名文件
    cloud_matches = [cp for cp in cloud_files if os.path.basename(cp).lower() == basename.lower()]
    if cloud_matches:
        print(f"  云端同名文件 ({len(cloud_matches)} 个):")
        for cp in cloud_matches:
            ci = cloud_files[cp]
            print(f"    路径: {cp}")
            print(f"    cloud_id: {ci.get('id', 'N/A')}")
            print(f"    在 only_cloud: {cp in only_cloud}")
            # 检查 metadata
            cp_meta = meta.get_file_info(cp)
            if cp_meta:
                print(f"    cp_metadata: file_id={cp_meta.get('file_id', 'N/A')}, "
                      f"content_hash={cp_meta.get('content_hash', 'N/A')[:20] if cp_meta.get('content_hash') else 'N/A'}")
            else:
                print(f"    cp_metadata: 无")
    else:
        # 扩大搜索：用 normalized name
        cloud_norm_matches = [cp for cp in cloud_files
                              if normalize_filename(os.path.basename(cp)).lower() == norm_name]
        if cloud_norm_matches:
            print(f"  云端 normalized 同名文件 ({len(cloud_norm_matches)} 个):")
            for cp in cloud_norm_matches:
                print(f"    路径: {cp}")
                print(f"    在 only_cloud: {cp in only_cloud}")
        else:
            print(f"  云端无同名文件！")

print("\n" + "=" * 80)
print("  结论")
print("=" * 80)
