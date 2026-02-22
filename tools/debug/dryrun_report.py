"""
Dry-run 报告工具 — 合并了 6 个原始脚本的功能。

子命令:
  summary     按目录分组的上传/下载/冲突统计 + 与上次对比
  list        列出所有非 SKIP 项，标注原因（本地新/云端新/…）
  analyze     按 action/扩展名/元数据分组统计
  edge-cases  边界情况分析（有 mtime 却被 download、纯本地 upload 等）
  export      将差异文件列表写入文件
  full        综合 Markdown 报告：汇总以上所有分析结果，写入 .md 文件

用法:
  python tools/debug/dryrun_report.py summary
  python tools/debug/dryrun_report.py list
  python tools/debug/dryrun_report.py export -o report.txt
  python tools/debug/dryrun_report.py full
  python tools/debug/dryrun_report.py full -o my_report.md
"""

import argparse
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.engine import SyncManager
from src.sync.utils import SyncDirection, SyncAction, filter_by_direction
from src.sync.metadata import SyncMetadata

LOCAL_DIR = "E:/Projects/notes"


# ===== 共用初始化 =====

def _init():
    """登录并返回 (api, meta, mgr, items)。"""
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        sys.exit(1)

    meta = SyncMetadata()
    mgr = SyncManager(api, LOCAL_DIR, meta)
    cloud_dir_id = api.get_root_id()
    items = mgr.collect_items(cloud_dir_id, "")
    items, _ = filter_by_direction(items, SyncDirection.BOTH)
    return api, meta, mgr, items


def _classify(items):
    """将 items 按 action 和 is_dir 分类，返回字典。"""
    upload_files = sorted([i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir],
                          key=lambda x: x.relative_path)
    upload_dirs = sorted([i for i in items if i.action == SyncAction.UPLOAD and i.is_dir],
                         key=lambda x: x.relative_path)
    download_files = sorted([i for i in items if i.action == SyncAction.DOWNLOAD and not i.is_dir],
                            key=lambda x: x.relative_path)
    download_dirs = sorted([i for i in items if i.action == SyncAction.DOWNLOAD and i.is_dir],
                           key=lambda x: x.relative_path)
    conflict_items = sorted([i for i in items if i.action == SyncAction.CONFLICT],
                            key=lambda x: x.relative_path)
    skip_count = sum(1 for i in items if i.action == SyncAction.SKIP)
    return {
        "upload_files": upload_files,
        "upload_dirs": upload_dirs,
        "download_files": download_files,
        "download_dirs": download_dirs,
        "conflicts": conflict_items,
        "skip_count": skip_count,
    }


# ===== 子命令：summary =====

def cmd_summary(args, _ctx=None):
    """按目录分组输出 upload/download/conflict 统计 + 与上次对比。"""
    _, meta, _, items = _ctx or _init()
    c = _classify(items)

    # 按 action/type 计数
    stats = Counter()
    for item in items:
        key = f"{item.action.value}_{'dir' if item.is_dir else 'file'}"
        stats[key] += 1

    print("=" * 60)
    print("  Dry-Run 统计")
    print("=" * 60)
    total = 0
    for key in sorted(stats.keys()):
        print(f"  {key:25s}: {stats[key]:5d}")
        total += stats[key]
    print(f"  {'总计':25s}: {total:5d}")

    # 上传文件按顶层目录分组
    print()
    print("=" * 60)
    print(f"  上传文件 ({len(c['upload_files'])} 个)")
    print("=" * 60)
    upload_by_top = Counter()
    for item in c["upload_files"]:
        top = item.relative_path.split("/")[0]
        upload_by_top[top] += 1
    for top, cnt in sorted(upload_by_top.items(), key=lambda x: -x[1]):
        sub = [i for i in c["upload_files"]
               if i.relative_path.startswith(top + "/") or i.relative_path == top]
        print(f"  {top}: {cnt}")
        for si in sub[:5]:
            print(f"    {'[目录]' if si.is_dir else ''} {si.relative_path}")
        if len(sub) > 5:
            print(f"    ... 还有 {len(sub) - 5} 个")

    # 下载文件列表
    print()
    print("=" * 60)
    print(f"  下载文件 ({len(c['download_files'])} 个)")
    print("=" * 60)
    for item in c["download_files"]:
        marker = "[目录]" if item.is_dir else ""
        print(f"  {marker} {item.relative_path}")

    # 上传/下载目录示例
    if c["upload_dirs"]:
        print()
        print(f"  上传目录示例 ({len(c['upload_dirs'])}):")
        for d in c["upload_dirs"][:10]:
            has_did = meta.get_dir_id(d.relative_path) is not None
            print(f"    {d.relative_path}  (dir_id={'有' if has_did else '无'})")
        if len(c["upload_dirs"]) > 10:
            print(f"    ... 还有 {len(c['upload_dirs']) - 10} 个")

    if c["download_dirs"]:
        print()
        print(f"  下载目录 ({len(c['download_dirs'])}):")
        for d in c["download_dirs"]:
            print(f"    {d.relative_path}")

    if c["conflicts"]:
        print()
        print(f"  冲突 ({len(c['conflicts'])}):")
        for item in c["conflicts"]:
            print(f"    {item.relative_path}")


