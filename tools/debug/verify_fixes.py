"""
验证所有修复的效果

1. 分页去重修复 → 检查 2025 日记目录是否拿全
2. _scan_local 扫所有文件 → 非 .md 文件应被扫到
3. 无扩展名/.clip → .md 映射 → 路径应该匹配
4. 跑一次完整 dry-run → 对比修复前后
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.engine import SyncManager
from src.sync.utils import SyncAction, SyncDirection, filter_by_direction
from src.sync.metadata import SyncMetadata

LOCAL_DIR = "E:/Projects/notes"


def main():
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        return 1

    meta = SyncMetadata()

    # 测试 1：分页去重
    print("=" * 70)
    print("  测试 1: 分页去重 - 2025 日记目录")
    print("=" * 70)
    dir_id = meta.get_dir_id("内在世界/日记/2025")
    if dir_id:
        data = api.get_dir_info_by_id(dir_id)
        entries = data.get("entries", [])
        count = data.get("count", 0)
        names = [e.get("fileEntry", {}).get("name", "") for e in entries]
        unique_names = set(names)
        print(f"  去重后条目数: {count}")
        print(f"  不同文件名数: {len(unique_names)}")

        jan_files = sorted([n for n in unique_names if n.startswith("2025年1月")])
        print(f"  2025年1月 文件数: {len(jan_files)}")
        for n in jan_files[:5]:
            print(f"    {n}")
        if len(jan_files) > 5:
            print(f"    ... 还有 {len(jan_files) - 5} 个")

        jun_files = sorted([n for n in unique_names if n.startswith("2025年6月")])
        print(f"  2025年6月 文件数: {len(jun_files)}")

    # 测试 2: 完整 _collect_items
    print()
    print("=" * 70)
    print("  测试 2: 完整 dry-run（使用 _collect_items）")
    print("=" * 70)

    mgr = SyncManager(api, LOCAL_DIR, meta)
    cloud_dir_id = api.get_root_id()
    items = mgr._collect_items(cloud_dir_id, "")
    items, _ = filter_by_direction(items, SyncDirection.BOTH)

    from collections import Counter
    action_count = Counter()
    upload_dirs = 0
    upload_files = 0
    download_dirs = 0
    download_files = 0

    for item in items:
        action_count[item.action.value] += 1
        if item.action == SyncAction.UPLOAD:
            if item.is_dir:
                upload_dirs += 1
            else:
                upload_files += 1
        elif item.action == SyncAction.DOWNLOAD:
            if item.is_dir:
                download_dirs += 1
            else:
                download_files += 1

    print(f"\n  同步总条目: {len(items)}")
    print(f"\n  动作分布:")
    for action, cnt in sorted(action_count.items()):
        print(f"    {action:12s}: {cnt}")

    print(f"\n  UPLOAD 明细: {upload_files} 个文件 + {upload_dirs} 个目录")
    print(f"  DOWNLOAD 明细: {download_files} 个文件 + {download_dirs} 个目录")

    # 测试 3: 嫌疑文件验证
    print()
    print("=" * 70)
    print("  测试 3: 嫌疑文件验证")
    print("=" * 70)
    suspects = [
        "内在世界/日记/2025/2025年1月10日.md",
        "内在世界/日记/2025/2025年6月8日.md",
        "参考资料/素材/八字/天乙風水命理博客  唐納·川普 - 美國現任總八字.md",
        "参考资料/素材/健康养生/All about slow eating.md",
    ]
    for suspect in suspects:
        match = [i for i in items if i.relative_path == suspect]
        if match:
            item = match[0]
            print(f"  {suspect}")
            print(f"    action={item.action.value}")
        else:
            print(f"  {suspect}")
            print(f"    → 未在结果中（可能是 SKIP 或路径不完全匹配）")

    # 测试 4: 上传文件分类
    print()
    print("=" * 70)
    print("  测试 4: 上传文件样本和扩展名分布")
    print("=" * 70)
    uploads = [i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir]
    ext_count = Counter()
    for item in uploads:
        _, ext = os.path.splitext(item.relative_path)
        ext_count[ext or "(无扩展名)"] += 1
    print(f"  上传文件扩展名分布:")
    for ext, cnt in sorted(ext_count.items(), key=lambda x: -x[1]):
        print(f"    {ext:20s}: {cnt}")

    # 测试 5: 下载文件样本
    print()
    print("=" * 70)
    print("  测试 5: 下载文件扩展名分布")
    print("=" * 70)
    downloads = [i for i in items if i.action == SyncAction.DOWNLOAD and not i.is_dir]
    dl_ext = Counter()
    for item in downloads:
        _, ext = os.path.splitext(item.relative_path)
        dl_ext[ext or "(无扩展名)"] += 1
    print(f"  下载文件扩展名分布:")
    for ext, cnt in sorted(dl_ext.items(), key=lambda x: -x[1]):
        print(f"    {ext:20s}: {cnt}")

    # 2025 日记的上传/下载情况
    print()
    print("=" * 70)
    print("  测试 6: 2025 日记同步状态")
    print("=" * 70)
    diary_2025 = [i for i in items if i.relative_path.startswith("内在世界/日记/2025/")]
    diary_actions = Counter()
    for item in diary_2025:
        diary_actions[item.action.value] += 1
    print(f"  2025 日记总条目: {len(diary_2025)}")
    for action, cnt in sorted(diary_actions.items()):
        print(f"    {action:12s}: {cnt}")

    # 不是 skip 的 2025 日记
    diary_not_skip = [i for i in diary_2025 if i.action != SyncAction.SKIP]
    if diary_not_skip:
        print(f"\n  非 SKIP 的 2025 日记 ({len(diary_not_skip)} 个):")
        for item in sorted(diary_not_skip, key=lambda x: x.relative_path)[:20]:
            print(f"    {item.action.value:8s} {item.relative_path}")
        if len(diary_not_skip) > 20:
            print(f"    ... 还有 {len(diary_not_skip) - 20} 个")

    return 0


if __name__ == "__main__":
    sys.exit(main())
