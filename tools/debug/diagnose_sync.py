"""
同步诊断工具 — 合并了 5 个路径/决策/移动检测 debug 脚本。

子命令:
  path         精确/模糊搜索指定路径在云端扫描结果中的匹配情况
  name         字符级比较、hex 输出，排查编码或空白差异
  moves        用 file_id 检测上传/下载项是否为同一文件的移动
  decision     对指定文件重跑 decide_action，输出每一步的判断
  calibration  对指定路径模拟 calibrate_metadata 过程

用法:
  python .local-scripts/diagnose_sync.py path --target "内在世界/日记/2025/2025年1月10日.md"
  python .local-scripts/diagnose_sync.py name --target "内在世界/日记/本科/大一上学期/2014年10月11日.md"
  python .local-scripts/diagnose_sync.py moves
  python .local-scripts/diagnose_sync.py decision --target "内在世界/日记/本科/大一上学期/2014年10月11日.md"
  python .local-scripts/diagnose_sync.py calibration --target "内在世界/日记/2025/2025年1月10日.md"
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager
from src.sync.engine import SyncManager
from src.sync.utils import (
    SyncDirection, SyncAction, filter_by_direction, decide_action,
)
from src.sync.scanner import scan_cloud, scan_local
from src.sync.decision import calibrate_metadata
from src.sync.metadata import SyncMetadata

LOCAL_DIR = "E:/Projects/notes"


# ===== 共用初始化 =====

def _login():
    """登录并返回 (api, meta, mgr)。"""
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        sys.exit(1)
    meta = SyncMetadata()
    mgr = SyncManager(api, LOCAL_DIR, meta)
    return api, meta, mgr


def _scan(api):
    """扫描云端和本地，返回 (cloud_dir_id, cloud_files, local_files)。"""
    cloud_dir_id = api.get_root_id()
    print("扫描云端...")
    cloud_files = scan_cloud(api, cloud_dir_id, "")
    print("扫描本地...")
    local_files = scan_local(LOCAL_DIR, "")
    return cloud_dir_id, cloud_files, local_files


# ===== 子命令：path =====

def cmd_path(args):
    """精确/模糊搜索指定路径在云端扫描结果中的匹配情况。"""
    api, meta, mgr = _login()
    cloud_dir_id, cloud_files, local_files = _scan(api)

    targets = [t.strip() for t in args.target] if args.target else []
    if not targets:
        print("请用 --target 指定至少一个路径")
        return 1

    print("=" * 70)
    print("  排查：指定路径在云端扫描结果中的匹配")
    print("=" * 70)

    for suspect in targets:
        print(f"\n  本地路径: {suspect}")

        # 精确匹配
        if suspect in cloud_files:
            print(f"    -> 精确匹配到! cloud_files['{suspect}']")
            info = cloud_files[suspect]
            print(f"       name={info.get('name')}, is_dir={info.get('is_dir')}, domain={info.get('domain')}")
            continue

        # 模糊搜索
        basename = os.path.basename(suspect)
        name_no_ext = os.path.splitext(basename)[0]
        matches = [(cp, ci) for cp, ci in cloud_files.items() if name_no_ext in cp]

        if matches:
            print(f"    -> 未精确匹配，模糊搜索到 {len(matches)} 个:")
            for m_path, m_info in matches[:5]:
                print(f"      云端路径: {m_path}")
                print(f"        is_dir={m_info.get('is_dir')}, name={m_info.get('name')}")
                if m_path != suspect:
                    print(f"        差异: 本地=[{suspect}] vs 云端=[{m_path}]")
        else:
            print(f"    -> 云端扫描结果中完全找不到!")
            parent = os.path.dirname(suspect)
            parent_matches = sorted([p for p in cloud_files
                                     if p.startswith(parent + "/") or p == parent])
            print(f"    -> 父目录 '{parent}' 下的云端文件 ({len(parent_matches)} 个):")
            for p in parent_matches[:10]:
                print(f"      {p}  (is_dir={cloud_files[p].get('is_dir')})")
            if len(parent_matches) > 10:
                print(f"      ... 还有 {len(parent_matches) - 10} 个")

    # 云端格式统计
    from collections import Counter
    ext_count = Counter()
    for p, info in cloud_files.items():
        if info.get("is_dir"):
            continue
        name = info.get("name", "")
        _, ext = os.path.splitext(name)
        ext_count[ext or "(无扩展名)"] += 1
    print()
    print("=" * 70)
    print("  云端格式统计")
    print("=" * 70)
    for ext in sorted(ext_count, key=lambda e: -ext_count[e]):
        print(f"  {ext:20s}: {ext_count[ext]}")


# ===== 子命令：name =====

def cmd_name(args):
    """字符级比较、hex 输出，排查编码或空白差异。"""
    api, meta, mgr = _login()
    cloud_dir_id, cloud_files, local_files = _scan(api)

    targets = [t.strip() for t in args.target] if args.target else []
    if not targets:
        # 默认检查本科日记
        targets = [
            "内在世界/日记/本科/大一上学期/2014年10月11日.md",
        ]

    for target in targets:
        print(f"\n{'='*60}")
        print(f"  目标: {target}")
        print(f"{'='*60}")
        in_cloud = target in cloud_files
        in_local = target in local_files
        print(f"  云端扫描结果: {'有' if in_cloud else '无'}")
        print(f"  本地扫描结果: {'有' if in_local else '无'}")

        if not in_cloud:
            basename = os.path.basename(target)
            name_core = os.path.splitext(basename)[0].strip()
            fuzzy = [cp for cp in cloud_files if name_core in cp]

            if fuzzy:
                print(f"  模糊匹配到 {len(fuzzy)} 个:")
                for fp in fuzzy:
                    print(f"    云端: [{fp}]")
                    print(f"    本地: [{target}]")
                    if fp != target:
                        print(f"    字符对比:")
                        for i in range(max(len(fp), len(target))):
                            c1 = fp[i] if i < len(fp) else '<END>'
                            c2 = target[i] if i < len(target) else '<END>'
                            if c1 != c2:
                                print(f"      位置 {i}: 云端='{c1}'(U+{ord(c1):04X}) "
                                      f"vs 本地='{c2}'(U+{ord(c2):04X})")
                        print(f"    长度: 云端={len(fp)}, 本地={len(target)}")
            else:
                print(f"  完全找不到任何匹配!")
                parent = os.path.dirname(target)
                children = sorted([p for p in cloud_files
                                   if p.startswith(parent + "/")
                                   and "/" not in p[len(parent) + 1:]])
                print(f"  该目录下云端文件 ({len(children)} 个):")
                for c in children[:5]:
                    cb = os.path.basename(c)
                    print(f"    [{cb}] bytes={cb.encode('utf-8').hex()}")
                if children:
                    tb = os.path.basename(target)
                    print(f"  本地文件名 bytes: [{tb}] = {tb.encode('utf-8').hex()}")

    # 统计：指定前缀下的匹配情况
    if args.prefix:
        prefix = args.prefix
        local_set = {k for k in local_files
                     if k.startswith(prefix) and not local_files[k].get("is_dir")}
        cloud_set = {k for k in cloud_files
                     if k.startswith(prefix) and not cloud_files[k].get("is_dir")}
        print(f"\n{'='*60}")
        print(f"  统计：'{prefix}' 匹配情况")
        print(f"{'='*60}")
        print(f"  本地: {len(local_set)}, 云端: {len(cloud_set)}")
        print(f"  交集: {len(local_set & cloud_set)}")
        print(f"  仅本地: {len(local_set - cloud_set)}")
        print(f"  仅云端: {len(cloud_set - local_set)}")

        only_local = sorted(local_set - cloud_set)
        only_cloud = sorted(cloud_set - local_set)
        if only_local:
            print(f"\n  仅本地前 10 个:")
            for p in only_local[:10]:
                print(f"    [{os.path.basename(p)}]")
        if only_cloud:
            print(f"\n  仅云端前 10 个:")
            for p in only_cloud[:10]:
                print(f"    [{os.path.basename(p)}]")

        # 配对尝试
        if only_local and only_cloud:
            for lp in only_local[:5]:
                ldir = os.path.dirname(lp)
                lname = os.path.basename(lp)
                lcore = os.path.splitext(lname)[0].strip()
                for cp in only_cloud:
                    if os.path.dirname(cp) == ldir:
                        cname = os.path.basename(cp)
                        ccore = os.path.splitext(cname)[0].strip()
                        if lcore == ccore or lcore in ccore or ccore in lcore:
                            print(f"\n  可能配对:")
                            print(f"    本地: [{lname}] hex={lname.encode('utf-8').hex()}")
                            print(f"    云端: [{cname}] hex={cname.encode('utf-8').hex()}")
                            for i in range(max(len(lname), len(cname))):
                                c1 = lname[i] if i < len(lname) else '<END>'
                                c2 = cname[i] if i < len(cname) else '<END>'
                                if c1 != c2:
                                    print(f"    位置{i}: 本地='{c1}'(U+{ord(c1):04X}) "
                                          f"vs 云端='{c2}'(U+{ord(c2):04X})")
                            break


# ===== 子命令：moves =====

def cmd_moves(args):
    """用 file_id 检测上传/下载项是否为同一文件的移动。"""
    api, meta, mgr = _login()
    cloud_dir_id, cloud_files, local_files = _scan(api)
    calibrate_metadata(meta, cloud_files, local_files)

    items = mgr._collect_items(cloud_dir_id, "")
    items, _ = filter_by_direction(items, SyncDirection.BOTH)

    uploads = sorted([i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir],
                     key=lambda x: x.relative_path)
    downloads = sorted([i for i in items if i.action == SyncAction.DOWNLOAD and not i.is_dir],
                       key=lambda x: x.relative_path)

    # 分析上传文件
    print("=" * 70)
    print("  分析：上传文件的 file_id 和云端当前路径")
    print("=" * 70)

    moved_uploads = 0
    real_new_uploads = 0
    for item in uploads:
        rel = item.relative_path
        file_meta = meta.get_file_info(rel)
        fid = file_meta.get("file_id", "") if file_meta else ""

        cloud_current = None
        if fid:
            for cp, ci in cloud_files.items():
                if ci.get("id") == fid:
                    cloud_current = cp
                    break

        print(f"\n  上传: {rel}")
        print(f"    file_id: {fid or '(无)'}")
        if cloud_current:
            print(f"    -> 云端当前路径: {cloud_current}")
            print(f"    -> 结论: 文件已被移动！")
            moved_uploads += 1
        else:
            basename = os.path.basename(rel)
            name_core = os.path.splitext(basename)[0].strip()
            cloud_matches = [(cp, ci) for cp, ci in cloud_files.items()
                             if name_core in os.path.basename(cp) and not ci.get("is_dir")]
            if cloud_matches:
                print(f"    -> 云端有同名文件:")
                for cm_path, _ in cloud_matches[:3]:
                    print(f"      {cm_path}")
            else:
                print(f"    -> 云端无同名文件（真正的本地新文件）")
            real_new_uploads += 1

    # 分析下载文件
    print()
    print("=" * 70)
    print("  分析：下载文件在元数据中的原路径")
    print("=" * 70)

    for item in downloads:
        rel = item.relative_path
        cloud_info = cloud_files.get(rel, {})
        cid = cloud_info.get("id", "")

        old_local_path = None
        if cid:
            all_meta = meta._data.get("files", {})
            for local_rel, fmeta in all_meta.items():
                if fmeta.get("file_id") == cid:
                    old_local_path = local_rel
                    break

        cid_display = f"{cid[:20]}..." if len(cid) > 20 else cid
        print(f"\n  下载: {rel}")
        print(f"    cloud_id: {cid_display}")
        if old_local_path:
            print(f"    -> 元数据中旧路径: {old_local_path}")
            print(f"    -> 结论: 同一个文件，云端路径变了")
            is_in_upload = any(u.relative_path == old_local_path for u in uploads)
            print(f"    -> 旧路径在上传列表中: {is_in_upload}")
        else:
            basename = os.path.basename(rel)
            name_core = os.path.splitext(basename)[0].strip()
            local_matches = [(lp, li) for lp, li in local_files.items()
                             if name_core in os.path.basename(lp) and not li.get("is_dir")]
            if local_matches:
                print(f"    -> 本地有类似文件:")
                for lm_path, _ in local_matches[:3]:
                    print(f"      {lm_path}")
            else:
                print(f"    -> 本地无类似文件")

    # 总结
    print()
    print("=" * 70)
    print("  总结")
    print("=" * 70)
    print(f"  上传 {len(uploads)} 个文件中:")
    print(f"    {moved_uploads} 个是云端已移动的文件")
    print(f"    {real_new_uploads} 个是真正的本地新文件")


# ===== 子命令：decision =====

def cmd_decision(args):
    """对指定文件重跑 decide_action，输出每一步的判断。"""
    api, meta, mgr = _login()
    cloud_dir_id, cloud_files, local_files = _scan(api)
    calibrate_metadata(meta, cloud_files, local_files)

    targets = [t.strip() for t in args.target] if args.target else []
    if not targets:
        print("请用 --target 指定至少一个路径")
        return 1

    for target in targets:
        print(f"\n{'='*60}")
        print(f"  文件: {target}")
        print(f"{'='*60}")

        cloud = cloud_files.get(target)
        local = local_files.get(target)
        file_meta = meta.get_file_info(target)

        print(f"  cloud: {cloud}")
        print(f"  local: {local}")
        print(f"  metadata: {file_meta}")

        if file_meta is not None and file_meta.get("file_id"):
            print(f"  -> 元数据完整，走 decide_action")
        else:
            print(f"  -> 元数据缺失或不完整")
            file_meta = meta.get_file_info(target)
            print(f"  校准后 metadata: {file_meta}")

        if file_meta and cloud and local:
            action = decide_action(
                cloud_mtime=cloud.get("mtime", 0),
                local_mtime=local.get("mtime", 0),
                meta_cloud_mtime=file_meta.get("cloud_mtime", 0),
                meta_local_mtime=file_meta.get("local_mtime", 0),
                meta_content_hash=file_meta.get("content_hash"),
                local_path=local.get("path"),
            )
            print(f"  decide_action 结果: {action}")
            print(f"    cloud_mtime={cloud.get('mtime')}, "
                  f"meta_cloud={file_meta.get('cloud_mtime')}, "
                  f"equal={cloud.get('mtime') == file_meta.get('cloud_mtime')}")
            print(f"    local_mtime={local.get('mtime')}, "
                  f"meta_local={file_meta.get('local_mtime')}, "
                  f"equal={local.get('mtime') == file_meta.get('local_mtime')}")

    # 批量检查（可选前缀过滤）
    if args.prefix:
        print()
        print("=" * 60)
        print(f"  批量检查 '{args.prefix}' 下被判为 UPLOAD 的文件")
        print("=" * 60)

        items = mgr._collect_items(cloud_dir_id, "")
        items, _ = filter_by_direction(items, SyncDirection.BOTH)
        filtered = [i for i in items
                    if i.action == SyncAction.UPLOAD
                    and i.relative_path.startswith(args.prefix)
                    and not i.is_dir]

        print(f"  UPLOAD 数: {len(filtered)}")
        for item in filtered[:5]:
            rel = item.relative_path
            c = cloud_files.get(rel)
            l = local_files.get(rel)
            m = meta.get_file_info(rel)
            print(f"\n  {rel}")
            print(f"    cloud: {c is not None} "
                  f"(mtime={c['mtime'] if c else 'N/A'})")
            print(f"    local: {l is not None} "
                  f"(mtime={l['mtime'] if l else 'N/A'})")
            if m:
                print(f"    meta: file_id={m.get('file_id', 'N/A')}, "
                      f"cloud_mtime={m.get('cloud_mtime', 'N/A')}, "
                      f"local_mtime={m.get('local_mtime', 'N/A')}")


# ===== 子命令：calibration =====

def cmd_calibration(args):
    """对指定路径模拟 calibrate_metadata 过程。"""
    api, meta, mgr = _login()
    cloud_dir_id, cloud_files, local_files = _scan(api)

    targets = [t.strip() for t in args.target] if args.target else []
    if not targets:
        print("请用 --target 指定至少一个路径")
        return 1

    for target in targets:
        print(f"\n=== 检查 '{target}' ===")
        print(f"  云端: {target in cloud_files}")
        if target in cloud_files:
            print(f"    {cloud_files[target]}")
        print(f"  本地: {target in local_files}")
        if target in local_files:
            print(f"    {local_files[target]}")
        print(f"  元数据: {meta.get_file_info(target)}")

        # 物理文件检查
        base_no_ext = os.path.splitext(target)[0]
        for ext in (".md", ".note", ".clip"):
            phys = os.path.join(LOCAL_DIR, base_no_ext + ext)
            if os.path.exists(phys):
                print(f"  本地 {ext} 存在: True ({phys})")

        # 分析
        cloud = cloud_files.get(target)
        local = local_files.get(target)
        if cloud and local:
            print(f"  -> 两端都有，应该被校准")
            existing = meta.get_file_info(target)
            if existing is None:
                print(f"  -> 需要校准！")
            elif not existing.get("file_id") or existing.get("local_mtime", 0) == 0:
                print(f"  -> 元数据不完整（file_id 或 local_mtime 缺失），需要校准")
            else:
                print(f"  -> 已有完整元数据，不需要校准")
        elif cloud and not local:
            print(f"  -> 只有云端，应该下载")
        elif local and not cloud:
            print(f"  -> 只有本地，应该上传")

    # 范围统计
    if args.prefix:
        prefix = args.prefix
        print(f"\n=== '{prefix}' 下的匹配情况 ===")
        pfx_cloud = {k for k in cloud_files if k.startswith(prefix)}
        pfx_local = {k for k in local_files if k.startswith(prefix)}
        print(f"  云端: {len(pfx_cloud)}, 本地: {len(pfx_local)}")
        print(f"  交集: {len(pfx_cloud & pfx_local)}")
        print(f"  仅云端: {len(pfx_cloud - pfx_local)}")
        print(f"  仅本地: {len(pfx_local - pfx_cloud)}")

        only_cloud = sorted(pfx_cloud - pfx_local)
        only_local = sorted(pfx_local - pfx_cloud)
        if only_cloud:
            for p in only_cloud[:5]:
                print(f"    仅云端: {p}")
        if only_local:
            for p in only_local[:5]:
                print(f"    仅本地: {p}")


# ===== 主入口 =====

def main():
    parser = argparse.ArgumentParser(
        description="同步诊断工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="子命令")

    # path
    p_path = sub.add_parser("path", help="搜索指定路径在云端扫描结果中的匹配")
    p_path.add_argument("--target", nargs="+", required=True,
                        help="要排查的文件路径（可多个）")

    # name
    p_name = sub.add_parser("name", help="字符级对比，排查编码/空白差异")
    p_name.add_argument("--target", nargs="+",
                        help="要排查的文件路径（可多个）")
    p_name.add_argument("--prefix", default=None,
                        help="统计指定前缀下的匹配情况")

    # moves
    sub.add_parser("moves", help="检测上传/下载项是否为移动的同一文件")

    # decision
    p_dec = sub.add_parser("decision", help="对指定文件重跑 decide_action")
    p_dec.add_argument("--target", nargs="+", required=True,
                       help="要排查的文件路径（可多个）")
    p_dec.add_argument("--prefix", default=None,
                       help="批量检查指定前缀下的 UPLOAD 文件")

    # calibration
    p_cal = sub.add_parser("calibration", help="模拟 calibrate_metadata 过程")
    p_cal.add_argument("--target", nargs="+", required=True,
                       help="要排查的文件路径（可多个）")
    p_cal.add_argument("--prefix", default=None,
                       help="统计指定前缀下的匹配情况")

    args = parser.parse_args()

    dispatch = {
        "path": cmd_path,
        "name": cmd_name,
        "moves": cmd_moves,
        "decision": cmd_decision,
        "calibration": cmd_calibration,
    }

    if args.command is None:
        parser.print_help()
        return 1

    return dispatch[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
