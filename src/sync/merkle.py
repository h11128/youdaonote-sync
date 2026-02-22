"""
Merkle tree for directory-level change detection.
"""

from typing import Dict, Set

import xxhash


def build_tree(local_files: Dict[str, Dict], hash_cache: Dict[str, str]) -> Dict[str, str]:
    dirs = {""}
    for rel, info in local_files.items():
        if info.get("is_dir"):
            dirs.add(rel)
    sorted_dirs = sorted(dirs, key=lambda d: -(d.count("/") + 1) if d else 0)

    result: Dict[str, str] = {}
    prefix = lambda d: (d + "/") if d else ""

    for d in sorted_dirs:
        pre = prefix(d)
        children: Dict[str, str] = {}
        for rel, info in local_files.items():
            if not rel.startswith(pre) or "/" in rel[len(pre):]:
                continue
            name = rel[len(pre):]
            if info.get("is_dir"):
                children[name] = result.get(rel, "unknown")
            else:
                children[name] = hash_cache.get(info.get("path", ""), "unknown")
        parts = [f"{k}:{v}" for k, v in sorted(children.items())]
        data = "|".join(parts).encode("utf-8")
        result[d] = xxhash.xxh3_128(data).hexdigest()

    return result


def diff_trees(old_hashes: Dict[str, str], new_hashes: Dict[str, str]) -> Set[str]:
    if old_hashes.get("") == new_hashes.get(""):
        return set()
    changed: Set[str] = set()
    all_dirs = set(old_hashes) | set(new_hashes)
    for d in all_dirs:
        if old_hashes.get(d) != new_hashes.get(d):
            changed.add(d)
    return changed
