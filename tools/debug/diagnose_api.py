"""
API 分页诊断工具 — 合并了 3 个分页 debug 脚本。

子命令:
  basic   拉指定目录，检查条目数量和分页字段
  detail  模拟分页循环，检查去重和退出条件
  large   测试不同 page_size 参数的效果

用法:
  python .local-scripts/diagnose_api.py basic --dir "内在世界/日记/2025"
  python .local-scripts/diagnose_api.py detail --dir "内在世界/日记/2025"
  python .local-scripts/diagnose_api.py large --dir "内在世界/日记/2025"
  python .local-scripts/diagnose_api.py basic --dir-id "WEBxxxxx"
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from youdaonote_sync.api import YoudaoNoteApi
from youdaonote_sync.cookies import CookieManager
from youdaonote_sync.sync.metadata import SyncMetadata


def _login():
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        sys.exit(1)
    return api


def _resolve_dir_id(api, args):
    """从 --dir-id 或 --dir（路径名）解析出 dir_id。"""
    if args.dir_id:
        return args.dir_id
    if args.dir:
        meta = SyncMetadata()
        did = meta.get_dir_id(args.dir)
        if did:
            return did
        print(f"元数据中找不到 '{args.dir}' 的 dir_id")
        sys.exit(1)
    print("请用 --dir 或 --dir-id 指定目录")
    sys.exit(1)


# ===== 子命令：basic =====

def cmd_basic(args):
    """拉指定目录，检查条目数量和分页字段。"""
    api = _login()
    dir_id = _resolve_dir_id(api, args)
    print(f"dir_id: {dir_id}")

    data = api.get_dir_info_by_id(dir_id)
    entries = data.get("entries", [])
    count = data.get("count", "N/A")

    print(f"API 返回 count: {count}")
    print(f"API 返回 entries 数量: {len(entries)}")

    names = sorted([e.get("fileEntry", {}).get("name", "") for e in entries])
    print(f"\n前 20 个文件:")
    for n in names[:20]:
        print(f"  {n}")
    print(f"\n后 20 个文件:")
    for n in names[-20:]:
        print(f"  {n}")

    # 搜索特定关键词
    if args.search:
        found = [n for n in names if args.search in n]
        print(f"\n搜索 '{args.search}': {len(found)} 个匹配")
        for n in sorted(found)[:10]:
            print(f"  {n}")

    print(f"\n响应顶层 key: {list(data.keys())}")


# ===== 子命令：detail =====

def cmd_detail(args):
    """模拟分页循环，检查去重和退出条件。"""
    api = _login()
    dir_id = _resolve_dir_id(api, args)
    print(f"dir_id: {dir_id}")

    page_size = args.page_size or 200
    offset = 0
    page = 0

    while True:
        url = api.DIR_MES_URL.format(
            dir_id=dir_id, page_size=page_size, cstk=api.cstk
        )
        if offset > 0:
            url += f"&startIndex={offset}"

        data = api._safe_json(api.http_get(url))
        entries = data.get("entries", [])
        total = data.get("count", 0)

        names = [e.get("fileEntry", {}).get("name", "") for e in entries]
        unique_names = set(names)

        page += 1
        print(f"\n=== 第 {page} 页 ===")
        print(f"  offset={offset}, page_size={page_size}")
        print(f"  返回 entries: {len(entries)}")
        print(f"  count (total): {total}")
        print(f"  不同文件名: {len(unique_names)}")
        print(f"  重复数: {len(entries) - len(unique_names)}")

        offset += len(entries)
        print(f"  累计 offset: {offset}")

        if len(entries) < page_size or offset >= total:
            print(f"\n  退出循环: entries({len(entries)}) < "
                  f"page_size({page_size}) = {len(entries) < page_size}")
            print(f"            offset({offset}) >= "
                  f"total({total}) = {offset >= total}")
            break

    print(f"\n最终: 共获取 {offset} 条 entries, API 声称总共 {total} 条")
    if offset < total:
        print(f"  WARNING: 还有 {total - offset} 条没获取到!")


# ===== 子命令：large =====

def cmd_large(args):
    """测试不同 page_size 参数的效果。"""
    api = _login()
    dir_id = _resolve_dir_id(api, args)
    print(f"dir_id: {dir_id}")

    # 试验 1: len=500
    for test_size in [500, 1000]:
        print(f"\n=== 试验: len={test_size} ===")
        url = (
            f"https://note.youdao.com/yws/api/personal/file/{dir_id}"
            f"?all=true&f=true&len={test_size}&sort=1&isReverse=false"
            f"&method=listPageByParentId&keyfrom=web&cstk={api.cstk}"
        )
        data = api._safe_json(api.http_get(url))
        entries = data.get("entries", [])
        total = data.get("count", 0)
        ids = set(e.get("fileEntry", {}).get("id", "") for e in entries)
        names = set(e.get("fileEntry", {}).get("name", "") for e in entries)
        print(f"  count={total}, entries={len(entries)}, "
              f"unique_ids={len(ids)}, unique_names={len(names)}")
        if args.search:
            found = sorted([n for n in names if args.search in n])
            print(f"  搜索 '{args.search}': {len(found)}")

    # 试验: 小步分页 len=100
    print(f"\n=== 试验: 小步分页 len=100 ===")
    all_ids = set()
    all_names = set()
    for start in range(0, 2000, 100):
        url = (
            f"https://note.youdao.com/yws/api/personal/file/{dir_id}"
            f"?all=true&f=true&len=100&sort=1&isReverse=false"
            f"&method=listPageByParentId&keyfrom=web&cstk={api.cstk}"
            f"&startIndex={start}"
        )
        data = api._safe_json(api.http_get(url))
        entries = data.get("entries", [])
        total = data.get("count", 0)
        page_ids = set(e.get("fileEntry", {}).get("id", "") for e in entries)
        new_ids = page_ids - all_ids
        all_ids.update(page_ids)
        all_names.update(e.get("fileEntry", {}).get("name", "") for e in entries)
        print(f"  startIndex={start}: entries={len(entries)}, "
              f"count={total}, new_ids={len(new_ids)}, "
              f"total_unique={len(all_ids)}")
        if len(entries) < 100:
            break

    print(f"  累计不同 name: {len(all_names)}")
    if args.search:
        found = sorted([n for n in all_names if args.search in n])
        print(f"  搜索 '{args.search}': {len(found)}: {found[:5]}...")


# ===== 主入口 =====

def main():
    parser = argparse.ArgumentParser(
        description="API 分页诊断工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="子命令")

    # 共用参数
    for name, help_text in [
        ("basic", "拉指定目录，检查条目和分页字段"),
        ("detail", "模拟分页循环，检查去重和退出条件"),
        ("large", "测试不同 page_size 参数的效果"),
    ]:
        p = sub.add_parser(name, help=help_text)
        group = p.add_mutually_exclusive_group(required=True)
        group.add_argument("--dir", default=None,
                           help="目录路径（从元数据查找 dir_id）")
        group.add_argument("--dir-id", default=None,
                           help="直接指定 dir_id")
        p.add_argument("--search", default=None,
                       help="在结果中搜索包含指定关键词的文件名")
        if name == "detail":
            p.add_argument("--page-size", type=int, default=200,
                           help="每页大小（默认 200）")

    args = parser.parse_args()

    dispatch = {
        "basic": cmd_basic,
        "detail": cmd_detail,
        "large": cmd_large,
    }

    if args.command is None:
        parser.print_help()
        return 1

    return dispatch[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
