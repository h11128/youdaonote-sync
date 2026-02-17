"""
笔记目录重复文件扫描器

基于内容 hash（normalized MD5）扫描，找出内容完全一致的重复文件。
不依赖文件名，纯看内容。同时也报告同名但内容不同的文件供参考。

用法：
    python tools/scan_duplicates.py [笔记目录]
    python tools/scan_duplicates.py E:/Projects/notes
"""

import os
import sys
import hashlib
from collections import defaultdict


def normalize_content(data: bytes) -> bytes:
    """去掉 CRLF / BOM 差异后的内容"""
    return data.replace(b"\r\n", b"\n").replace(b"\xef\xbb\xbf", b"")


def scan(root: str):
    """扫描目录，返回 {文件名: [路径列表]}"""
    name_map: dict[str, list[str]] = defaultdict(list)
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过 .git 和隐藏目录
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if f.startswith(".") or ".conflict." in f:
                continue
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, root).replace("\\", "/")
            name_map[f].append(rel)
    return name_map


def classify(root: str, paths: list[str]):
    """
    对同名文件的多个路径做分类：
    返回 (identical, crlf_only, real_diff)
    - identical: 字节完全一致的路径组
    - crlf_only: 去掉换行符差异后一致
    - real_diff: 有实质内容差异
    """
    contents = {}
    for p in paths:
        full = os.path.join(root, p)
        try:
            with open(full, "rb") as fh:
                contents[p] = fh.read()
        except Exception:
            contents[p] = None

    # 按原始 hash 分组
    hash_groups: dict[str, list[str]] = defaultdict(list)
    for p, data in contents.items():
        if data is not None:
            h = hashlib.md5(data).hexdigest()
            hash_groups[h].append(p)

    # 如果所有文件 hash 一样 → identical
    if len(hash_groups) == 1:
        return "identical", paths

    # 按 normalized hash 分组
    norm_groups: dict[str, list[str]] = defaultdict(list)
    for p, data in contents.items():
        if data is not None:
            h = hashlib.md5(normalize_content(data)).hexdigest()
            norm_groups[h].append(p)

    if len(norm_groups) == 1:
        return "crlf_only", paths

    return "real_diff", paths


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    root = os.path.abspath(root)

    if not os.path.isdir(root):
        print(f"目录不存在: {root}")
        sys.exit(1)

    print(f"扫描目录: {root}\n")
    name_map = scan(root)

    # 只保留出现 2 次以上的
    dupes = {k: v for k, v in name_map.items() if len(v) > 1}

    if not dupes:
        print("没有找到重复文件。")
        return

    identical_list = []
    crlf_list = []
    diff_list = []

    for name, paths in sorted(dupes.items()):
        category, ps = classify(root, paths)
        if category == "identical":
            identical_list.append((name, ps))
        elif category == "crlf_only":
            crlf_list.append((name, ps))
        else:
            diff_list.append((name, ps))

    total = len(identical_list) + len(crlf_list) + len(diff_list)
    print(f"共 {total} 组同名文件：\n")

    # ── 内容完全一致 ──
    if identical_list:
        print(f"{'='*60}")
        print(f"  内容完全一致（可安全删除副本）: {len(identical_list)} 组")
        print(f"{'='*60}")
        for name, paths in identical_list:
            print(f"\n  {name}")
            for p in paths:
                size = os.path.getsize(os.path.join(root, p))
                print(f"    {p}  ({size:,} bytes)")

    # ── 仅换行符差异 ──
    if crlf_list:
        print(f"\n{'='*60}")
        print(f"  仅换行符差异 (LF vs CRLF): {len(crlf_list)} 组")
        print(f"{'='*60}")
        for name, paths in crlf_list:
            print(f"\n  {name}")
            for p in paths:
                size = os.path.getsize(os.path.join(root, p))
                print(f"    {p}  ({size:,} bytes)")

    # ── 有实质差异 ──
    if diff_list:
        print(f"\n{'='*60}")
        print(f"  有实质内容差异（需人工检查）: {len(diff_list)} 组")
        print(f"{'='*60}")
        for name, paths in diff_list:
            print(f"\n  {name}")
            for p in paths:
                size = os.path.getsize(os.path.join(root, p))
                print(f"    {p}  ({size:,} bytes)")

    # ── 汇总 ──
    print(f"\n{'='*60}")
    print(f"  汇总")
    print(f"{'='*60}")
    print(f"  完全一致:     {len(identical_list)} 组")
    print(f"  仅换行符差异: {len(crlf_list)} 组")
    print(f"  实质差异:     {len(diff_list)} 组")

    # ── 找出「整个子目录是另一个目录副本」的情况 ──
    print(f"\n{'='*60}")
    print(f"  可能重复的目录结构")
    print(f"{'='*60}")

    # 收集所有重复文件的目录对
    dir_pairs: dict[tuple[str, str], int] = defaultdict(int)
    for name, paths in identical_list + crlf_list:
        dirs = [os.path.dirname(p) for p in paths]
        for i in range(len(dirs)):
            for j in range(i + 1, len(dirs)):
                a, b = sorted([dirs[i], dirs[j]])
                dir_pairs[(a, b)] += 1

    # 只显示重复文件数 >= 3 的目录对
    shown = False
    for (a, b), count in sorted(dir_pairs.items(), key=lambda x: -x[1]):
        if count >= 3:
            a_total = sum(1 for _ in os.listdir(os.path.join(root, a)) if not _.startswith("."))
            b_total = sum(1 for _ in os.listdir(os.path.join(root, b)) if not _.startswith("."))
            print(f"\n  {a}/  ({a_total} 项)")
            print(f"  {b}/  ({b_total} 项)")
            print(f"  → 有 {count} 个相同文件")
            shown = True

    if not shown:
        print("\n  没有发现大规模目录级重复。")


if __name__ == "__main__":
    main()