# ===== 子命令：list =====

def cmd_list(args, _ctx=None):
    """列出所有非 SKIP 项，标注原因。"""
    _, meta, _, items = _ctx or _init()
    c = _classify(items)

    # 上传文件
    print("=" * 70)
    print(f"  上传文件 ({len(c['upload_files'])} 个)")
    print("=" * 70)
    for i, item in enumerate(c["upload_files"], 1):
        info = meta.get_file_info(item.relative_path)
        cloud_id = info.get("file_id", "") if info else ""
        tag = "本地新文件" if not cloud_id else "本地修改"
        print(f"  {i:3d}. [{tag}] {item.relative_path}")

    # 上传目录
    print()
    print("=" * 70)
    print(f"  上传目录 ({len(c['upload_dirs'])} 个)")
    print("=" * 70)
    for i, item in enumerate(c["upload_dirs"], 1):
        did = meta.get_dir_id(item.relative_path)
        tag = "本地新目录" if not did else "有dir_id"
        print(f"  {i:3d}. [{tag}] {item.relative_path}")

    # 下载文件
    print()
    print("=" * 70)
    print(f"  下载文件 ({len(c['download_files'])} 个)")
    print("=" * 70)
    for i, item in enumerate(c["download_files"], 1):
        info = meta.get_file_info(item.relative_path)
        local_exists = os.path.exists(os.path.join(LOCAL_DIR, item.relative_path))
        if info and info.get("local_mtime", 0) == 0:
            tag = "云端有/本地未下载"
        elif local_exists:
            tag = "本地有但未被扫描到"
        else:
            tag = "云端新文件"
        ext = os.path.splitext(item.relative_path)[1] or "(无扩展名)"
        print(f"  {i:3d}. [{tag}] {item.relative_path}  [{ext}]")

    # 下载目录
    if c["download_dirs"]:
        print()
        print("=" * 70)
        print(f"  下载目录 ({len(c['download_dirs'])} 个)")
        print("=" * 70)
        for i, item in enumerate(c["download_dirs"], 1):
            print(f"  {i:3d}. {item.relative_path}")

    # 冲突
    if c["conflicts"]:
        print()
        print("=" * 70)
        print(f"  冲突 ({len(c['conflicts'])} 个)")
        print("=" * 70)
        for i, item in enumerate(c["conflicts"], 1):
            print(f"  {i:3d}. {item.relative_path}")

    # 汇总
    print()
    print("=" * 70)
    print("  汇总")
    print("=" * 70)
    print(f"  上传: {len(c['upload_files'])} 文件 + {len(c['upload_dirs'])} 目录")
    print(f"  下载: {len(c['download_files'])} 文件 + {len(c['download_dirs'])} 目录")
    print(f"  冲突: {len(c['conflicts'])}")
    print(f"  跳过: {c['skip_count']}")
    print(f"  总计: {len(items)}")


# ===== 子命令：analyze =====

