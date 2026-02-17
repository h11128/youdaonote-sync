"""
本地文件和目录分析工具 — 合并了 3 个分析脚本。

子命令:
  extra       统计本地非 .md 文件（.note、images、其他格式）
  dir-match   对比本地/云端目录匹配情况，找有 dir_id 但云端扫描不到的
  dir-upload  分析目录被标记为 UPLOAD 的原因

用法:
  python .local-scripts/analyze_local.py extra
  python .local-scripts/analyze_local.py dir-match
  python .local-scripts/analyze_local.py dir-upload
"""

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

LOCAL_DIR = "E:/Projects/notes"


# ===== 子命令：extra =====

def cmd_extra(args):
    """统计本地非 .md 文件、.note/.md 配对、images 扩展名分布。"""
    note_files = []
    image_files = []
    other_non_md = []

    for root, dirs, filenames in os.walk(LOCAL_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in filenames:
            if f.startswith("."):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, LOCAL_DIR).replace("\\", "/")
            _, ext = os.path.splitext(f)

            if ext == ".note":
                note_files.append(rel)
            elif "/images/" in rel or "/attachments/" in rel:
                image_files.append(rel)
            elif ext != ".md" and ext != "":
                other_non_md.append(rel)

    print("=" * 70)
    print("  本地非 .md 文件统计")
    print("=" * 70)
    print(f"  .note 文件: {len(note_files)}")
    print(f"  images/attachments 下的文件: {len(image_files)}")
    print(f"  其他非 .md 文件: {len(other_non_md)}")

    # .note vs .md 配对
    print()
    print("=" * 70)
    print("  .note 文件 vs .md 对照")
    print("=" * 70)
    has_md_pair = 0
    no_md_pair = 0
    for i, note in enumerate(note_files):
        md_version = note[:-5] + ".md"
        md_exists = os.path.exists(os.path.join(LOCAL_DIR, md_version))
        if i < 10:
            status = "有 .md" if md_exists else "无 .md"
            print(f"  {status}  {note}")
        if md_exists:
            has_md_pair += 1
        else:
            no_md_pair += 1
    print(f"\n  总计: {has_md_pair} 个 .note 有对应 .md, {no_md_pair} 个没有")

    # 其他非 .md 文件
    print()
    print("=" * 70)
    print("  其他非 .md 非 .note 非 images 文件")
    print("=" * 70)
    for f in other_non_md[:20]:
        print(f"  {f}")
    if len(other_non_md) > 20:
        print(f"  ... 还有 {len(other_non_md) - 20} 个")

    # images 扩展名分布
    print()
    print("=" * 70)
    print("  images/attachments 文件扩展名分布")
    print("=" * 70)
    img_ext = Counter()
    for f in image_files:
        _, ext = os.path.splitext(f)
        img_ext[ext] += 1
    for ext, cnt in sorted(img_ext.items(), key=lambda x: -x[1]):
        print(f"    {ext:20s}: {cnt}")


# ===== 子命令：dir-match =====

def cmd_dir_match(args):
    """对比本地/云端目录匹配，找有 dir_id 但云端扫描不到的。"""
    from youdaonote_sync.api import YoudaoNoteApi
    from youdaonote_sync.cookies import CookieManager
    from youdaonote_sync.sync.scanner import scan_cloud, scan_local
    from youdaonote_sync.sync.metadata import SyncMetadata

    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        return 1

    meta = SyncMetadata()
    cloud_dir_id = api.get_root_id()

    cloud_files = scan_cloud(api, cloud_dir_id, "")
    local_files = scan_local(LOCAL_DIR, "")

    cloud_dir_paths = {k for k, v in cloud_files.items() if v.get("is_dir")}

    # 本地有但云端没有的目录
    only_local_dirs = set()
    for rel in local_files:
        if local_files[rel].get("is_dir") and rel not in cloud_dir_paths:
            only_local_dirs.add(rel)

    has_id = [d for d in only_local_dirs if meta.get_dir_id(d)]
    no_id = [d for d in only_local_dirs if not meta.get_dir_id(d)]

    print("=" * 60)
    print(f"  目录匹配分析")
    print("=" * 60)
    print(f"  云端扫描返回的目录数: {len(cloud_dir_paths)}")
    print(f"  本地扫描返回的目录数: "
          f"{sum(1 for v in local_files.values() if v.get('is_dir'))}")
    print(f"\n  本地有但云端扫描无:")
    print(f"    有 dir_id: {len(has_id)}")
    print(f"    无 dir_id: {len(no_id)}")

    # 抽样验证
    print(f"\n  抽样验证 5 个有 dir_id 的目录:")
    for d in sorted(has_id)[:5]:
        did = meta.get_dir_id(d)
        parent = os.path.dirname(d).replace("\\", "/")
        parent_in_cloud = parent in cloud_dir_paths or parent == ""
        print(f"    {d}")
        print(f"      dir_id: {did[:30]}...")
        print(f"      父目录 '{parent}' 在云端: {parent_in_cloud}")

    # 检查这些目录是否在 cloud_files 中（不区分 is_dir）
    print(f"\n  前 10 个有 dir_id 但云端没有的目录:")
    for d in sorted(has_id)[:10]:
        in_cloud = d in cloud_files
        print(f"    {d}")
        print(f"      在 cloud_files: {in_cloud}")
        if in_cloud:
            print(f"      cloud_files[d] = {cloud_files[d]}")


