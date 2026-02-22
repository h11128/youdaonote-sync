"""诊断缓存重建 vs 全量扫描的差异"""
import os
import sys
import logging

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
logging.basicConfig(level=logging.WARNING)

from src.sync.metadata import SyncMetadata

meta = SyncMetadata()
all_files = meta.get_all_files()
all_dirs = meta.get_all_dirs()

no_fid = [p for p, info in all_files.items() if not info.get("file_id")]
zero_mtime = [p for p, info in all_files.items()
              if info.get("file_id") and info.get("cloud_mtime", 0) == 0]
has_fid = [p for p, info in all_files.items() if info.get("file_id")]

print(f"总文件数: {len(all_files)}")
print(f"有 file_id: {len(has_fid)}")
print(f"无 file_id: {len(no_fid)}")
print(f"有 file_id 但 cloud_mtime=0: {len(zero_mtime)}")
print(f"总目录数: {len(all_dirs)}")

if no_fid:
    print(f"\n无 file_id 的前 5 个:")
    for p in sorted(no_fid)[:5]:
        print(f"  {p}: {all_files[p]}")

if zero_mtime:
    print(f"\ncloud_mtime=0 的前 5 个:")
    for p in sorted(zero_mtime)[:5]:
        info = all_files[p]
        print(f"  {p}: fid={info.get('file_id', '')[:20]}... mtime={info.get('cloud_mtime')}")

local_dir = "E:/Projects/notes"
cached_only = []
for p, info in all_files.items():
    if not info.get("file_id"):
        continue
    local_path = os.path.join(local_dir, p)
    if not os.path.exists(local_path):
        cached_only.append(p)

print(f"\n有 file_id 但本地不存在: {len(cached_only)}")
if cached_only:
    print(f"  前 10 个:")
    for p in sorted(cached_only)[:10]:
        print(f"    {p}")

meta.close()