def cmd_analyze(args, _ctx=None):
    """按 action/扩展名/元数据分组统计。"""
    _, meta, _, items = _ctx or _init()

    # 基础统计
    action_counts = Counter()
    for item in items:
        key = f"{item.action.value}_{'dir' if item.is_dir else 'file'}"
        action_counts[key] += 1

    print("=" * 60)
    print("  DRY-RUN 分类统计")
    print("=" * 60)
    for key in sorted(action_counts.keys()):
        print(f"  {key:25s}: {action_counts[key]}")
    print()

    # 上传分析
    uploads = [i for i in items if i.action == SyncAction.UPLOAD]
    upload_dirs = [i for i in uploads if i.is_dir]
    upload_files = [i for i in uploads if not i.is_dir]

    print("=" * 60)
    print(f"  上传分析: {len(uploads)} 项 (目录={len(upload_dirs)}, 文件={len(upload_files)})")
    print("=" * 60)

    # 按扩展名
    ext_groups = defaultdict(list)
    for item in upload_files:
        _, ext = os.path.splitext(item.relative_path)
        ext_groups[ext or "(无扩展名)"].append(item.relative_path)

    print("\n  上传文件按扩展名:")
    for ext in sorted(ext_groups, key=lambda e: -len(ext_groups[e])):
        paths = ext_groups[ext]
        print(f"    {ext:15s}: {len(paths)}")
        for p in paths[:3]:
            print(f"      {p}")
        if len(paths) > 3:
            print(f"      ... 还有 {len(paths) - 3} 个")

    # 元数据情况
    print("\n  上传文件的元数据分析:")
    has_meta_no_cloud_id = 0
    has_meta_with_cloud_id = 0
    no_meta = 0
    for item in upload_files:
        info = meta.get_file_info(item.relative_path)
        if info is None:
            no_meta += 1
        elif info.get("file_id"):
            has_meta_with_cloud_id += 1
        else:
            has_meta_no_cloud_id += 1
    print(f"    无元数据:          {no_meta}")
    print(f"    有元数据无cloud_id: {has_meta_no_cloud_id}")
    print(f"    有元数据有cloud_id: {has_meta_with_cloud_id}")

    if has_meta_with_cloud_id > 0:
        print(f"\n    --- 有 cloud_id 但仍要上传（可能是本地修改了）---")
        count = 0
        for item in upload_files:
            info = meta.get_file_info(item.relative_path)
            if info and info.get("file_id"):
                print(f"      {item.relative_path}")
                print(f"        local_mtime={item.local_mtime}, "
                      f"meta_local={info.get('local_mtime')}, "
                      f"meta_cloud={info.get('cloud_mtime')}")
                count += 1
                if count >= 5:
                    print(f"      ... 还有 {has_meta_with_cloud_id - 5} 个")
                    break

    # 上传目录
    print(f"\n  上传目录分析 ({len(upload_dirs)} 个):")
    dir_has_meta = sum(1 for i in upload_dirs if meta.get_dir_id(i.relative_path))
    dir_no_meta = len(upload_dirs) - dir_has_meta
    print(f"    有 dir_id: {dir_has_meta}")
    print(f"    无 dir_id: {dir_no_meta}")
    if dir_no_meta > 0:
        shown = 0
        print("    --- 无 dir_id 的目录示例 ---")
        for item in upload_dirs:
            if not meta.get_dir_id(item.relative_path):
                print(f"      {item.relative_path}")
                shown += 1
                if shown >= 5:
                    break

    # 下载分析
    downloads = [i for i in items if i.action == SyncAction.DOWNLOAD]
    dl_dirs = [i for i in downloads if i.is_dir]
    dl_files = [i for i in downloads if not i.is_dir]

    print()
    print("=" * 60)
    print(f"  下载分析: {len(downloads)} 项 (目录={len(dl_dirs)}, 文件={len(dl_files)})")
    print("=" * 60)

    dl_no_meta = dl_has_meta = dl_meta_local_zero = dl_cloud_changed = 0
    for item in dl_files:
        info = meta.get_file_info(item.relative_path)
        if info is None:
            dl_no_meta += 1
        else:
            dl_has_meta += 1
            if info.get("local_mtime", 0) == 0:
                dl_meta_local_zero += 1
            if (item.cloud_mtime and info.get("cloud_mtime")
                    and item.cloud_mtime > info["cloud_mtime"]):
                dl_cloud_changed += 1

    print(f"\n  下载文件的元数据分析:")
    print(f"    无元数据:           {dl_no_meta}")
    print(f"    有元数据:           {dl_has_meta}")
    print(f"      local_mtime=0:    {dl_meta_local_zero} (只有云端，本地没下载过)")
    print(f"      云端有更新:       {dl_cloud_changed}")

    print("\n  下载文件示例:")
    for count, item in enumerate(dl_files[:15], 1):
        info = meta.get_file_info(item.relative_path)
        if info is None:
            reason = "无元数据"
        elif info.get("local_mtime", 0) == 0:
            reason = "local_mtime=0 (从未下载)"
        elif (item.cloud_mtime and info.get("cloud_mtime")
              and item.cloud_mtime > info["cloud_mtime"]):
            reason = (f"云端更新 (cloud={item.cloud_mtime} "
                      f"> meta={info['cloud_mtime']})")
        else:
            reason = (f"meta_local={info.get('local_mtime')}, "
                      f"meta_cloud={info.get('cloud_mtime')}, "
                      f"cloud_now={item.cloud_mtime}")
        print(f"    {item.relative_path}")
        print(f"      原因: {reason}")


# ===== 子命令：edge-cases =====