# ===== 子命令：dir-upload =====

def cmd_dir_upload(args):
    """分析目录被标记为 UPLOAD 的原因。"""
    from youdaonote_sync.api import YoudaoNoteApi
    from youdaonote_sync.cookies import CookieManager
    from youdaonote_sync.sync.engine import SyncManager
    from youdaonote_sync.sync.utils import SyncAction, SyncDirection, filter_by_direction
    from youdaonote_sync.sync.scanner import scan_cloud, scan_local
    from youdaonote_sync.sync.metadata import SyncMetadata

    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        return 1

    meta = SyncMetadata()
    mgr = SyncManager(api, LOCAL_DIR, meta)
    cloud_dir_id = api.get_root_id()

    cloud_files = scan_cloud(api, cloud_dir_id, "")
    local_files = scan_local(LOCAL_DIR, "")

    items = mgr._collect_items(cloud_dir_id, "")
    items = filter_by_direction(items, SyncDirection.BOTH)

    upload_dirs = [i for i in items if i.action == SyncAction.UPLOAD and i.is_dir]

    print(f"被判为 UPLOAD 的目录总数: {len(upload_dirs)}")

    # 分类
    both_sides = []
    local_only = []
    for d in upload_dirs:
        rel = d.relative_path
        in_cloud = rel in cloud_files
        in_local = rel in local_files
        has_did = meta.get_dir_id(rel) is not None
        entry = {"rel": rel, "in_cloud": in_cloud, "in_local": in_local,
                 "has_dir_id": has_did}
        if in_cloud and in_local:
            both_sides.append(entry)
        elif in_local and not in_cloud:
            local_only.append(entry)

    print(f"\n  两端都有:     {len(both_sides)}")
    print(f"  只有本地:     {len(local_only)}")

    if both_sides:
        print(f"\n  --- 两端都有却判为 UPLOAD ---")
        for d in both_sides[:5]:
            print(f"    {d['rel']}")
            cloud = cloud_files[d["rel"]]
            local = local_files[d["rel"]]
            file_meta = meta.get_file_info(d["rel"])
            print(f"      cloud_mtime={cloud.get('mtime')}, "
                  f"local_mtime={local.get('mtime')}")
            print(f"      meta: {file_meta}")

    # 只有本地的目录分析
    images_count = sum(1 for d in local_only
                       if d["rel"].endswith(("/images", "/attachments")))
    has_did_count = sum(1 for d in local_only if d["has_dir_id"])
    print(f"\n  只有本地的目录按类型:")
    print(f"    images/attachments: {images_count}")
    print(f"    其他:              {len(local_only) - images_count}")
    print(f"    有 dir_id:         {has_did_count}")
    print(f"    无 dir_id:         {len(local_only) - has_did_count}")

    # 验证 dir_id 是否在云端
    if has_did_count > 0:
        cloud_dir_ids = {}
        for rel, info in cloud_files.items():
            if info.get("is_dir") and info.get("id"):
                cloud_dir_ids[info["id"]] = rel

        print(f"\n  验证 dir_id 是否在云端扫描结果中:")
        for d in local_only:
            if d["has_dir_id"]:
                did = meta.get_dir_id(d["rel"])
                cloud_rel = cloud_dir_ids.get(did)
                print(f"    {d['rel']}")
                if cloud_rel:
                    print(f"      路径不同! 云端: {cloud_rel}")
                else:
                    print(f"      dir_id 在云端扫描结果中不存在")


# ===== 主入口 =====

def main():
    parser = argparse.ArgumentParser(
        description="本地文件和目录分析工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="子命令")

    sub.add_parser("extra", help="统计本地非 .md 文件")
    sub.add_parser("dir-match", help="对比本地/云端目录匹配情况")
    sub.add_parser("dir-upload", help="分析目录被标记为 UPLOAD 的原因")

    args = parser.parse_args()

    dispatch = {
        "extra": cmd_extra,
        "dir-match": cmd_dir_match,
        "dir-upload": cmd_dir_upload,
    }

    if args.command is None:
        parser.print_help()
        return 1

    return dispatch[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
