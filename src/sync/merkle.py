"""
Merkle tree for directory-level change detection.
"""

from collections import defaultdict
from typing import Dict, List, Set, Tuple

import xxhash


def build_tree(local_files: Dict[str, Dict], hash_cache: Dict[str, str]) -> Dict[str, str]:
    # Phase 1: single-pass grouping — O(N) to build parent→children index
    dirs: Set[str] = {""}
    # parent_dir → [(child_name, is_dir, rel_path, abs_path)]
    children_of: Dict[str, List[Tuple[str, bool, str, str]]] = defaultdict(list)

    for rel, info in local_files.items():
        is_dir = info.get("is_dir", False)
        if is_dir:
            dirs.add(rel)
        slash_pos = rel.rfind("/")
        if slash_pos < 0:
            parent, name = "", rel
        else:
            parent, name = rel[:slash_pos], rel[slash_pos + 1:]
        abs_path = info.get("path", "")
        children_of[parent].append((name, is_dir, rel, abs_path))

    # Phase 2: bottom-up hash — process deepest dirs first
    sorted_dirs = sorted(dirs, key=lambda d: -(d.count("/") + 1) if d else 0)

    result: Dict[str, str] = {}
    for d in sorted_dirs:
        child_hashes: Dict[str, str] = {}
        for name, is_dir, rel, abs_path in children_of.get(d, []):
            if is_dir:
                child_hashes[name] = result.get(rel, "unknown")
            else:
                child_hashes[name] = hash_cache.get(abs_path, "unknown")
        parts = [f"{k}:{v}" for k, v in sorted(child_hashes.items())]
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