def cmd_edge_cases(args, _ctx=None):
    """边界情况分析。"""
    _, meta, _, items = _ctx or _init()

    # 1. 下载项中 local_mtime ≠ 0 的文件
    print("=" * 60)
    print("  1. 下载项中 local_mtime ≠ 0 的文件")
    print("=" * 60)
    dl_non_zero = [
        i for i in items
        if (i.action == SyncAction.DOWNLOAD and not i.is_dir
            and (meta.get_file_info(i.relative_path) or {}).get("local_mtime", 0) != 0)
    ]
    print(f"  总数: {len(dl_non_zero)}")
    for item in dl_non_zero:
        info = meta.get_file_info(item.relative_path)
        local_exists = os.path.exists(os.path.join(LOCAL_DIR, item.relative_path))
        print(f"\n  {item.relative_path}")
        print(f"    本地文件存在: {local_exists}")
        print(f"    cloud_mtime:  {item.cloud_mtime}")
        print(f"    local_mtime:  {item.local_mtime}")
        print(f"    meta_cloud:   {info.get('cloud_mtime') if info else 'N/A'}")
        print(f"    meta_local:   {info.get('local_mtime') if info else 'N/A'}")
        fid = info.get("file_id", "N/A") if info else "N/A"
        print(f"    file_id:      {str(fid)[:20]}...")

    # 2. 上传文件分析
    print()
    print("=" * 60)
    print("  2. 上传 .md 文件详细分析")
    print("=" * 60)
    upload_files = [i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir]
    local_only_new = []
    for item in upload_files:
        info = meta.get_file_info(item.relative_path)
        local_only_new.append({
            "path": item.relative_path,
            "has_cloud_id": bool(info and info.get("file_id")),
            "meta_cloud_mtime": info.get("cloud_mtime", 0) if info else 0,
            "meta_local_mtime": info.get("local_mtime", 0) if info else 0,
            "local_exists": os.path.exists(os.path.join(LOCAL_DIR, item.relative_path)),
        })

    pure_local = [f for f in local_only_new if not f["has_cloud_id"]]
    has_cloud = [f for f in local_only_new if f["has_cloud_id"]]
    print(f"  纯本地（无 cloud_id）: {len(pure_local)}")
    print(f"  有 cloud_id:           {len(has_cloud)}")

    year_counts = Counter()
    for f in pure_local:
        parts = f["path"].split("/")
        year = "unknown"
        for part in parts:
            if part.isdigit() and 2014 <= int(part) <= 2026:
                year = part
                break
            if part.startswith("20") and len(part) == 4:
                year = part
                break
        year_counts[year] += 1

    print("\n  纯本地文件按年份分布:")
    for year in sorted(year_counts.keys()):
        print(f"    {year}: {year_counts[year]}")

    print("\n  纯本地文件示例 (前 20):")
    for f in pure_local[:20]:
        print(f"    {f['path']}")

    # 3. 上传目录
    print()
    print("=" * 60)
    print("  3. 上传目录分析")
    print("=" * 60)
    upload_dirs = [i for i in items if i.action == SyncAction.UPLOAD and i.is_dir]
    images_dirs = [d for d in upload_dirs
                   if d.relative_path.endswith(("/images", "/attachments"))]
    other_dirs = [d for d in upload_dirs
                  if not d.relative_path.endswith(("/images", "/attachments"))]
    print(f"  images/attachments 目录: {len(images_dirs)}")
    print(f"  其他目录:                {len(other_dirs)}")
    if other_dirs:
        print("\n  非 images 目录:")
        for d in other_dirs:
            dir_id = meta.get_dir_id(d.relative_path)
            print(f"    {d.relative_path}  (dir_id={'有' if dir_id else '无'})")


# ===== 子命令：export =====

