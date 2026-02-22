"""实际测试扫描缓存机制：
1. 第一次 dry-run — 全量 HTTP 扫描，建立缓存
2. 第二次 dry-run — 应命中缓存，跳过 HTTP 扫描
3. 对比两次结果是否一致
"""
import os
import sys
import time
import logging

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.engine import SyncManager
from src.sync.utils import SyncDirection, SyncAction, filter_by_direction
from src.sync.metadata import SyncMetadata

logging.basicConfig(level=logging.INFO, format="%(levelname)-5s %(message)s")

LOCAL_DIR = "E:/Projects/notes"

def login():
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        sys.exit(1)
    return api

def run_collect(api, meta, label):
    mgr = SyncManager(api, LOCAL_DIR, meta)
    cloud_dir_id = api.get_root_id()
    t0 = time.perf_counter()
    items = mgr.collect_items(cloud_dir_id, "", dry_run=True)
    elapsed = time.perf_counter() - t0
    items, skip_count = filter_by_direction(items, SyncDirection.BOTH)

    actions = {}
    for item in items:
        a = item.action.name
        actions[a] = actions.get(a, 0) + 1

    print(f"\n{'='*60}")
    print(f"  [{label}] 耗时: {elapsed:.2f}s")
    print(f"  总项数: {len(items)}, 跳过: {skip_count}")
    print(f"  Actions: {actions}")
    print(f"  缓存 version: {meta.get_state('last_cloud_version')}")
    print(f"  缓存时间: {meta.get_state('last_scan_time')}")
    print(f"{'='*60}")
    return items, elapsed

def main():
    api = login()
    meta = SyncMetadata()

    print("\n" + "="*60)
    print("  缓存状态（运行前）")
    print("="*60)
    ver = meta.get_state("last_cloud_version")
    scan_time = meta.get_state("last_scan_time")
    files_count = len(meta.get_all_files())
    dirs_count = len(meta.get_all_dirs())
    print(f"  version: {ver}")
    print(f"  scan_time: {scan_time}")
    print(f"  缓存文件数: {files_count}")
    print(f"  缓存目录数: {dirs_count}")

    # --- Round 1: 如果没有缓存，会全量扫描 ---
    items1, t1 = run_collect(api, meta, "第 1 次 (可能全量)")

    # --- Round 2: 应该命中缓存 ---
    items2, t2 = run_collect(api, meta, "第 2 次 (应命中缓存)")

    # --- 对比 ---
    print(f"\n{'='*60}")
    print("  对比结果")
    print("="*60)

    paths1 = {i.relative_path: i.action.name for i in items1}
    paths2 = {i.relative_path: i.action.name for i in items2}

    only_in_1 = set(paths1.keys()) - set(paths2.keys())
    only_in_2 = set(paths2.keys()) - set(paths1.keys())
    diff_action = {p for p in paths1 if p in paths2 and paths1[p] != paths2[p]}

    print(f"  第 1 次项数: {len(paths1)}")
    print(f"  第 2 次项数: {len(paths2)}")
    print(f"  只在第 1 次: {len(only_in_1)}")
    print(f"  只在第 2 次: {len(only_in_2)}")
    print(f"  action 不同: {len(diff_action)}")
    print(f"  速度提升: {t1/t2:.1f}x ({t1:.2f}s → {t2:.2f}s)")

    if only_in_1:
        print(f"\n  只在第 1 次的前 10 个:")
        for p in sorted(only_in_1)[:10]:
            print(f"    {paths1[p]:10s} {p}")
    if only_in_2:
        print(f"\n  只在第 2 次的前 10 个:")
        for p in sorted(only_in_2)[:10]:
            print(f"    {paths2[p]:10s} {p}")
    if diff_action:
        print(f"\n  action 不同的前 10 个:")
        for p in sorted(diff_action)[:10]:
            print(f"    {p}: {paths1[p]} → {paths2[p]}")

    if not only_in_1 and not only_in_2 and not diff_action:
        print("\n  ✓ 两次结果完全一致！缓存机制工作正常。")

    meta.close()

if __name__ == "__main__":
    main()