def cmd_export(args, _ctx=None):
    """将完整差异报告写入文件。"""
    _, meta, _, items = _ctx or _init()
    c = _classify(items)

    output_path = args.output or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "dryrun_diff_output.txt")

    uploads = c["upload_files"] + c["upload_dirs"]
    uploads.sort(key=lambda x: x.relative_path)
    downloads = c["download_files"] + c["download_dirs"]
    downloads.sort(key=lambda x: x.relative_path)

    lines = []
    w = lines.append

    w("=" * 80)
    w("  Dry-Run 差异报告")
    w("=" * 80)
    w("")
    w(f"  总条目: {len(items)}")
    w(f"  SKIP:     {c['skip_count']}")
    w(f"  UPLOAD:   {len(uploads)}  "
      f"({len(c['upload_files'])} 文件 + {len(c['upload_dirs'])} 目录)")
    w(f"  DOWNLOAD: {len(downloads)}  "
      f"({len(c['download_files'])} 文件 + {len(c['download_dirs'])} 目录)")
    w(f"  CONFLICT: {len(c['conflicts'])}")
    w("")

    # UPLOAD 详情
    w("=" * 80)
    w(f"  UPLOAD ({len(uploads)} 个) — 本地有，云端没有")
    w("=" * 80)
    w("")

    upload_groups = {}
    for item in uploads:
        top = item.relative_path.split("/")[0]
        upload_groups.setdefault(top, []).append(item)
    for top in sorted(upload_groups, key=lambda t: -len(upload_groups[t])):
        group = upload_groups[top]
        w(f"  [{top}] ({len(group)} 个)")
        for item in group:
            tag = "[目录]" if item.is_dir else ""
            w(f"    {tag}{item.relative_path}")
        w("")

    # DOWNLOAD 详情
    w("=" * 80)
    w(f"  DOWNLOAD ({len(downloads)} 个) — 云端有，本地没有")
    w("=" * 80)
    w("")
    for item in downloads:
        tag = "[目录]" if item.is_dir else ""
        w(f"  {tag}{item.relative_path}")

    w("")
    w("=" * 80)
    w("  报告结束")
    w("=" * 80)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"已写入 {output_path}")
    print(f"共 {len(lines)} 行")


# ===== 子命令：full =====

def cmd_full(args, _ctx=None):
    """综合 Markdown 报告：汇总所有子命令的分析结果。只登录和扫描一次。"""
    from datetime import datetime

    output_path = args.output or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "dryrun_full_report.md")

    ctx = _ctx or _init()
    _, meta, _, items = ctx
    c = _classify(items)

    L = []  # lines buffer
    w = L.append

    # ── 标题 ──
    w(f"# Dry-Run 综合报告")
    w("")
    w(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    w(f"> 本地目录: `{LOCAL_DIR}`")
    w("")

    # ════════════════════════════════════════════
    # 1. Summary
    # ════════════════════════════════════════════
    w("## 1. 统计总览")
    w("")
    w("| 类别 | 文件 | 目录 | 合计 |")
    w("|------|------|------|------|")

    action_counts = Counter()
    for item in items:
        key = (item.action.value, "dir" if item.is_dir else "file")
        action_counts[key] += 1

    for action_name in ["upload", "download", "conflict", "skip"]:
        fc = action_counts.get((action_name, "file"), 0)
        dc = action_counts.get((action_name, "dir"), 0)
        label = {"upload": "上传", "download": "下载",
                 "conflict": "冲突", "skip": "跳过"}[action_name]
        w(f"| {label} | {fc} | {dc} | {fc + dc} |")

    total = len(items)
    w(f"| **总计** | | | **{total}** |")
    w("")

    # 上传文件按顶层目录
    upload_by_top = Counter()
    for item in c["upload_files"]:
        upload_by_top[item.relative_path.split("/")[0]] += 1

    w("### 上传文件按目录")
    w("")
    w("| 目录 | 文件数 |")
    w("|------|--------|")
    for top, cnt in sorted(upload_by_top.items(), key=lambda x: -x[1]):
        w(f"| {top} | {cnt} |")
    w("")

    # 下载文件按顶层目录
    dl_by_top = Counter()
    for item in c["download_files"]:
        dl_by_top[item.relative_path.split("/")[0]] += 1

    w("### 下载文件按目录")
    w("")
    w("| 目录 | 文件数 |")
    w("|------|--------|")
    for top, cnt in sorted(dl_by_top.items(), key=lambda x: -x[1]):
        w(f"| {top} | {cnt} |")
    w("")

    # 冲突
    if c["conflicts"]:
        w("### 冲突文件")
        w("")
        for item in c["conflicts"]:
            w(f"- `{item.relative_path}`")
        w("")

    # ════════════════════════════════════════════
    # 2. List (带原因标注)
    # ════════════════════════════════════════════
    w("## 2. 文件清单（带原因标注）")
    w("")

    # 上传文件
    w(f"### 上传文件（{len(c['upload_files'])} 个）")
    w("")
    w("| # | 标签 | 路径 |")
    w("|---|------|------|")
    for i, item in enumerate(c["upload_files"], 1):
        info = meta.get_file_info(item.relative_path)
        cloud_id = info.get("file_id", "") if info else ""
        tag = "本地新文件" if not cloud_id else "本地修改"
        w(f"| {i} | {tag} | `{item.relative_path}` |")
    w("")

    # 上传目录
    if c["upload_dirs"]:
        w(f"### 上传目录（{len(c['upload_dirs'])} 个）")
        w("")
        w("| # | 标签 | 路径 |")
        w("|---|------|------|")
        for i, item in enumerate(c["upload_dirs"], 1):
            did = meta.get_dir_id(item.relative_path)
            tag = "本地新目录" if not did else "有 dir_id"
            w(f"| {i} | {tag} | `{item.relative_path}` |")
        w("")

    # 下载文件
    w(f"### 下载文件（{len(c['download_files'])} 个）")
    w("")
    w("| # | 标签 | 路径 | 扩展名 |")
    w("|---|------|------|--------|")
    for i, item in enumerate(c["download_files"], 1):
        info = meta.get_file_info(item.relative_path)
        local_exists = os.path.exists(os.path.join(LOCAL_DIR, item.relative_path))
        if info and info.get("local_mtime", 0) == 0:
            tag = "云端有/本地未下载"
        elif local_exists:
            tag = "本地有但未被扫描到"
        else:
            tag = "云端新文件"
        ext = os.path.splitext(item.relative_path)[1] or "(无)"
        w(f"| {i} | {tag} | `{item.relative_path}` | {ext} |")
    w("")

    # 下载目录
    if c["download_dirs"]:
        w(f"### 下载目录（{len(c['download_dirs'])} 个）")
        w("")
        for i, item in enumerate(c["download_dirs"], 1):
            w(f"{i}. `{item.relative_path}`")
        w("")

    # ════════════════════════════════════════════
    # 3. Analyze (深度分析)
    # ════════════════════════════════════════════
    w("## 3. 深度分析")
    w("")

    uploads = [i for i in items if i.action == SyncAction.UPLOAD]
    upload_dirs = [i for i in uploads if i.is_dir]
    upload_files = [i for i in uploads if not i.is_dir]

    # 按扩展名
    w("### 上传文件按扩展名")
    w("")
    ext_groups = defaultdict(list)
    for item in upload_files:
        _, ext = os.path.splitext(item.relative_path)
        ext_groups[ext or "(无扩展名)"].append(item.relative_path)

    w("| 扩展名 | 数量 | 示例 |")
    w("|--------|------|------|")
    for ext in sorted(ext_groups, key=lambda e: -len(ext_groups[e])):
        paths = ext_groups[ext]
        example = paths[0] if paths else ""
        suffix = f" (+{len(paths)-1})" if len(paths) > 1 else ""
        w(f"| {ext} | {len(paths)} | `{example}`{suffix} |")
    w("")

    # 上传元数据分析
    w("### 上传文件元数据分析")
    w("")
    no_meta = has_meta_no_cid = has_meta_with_cid = 0
    for item in upload_files:
        info = meta.get_file_info(item.relative_path)
        if info is None:
            no_meta += 1
        elif info.get("file_id"):
            has_meta_with_cid += 1
        else:
            has_meta_no_cid += 1

    w("| 分类 | 数量 | 说明 |")
    w("|------|------|------|")
    w(f"| 无元数据 | {no_meta} | 完全新文件 |")
    w(f"| 有元数据无 cloud_id | {has_meta_no_cid} | 本地创建但从未上传 |")
    w(f"| 有元数据有 cloud_id | {has_meta_with_cid} | 本地修改了已有云端文件 |")
    w("")

    if has_meta_with_cid > 0:
        w("**有 cloud_id 但仍要上传的文件（本地修改）：**")
        w("")
        count = 0
        for item in upload_files:
            info = meta.get_file_info(item.relative_path)
            if info and info.get("file_id"):
                w(f"- `{item.relative_path}` — local_mtime={item.local_mtime}, "
                  f"meta_local={info.get('local_mtime')}, meta_cloud={info.get('cloud_mtime')}")
                count += 1
                if count >= 5:
                    w(f"- ... 还有 {has_meta_with_cid - 5} 个")
                    break
        w("")

    # 上传目录分析
    w("### 上传目录分析")
    w("")
    dir_has_meta = sum(1 for i in upload_dirs if meta.get_dir_id(i.relative_path))
    dir_no_meta = len(upload_dirs) - dir_has_meta
    w(f"- 有 dir_id: {dir_has_meta}")
    w(f"- 无 dir_id: {dir_no_meta}")
    if dir_no_meta > 0:
        w("")
        for item in upload_dirs:
            if not meta.get_dir_id(item.relative_path):
                w(f"  - `{item.relative_path}`")
    w("")

    # 下载分析
    downloads = [i for i in items if i.action == SyncAction.DOWNLOAD]
    dl_dirs = [i for i in downloads if i.is_dir]
    dl_files = [i for i in downloads if not i.is_dir]

    w("### 下载文件元数据分析")
    w("")
    dl_no_meta = dl_has_meta = dl_meta_local_zero = dl_cloud_changed = 0
    for item in dl_files:
        info = meta.get_file_info(item.relative_path)
        if info is None:
            dl_no_meta += 1
        else:
            dl_has_meta += 1
            if info.get("local_mtime", 0) == 0:
                dl_meta_local_zero += 1
            if (item.cloud_mtime and info.get("cloud_mtime")
                    and item.cloud_mtime > info["cloud_mtime"]):
                dl_cloud_changed += 1

    w("| 分类 | 数量 | 说明 |")
    w("|------|------|------|")
    w(f"| 无元数据 | {dl_no_meta} | 云端新文件，本地从未见过 |")
    w(f"| local_mtime=0 | {dl_meta_local_zero} | 只有云端，本地没下载过 |")
    w(f"| 云端有更新 | {dl_cloud_changed} | 需要覆盖本地旧版 |")
    w(f"| 其他有元数据 | {dl_has_meta - dl_meta_local_zero - dl_cloud_changed} | |")
    w("")

    # 下载文件示例（前 15 个带原因）
    w("**下载文件详细原因（前 15 个）：**")
    w("")
    for item in dl_files[:15]:
        info = meta.get_file_info(item.relative_path)
        if info is None:
            reason = "无元数据"
        elif info.get("local_mtime", 0) == 0:
            reason = "从未下载 (local_mtime=0)"
        elif (item.cloud_mtime and info.get("cloud_mtime")
              and item.cloud_mtime > info["cloud_mtime"]):
            reason = f"云端更新 (cloud={item.cloud_mtime} > meta={info['cloud_mtime']})"
        else:
            reason = (f"meta_local={info.get('local_mtime')}, "
                      f"meta_cloud={info.get('cloud_mtime')}, "
                      f"cloud_now={item.cloud_mtime}")
        w(f"- `{item.relative_path}` — {reason}")
    w("")

    # ════════════════════════════════════════════
    # 4. Edge Cases
    # ════════════════════════════════════════════
    w("## 4. 边界情况分析")
    w("")

    # 4.1 下载项中 local_mtime ≠ 0
    dl_non_zero = [
        i for i in items
        if (i.action == SyncAction.DOWNLOAD and not i.is_dir
            and (meta.get_file_info(i.relative_path) or {}).get("local_mtime", 0) != 0)
    ]
    w(f"### 4.1 下载项中 local_mtime ≠ 0 的文件（{len(dl_non_zero)} 个）")
    w("")
    if dl_non_zero:
        w("| 路径 | 本地存在 | cloud_mtime | local_mtime | meta_cloud | meta_local |")
        w("|------|----------|-------------|-------------|------------|------------|")
        for item in dl_non_zero:
            info = meta.get_file_info(item.relative_path)
            local_exists = os.path.exists(os.path.join(LOCAL_DIR, item.relative_path))
            mc = info.get('cloud_mtime', 'N/A') if info else 'N/A'
            ml = info.get('local_mtime', 'N/A') if info else 'N/A'
            w(f"| `{item.relative_path}` | {local_exists} | {item.cloud_mtime} | "
              f"{item.local_mtime} | {mc} | {ml} |")
        w("")
    else:
        w("无。")
        w("")

    # 4.2 上传文件分析
    up_files_all = [i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir]
    local_only_new = []
    for item in up_files_all:
        info = meta.get_file_info(item.relative_path)
        local_only_new.append({
            "path": item.relative_path,
            "has_cloud_id": bool(info and info.get("file_id")),
        })

    pure_local = [f for f in local_only_new if not f["has_cloud_id"]]
    has_cloud = [f for f in local_only_new if f["has_cloud_id"]]

    w(f"### 4.2 上传文件来源分析")
    w("")
    w(f"- 纯本地（无 cloud_id）: {len(pure_local)}")
    w(f"- 有 cloud_id: {len(has_cloud)}")
    w("")

    year_counts = Counter()
    for f in pure_local:
        parts = f["path"].split("/")
        year = "unknown"
        for part in parts:
            if part.isdigit() and 2014 <= int(part) <= 2026:
                year = part
                break
            if part.startswith("20") and len(part) == 4:
                year = part
                break
        year_counts[year] += 1

    w("**纯本地文件按年份分布：**")
    w("")
    w("| 年份 | 数量 |")
    w("|------|------|")
    for year in sorted(year_counts.keys()):
        w(f"| {year} | {year_counts[year]} |")
    w("")

    # 4.3 上传目录分析
    up_dirs = [i for i in items if i.action == SyncAction.UPLOAD and i.is_dir]
    images_dirs = [d for d in up_dirs
                   if d.relative_path.endswith(("/images", "/attachments"))]
    other_dirs = [d for d in up_dirs
                  if not d.relative_path.endswith(("/images", "/attachments"))]

    w("### 4.3 上传目录分析")
    w("")
    w(f"- images/attachments 目录: {len(images_dirs)}")
    w(f"- 其他目录: {len(other_dirs)}")
    w("")
    if other_dirs:
        for d in other_dirs:
            dir_id = meta.get_dir_id(d.relative_path)
            w(f"  - `{d.relative_path}` (dir_id={'有' if dir_id else '无'})")
        w("")

    # ════════════════════════════════════════════
    # 5. 上传/下载同名文件交叉检查
    # ════════════════════════════════════════════
    w("## 5. 上传/下载同名文件交叉检查")
    w("")
    w("> 检测上传列表和下载列表中文件名相同但路径不同的项。")
    w("> 这通常意味着同一文件在本地和云端被放到了不同目录，同步后会产生重复。")
    w("")

    from src.sync.moves import normalize_filename as _norm_fn

    upload_by_name = defaultdict(list)
    for item in c["upload_files"]:
        name = _norm_fn(os.path.basename(item.relative_path))
        upload_by_name[name].append(item.relative_path)

    download_by_name = defaultdict(list)
    for item in c["download_files"]:
        name = _norm_fn(os.path.basename(item.relative_path))
        download_by_name[name].append(item.relative_path)

    cross_matches = []
    for name in sorted(set(upload_by_name) & set(download_by_name)):
        for up_path in upload_by_name[name]:
            for dl_path in download_by_name[name]:
                if up_path != dl_path:
                    cross_matches.append((name, up_path, dl_path))

    if cross_matches:
        w(f"**发现 {len(cross_matches)} 对同名文件：**")
        w("")
        w("| # | 文件名 | 上传路径（本地） | 下载路径（云端） |")
        w("|---|--------|-----------------|-----------------|")
        for i, (name, up, dl) in enumerate(cross_matches, 1):
            w(f"| {i} | {name} | `{up}` | `{dl}` |")
        w("")

        # 按模式分组
        pattern_groups = defaultdict(list)
        for name, up, dl in cross_matches:
            up_dir = os.path.dirname(up)
            dl_dir = os.path.dirname(dl)
            pattern_groups[(up_dir, dl_dir)].append(name)

        w("**按目录迁移模式分组：**")
        w("")
        for (up_dir, dl_dir), names in sorted(
                pattern_groups.items(), key=lambda x: -len(x[1])):
            w(f"- `{up_dir}/` → `{dl_dir}/` （{len(names)} 个文件）")
            for n in names[:5]:
                w(f"  - {n}")
            if len(names) > 5:
                w(f"  - ... 还有 {len(names) - 5} 个")
        w("")

        w("**风险提示：** 如果直接同步，这些文件会在两个路径各存一份。"
          "建议先在一端统一目录结构，再运行同步。")
        w("")
    else:
        w("未发现上传/下载同名文件交叉。")
        w("")

    # ── 写入文件 ──
    content = "\n".join(L)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)

    line_count = content.count("\n") + 1
    print(f"综合报告已写入 {output_path}")
    print(f"共 {line_count} 行")


# ===== 主入口 =====

def main():
    parser = argparse.ArgumentParser(
        description="Dry-run 报告工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="子命令")

    sub.add_parser("summary", help="按目录分组统计 + 与上次对比")
    sub.add_parser("list", help="列出所有非 SKIP 项并标注原因")
    sub.add_parser("analyze", help="按 action/扩展名/元数据分组统计")
    sub.add_parser("edge-cases", help="边界情况分析")

    export_p = sub.add_parser("export", help="将差异报告写入文件")
    export_p.add_argument("-o", "--output", default=None,
                          help="输出文件路径（默认 dryrun_diff_output.txt）")

    full_p = sub.add_parser("full", help="综合 Markdown 报告，写入 .md 文件")
    full_p.add_argument("-o", "--output", default=None,
                        help="输出文件路径（默认 dryrun_full_report.md）")

    args = parser.parse_args()

    dispatch = {
        "summary": cmd_summary,
        "list": cmd_list,
        "analyze": cmd_analyze,
        "edge-cases": cmd_edge_cases,
        "export": cmd_export,
        "full": cmd_full,
    }

    if args.command is None:
        parser.print_help()
        return 1

    return dispatch[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
